import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, accountIdentity, stateDirectory, digest } from './state.mjs';
import { rpc, receipt, hasSecret, validId, options } from './runtime.mjs';
import { archiveTurn } from './archive.mjs';
import { generate } from './generation.mjs';
import { acquireLock, alive } from './lock.mjs';
import { checkControl } from './queue.mjs';

export async function processJob(store, name, { model, call: injectedCall } = {}) {
  let job = await store.get(name);
  if (!job || job.status !== 'queued') return;
  let signal = AbortSignal.timeout(280000);
  const rawCall = injectedCall ?? ((args) => rpc({ ...job.o, timeout: 20000 }, args, signal));
  const save = async patch => { job = { ...job, ...patch }; await store.put(name, job); };
  const controlName = 'control-' + digest(job.account, job.o.url, job.o.project);
  const beforeWrite = async () => {
    const control = await store.get(controlName);
    checkControl(job, control);
    if (job.o.readOnly || control?.readOnly) throw new Error('read-only');
    if (job.o.archive && control?.archive === false || job.o.capture && control?.capture === false) throw new Error('job-disabled');
    if (await accountIdentity(job.o, rawCall) !== job.account) throw new Error('account-changed');
    const mode = await rawCall(['agent-config']);
    if (mode.status !== 'ok' || mode.summary?.readonly || mode.summary?.memory_off || ['readonly', 'off'].includes(mode.summary?.workspace_mode)) throw new Error('engine-read-only');
    await save({ writeAttempted: true });
  };
  try {
    await save({ status: 'running', pid: process.pid, progress: { stage: 'checking' } });
    const control = await store.get(controlName);
    signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, checkControl(job, control) - Date.now()))]);
    if (await accountIdentity(job.o, rawCall) !== job.account) throw new Error('account-changed');
    if (job.o.readOnly || control?.readOnly || job.o.archive && control?.archive === false || job.o.capture && control?.capture === false) throw new Error('job-disabled');
    const records = [];
    const call = async args => {
      if (['remember', 'update'].includes(args[0])) {
        await beforeWrite();
        if (args[0] === 'update') {
          const current = await rawCall(['show', args[1]]);
          if (job.o.project && current.details?.entry?.project !== job.o.project) throw new Error('project-mismatch');
        }
        const trivial = args[0] === 'remember' && args[args.indexOf('--importance') + 1] === 'trivial';
        if (!trivial) {
          const at = args[0] === 'remember' ? 1 : args.indexOf('--content') + 1;
          if (at <= 0 || typeof args[at] !== 'string') throw new Error('content-required');
          if (!args[at].includes(job.source)) { args = [...args]; args[at] += `\n【来源】回合 ${job.source}`; }
        }
      }
      if (['recall', 'remember'].includes(args[0]) && job.o.project) {
        if (args.includes('--project')) {
          const at = args.indexOf('--project');
          if (args[at + 1] !== job.o.project || args.lastIndexOf('--project') !== at) throw new Error('project-override');
          args = [...args.slice(0, at), ...args.slice(at + 2)];
        }
        if (args.some(a => a.startsWith('--project'))) throw new Error('project-override');
        args = [...args, '--project', job.o.project];
      }
      const doc = await rawCall(args);
      if (['remember', 'update'].includes(args[0]) && doc.status === 'ok' && validId(doc.summary?.id)) {
        records.push(doc.summary.id); await save({ records: [...new Set(records)] });
      }
      return doc;
    };
    let diary;
    if (job.o.capture) {
      await rawCall(['recall', '回合过程采集', '--titles', '--limit', '1']);
      const policy = await rawCall(['prompt']);
      if (policy.status !== 'ok' || typeof policy.summary?.instructions !== 'string' || !policy.summary.instructions.trim()) throw new Error('invalid-engine-policy');
      await beforeWrite();
      const content = JSON.stringify({ schema: 'respire.memory.turn.v1', source: job.source, messages: job.messages });
      if (hasSecret(job.messages) || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('capture-content-limit');
      diary = receipt(await call(['remember', content, '--importance', 'trivial']));
      if (diary.status !== 'stored') throw new Error('capture-unconfirmed');
      const check = await rawCall(['show', diary.id]);
      if (check.status !== 'ok' || check.details?.entry?.id !== diary.id || !check.details.entry.content.includes(job.source)) throw new Error('capture-readback-failed');
      await save({ diary: { ...diary, verified: true } });
    }
    const result = job.o.archive ? await archiveTurn(job, { call, signal, model: async (...args) => {
      checkControl(job, await store.get(controlName));
      if (await accountIdentity(job.o, rawCall) !== job.account) throw new Error('account-changed');
      const mode = await rawCall(['agent-config']);
      if (mode.status !== 'ok' || mode.summary?.readonly || mode.summary?.memory_off || ['readonly', 'off'].includes(mode.summary?.workspace_mode)) throw new Error('engine-read-only');
      return (model ?? generate)(...args);
    },
      progress: async progress => save({ progress }) }) : { result: 'captured', records, checkedRecords: diary ? [diary.id] : [] };
    const finishedAt = new Date().toISOString();
    await save({ status: 'completed', result, finishedAt, progress: { stage: 'completed' } });
  } catch (error) {
    await save({ status: error.message === 'control-expired' && !job.writeAttempted ? 'expired' : 'unconfirmed',
      error: /^[a-z-]{1,64}$/.test(error.message) ? error.message : 'archive-failed', finishedAt: new Date().toISOString() });
  }
  try {
    await store.change('session-' + job.sessionKey, async (session = {}, persist) => persist({ ...session,
      lastArchive: { source: job.source, status: job.status, result: job.result, error: job.error, records: job.records ?? [], finishedAt: job.finishedAt } }));
  } catch (error) { await save({ notificationError: error.message === 'lock-busy' ? 'session-lock-busy' : 'session-notification-failed' }); }
}

export async function runQueue(dir) {
  const store = new Store(dir); await store.key();
  let release;
  try { release = await acquireLock(join(dir, 'worker.lock'), { waitMs: 0 }); }
  catch (error) { if (error.message === 'lock-busy') return; throw error; }
  try {
    await store.prune();
    for (const name of await store.jobs()) {
      const job = await store.get(name);
      if (job.status === 'running' && Date.now() - Date.parse(job.createdAt) > 300000)
        await store.put(name, { ...job, status: job.writeAttempted ? 'unconfirmed' : 'expired', error: 'control-expired' });
      else if (job.status === 'running' && !alive(job.pid)) await store.put(name, { ...job, status: job.writeAttempted ? 'unconfirmed' : 'queued', error: 'interrupted' });
    }
    while (true) {
      const queued = [];
      for (const name of await store.jobs()) {
        const job = await store.get(name);
        if (job.status === 'queued') queued.push({ name, createdAt: job.createdAt ?? '' });
      }
      if (!queued.length) break;
      queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
      for (const { name } of queued) await processJob(store, name);
    }
  } finally { await release(); }
}

async function cli() {
  const [command = 'status', dir = stateDirectory({})] = process.argv.slice(2);
  if (command === 'evidence') {
    const source = process.argv[3];
    if (!/^[a-f0-9]{64}$/.test(source ?? '')) throw new Error('invalid-source');
    const job = await new Store(process.argv[4] || stateDirectory({})).get('job-' + source);
    if (!job) throw new Error('source-not-found');
    const evidenceAt = Date.parse(job.retentionAt ?? job.finishedAt ?? job.createdAt);
    if (!job.messages || !Number.isFinite(evidenceAt) || Date.now() - evidenceAt > 86400000) throw new Error('evidence-expired');
    console.log(JSON.stringify({ source, messages: job.messages })); return;
  }
  const store = new Store(dir);
  if (command === 'setup') {
    const o = options({ stateDir: dir });
    const signal = AbortSignal.timeout(5000);
    const status = await rpc(o, ['status'], signal), mode = await rpc(o, ['agent-config'], signal);
    await store.key();
    console.log(JSON.stringify({ node: process.version, stateDir: dir, runtimeReady: status.status === 'ok' && status.summary?.unlocked === true,
      readonly: mode.summary?.readonly, memoryOff: mode.summary?.memory_off, note: 'Generation configuration is set in the Magpie plugin page; setup does not send a model request.' })); return;
  }
  if (command === 'run') return runQueue(dir);
  if (command === 'recover') {
    return runQueue(dir);
  }
  if (command !== 'status') throw new Error('usage-status-run-recover');
  const jobs = await Promise.all((await store.jobs()).map(async name => {
    const j = await store.get(name); return { source: j.source, status: j.status, progress: j.progress,
      result: j.result, error: j.error, records: j.records, createdAt: j.createdAt, evidenceExpired: j.evidenceExpired, notificationError: j.notificationError };
  }));
  console.log(JSON.stringify({ jobs }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error => {
  console.error(/^[a-z-]+$/.test(error.message) ? error.message : 'worker-failed'); process.exitCode = 1;
});

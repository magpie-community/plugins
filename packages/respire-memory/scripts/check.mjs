import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { onRequest, onResponse, reset } from '../respire.hooks.mjs';
import { options, hasSecret } from '../runtime.mjs';
import { Store, digest, accountIdentity } from '../state.mjs';
import { processJob, runQueue } from '../worker.mjs';
import { acquireLock } from '../lock.mjs';
import { enqueue, checkControl, controlSignature, CONTROL_LEASE_MS } from '../queue.mjs';
import { rpc } from '../runtime.mjs';
import { memoryTools } from '../memory-tools.mjs';
import { prepareArchiveContext, readEvidence, parseExtraction } from '../archive-context.mjs';
import { archiveTurn } from '../archive.mjs';
import { generate } from '../generation.mjs';
if (!process.env.RESPIRE_CHECK_HOME) {
  const isolated = mkdtempSync(join(tmpdir(), 'respire-home-'));
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
      env: { ...process.env, HOME: isolated, USERPROFILE: isolated, RESPIRE_CHECK_HOME: isolated } });
  } finally { rmSync(isolated, { recursive: true }); }
  process.exit(0);
}
assert.equal(process.env.HOME, process.env.RESPIRE_CHECK_HOME);
assert.equal(process.env.USERPROFILE, process.env.RESPIRE_CHECK_HOME);
assert(resolve(process.env.RESPIRE_CHECK_HOME).startsWith(resolve(tmpdir()) + sep), 'Refusing a non-temporary HOME');
if (process.versions.bun) {
  // Runtime modules are parsed by the imports above; compile the browser script without executing it.
  new Function(readFileSync('page/settings.js', 'utf8'));
} else for (const file of [...readdirSync('.').filter(f => f.endsWith('.mjs')), 'page/settings.js']) execFileSync(process.execPath, ['--check', file]);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.name.startsWith('@magpie-community/')) {
  assert.equal(pkg.repository.url, 'git+https://github.com/magpie-community/plugins.git');
  assert.equal(pkg.repository.directory, 'packages/respire-memory');
}
assert.equal(options().archive, true); assert.equal(pkg.magpie.options.archive, true);
assert.equal(options().showMemoryStatus, false); assert.equal(pkg.magpie.options.showMemoryStatus, false);
assert.deepEqual(Buffer.from(pkg.magpie.icon.split(',')[1], 'base64'), readFileSync(pkg.magpie.page.icon));
for (const path of pkg.files) assert(existsSync(path), path);
for (const runtimeUrl of ['http://example.com', 'http://u:x@127.0.0.1', 'http://127.0.0.1/path']) assert.throws(() => options({ runtimeUrl }));
assert(hasSecret({ content: '{"api_key":"fixture-secret"}' }));
assert(hasSecret({ tool: { PGPASSWORD: 'fixture-secret' } }));
const id = '11111111-1111-4111-8111-111111111111';
let calls = 0;
let generationRound = 0, unknownWrite = false, writes = 0, policyReady = true, emptyRecall = false, oversizedChain = false, brokenDiary = false, wholeDiaryReads = 0, fixturePolicy = 'Complete fixture policy';
const savedId = '22222222-2222-4222-8222-222222222222';
const diaryId = '33333333-3333-4333-8333-333333333333';
const commandLog = [];
const entries = new Map([[id, { id, title: 'Example', content: 'Historical evidence', project: '' }]]);
const server = createServer(async (req, res) => {
  assert(!/magpie/i.test(req.headers['user-agent'] ?? ''));
  let body = ''; for await (const chunk of req) body += chunk;
  const r = JSON.parse(body); calls++;
  if (req.url === '/v1/chat/completions') {
    assert(!body.includes('Other turn: private unrelated content'), 'Daily aggregate must never reach the model through remember or show');
    const actions = [ ['recall', ['project']], ['prompt', []], ['agent-config', []], ['show', [id]],
      ['remember', ['【前因】用户明确项目约定。【行为】实际采用规则。【后果】保留规则。', '--title', '项目已明确采用现有验证规则', '--importance', 'important', '--parent', id]], ['show', [savedId]],
      ['remember', ['助手在fixture主机完成项目规则验证。', '--importance', 'trivial']], ['show', [diaryId]] ];
    const action = actions[generationRound++];
    const message = action ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool-' + generationRound, type: 'function', function: { name: 'respire_memory', arguments: JSON.stringify({ command: action[0], args: action[1] }) } }] }
      : { role: 'assistant', content: JSON.stringify({ result: 'stored', ids: [savedId] }) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: action ? 'tool_calls' : 'stop', message }] })); return;
  }
  assert(r.queue_wait_ms > 0);
  const command = r.args[1];
  commandLog.push(command);
  const envelope = { status: 'ok', summary: command === 'status' ? { data_dir: 'fixture', unlocked: true, session: { has_session: true, user: 'fixture', addr: 'fixture' } }
    : command === 'agent-config' ? { readonly: false, memory_off: false, workspace_mode: 'normal' }
    : command === 'prompt' ? { instructions: policyReady ? fixturePolicy : '' } : {},
    details: command === 'recall' ? (emptyRecall ? [] : [{ id }]) : command === 'prompt' ? null : command === 'chain' && oversizedChain ? { content: 'x'.repeat(16000) } : { entry: entries.get(r.args[2]) ?? entries.get(id) } };
  if (command === 'show') { envelope.summary.id = r.args[2]; if (r.args[2] === diaryId) wholeDiaryReads++; }
  if (command === 'diary-search' || command === 'diary-fragment') {
    const text = command === 'diary-fragment' && brokenDiary ? 'Only the marker remains: ' + (entries.get(diaryId)?.content.split('【来源】回合 ')[1] ?? '') : entries.get(diaryId)?.content ?? '';
    envelope.details = { items: [{ source_id: diaryId, fragment_id: 'fixture-fragment', source_version: 'fixture-version',
      text, start: 0, end: Array.from(text).length, truncated: false }] };
    if (command === 'diary-fragment') {
      const chars = Array.from(text), split = Math.floor(chars.length / 2);
      envelope.details.items = [
        { ...envelope.details.items[0], fragment_id: 'fixture-neighbor', text: chars.slice(0, split + 8).join(''), end: split + 8 },
        { ...envelope.details.items[0], text: chars.slice(split).join(''), start: split }
      ];
    }
  }
  if (command === 'remember') {
    if (r.args[2] === 'pending-fixture-content') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: 1, id: r.id, ok: false, exit: 2, envelope: { status: 'pending', summary: {}, items: [] } })); return;
    }
    const writtenId = r.args.includes('trivial') ? diaryId : savedId;
    writes++; entries.set(writtenId, { id: writtenId, title: 'Saved', content: r.args.includes('trivial') ? 'Other turn: private unrelated content.\n' + r.args[2] : r.args[2], project: '', importance: r.args.includes('trivial') ? 'trivial' : 'important' }); envelope.summary.id = writtenId;
    if (writtenId === diaryId) envelope.details = { entry: entries.get(diaryId) };
    if (unknownWrite) { res.destroy(); return; }
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ v: 1, id: r.id, ok: true, exit: 0, envelope }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const scratch = mkdtempSync(join(tmpdir(), 'respire-check-'));
try {
  const stateDir = join(scratch, 'state');
  mkdirSync(stateDir, { recursive: true });
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const stalePath = join(stateDir, 'stale.lock');
  mkdirSync(stalePath); writeFileSync(join(stalePath, `${deadPid}-abcdef.owner`), 'fixture');
  await (await acquireLock(stalePath))(); assert(!existsSync(stalePath));
  writeFileSync(stalePath, String(deadPid)); await (await acquireLock(stalePath))();
  const held = await acquireLock(stalePath); const waiter = acquireLock(stalePath);
  setTimeout(() => held(), 100); await (await waiter)();
  writeFileSync(stalePath, String(deadPid));
  const sharedCounter = join(scratch, 'shared-counter'); writeFileSync(sharedCounter, '0');
  const lockScript = `(async()=>{const {acquireLock}=await import(${JSON.stringify(new URL('../lock.mjs', import.meta.url).href)});const fs=await import('node:fs/promises');const release=await acquireLock(${JSON.stringify(stalePath)});const n=Number(await fs.readFile(${JSON.stringify(sharedCounter)},'utf8'));await new Promise(r=>setTimeout(r,10));await fs.writeFile(${JSON.stringify(sharedCounter)},String(n+1));await release()})().catch(e=>{console.error(e);process.exitCode=1})`;
  const lockChildren = await Promise.allSettled(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', lockScript], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); let error = '';
    child.stderr.on('data', data => { error += data; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(error || 'lock-child-failed')));
  })));
  assert(lockChildren.every(r => r.status === 'fulfilled'), lockChildren.filter(r => r.status === 'rejected').map(r => String(r.reason)).join('\n'));
  assert.equal(readFileSync(sharedCounter, 'utf8'), '4');
  const concurrent = new Store(stateDir), counterKey = 'session-' + digest('lock-counter');
  for (let round = 0; round < 8; round++) {
    await Promise.all(Array.from({ length: 8 }, () => concurrent.change(counterKey, async (v = {}, save) => save({ count: (v.count ?? 0) + 1 }))));
  }
  assert.equal((await concurrent.get(counterKey)).count, 64);
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    reset(); const ctx = { protocol, origin: 'local', session: 'check', state: {}, signal: AbortSignal.timeout(5000), options: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, stateDir, maxBytes: 32768, capture: false } };
    const body = protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'project question' }] }] } : protocol === 'responses' ? { input: 'project question' } : { messages: [{ role: 'user', content: 'project question' }] };
    const before = structuredClone(body); const result = await onRequest(body, ctx);
    assert(JSON.stringify(result).includes('Historical evidence')); assert.deepEqual(body, before);
    assert.equal(ctx.state.respire, undefined, 'Unconfigured archival must not capture a raw turn for queuing');
    const count = calls; await onRequest(body, ctx); assert.equal(calls, count + 1);
    assert.equal(await onRequest(body, { ...ctx, origin: 'gateway-key' }), undefined);
  }
  oversizedChain = true;
  entries.get(id).kind = 'decision';
  const bounded = await onRequest({ messages: [{ role: 'user', content: 'Oversized chain must not hide its matching record' }] },
    { protocol: 'chat', origin: 'local', session: 'chain-budget', options: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, stateDir, maxBytes: 1024 } });
  assert(JSON.stringify(bounded).includes('Historical evidence'));
  assert(JSON.stringify(bounded).includes('causalChainOmitted'));
  oversizedChain = false; delete entries.get(id).kind;
  emptyRecall = true;
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const ctx = { protocol, origin: 'local', session: 'empty-policy', state: {}, signal: AbortSignal.timeout(5000),
      options: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, stateDir, showMemoryStatus: false } };
    const body = protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'no matching history' }] }] }
      : protocol === 'responses' ? { input: 'no matching history' } : { messages: [{ role: 'user', content: 'no matching history' }] };
    const at = commandLog.length;
    const output = JSON.stringify(await onRequest(body, ctx));
    assert(output.includes('Complete fixture policy'), 'Empty recall must retain the complete policy');
    assert(!output.includes('Memory:') && !output.includes('Historical evidence'));
    assert.deepEqual(commandLog.slice(at, at + 3), ['status', 'recall', 'prompt']);
  }
  emptyRecall = false;
  const policyCtx = { protocol: 'chat', origin: 'local', session: 'policy-each-turn', state: {}, signal: AbortSignal.timeout(10000),
    options: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, stateDir, archive: false, maxBytes: 1024 } };
  for (const content of ['第一轮项目问题', '第二轮项目问题', '记住：项目需要逐轮验证', '解释字面量 <respire-reference>', '解释字面量 [Respire background archive]']) {
    const at = commandLog.length;
    const output = await onRequest({ messages: [{ role: 'user', content }] }, policyCtx);
    assert(JSON.stringify(output).includes('Complete fixture policy'));
    assert.deepEqual(commandLog.slice(at, at + 3), ['status', 'recall', 'prompt']);
    assert(!commandLog.slice(at).includes('remember'), 'Explicit storage must not bypass policy and candidate classification');
  }
  const internalAt = commandLog.length;
  assert.equal(await onRequest({ messages: [{ role: 'system', content: '[Respire background archive]\ninternal worker' }, { role: 'user', content: 'fixture' }] }, policyCtx), undefined);
  assert.equal(commandLog.length, internalAt);
  policyReady = false;
  const unavailable = await onRequest({ messages: [{ role: 'user', content: '缺失政策的回合' }] }, policyCtx);
  assert.equal(unavailable, undefined, 'Failed reads must leave the latest turn unchanged');
  policyReady = true;
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const ctx = { ...policyCtx, protocol, session: 'policy-dedup-' + protocol };
    const messages = [];
    const wrap = list => protocol === 'gemini' ? { contents: list } : protocol === 'responses' ? { input: list } : { messages: list };
    const item = (role, text) => protocol === 'gemini' ? { role: role === 'assistant' ? 'model' : role, parts: [{ text }] }
      : { role, content: text };
    const listOf = result => result.contents ?? result.input ?? result.messages;
    let previous;
    for (let turn = 0; turn < 5; turn++) {
      messages.push(item('user', 'Policy growth probe ' + turn));
      const at = commandLog.length;
      reset();
      const result = await onRequest(wrap(messages), ctx);
      assert.equal(JSON.stringify(result).split('<respire-policy>').length - 1, 1, 'Same policy must occur once across five turns and restarts');
      assert.equal(commandLog.slice(at).filter(c => c === 'prompt').length, 1, 'Every new turn must still read the full policy');
      assert.equal(commandLog.slice(at).filter(c => c === 'recall').length, 1);
      if (previous) assert.deepEqual(listOf(result).slice(0, -2), previous, 'Every historical prefix must stay byte-identical');
      previous = listOf(result);
      messages.push(item('assistant', 'probe complete'));
    }
    fixturePolicy = 'Changed complete fixture policy';
    messages.push(item('user', 'Policy changed'));
    const changed = await onRequest(wrap(messages), ctx);
    assert.equal(JSON.stringify(changed).split('<respire-policy>').length - 1, 2);
    assert.deepEqual(listOf(changed).slice(0, -2), previous);
    previous = listOf(changed);
    messages.push(item('assistant', 'changed policy read'), item('user', 'Policy unchanged again'));
    reset();
    const same = await onRequest(wrap(messages), ctx);
    assert.equal(JSON.stringify(same).split('<respire-policy>').length - 1, 2);
    assert.deepEqual(listOf(same).slice(0, -2), previous);
    fixturePolicy = 'Complete fixture policy';
    messages.push(item('assistant', 'same policy read'), item('user', 'Policy reverted'));
    const reverted = await onRequest(wrap(messages), ctx);
    assert.equal(JSON.stringify(reverted).split('<respire-policy>').length - 1, 3, 'Returning to a previous policy must inject the new current version');
  }
  const originalCtx = { ...policyCtx, session: 'history-restoration' };
  const original = await onRequest({ messages: [{ role: 'user', content: '第一回合稳定历史' }] }, originalCtx);
  const controlKey = 'control-' + digest(await accountIdentity(options(policyCtx.options), args => rpc(options(policyCtx.options), args, policyCtx.signal)), options(policyCtx.options).url, '');
  const controlBefore = readFileSync(concurrent.path(controlKey));
  const hotAt = commandLog.length;
  for (let i = 0; i < 30; i++) await onRequest({ messages: [{ role: 'user', content: '第一回合稳定历史' }] }, originalCtx);
  assert.equal(commandLog.slice(hotAt).filter(command => command === 'status').length, 30, 'Fresh account checks intentionally remain');
  assert.equal(commandLog.slice(hotAt).filter(command => command === 'recall').length, 0);
  assert.deepEqual(readFileSync(concurrent.path(controlKey)), controlBefore);
  reset();
  const restored = await onRequest({ messages: [{ role: 'user', content: '第一回合稳定历史' }, { role: 'assistant', content: '已处理' }, { role: 'user', content: '新的第二回合' }] },
    { ...originalCtx, options: { ...originalCtx.options, readOnly: true, generationModel: 'changed-setting' } });
  assert.equal(restored.messages[0].content, original.messages[0].content, 'History prefix must survive restart and non-recall options');
  reset();
  const continuation = await onRequest({ messages: [{ role: 'user', content: '第一回合稳定历史' }, { role: 'assistant', content: '工具已完成' }] }, originalCtx);
  assert.equal(continuation.messages[0].content, original.messages[0].content, 'Tool continuation must restore the durable block after restart');
  const o = options({ stateDir, runtimeUrl: `http://127.0.0.1:${server.address().port}`, archive: true,
    generationBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, generationModel: 'fixture', authorizationEnv: 'RESPIRE_MAGPIE_FIXTURE_KEY' });
  const store = new Store(stateDir), call = args => rpc(o, args);
  const account = await accountIdentity(o, call);
  const acceptedAt = Date.now();
  await store.put('control-' + digest(account, o.url, o.project), { readOnly: false, archive: true, capture: false, updatedAt: acceptedAt, signature: controlSignature(o) });
  const makeJob = source => ({ source, sessionKey: digest('session', source), account, o, status: 'queued', writeAttempted: false,
    createdAt: new Date(acceptedAt).toISOString(), messages: [{ role: 'user', content: '项目已采用验证规则' }, { role: 'assistant', content: '已实施并验证。' }] });
  const source = digest('archive-success'); await store.put('job-' + source, makeJob(source));
  const startupAt = commandLog.length;
  await processJob(store, 'job-' + source);
  assert.deepEqual(commandLog.slice(startupAt, startupAt + 4), ['status', 'recall', 'prompt', 'agent-config']);
  const done = await store.get('job-' + source);
  assert.equal(done.status, 'completed', JSON.stringify({ error: done.error, progress: done.progress }));
  assert(done.result.checkedRecords.includes(savedId)); assert(done.result.checkedRecords.includes(diaryId)); assert.equal(writes, 2); assert(entries.get(savedId).content.includes(source));
  assert(!readFileSync(store.path('job-' + source), 'utf8').includes('项目已采用验证规则'));
  generationRound = 0; unknownWrite = true;
  const uncertain = digest('archive-uncertain'); await store.put('job-' + uncertain, makeJob(uncertain));
  await processJob(store, 'job-' + uncertain);
  assert.equal((await store.get('job-' + uncertain)).status, 'unconfirmed');
  const count = writes; await processJob(store, 'job-' + uncertain); assert.equal(writes, count);
  unknownWrite = false;
  const readOnlySource = digest('read-only'); const readonly = makeJob(readOnlySource); readonly.o = { ...o, readOnly: true };
  await store.put('job-' + readOnlySource, readonly); await processJob(store, 'job-' + readOnlySource); assert.equal(writes, count);
  const guarded = memoryTools(call);
  await assert.rejects(() => guarded.run({ command: 'remember', args: ['text', '--force'] }));
  await assert.rejects(() => guarded.run({ command: 'remember', args: ['text', '--importance', 'important', '--title', 'title', '--parent', id] }));
  await assert.rejects(() => guarded.run({ command: 'agent-config', args: ['--set', 'readonly=false'] }));
  await assert.rejects(() => guarded.run({ command: 'show', args: [diaryId.slice(0,8)] }), /full-id-required/);
  const diaryGuard = memoryTools(call, { source: digest('strict-diary-readback') });
  await diaryGuard.run({ command: 'recall', args: ['project'] }); await diaryGuard.run({ command: 'prompt', args: [] });
  const diaryWrite = await diaryGuard.run({ command: 'remember', args: ['Current turn complete diary.', '--importance', 'trivial'] });
  assert(!JSON.stringify(diaryWrite).includes('Other turn:'));
  await assert.rejects(() => diaryGuard.run({ command: 'remember', args: ['Do not overwrite unverified daily write.', '--importance', 'trivial'] }), /diary-readback-required/);
  brokenDiary = true;
  await assert.rejects(() => diaryGuard.run({ command: 'show', args: [diaryId] }), /diary-readback-unconfirmed/);
  assert(diaryGuard.uncertain);
  await assert.rejects(() => diaryGuard.run({ command: 'remember', args: ['No replay after incomplete readback.', '--importance', 'trivial'] }), /read-before-write/);
  brokenDiary = false;
  const large = prepareArchiveContext([{ type: 'userMessage', content: [{ text: 'a'.repeat(270000) }] }]);
  assert(large.chunks.length > 1); assert.equal(readEvidence(large.fragments, [large.userSources[0]])[0].text.length, 6000);
  assert.throws(() => parseExtraction(JSON.stringify({ facts: [{ text: 'x', status: 'confirmed', sources: ['invented'] }], constraints: [] }), large.fragments));
  const emptyFinish = memoryTools(call);
  await emptyFinish.run({ command: 'recall', args: ['project'] }); await emptyFinish.run({ command: 'prompt', args: [] });
  assert.throws(() => emptyFinish.finish('{"result":"nothing-to-store","ids":[]}'), /turn-diary-required/);
  let extractionCount = 0, finalRound = 0, userAt = 0, diaryRound = 0;
  const largeJob = makeJob(digest('large-turn')); largeJob.messages[0].content = 'a'.repeat(270000);
  const segmented = await archiveTurn(largeJob, { call, signal: AbortSignal.timeout(20000), model: async (_o, messages, tools) => {
    if (!tools.length) { extractionCount++; return { role: 'assistant', content: '{"facts":[],"constraints":[]}' }; }
    const input = JSON.parse(messages[1].content); let command;
    if (finalRound++ === 0) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'recall', args: ['project'] }) };
    else if (finalRound === 2) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'prompt', args: [] }) };
    else if (userAt < input.userSources.length) { command = { name: 'respire_turn_evidence', arguments: JSON.stringify({ sources: input.userSources.slice(userAt, userAt += 4) }) }; }
    else if (diaryRound++ === 0) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'remember', args: ['助手在fixture主机核对分段回合原文。', '--importance', 'trivial'] }) };
    else if (diaryRound === 2) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'show', args: [diaryId] }) };
    else return { role: 'assistant', content: JSON.stringify({ result: 'stored', ids: [diaryId] }) };
    return { role: 'assistant', content: null, tool_calls: [{ id: 'large-' + finalRound, type: 'function', function: command }] };
  } });
  assert(extractionCount > 1); assert.equal(segmented.result, 'stored'); assert(segmented.checkedRecords.includes(diaryId));
  assert.equal(wholeDiaryReads, 0, 'Known current-turn diaries must use fragment readback, never whole-source show');
  generationRound = 0;
  const queuedCtx = { protocol: 'chat', origin: 'local', session: 'detached-worker', state: {}, signal: AbortSignal.timeout(20000),
    options: { ...o, runtimeUrl: o.url, maxBytes: 32768 } };
  reset();
  await onRequest({ messages: [{ role: 'user', content: '完成项目规则记录' }] }, queuedCtx);
  await onResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '已执行并验证' } }] }, { ...queuedCtx, success: true });
  const queuedName = 'job-' + queuedCtx.state.respire.key;
  let queued;
  for (let i = 0; i < 100; i++) { queued = await store.get(queuedName); if (['completed', 'unconfirmed'].includes(queued?.status)) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(queued?.status, 'completed', JSON.stringify({ status: queued?.status, error: queued?.error }));
  const scopedName = 'job-' + digest('scope-check');
  const scoped = makeJob(digest('scope-check')); scoped.o = { ...o, project: 'fixture-project' };
  await store.put('control-' + digest(account, o.url, scoped.o.project), { readOnly: false, archive: true, capture: false, updatedAt: acceptedAt, signature: controlSignature(scoped.o) });
  await store.put(scopedName, scoped);
  let scopeRound = 0;
  await processJob(store, scopedName, { model: async (_o, messages) => {
    const round = scopeRound++; let input;
    if (round === 0) input = { command: 'recall', args: ['project', '--project', 'other-project'] };
    else if (round === 1) {
      assert.equal(JSON.parse(messages.at(-1).content).error, 'project-override');
      input = { command: 'recall', args: ['project', '--project', 'fixture-project'] };
    } else if (round === 2) input = { command: 'remember', args: ['助手在fixture主机验证项目范围。', '--importance', 'trivial', '--project', 'fixture-project'] };
    else if (round === 3) input = { command: 'show', args: [diaryId] };
    else return { role: 'assistant', content: JSON.stringify({ result: 'stored', ids: [diaryId] }) };
    return { role: 'assistant', content: null, tool_calls: [{ id: 'scope-' + round, type: 'function', function: { name: 'respire_memory', arguments: JSON.stringify(input) } }] };
  } });
  assert.equal((await store.get(scopedName)).status, 'completed');
  generationRound = 0;
  const collision = makeJob(digest('session-collision')), collisionName = 'job-' + collision.source;
  await store.put(collisionName, collision);
  const releaseSession = await acquireLock(store.path('session-' + collision.sessionKey) + '.lock');
  let sessionReleased;
  await processJob(store, collisionName, { model: async (...args) => {
    const reply = await generate(...args);
    if (!reply.tool_calls?.length) sessionReleased = new Promise(resolve => setTimeout(async () => { await releaseSession(); resolve(); }, 100));
    return reply;
  } });
  await sessionReleased;
  assert.equal((await store.get(collisionName)).status, 'completed');
  generationRound = 0;
  const failedNotice = makeJob(digest('notification-failed')), failedNoticeName = 'job-' + failedNotice.source;
  class FailedNotificationStore extends Store {
    async change(name, fn) { if (name === 'session-' + failedNotice.sessionKey) throw Error('lock-busy'); return super.change(name, fn); }
  }
  const noticeStore = new FailedNotificationStore(stateDir); await noticeStore.put(failedNoticeName, failedNotice);
  await processJob(noticeStore, failedNoticeName);
  assert.equal((await noticeStore.get(failedNoticeName)).status, 'completed');
  assert.equal((await noticeStore.get(failedNoticeName)).notificationError, 'session-lock-busy');
  const expired = makeJob(digest('expired-control')); expired.createdAt = new Date(Date.now() - CONTROL_LEASE_MS - 1000).toISOString();
  const expiredName = 'job-' + expired.source; await store.put(expiredName, expired); let expiredCalls = 0;
  await processJob(store, expiredName, { model: async () => { expiredCalls++; throw Error('must-not-run'); } });
  assert.equal(expiredCalls, 0); assert.equal((await store.get(expiredName)).error, 'control-expired');
  assert.throws(() => checkControl(makeJob(digest('old-control')), { updatedAt: acceptedAt - 1, archive: true }), /control-expired/);
  assert.throws(() => checkControl(makeJob(digest('changed-config')), { updatedAt: Date.now(), archive: true, signature: 'different-configuration' }), /job-disabled/);
  const disabled = makeJob(digest('disabled-between-generations')), disabledName = 'job-' + disabled.source; await store.put(disabledName, disabled);
  let disabledCalls = 0;
  await processJob(store, disabledName, { model: async () => {
    disabledCalls++;
    await store.put('control-' + digest(account, o.url, o.project), { archive: false, capture: false, readOnly: false, updatedAt: Date.now(), signature: controlSignature({ ...o, archive: false }) });
    return { role: 'assistant', content: null, tool_calls: [{ id: 'disable-test', type: 'function', function: { name: 'respire_memory', arguments: JSON.stringify({ command: 'recall', args: ['project'] }) } }] };
  } });
  assert.equal(disabledCalls, 1); assert.equal((await store.get(disabledName)).error, 'job-disabled');
  await store.put('control-' + digest(account, o.url, o.project), { archive: true, capture: false, readOnly: false, updatedAt: Date.now(), signature: controlSignature(o) });
  const retention = new Store(join(scratch, 'retention')); const oldTime = new Date(Date.now() - 9 * 86400000);
  const oldTurn = 'turn-' + digest('expired-turn'), oldJob = 'job-' + digest('old-completed'), unknownJob = 'job-' + digest('old-unknown');
  for (const [name, value] of [[oldTurn, { phase: 'done', text: 'private turn' }], [oldJob, { status: 'completed', messages: ['private body'] }], [unknownJob, { status: 'unconfirmed', messages: ['private body'], writeAttempted: true }]]) {
    await retention.put(name, value); utimesSync(retention.path(name), oldTime, oldTime);
  }
  await retention.prune(); assert.equal(await retention.get(oldTurn), undefined); assert.equal(await retention.get(oldJob), undefined);
  assert.equal((await retention.get(unknownJob)).messages, undefined); assert.equal((await retention.get(unknownJob)).writeAttempted, true);
  const midJob = 'job-' + digest('two-day-receipt'), uncertainTurn = 'turn-' + digest('uncertain-turn');
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  await retention.put(midJob, { status: 'completed', finishedAt: twoDaysAgo.toISOString(), messages: ['private evidence'] }); utimesSync(retention.path(midJob), twoDaysAgo, twoDaysAgo);
  await retention.put(uncertainTurn, { phase: 'done', text: 'private recalled body', storage: { status: 'uncertain' } }); utimesSync(retention.path(uncertainTurn), oldTime, oldTime);
  await retention.prune(); assert.equal((await retention.get(midJob)).messages, undefined);
  assert.equal((await retention.get(uncertainTurn)).text, undefined); assert.equal((await retention.get(uncertainTurn)).storage.status, 'uncertain');
  await retention.prune(Date.now() + 6 * 86400000); assert.equal(await retention.get(midJob), undefined);
  const recoveredDir = join(scratch, 'recovery'); const recoveredStore = new Store(recoveredDir); await recoveredStore.key();
  writeFileSync(join(recoveredDir, 'worker.lock'), String(deadPid)); await runQueue(recoveredDir); assert(!existsSync(join(recoveredDir, 'worker.lock')));
  const capacity = new Store(join(scratch, 'capacity')); await capacity.key();
  const holdCapacity = await acquireLock(join(capacity.dir, 'worker.lock'));
  const capacityJob = makeJob(digest('capacity-next')); capacityJob.o = { ...o, stateDir: capacity.dir };
  await capacity.put('control-' + digest(account, o.url, o.project), { readOnly: false, archive: true, capture: false, updatedAt: Date.now(), signature: controlSignature(capacityJob.o) });
  for (let i = 0; i < 512; i++) await capacity.put('job-' + digest('completed', i), { status: 'completed' });
  const capacityChild = await enqueue(capacityJob); assert.equal((await capacity.get('job-' + capacityJob.source)).status, 'queued');
  if (capacityChild.exitCode === null) await new Promise(resolve => capacityChild.once('close', resolve));
  assert.equal(capacityChild.exitCode, 0);
  for (const key of await capacity.jobs()) if (key !== 'job-' + capacityJob.source) await capacity.put(key, { status: 'queued' });
  await assert.rejects(() => enqueue({ ...capacityJob, source: digest('capacity-overflow') }), /queue-capacity/);
  for (const key of await capacity.jobs()) unlinkSync(capacity.path(key));
  await holdCapacity();
  assert.equal((await call(['remember', 'pending-fixture-content'])).status, 'pending');
  const captureOptions = { ...o, archive: false, capture: true };
  for (const [label, text, expected] of [['short', '短回合🙂', 'completed'], ['large', 'x'.repeat(5000), 'unconfirmed']]) {
    const captureAcceptedAt = Date.now();
    await store.put('control-' + digest(account, o.url, ''), { readOnly: false, archive: false, capture: true, updatedAt: captureAcceptedAt, signature: controlSignature(captureOptions) });
    const captureSource = digest('strict-raw-capture', label), name = 'job-' + captureSource;
    await store.put(name, { ...makeJob(captureSource), o: captureOptions, createdAt: new Date(captureAcceptedAt).toISOString(), messages: [{ role: 'user', content: text }, { role: 'assistant', content: '收到' }] });
    await processJob(store, name);
    assert.equal((await store.get(name)).status, expected);
    const beforeReplay = writes; await processJob(store, name); assert.equal(writes, beforeReplay);
  }
  assert.equal(wholeDiaryReads, 0);
  console.log('Detached worker check passed: gateway completion -> encrypted queue -> child process -> model tools -> readback.');
  console.log('Archive checks passed: real HTTP model tool loop, readback, encrypted persistence, unknown-write no-retry, read-only, tool restrictions and source-checked segmentation.');
  console.log('Review regressions passed: stale/live locks, receipts, capacity, retention, leases, stable history, four-protocol policy dedup/change/revert and neutral user agents.');
} finally {
  await new Promise(resolve => server.close(resolve));
  for (let i = 0; i < 100 && existsSync(join(scratch, 'state', 'worker.lock')); i++) await new Promise(r => setTimeout(r, 25));
  rmSync(scratch, { recursive: true, maxRetries: 2, retryDelay: 25 });
}
console.log('Package checks passed: protocol recall, cache, caller boundary, URL and icon assets.');

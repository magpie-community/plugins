import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { onRequest, onResponse, reset } from '../respire.hooks.mjs';
import { options, hasSecret } from '../runtime.mjs';
import { Store, digest, accountIdentity } from '../state.mjs';
import { processJob } from '../worker.mjs';
import { rpc } from '../runtime.mjs';
import { memoryTools } from '../memory-tools.mjs';
import { prepareArchiveContext, readEvidence, parseExtraction } from '../archive-context.mjs';
import { archiveTurn } from '../archive.mjs';
for (const file of [...readdirSync('.').filter(f => f.endsWith('.mjs')), 'page/settings.js']) execFileSync(process.versions.bun ? 'node' : process.execPath, ['--check', file]);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.deepEqual(Buffer.from(pkg.magpie.icon.split(',')[1], 'base64'), readFileSync(pkg.magpie.page.icon));
for (const path of pkg.files) assert(existsSync(path), path);
for (const runtimeUrl of ['http://example.com', 'http://u:x@127.0.0.1', 'http://127.0.0.1/path']) assert.throws(() => options({ runtimeUrl }));
assert(hasSecret({ content: '{"api_key":"fixture-secret"}' }));
assert(hasSecret({ tool: { PGPASSWORD: 'fixture-secret' } }));
const id = '11111111-1111-4111-8111-111111111111';
let calls = 0;
let generationRound = 0, unknownWrite = false, writes = 0;
const savedId = '22222222-2222-4222-8222-222222222222';
const entries = new Map([[id, { id, title: 'Example', content: 'Historical evidence', project: '' }]]);
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const r = JSON.parse(body); calls++;
  if (req.url === '/v1/chat/completions') {
    const actions = [ ['recall', ['project']], ['prompt', []], ['agent-config', []], ['show', [id]],
      ['remember', ['【前因】用户明确项目约定。【行为】实际采用规则。【后果】保留规则。', '--title', '项目已明确采用现有验证规则', '--importance', 'important', '--parent', id]], ['show', [savedId]] ];
    const action = actions[generationRound++];
    const message = action ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool-' + generationRound, type: 'function', function: { name: 'respire_memory', arguments: JSON.stringify({ command: action[0], args: action[1] }) } }] }
      : { role: 'assistant', content: JSON.stringify({ result: 'stored', ids: [savedId] }) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: action ? 'tool_calls' : 'stop', message }] })); return;
  }
  assert(r.queue_wait_ms > 0);
  const command = r.args[1];
  const envelope = { status: 'ok', summary: command === 'status' ? { data_dir: 'fixture', unlocked: true, session: { has_session: true, user: 'fixture', addr: 'fixture' } }
    : command === 'agent-config' ? { readonly: false, memory_off: false, workspace_mode: 'normal' } : {},
    details: command === 'recall' ? [{ id }] : command === 'prompt' ? 'Complete fixture policy' : { entry: entries.get(r.args[2]) ?? entries.get(id) } };
  if (command === 'show') envelope.summary.id = r.args[2];
  if (command === 'remember') {
    if (r.args[2] === 'pending-fixture-content') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: 1, id: r.id, ok: false, exit: 2, envelope: { status: 'pending', summary: {}, items: [] } })); return;
    }
    writes++; entries.set(savedId, { id: savedId, title: 'Saved', content: r.args[2], project: '' }); envelope.summary.id = savedId;
    if (unknownWrite) { res.destroy(); return; }
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ v: 1, id: r.id, ok: true, exit: 0, envelope }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  mkdirSync('.verification', { recursive: true });
  const stateDir = mkdtempSync(resolve('.verification/check-'));
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    reset(); const ctx = { protocol, origin: 'local', session: 'check', state: {}, signal: AbortSignal.timeout(5000), options: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, stateDir, maxBytes: 32768, capture: false } };
    const body = protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'project question' }] }] } : protocol === 'responses' ? { input: 'project question' } : { messages: [{ role: 'user', content: 'project question' }] };
    const before = structuredClone(body); const result = await onRequest(body, ctx);
    assert(JSON.stringify(result).includes('Historical evidence')); assert.deepEqual(body, before);
    const count = calls; await onRequest(body, ctx); assert.equal(calls, count + 1);
    assert.equal(await onRequest(body, { ...ctx, origin: 'gateway-key' }), undefined);
  }
  const o = options({ stateDir, runtimeUrl: `http://127.0.0.1:${server.address().port}`, archive: true,
    generationBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, generationModel: 'fixture', authorizationEnv: 'RESPIRE_MAGPIE_FIXTURE_KEY' });
  const store = new Store(stateDir), signal = AbortSignal.timeout(20000), call = args => rpc(o, args, signal);
  const account = await accountIdentity(o, call);
  await store.put('control-' + digest(account, o.url, o.project), { readOnly: false, archive: true, capture: false });
  const makeJob = source => ({ source, sessionKey: digest('session', source), account, o, status: 'queued', writeAttempted: false,
    messages: [{ role: 'user', content: '项目已采用验证规则' }, { role: 'assistant', content: '已实施并验证。' }] });
  const source = digest('archive-success'); await store.put('job-' + source, makeJob(source));
  await processJob(store, 'job-' + source);
  const done = await store.get('job-' + source);
  assert.equal(done.status, 'completed', JSON.stringify({ error: done.error, progress: done.progress }));
  assert(done.result.checkedRecords.includes(savedId)); assert.equal(writes, 1); assert(entries.get(savedId).content.includes(source));
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
  const large = prepareArchiveContext([{ type: 'userMessage', content: [{ text: 'a'.repeat(270000) }] }]);
  assert(large.chunks.length > 1); assert.equal(readEvidence(large.fragments, [large.userSources[0]])[0].text.length, 6000);
  assert.throws(() => parseExtraction(JSON.stringify({ facts: [{ text: 'x', status: 'confirmed', sources: ['invented'] }], constraints: [] }), large.fragments));
  let extractionCount = 0, finalRound = 0, userAt = 0;
  const largeJob = makeJob(digest('large-turn')); largeJob.messages[0].content = 'a'.repeat(270000);
  const segmented = await archiveTurn(largeJob, { call, signal, model: async (_o, messages, tools) => {
    if (!tools.length) { extractionCount++; return { role: 'assistant', content: '{"facts":[],"constraints":[]}' }; }
    const input = JSON.parse(messages[1].content); let command;
    if (finalRound++ === 0) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'recall', args: ['project'] }) };
    else if (finalRound === 2) command = { name: 'respire_memory', arguments: JSON.stringify({ command: 'prompt', args: [] }) };
    else if (userAt < input.userSources.length) { command = { name: 'respire_turn_evidence', arguments: JSON.stringify({ sources: input.userSources.slice(userAt, userAt += 4) }) }; }
    else return { role: 'assistant', content: '{"result":"nothing-to-store","ids":[]}' };
    return { role: 'assistant', content: null, tool_calls: [{ id: 'large-' + finalRound, type: 'function', function: command }] };
  } });
  assert(extractionCount > 1); assert.equal(segmented.result, 'nothing-to-store');
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
  assert.equal((await call(['remember', 'pending-fixture-content'])).status, 'pending');
  console.log('Detached worker check passed: gateway completion -> encrypted queue -> child process -> model tools -> readback.');
  console.log('Archive checks passed: real HTTP model tool loop, readback, encrypted persistence, unknown-write no-retry, read-only, tool restrictions and source-checked segmentation.');
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('Package checks passed: protocol recall, cache, caller boundary, URL and icon assets.');

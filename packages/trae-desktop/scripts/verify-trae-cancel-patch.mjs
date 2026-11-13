import test from 'node:test';
import assert from 'node:assert/strict';
import { originalSource, patchSource } from './trae-cancel-patch.mjs';

const original = originalSource(), patched = patchSource(original);
const extract = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const statuses = { Running: 3, Stopped: 4, Finished: 5, Failed: 6, Creating: 1, Waiting: 7, Pending: 8 };
const log = { logger: { info() {}, warn() {}, error() {}, debug() {} } };
function statusFixture(source) {
  const timers = [], updates = [];
  let streaming = true, status = 1, subscription = { status: 'active' }, reads = 0;
  const method = extract(source, 'handleStatusConflictWithStreaming(e,t,r){', 'tryFinalizeStreamOnFailed(e){');
  const instance = new Function('s', 'd', 'C', 'y', 'x', 'setTimeout', `return {${method}}`)(
    { Ph: statuses }, log, 'fixture', { o3() {} }, () => ({ chat: { getSession: async () => { reads++; return { code: 0, data: { status: 6 } }; } } }),
    callback => timers.push(callback));
  Object.assign(instance, { eventOwnerGeneration: 1,
    streamService: { isStreaming: () => streaming },
    streamStore: { subscription: { get: () => subscription } },
    chatSessionService: { isAutoRetryInProgress: () => false },
    sessionStore: { sessionStatus: { get: () => status }, sessionById: { get: () => ({ env: 'local' }) },
      core: { update: (_id, patch) => { updates.push(patch.status); status = patch.status; } } } });
  return { instance, updates, run: () => timers.shift()(), reads: () => reads,
    finish: () => { streaming = false; status = 4; subscription = { status: 'completed' }; },
    nextTurn: () => { streaming = true; subscription = { status: 'active' }; } };
}

test('original code reproduces delayed Running overwriting a terminal status', async () => {
  const f = statusFixture(original); f.instance.handleStatusConflictWithStreaming('fixture', 3, 1);
  f.finish(); await f.run(); assert.deepEqual(f.updates, [3]);
});
test('fixed code ignores the obsolete update after stream completion', async () => {
  const f = statusFixture(patched); f.instance.handleStatusConflictWithStreaming('fixture', 3, 1);
  f.finish(); await f.run(); assert.deepEqual(f.updates, []);
});
test('an old turn cannot change a replacement subscription', async () => {
  const f = statusFixture(patched); f.instance.handleStatusConflictWithStreaming('fixture', 3, 1);
  f.nextTurn(); await f.run(); assert.equal(f.reads(), 0); assert.deepEqual(f.updates, []);
});
test('a current streaming subscription still reconciles with the backend', async () => {
  const f = statusFixture(patched); f.instance.handleStatusConflictWithStreaming('fixture', 3, 1);
  await f.run(); assert.equal(f.reads(), 1); assert.deepEqual(f.updates, [6]);
});
for (const streaming of [false, true]) test(`successful stop reconciles only without an active stream: ${streaming}`, async () => {
  const method = extract(patched, 'async stopSession(e,t){', 'async waitForSessionStopped(e,');
  const instance = new Function('f', 'u', 'v', 'setTimeout', 'clearTimeout', `return {${method}}`)(
    { Ph: statuses }, log, { Po: { StopButton: 'stop_button' } }, () => 1, () => {});
  let status = 3, refreshed = 0, cleared = 0;
  Object.assign(instance, { cancelAutoRetry() {},
    sessionStore: { sessionStatus: { get: () => status }, lastUserMessage: { get: () => ({ messageId: 'fixture-user' }) } },
    streamStore: { core: { clearPendingCancelReason: () => cleared++ } },
    streamService: { requestStop: () => { status = 10; }, isStreaming: () => streaming },
    chatApi: { stopSession: async () => ({ code: 0 }) },
    refreshSession: async () => { refreshed++; status = 6; } });
  assert.equal((await instance.stopSession('fixture')).success, true);
  assert.equal(refreshed, streaming ? 0 : 1); assert.equal(cleared, streaming ? 0 : 1);
  assert.equal(status, streaming ? 10 : 6);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyForward, forwardRecord, planForward, publishedFor, removeForward, serveState, targetFor,
} from '../lib/forward.mjs';
import { mockTailscale } from './helpers.mjs';

const PUBLISHED = 3498;
const PHONE = 3499;

test('the forwarding of another service on the same port is not touched', () => {
  const mock = mockTailscale();
  mock.serve.TCP[String(PUBLISHED)] = { TCPForward: '127.0.0.1:1234' };
  const plan = planForward(PUBLISHED, PHONE, { data: mock.serve });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /已经有别的转发/);
  assert.equal(plan.commands, undefined);
});

test('the forwarding of the phone is made when there is none', async () => {
  const mock = mockTailscale();
  const answer = await applyForward(PUBLISHED, PHONE, mock.runner);
  assert.equal(answer.ok, true);
  assert.equal(mock.serve.TCP[String(PUBLISHED)].TCPForward, targetFor(PHONE));
});

test('a forwarding that already is right is left alone', async () => {
  const mock = mockTailscale();
  mock.serve.TCP[String(PUBLISHED)] = { TCPForward: targetFor(PHONE) };
  const plan = planForward(PUBLISHED, PHONE, { data: mock.serve });
  assert.deepEqual(plan.commands, []);
  const answer = await applyForward(PUBLISHED, PHONE, mock.runner);
  assert.equal(answer.ok, true);
  // Nothing was run at all.
  assert.equal(mock.calls.filter(call => call.startsWith('serve --bg')).length, 0);
});

test('the forwarding of an older version is moved to the phone side', async () => {
  const mock = mockTailscale();
  // The old version pointed the published port at the console of this
  // computer.
  mock.serve.TCP[String(PUBLISHED)] = { TCPForward: targetFor(PUBLISHED) };
  const answer = await applyForward(PUBLISHED, PHONE, mock.runner);
  assert.equal(answer.ok, true);
  assert.equal(answer.legacy, true);
  assert.equal(mock.serve.TCP[String(PUBLISHED)].TCPForward, targetFor(PHONE));
});

test('the forwarding is found again after a restart and is not made twice', async () => {
  const mock = mockTailscale();
  await applyForward(PUBLISHED, PHONE, mock.runner);
  const first = mock.calls.filter(call => call.startsWith('serve --bg')).length;
  assert.equal(first, 1);
  // The plugin starts again and finds the forwarding it made before.
  const answer = await applyForward(PUBLISHED, PHONE, mock.runner);
  assert.equal(answer.ok, true);
  assert.equal(mock.calls.filter(call => call.startsWith('serve --bg')).length, first);
});

test('a forwarding that was made by hand is taken over and written down', () => {
  const mock = mockTailscale();
  mock.serve.TCP[String(PUBLISHED)] = { TCPForward: targetFor(PHONE) };
  const plan = planForward(PUBLISHED, PHONE, { data: mock.serve }, null);
  assert.equal(plan.adopted, true);
  const record = forwardRecord(PUBLISHED, PHONE, { legacy: plan.legacy });
  assert.equal(record.target, targetFor(PHONE));
  assert.equal(record.publishedPort, PUBLISHED);
});

test('only the forwarding of the plugin is removed', async () => {
  const mock = mockTailscale();
  // Another service has its own forwarding on another port.
  mock.serve.TCP['9999'] = { TCPForward: '127.0.0.1:9999' };
  await applyForward(PUBLISHED, PHONE, mock.runner);
  const record = forwardRecord(PUBLISHED, PHONE);
  const answer = await removeForward(PUBLISHED, PHONE, mock.runner, record);
  assert.equal(answer.ok, true);
  assert.equal(mock.serve.TCP[String(PUBLISHED)], undefined);
  // The forwarding of the other service is still there.
  assert.deepEqual(mock.serve.TCP['9999'], { TCPForward: '127.0.0.1:9999' });
});

test('a forwarding that was never written down is not removed', async () => {
  const mock = mockTailscale();
  await applyForward(PUBLISHED, PHONE, mock.runner);
  const answer = await removeForward(PUBLISHED, PHONE, mock.runner, null);
  assert.equal(answer.ok, false);
  // The forwarding is still there.
  assert.equal(mock.serve.TCP[String(PUBLISHED)].TCPForward, targetFor(PHONE));
});

test('a forwarding that points somewhere else is not removed', async () => {
  const mock = mockTailscale();
  await applyForward(PUBLISHED, PHONE, mock.runner);
  // Somebody changed the forwarding by hand in the meantime.
  mock.serve.TCP[String(PUBLISHED)] = { TCPForward: '127.0.0.1:4321' };
  const record = forwardRecord(PUBLISHED, PHONE);
  const answer = await removeForward(PUBLISHED, PHONE, mock.runner, record);
  assert.equal(answer.ok, false);
  assert.deepEqual(mock.serve.TCP[String(PUBLISHED)], { TCPForward: '127.0.0.1:4321' });
});

test('the status of the forwarding is read from the mock of the command', async () => {
  const mock = mockTailscale();
  mock.serve.TCP['3498'] = { TCPForward: '127.0.0.1:3499' };
  const status = await serveState(mock.runner);
  assert.equal(status.ok, true);
  assert.equal(publishedFor(status, 3498).TCPForward, '127.0.0.1:3499');
  assert.equal(publishedFor(status, 3499), null);
});

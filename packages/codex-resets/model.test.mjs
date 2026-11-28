import { test } from 'node:test';
import assert from 'node:assert/strict';
import M from './page/model.js';
const NOW = Date.parse('2026-10-23T08:00:00Z');
function fixture(type = 'regular') {
  return {
    meta: { api_version: 'v1', generated_at: '2026-10-23T08:00:00Z' },
    data: {
      scheduled_reset: {
        id: '123456789', status: 'scheduled', reset_type: type,
        announced_at: '2026-10-23T07:00:00Z', scheduled_for: '2026-10-23T10:00:00Z',
        source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/123456789' },
      },
      latest_reset: null, active_watch: null,
    },
  };
}
test('an announced global reset retains its source and explicit time', () => {
  const s = M.parse(fixture(), NOW);
  assert.equal(s.announcement?.scheduledFor, '2026-10-23T10:00:00.000Z');
  assert.equal(s.announcement?.url, 'https://x.com/thsottiaux/status/123456789');
});
test('a credit grant is not a global reset announcement', () => {
  const s = M.parse(fixture('banked'), NOW);
  assert.equal(s.announcement, null);
  assert.equal(s.grant?.id, '123456789');
});
export { NOW, fixture };

test('unknown, stale, failed and future-dated saved data never shows current announcements', () => {
  assert.equal(M.view(null, NOW).state, 'empty');
  const record = { version: 1, checkedAt: new Date(NOW).toISOString(), payload: fixture() };
  assert.equal(M.view(record, NOW).state, 'ready');
  for (const r of [ {}, { ...record, error: 'offline' }, { ...record, checkedAt: 'bad' },
    { ...record, checkedAt: new Date(NOW + 6 * 60e3).toISOString() },
    { ...record, checkedAt: new Date(NOW - M.FRESH - 1).toISOString() } ]) {
    assert.equal(M.view(r, NOW).state, 'unavailable');
    assert.equal(M.view(r, NOW).announcement, null);
  }
  assert.equal(M.view(record, NOW + M.FRESH + 1).state, 'unavailable');
});

test('forecasts in old snapshots are ignored, including malformed or absent forecast fields', () => {
  for (const watch of [undefined, null, { reset_chance_percent: 75 }, 'invalid']) {
    const f = fixture();
    if (watch === undefined) delete f.data.active_watch;
    else f.data.active_watch = watch;
    const result = M.parse(f, NOW);
    assert.ok(result.announcement);
    assert.equal(Object.hasOwn(result, 'forecast'), false);
    assert.equal(Object.hasOwn(M.view({ version: 1, checkedAt: new Date(NOW).toISOString(), payload: f }, NOW), 'forecast'), false);
  }
});

test('missing fields and stale upstream responses are errors, not no-announcement results', () => {
  for (const field of ['scheduled_reset', 'latest_reset']) {
    const f = fixture(); delete f.data[field]; assert.throws(() => M.parse(f, NOW));
  }
  for (const generated of ['garbage', '2026-10-23T07:44:59Z', '2026-10-23T08:06:00Z', '2026-10-23T08:00:00']) {
    const f = fixture(); f.meta.generated_at = generated; assert.throws(() => M.parse(f, NOW));
  }
  const f = fixture(); f.data.scheduled_reset = null;
  assert.deepEqual(M.parse(f, NOW), { announcement: null, grant: null, latest: null });
});

test('source validation rejects spoofed authors, destinations and mismatched IDs', () => {
  for (const url of ['javascript:alert(1)', 'https://x.com.evil.test/thsottiaux/status/123456789',
    'https://x.com@evil.test/thsottiaux/status/123456789', 'https://x.com/other/status/123456789',
    'https://x.com/thsottiaux/status/123456789?redirect=evil', 'https://x.com/thsottiaux/status/987']) {
    const f = fixture(); f.data.scheduled_reset.source.url = url; assert.throws(() => M.parse(f, NOW));
  }
  const f = fixture(); f.data.scheduled_reset.source.author = 'other'; assert.throws(() => M.parse(f, NOW));
});

test('passing a scheduled time never fabricates a completed reset', () => {
  const f = fixture(); f.data.scheduled_reset.scheduled_for = '2026-10-23T07:59:00Z';
  const s = M.parse(f, NOW);
  assert.ok(s.announcement); assert.equal(s.latest, null);
});

test('a stale scheduled announcement makes the snapshot unavailable rather than claiming no announcement', () => {
  const f = fixture(); f.data.scheduled_reset.announced_at = '2026-10-21T07:59:59Z';
  assert.throws(() => M.parse(f, NOW));
  assert.equal(M.view({ version: 1, checkedAt: new Date(NOW).toISOString(), payload: f }, NOW).state, 'unavailable');
});

// Port of the prototype's public-data rules. Both the page and sync module
// validate data; a saved option or source response never becomes executable HTML.
(function (root) {
  'use strict';
  const FRESH = 15 * 60e3, SKEW = 5 * 60e3, MAX_AGE = 48 * 3600e3;
  const own = (v, k) => v && Object.prototype.hasOwnProperty.call(v, k);
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function fail() { throw new Error('Invalid or out-of-date public status'); }
  function time(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)) fail();
    const n = Date.parse(v);
    if (!Number.isFinite(n)) fail();
    return n;
  }
  function sourceURL(v) {
    if (typeof v !== 'string') return '';
    return /^https:\/\/(?:x\.com|twitter\.com)\/thsottiaux\/status\/\d+$/.test(v) ? v : '';
  }
  function source(v) {
    if (!object(v) || (v.type !== 'observed' && (v.type !== 'x_post' || v.author !== 'thsottiaux'))) fail();
    if (!v.url && v.type === 'observed') return '';
    const url = sourceURL(v.url);
    if (!url) fail();
    return url;
  }
  function parse(wire, now = Date.now()) {
    if (!object(wire) || !object(wire.data) || wire.meta?.api_version !== 'v1') fail();
    const generated = time(wire.meta.generated_at);
    if (now - generated > FRESH || generated - now > SKEW) fail();
    const d = wire.data;
    if (!['scheduled_reset', 'latest_reset'].every(k => own(d, k))) fail();
    const out = { announcement: null, grant: null, latest: null };
    if (d.scheduled_reset !== null) {
      const a = d.scheduled_reset;
      if (!object(a) || a.status !== 'scheduled' || !['regular', 'banked'].includes(a.reset_type)
          || typeof a.id !== 'string' || !/^\d{1,64}$/.test(a.id)) fail();
      const announced = time(a.announced_at), scheduled = a.scheduled_for == null ? null : time(a.scheduled_for);
      const url = source(a.source);
      if (announced > now + SKEW || (scheduled !== null && scheduled < announced)
          || a.source.type !== 'x_post' || !url.endsWith('/' + a.id)) fail();
      // An old scheduled entry is unverifiable, not evidence of no announcement.
      if (now - announced > MAX_AGE) fail();
      out[a.reset_type === 'banked' ? 'grant' : 'announcement'] = {
        id: a.id, announcedAt: new Date(announced).toISOString(),
        scheduledFor: scheduled === null ? null : new Date(scheduled).toISOString(), url,
      };
    }
    if (d.latest_reset !== null) {
      const e = d.latest_reset;
      if (!object(e) || typeof e.id !== 'string' || !e.id || e.id.length > 64 || !['regular', 'banked'].includes(e.reset_type)) fail();
      const at = time(e.announced_at);
      if (at > now + SKEW) fail();
      out.latest = { type: e.reset_type, at: new Date(at).toISOString(), url: source(e.source) };
    }
    return out;
  }
  function view(record, now = Date.now()) {
    const unknown = { state: 'unavailable', announcement: null, grant: null, latest: null, checkedAt: null };
    if (!record) return { ...unknown, state: 'empty' };
    try {
      const checked = time(record.checkedAt);
      if (record.version !== 1 || record.error || now - checked > FRESH || checked - now > SKEW) return unknown;
      const data = parse(record.payload, now);
      return { ...data, state: 'ready', checkedAt: record.checkedAt };
    } catch { return unknown; }
  }
  const api = { parse, view, sourceURL, FRESH };
  if (typeof module !== 'undefined') module.exports = api;
  else root.CodexResetModel = api;
})(globalThis);

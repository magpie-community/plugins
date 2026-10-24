(async () => {
  'use strict';
  const M = globalThis.CodexResetModel, $ = id => document.getElementById(id);
  let lang = 'en', record = null, loading = false, first = true;
  const t = (key, values = {}) => String(globalThis.CodexResetWords(lang)[key]).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
  const locale = () => lang === 'zh' ? 'zh-CN' : lang;
  const date = (at, full = false) => new Intl.DateTimeFormat(locale(), full
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  const rows = {};
  for (const key of ['sourceWebsite', 'sourceReset', 'sourceForecast', 'sourceGrant', 'sourceLatest']) {
    const row = document.createElement('div'); row.className = 'source-row';
    const label = document.createElement('label'); label.htmlFor = key;
    const input = document.createElement('input'); input.id = key; input.readOnly = true; input.type = 'text'; input.spellcheck = false;
    const button = document.createElement('button'); button.type = 'button';
    button.addEventListener('click', () => { input.focus(); input.select(); });
    row.append(label, input, button); $('sourceFields').append(row); rows[key] = { row, label, input, button };
  }
  function source(key, url) {
    const r = rows[key];
    r.row.hidden = !url; r.label.textContent = t(key); r.input.value = url || '';
    r.button.textContent = t('select'); r.button.setAttribute('aria-label', `${t('select')} · ${t(key)}`);
  }
  function paint() {
    document.querySelectorAll('[data-t]').forEach(e => { e.textContent = t(e.dataset.t); });
    document.title = t('title'); $('overview').setAttribute('aria-label', t('title'));
    const s = M.view(record), ready = s.state === 'ready', a = s.announcement, w = s.forecast, g = s.grant, latest = s.latest;
    const future = a?.scheduledFor && Date.parse(a.scheduledFor) > Date.now();
    $('overview').hidden = !ready; $('empty').hidden = ready;
    $('status').textContent = ready ? t('updated', { when: date(s.checkedAt, true) }) : t('unknown');
    $('emptyTitle').textContent = t(s.state === 'empty' ? 'emptyTitle' : 'unavailableTitle');
    $('emptyText').textContent = t(s.state === 'empty' ? 'emptyText' : 'unavailableText');
    if (first && s.state === 'empty') $('setup').open = true;
    first = false;
    $('resetValue').textContent = !a ? t('noAnnouncement') : !a.scheduledFor ? t('timeUnknown') : future ? date(a.scheduledFor) : t('pending');
    $('resetValue').title = a?.scheduledFor ? new Date(a.scheduledFor).toLocaleString(locale(), { timeZoneName: 'short' }) : '';
    $('resetNote').textContent = a ? t('checkAccount') : t('noScheduled');
    $('forecastValue').textContent = !w ? t('noForecast') : w.percent === null ? t('noProbability') : `${w.percent}%`;
    $('grantValue').textContent = t(g ? 'grantAnnounced' : latest?.type === 'banked' ? 'grantReported' : 'noGrant');
    $('grantNote').textContent = g ? g.scheduledFor ? t('grantAt', { when: date(g.scheduledFor) }) : t('grantNoTime')
      : latest?.type === 'banked' ? t('grantPast', { when: date(latest.at) }) : t('creditNote');
    $('advisory').hidden = !a || (!!a.scheduledFor && !future);
    const facts = [];
    const fact = text => { const p = document.createElement('p'); p.textContent = text; facts.push(p); };
    if (a) fact(a.scheduledFor ? t('announcementAt', { when: date(a.scheduledFor, true) }) : t('announcementNoTime'));
    if (w) {
      if (w.window) fact(t('forecastWindow', { window: w.window }));
      fact(t('forecastUntil', { when: date(w.expiresAt, true) }));
    }
    if (latest) fact(t(latest.type === 'banked' ? 'latestGrant' : 'latestReset', { when: date(latest.at, true) }));
    $('facts').replaceChildren(...facts);
    source('sourceWebsite', 'https://codex-resets.com'); source('sourceReset', a?.url); source('sourceForecast', w?.url);
    source('sourceGrant', g?.url); source('sourceLatest', latest?.url);
  }
  async function load() {
    if (loading) return;
    loading = true; $('reload').disabled = true;
    try { record = (await magpie.options.get())?.codexResets ?? null; }
    catch { record = {}; }
    finally { loading = false; $('reload').disabled = false; paint(); }
  }
  $('reload').addEventListener('click', load);
  // The host's sandbox forbids popups. Keep the backlink for attribution,
  // and offer a selectable address instead of pretending to open a new tab.
  $('attribution').addEventListener('click', event => {
    event.preventDefault(); $('details').open = true;
    rows.sourceWebsite.input.focus(); rows.sourceWebsite.input.select();
  });
  try { lang = (await magpie.ready)?.lang || 'en'; }
  catch { record = {}; paint(); return; }
  magpie.onTheme(theme => { lang = theme.lang || 'en'; paint(); });
  await load();
  setInterval(load, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();

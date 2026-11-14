const $ = id => document.getElementById(id);
// The token stays on this phone. Safari forgets a session when the tab is
// closed, and the page is opened from the widget days later — asking for the
// token every time was the wrong kind of careful. localStorage keeps it
// until 「断开」 is pressed; a browser that refuses it falls back to the
// session, which is the old behaviour.
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { /* A browser that refuses it. */ }
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); return; } catch { /* A browser that refuses it. */ }
    try { sessionStorage.setItem(key, value); } catch { /* Nothing to do. */ }
  },
  drop(key) {
    try { localStorage.removeItem(key); } catch { /* Nothing to do. */ }
    try { sessionStorage.removeItem(key); } catch { /* Nothing to do. */ }
  },
};
const savedTheme = store.get('usage-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' || !document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  store.set('usage-theme', theme);
});
const compact = value => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const exact = value => new Intl.NumberFormat('en').format(value);
const money = value => value == null ? '—' : value >= 100 ? value.toFixed(0) : value.toFixed(2);
const time = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '未知';
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
// The token is remembered for a while, not forever: it is a long-lived
// credential and every script on that address can read the storage. Thirty
// days is long enough for a daily look and short enough to be forgotten.
// Tapping the widget brings the token again anyway.
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const remember = value => store.set('usage-token', JSON.stringify({ token: value, at: Date.now() }));
const recall = () => {
  try {
    const saved = JSON.parse(store.get('usage-token'));
    if (saved && typeof saved.token === 'string') {
      if (Date.now() - Number(saved.at || 0) < REMEMBER_MS) return saved.token;
      // Past the window it is not only ignored, it is dropped: an old token
      // should not stay readable in the storage.
      store.drop('usage-token');
    }
  } catch { /* Nothing stored, or something that is not ours. */ }
  return null;
};
if (token) remember(token);
token ||= recall();
let last;
try { last = JSON.parse(store.get('usage-overview')); } catch { /* No cached response. */ }
// Percent direction and ranking tab are per-device viewing choices,
// not changes to what the service projects.
let quotaMode = store.get('usage-quota-mode') === 'used' ? 'used' : 'remaining';
const RANKING_TABS = ['models', 'providers', 'agents', 'computers'];
let rankTab = RANKING_TABS.includes(store.get('usage-ranking')) ? store.get('usage-ranking') : 'models';
function syncQuotaToggle() {
  for (const mode of ['remaining', 'used']) {
    const button = $('mode-' + mode);
    button.classList.toggle('active', quotaMode === mode);
    button.setAttribute('aria-pressed', String(quotaMode === mode));
  }
}
function syncRankTabs() {
  for (const id of RANKING_TABS) {
    const button = $('tab-' + id);
    button.classList.toggle('active', rankTab === id);
    button.setAttribute('aria-pressed', String(rankTab === id));
  }
}
for (const mode of ['remaining', 'used']) $('mode-' + mode).addEventListener('click', () => {
  quotaMode = mode;
  store.set('usage-quota-mode', mode);
  syncQuotaToggle();
  if (last) renderQuotas(last.subscriptions);
});
for (const id of RANKING_TABS) $('tab-' + id).addEventListener('click', () => {
  rankTab = id;
  store.set('usage-ranking', id);
  syncRankTabs();
  if (last) renderRankings(last);
});
syncQuotaToggle();
syncRankTabs();
function resetLabel(window) {
  if (window.expired) return '窗口已到期· 等待更新';
  if (!window.resetsAt) return '重置时间未提供';
  const minutes = Math.ceil((Date.parse(window.resetsAt) - Date.now()) / 60000);
  if (minutes <= 0) return '窗口已到期· 等待更新';
  const duration = minutes < 60 ? minutes + ' 分钟' : minutes < 1440 ? Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分钟' : Math.floor(minutes / 1440) + ' 天 ' + Math.floor(minutes % 1440 / 60) + ' 小时';
  return duration + '后重置';
}
function windowName(name) {
  const suffix = quotaMode === 'used' ? '已用' : '剩余';
  return /5\s*h|5\s*hour/i.test(name) ? '5 小时' + suffix : /7\s*d|7\s*day|week/i.test(name) ? '本周' + suffix : name + suffix;
}
function progress(value, className, label) {
  const bar = node('progress', className);
  bar.max = 100;
  bar.value = value || 0;
  bar.setAttribute('aria-label', (label || '剩余') + ' ' + (value == null ? '未知' : Math.round(value) + '%'));
  return bar;
}
function quotaValue(window) {
  return window.expired ? null : quotaMode === 'used' ? window.usedPercent : window.remainingPercent;
}
function quotaState(value) {
  if (value == null) return '';
  const consumed = quotaMode === 'used' ? value : 100 - value;
  return consumed >= 90 ? 'critical' : consumed >= 75 ? 'low' : '';
}
function renderQuotas(cards) {
  const parent = $('quotas'); parent.replaceChildren();
  if (!cards.length) { parent.append(node('div', 'empty panel', '尚未读取到有效套餐。请确认 Magpie 已登录订阅并更新额度。')); return; }
  for (const card of cards) {
    const article = node('article', 'panel quota-card');
    const heading = node('div', 'provider-heading');
    heading.append(node('span', 'provider-monogram', card.label[0]), node('span', 'provider-name', card.label), node('span', 'tag', card.plan));
    article.append(heading);
    const windows = node('div', 'windows');
    card.windows.forEach((window, i) => {
      const value = quotaValue(window);
      const state = quotaState(value);
      const block = node('div', 'window ' + (i ? '' : 'primary ') + state);
      const row = node('div', 'window-heading');
      const valueNode = node('span', 'window-value', value == null ? '—' : String(Math.round(value)));
      if (value != null) valueNode.append(node('small', '', '%'));
      row.append(node('span', 'window-name', windowName(window.label)), valueNode);
      block.append(row, progress(value, state, quotaMode === 'used' ? '已用' : '剩余'), node('p', 'window-reset', resetLabel(window)));
      if (window.amount != null && window.limit != null) {
        block.append(node('p', 'window-amount', '读数 ' + compact(window.amount) + ' / ' + compact(window.limit)));
      }
      windows.append(block);
    });
    article.append(windows);
    if (!card.windows.length) article.append(node('p', 'fine-print', '此套餐未提供额度窗口'));
    if (card.usage && card.usage.today) {
      const today = card.usage.today;
      const line = '今日 ' + compact(today.totalTokens) + ' Token';
      const detail = Number.isFinite(today.requests) ? ' · ' + today.requests + ' 次请求' : '';
      article.append(node('p', 'fine-print', line + detail + (card.usageStale ? ' · 缓存读数' : '')));
    } else {
      // The usage of this subscription is unknown; the total of all is never
      // shown in its place.
      article.append(node('p', 'fine-print', '今日用量未知'));
    }
    if (card.stale) article.append(node('p', 'stale-label', '缓存额度· ' + (card.updatedAt ? time(card.updatedAt) : '读取时间未知')));
    article.title = '额度读数：' + time(card.updatedAt);
    parent.append(article);
  }
}
const RANKING_NOTES = {
  models: '同名模型已合并，含不同厂商前缀与大小写',
  providers: '按上游稳定 id 解析厂商',
  agents: 'Magpie 识别的调用客户端',
  computers: '发起请求的设备，沿用 Magpie 的合并结果',
};
function renderRanking(rows, total) {
  const parent = $('rank-body'); parent.replaceChildren();
  if (!rows.length) { parent.append(node('p', 'empty', '此周期暂无记录')); return; }
  for (const item of rows) {
    const row = node('div', 'ranking-row'), heading = node('div', 'ranking-heading');
    const value = node('span', 'ranking-value');
    value.append(node('strong', '', compact(item.totalTokens)));
    if (item.cost > 0) value.append(node('span', 'ranking-cost', money(item.cost)));
    heading.append(node('span', '', item.label), value);
    const bar = progress(total ? item.totalTokens / total * 100 : 0);
    bar.setAttribute('aria-label', item.label + '：' + exact(item.totalTokens) + ' Token' + (item.cost > 0 ? '· 预估费用 ' + money(item.cost) : ''));
    row.append(heading, bar); parent.append(row);
  }
}
function renderRankings(data) {
  renderRanking(data.rankings[rankTab] || [], data.usage.week?.totalTokens);
  $('rank-note').textContent = RANKING_NOTES[rankTab] || '';
}
const NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs, text) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
}
function renderChart(rows) {
  const parent = $('chart'); parent.replaceChildren();
  if (!rows.length) { parent.append(node('p', 'empty', '暂无趋势数据')); return; }
  const svg = svgNode('svg', { viewBox: '0 0 420 175', role: 'img', 'aria-label': '近七日 Token 用量' });
  const max = Math.max(1, ...rows.map(row => row.totalTokens));
  for (const y of [35, 80, 125]) svg.append(svgNode('line', { x1: 0, x2: 420, y1: y, y2: y, class: 'gridline' }));
  rows.forEach((row, i) => {
    const x = 420 / rows.length * (i + .5), height = row.totalTokens / max * 100;
    const rect = svgNode('rect', { x: x - 12, y: 139 - height, width: 24, height: Math.max(2, height), rx: 3, class: i === rows.length - 1 ? 'last' : '' });
    rect.append(svgNode('title', {}, row.label + '：' + exact(row.totalTokens) + ' Token'));
    const date = row.at ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(row.at)) : row.label;
    svg.append(rect, svgNode('text', { x, y: 159, 'text-anchor': 'middle' }, date));
  });
  parent.append(svg);
}
function speedText(metrics) {
  const parts = [];
  if (metrics?.outputTokensPerSecond != null) parts.push('输出 约' + metrics.outputTokensPerSecond + ' tok/s');
  if (metrics?.ttftMs != null) parts.push('首字 约' + (metrics.ttftMs >= 1000 ? (metrics.ttftMs / 1000).toFixed(1) + ' 秒' : metrics.ttftMs + ' 毫秒'));
  return parts.join('· ');
}
function render(data, offline = false) {
  const stale = offline || Object.values(data.sources).some(source => source.state !== 'ok');
  $('connection').textContent = offline ? '离线· 显示缓存' : stale ? '部分数据待更新' : '已连接';
  $('status-dot').className = 'status-dot ' + (stale ? 'warn' : 'ok');
  const notices = [];
  if (data.demo) notices.push('演示模式· 所有数字、模型和设备用量均为虚构数据。');
  if (stale) notices.push('当前显示最后成功的统计，请查看下方更新时间；未获取到的数据以 — 表示。');
  $('notice').hidden = !notices.length; $('notice').textContent = notices.join(' ');
  const day = value => new Date(value + 8 * 3600000).toISOString().slice(0, 10);
  const oldDay = data.sources.today.outdated || data.sources.today.observedAt && day(Date.parse(data.sources.today.observedAt)) !== day(Date.now());
  // A reading of another day is not the usage of today: the cards must not
  // keep yesterday's number and let it be read as today's.
  if (oldDay) for (const card of data.subscriptions || []) if (card) card.usage = null;
  renderQuotas(data.subscriptions);
  const today = oldDay ? null : data.usage.today, week = data.usage.week;
  $('today-total').textContent = compact(today?.totalTokens);
  $('today-total').title = today ? exact(today.totalTokens) + ' Token' : '';
  $('today-caption').textContent = today ? exact(today.totalTokens) + ' Token·上海时间今日累计' : '尚未读取到今日用量';
  const breakdown = $('breakdown'); breakdown.replaceChildren();
  for (const [text, field] of [['输入', 'inputTokens'], ['输出', 'outputTokens'], ['缓存读取', 'cacheReadTokens'], ['缓存写入', 'cacheWriteTokens']]) {
    const item = node('div', 'breakdown-item');
    item.append(node('span', '', text), node('strong', '', compact(today?.[field]))); breakdown.append(item);
  }
  $('reasoning').textContent = '推理 ' + (today ? compact(today.reasoningTokens) : '—') + ' Token· 已包含在输出中';
  const extras = [speedText(today), today && today.cost != null ? '预估费用 ' + money(today.cost) : ''].filter(Boolean).join('· ');
  $('today-extras').textContent = extras;
  $('today-extras').title = today && today.unpriced > 0 ? '有 ' + today.unpriced + ' 条未计价请求，费用估算可能偏低' : '';
  $('requests').textContent = (today ? exact(today.requests) : '—') + ' 次请求' + (today && today.errors > 0 ? '·失败 ' + today.errors : '');
  $('cache-hit').textContent = (today?.cacheHitPercent == null ? '—' : today.cacheHitPercent.toFixed(1) + '%') + ' 缓存命中';
  $('week-total').textContent = compact(week?.totalTokens);
  $('week-requests').textContent = (week ? exact(week.requests) : '—') + ' 次请求' + (week && week.cost != null ? '· 预估费用 ' + money(week.cost) : '');
  $('week-requests').title = week && week.unpriced > 0 ? '有 ' + week.unpriced + ' 条未计价请求，费用估算可能偏低' : '';
  renderChart(data.trend);
  renderRankings(data);
  const observations = Object.values(data.sources).map(source => source.observedAt).filter(Boolean).sort();
  $('updated').textContent = '汇总更新于 ' + time(observations[0]);
}
function auth(message = '') {
  $('auth-error').textContent = message;
  if (!$('auth').open) $('auth').showModal();
}
// A phone that is going away asks the service to take its row off the list of
// the devices. The answer says whether the row is really gone.
async function forget(dying) {
  try {
    const response = await fetch('/api/v1/device/forget', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + dying, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return false;
    const answer = await response.json();
    return !!(answer && answer.forgotten);
  } catch {
    return false;
  }
}
async function load() {
  if (!token) { auth(); return; }
  $('refresh').disabled = true;
  try {
    const response = await fetch('/api/v1/overview', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.status === 401) {
      // The service puts its name on every answer that refuses a token. A
      // refusal without that name comes from something in front of the
      // service, and the token of the phone may still be good — so it is
      // kept, and only the truth is told.
      if (response.headers.get('x-token-widget-service') === '@magpie-community/page-token-widget') {
        // The service does not know this token. The phone says so, and its row
        // on the PC goes with it — the same way a widget that reads a dead
        // token cleans up after itself.
        const dying = token;
        token = null; store.drop('usage-token');
        if (dying) void forget(dying);
        auth('令牌无效，请重新输入。');
      } else {
        auth('服务返回 401：这个地址回的不是你的插件服务。令牌没有动。');
      }
      return;
    }
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    if (data.schemaVersion !== 1) throw new Error('Unsupported response');
    last = data; store.set('usage-overview', JSON.stringify(data));
    $('auth').close(); render(data);
  } catch {
    if (last) render(last, true);
    else { $('connection').textContent = '连接失败'; $('notice').hidden = false; $('notice').textContent = '无法连接服务。请检查 PC 服务和 iPhone 的网络（尾网或内网）。'; }
  } finally { $('refresh').disabled = false; }
}
$('auth-form').addEventListener('submit', event => {
  event.preventDefault(); token = $('token').value.trim(); remember(token); void load();
});
// 「断开」 puts the token away: the page forgets it, the row of this phone is
// taken off the list of the devices, and the next visit asks for it again.
// It asks once more before it does: the row on the PC goes with it, and that
// is not always what the finger meant.
let forgetArmed = 0;
$('forget').addEventListener('click', () => {
  if (Date.now() > forgetArmed) {
    forgetArmed = Date.now() + 4000;
    $('forget').textContent = '确定断开？';
    setTimeout(() => { forgetArmed = 0; $('forget').textContent = '断开'; }, 4000);
    return;
  }
  forgetArmed = 0; $('forget').textContent = '断开';
  const dying = token;
  token = null; store.drop('usage-token');
  // The old numbers go with the token: they belong to the device that was
  // just disconnected.
  last = null; store.drop('usage-overview');
  // The row on the PC goes as well, so a phone that is going away does not
  // stay in the list. A token that has run out is enough for that.
  const note = $('notice');
  if (dying) {
    void forget(dying).then(gone => {
      note.hidden = false;
      note.textContent = gone
        ? '这台手机已经断开：令牌抹掉了，PC 名单上那一行也删掉了。下次打开这个页面会重新问你要。'
        : '这台手机已经断开：令牌抹掉了。PC 名单上那一行还没删掉（服务没有答话），可以在控制台的设备管理里把它删掉。';
    });
  } else {
    note.hidden = false;
    note.textContent = '这台手机已经断开：令牌抹掉了。下次打开这个页面会重新问你要。';
  }
  $('connection').textContent = '已断开';
  auth('已经断开了。');
});
$('auth').addEventListener('cancel', event => event.preventDefault());
$('refresh').addEventListener('click', () => void load());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
if (last) render(last, true);
void load();
setInterval(() => { if (!document.hidden && token) void load(); }, 60000);

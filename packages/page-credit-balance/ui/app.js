const byId = id => document.getElementById(id);
const key = document.querySelector('meta[name="credit-key"]').content;
const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const periods = { recent: '近期实测', peak: '高峰', offpeak: '低峰' };
const spendWindows = { '24h': '近 24 小时', '7d': '最近 7 日', '30d': '最近 30 日' };
const spendBases = { counter: '官方计数器', 'counter-partial': '部分账号计数器',
  snapshot: '余额快照与当日计数', 'snapshot-partial': '部分账号余额快照与当日计数',
  request: '请求扣分', 'request-estimate': '按请求估算', none: '无数据' };
const sources = { manual: '手填', observed: '实际扣分', 'observed-average': '近期扣分均值',
  'rule-manual': '手填 × 时段倍率', 'rule-observed': '实际扣分 × 时段倍率',
  'learned-catalog': '目录倍率 × 实测积分比例',
  'rule-learned-catalog': '目录倍率 × 实测积分比例 × 时段规则',
  aggregate: '按近期用量加权' };
let report;
let view = 'credits';
let editing;
let pending = 0;
let writes = Promise.resolve();
let revision = 0;

function element(tag, classes, text) {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  if (text !== undefined) node.textContent = text;
  return node;
}

const credit = value => value == null ? '—' : fmt.format(value);
function tokens(value) {
  if (value == null) return '—';
  if (value >= 100_000_000) return `${fmt.format(value / 100_000_000)} 亿`;
  if (value >= 10_000) return `${fmt.format(value / 10_000)} 万`;
  return fmt.format(Math.floor(value));
}

function sum(values) {
  const known = values.filter(v => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function options(select, choices, selected) {
  select.replaceChildren(...choices.map(([id, label]) => new Option(label, id, false, id === selected)));
}

function modelChoices(provider, baseModel, placeholder = '请选择对应模型') {
  const entries = Object.entries(provider.models).filter(([, item]) => item.eligible && item.checked);
  entries.sort((a, b) => Number(b[0] === baseModel) - Number(a[0] === baseModel) ||
    b[1].recent - a[1].recent || a[0].localeCompare(b[0]));
  return [['', placeholder], ...entries.map(([id]) => {
    const name = nameOf(id);
    return [id, `${id === baseModel ? '同名候选 · ' : ''}${name === id ? id : `${name} · ${id}`}`];
  })];
}

function modelSelector(provider, targetModel, selected, kind, disabled) {
  const field = element('fieldset', 'model-choice');
  field.append(element('legend', '', '对应型号（可多选）'));
  const choices = modelChoices(provider, targetModel).slice(1);
  if (!choices.length) field.append(element('p', 'minor', '暂无已启用型号'));
  for (const [id, label] of choices) {
    const option = element('label', 'model-option');
    const input = element('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = selected?.includes(id);
    input.disabled = disabled;
    input.dataset.focus = id;
    input.onchange = () => {
      const selected = [...field.querySelectorAll('input:checked')].map(node => node.value);
      save({ kind, provider: provider.id, value: selected });
    };
    option.append(input, element('span', '', label));
    field.append(option);
  }
  return field;
}

function participation(provider) {
  const field = element('label', 'participate', '参与合计');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = provider.enabled;
  input.setAttribute('aria-label', `${provider.name}参与合计`);
  input.dataset.focus = 'participation';
  input.onchange = () => save({ kind: 'enabled', provider: provider.id, value: input.checked });
  field.prepend(input);
  return field;
}

const nameOf = id => report.models.find(m => m.id === id)?.name ?? id;

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-magpie-credit-key': key, ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

function failure(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}

async function change(operation, errorNode = byId('error')) {
  const version = ++revision;
  pending++;
  byId('refresh').disabled = true;
  byId('report').setAttribute('aria-busy', 'true');
  failure(errorNode, null);
  try {
    const next = await operation();
    if (version === revision) {
      report = next;
      render();
    }
    return true;
  } catch (error) {
    failure(errorNode, error.message || '请求失败，请刷新后重试。');
    if (report && version === revision) {
      // A preceding update may have succeeded before this update failed.
      try { report = await request('api/report'); } catch (readError) {
        failure(errorNode, `${error.message}。请刷新以重新读取设置。`);
      }
      if (version === revision) render();
    }
    return false;
  } finally {
    pending--;
    byId('refresh').disabled = pending > 0;
    byId('report').setAttribute('aria-busy', String(pending > 0));
    byId('loading').hidden = true;
  }
}

function save(fields, errorNode) {
  return change(() => {
    const write = writes.then(() => request('api/preference', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }));
    writes = write.catch(() => undefined);
    return write;
  }, errorNode);
}

function status(provider, model, estimate, period = report.period) {
  if (provider.balance === null) return '余额暂不可读';
  if (!model) return '待选型号';
  if (!estimate) return provider.modelCoverageUnknown ? '型号待确认' : '不提供此型号';
  if (estimate.status === 'free') return '免费额度另计';
  if (estimate.status === 'unknown-model') return '型号待确认';
  if (estimate.status === 'unsupported') return '不提供此型号';
  if (estimate.tokens === null) return period === 'recent' ? '待补费率' : `待补${periods[period]}费率`;
  if (estimate.models?.length > 1) {
    if (estimate.status === 'partial') return `已聚合 ${estimate.models.length} 个型号 · 部分数据缺失`;
    return estimate.rate ? `${fmt.format(estimate.rate.value)} 分／百万 Token` : '积分用尽';
  }
  if (estimate.status === 'partial') return `已覆盖 ${estimate.covered}/${estimate.eligible} 个可用账号`;
  if (!estimate.rate) return '积分用尽';
  return `${fmt.format(estimate.rate.value)} 分／百万 Token`;
}

function metric(label, primary, secondary, classes = '') {
  const item = element('span', `line-item ${classes}`);
  item.append(element('span', 'minor', label), element('span', 'metric', primary));
  if (secondary) item.append(element('span', 'minor', secondary));
  return item;
}

function detailOf(provider, id, estimate, bridges = provider.selectedBridges) {
  const detail = element('div', 'detail');
  const actions = element('div', 'detail-actions');
  if (Object.values(provider.models).some(m => m.eligible && m.checked)) {
    const edit = element('button', '', '设置费率');
    edit.type = 'button';
    edit.onclick = () => openEditor(provider, id);
    actions.append(edit);
  }
  if (actions.childElementCount) detail.append(actions);
  if (estimate?.rate) {
    const rate = estimate.rate;
    detail.append(element('p', 'note', `${credit(rate.value)} 分／百万 Token · ${sources[rate.source]}${rate.samples ? ` · ${rate.samples} 条扣分样本` : ''}`));
  } else if (id) detail.append(element('p', 'note', '当前费率待确认，计算使用供应商自己的扣分记录和目录系数。'));
  if (estimate?.offer) detail.append(element('p', 'note',
    `目录显示折扣 ×${fmt.format(estimate.offer.rate)}，原倍率 ×${fmt.format(estimate.offer.was)}。`));
  if (estimate?.rule) {
    const rule = estimate.rule;
    const copy = element('p', 'note', rule.custom
      ? `计费时段：${rule.hours}；时段外按基础费率。`
      : `北京时间低峰 ${rule.hours} · 低峰费率为高峰的 ${fmt.format(rule.ratio * 100)}% `);
    if (rule.url) {
      const link = element('a', '', '厂商规则');
      link.href = rule.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      copy.append(link);
    }
    detail.append(copy);
  }
  if (bridges?.length > 1) {
    detail.append(element('p', 'note',
      `本次聚合：${bridges.map(nameOf).join('、')}。供应商余额只计一次，费率按各型号近期 Token 占比加权。`));
  }
  for (const account of provider.accounts) {
    const line = element('div', 'account');
    const at = Date.parse(account.readAt);
    line.append(element('span', 'minor', `${account.label}${Number.isFinite(at) ? ` · ${time.format(at)}` : ''}`),
      element('span', '', account.balance === null ? '余额待查' : `${credit(account.balance)} 分`));
    detail.append(line);
    if (account.expiring) {
      const exp = account.expiring;
      detail.append(element('p', 'note', `${account.label} 含${exp.amount != null ? ` ${credit(exp.amount)} 分` : '部分积分'}将于 ${time.format(exp.at)} 过期（按供应商口径，未从余额扣除）。`));
    }
  }
  return detail;
}

function spendDetail(provider) {
  const bucket = provider.spend[report.spendWindow];
  const detail = element('div', 'detail');
  if (!bucket.models.length) detail.append(element('p', 'note',
    bucket.actual > 0 ? '已收到供应商扣分，缺少型号明细。' :
      bucket.basis === 'none' ? '还没有可核对的扣分记录。' : '当前读数未记录扣分。'));
  for (const model of bucket.models) {
    const line = element('div', 'account');
    const label = model.name === model.id ? model.id : `${model.name} · ${model.id}`;
    const provenance = model.estimated > 0 ? ` · 含估算 ${credit(model.estimated)}` : '';
    line.append(element('span', 'minor', label),
      element('span', '', model.credits === 0 && model.unpriced > 0 ? '扣分待查' : `${credit(model.credits)} 分${provenance}`));
    detail.append(line);
  }
  if (bucket.unallocated > 0) detail.append(element('p', 'note',
    `另有 ${credit(bucket.unallocated)} 分为官方计数与模型明细之间的差额，未强行分摊到某个型号。`));
  if (bucket.unattributed) detail.append(element('p', 'note', '部分请求缺少可匹配的账号，已与账号计数对照去重，消耗可能少计。'));
  detail.append(element('p', 'note', `口径：${spendBases[bucket.basis] ?? bucket.basis}。`));
  if (report.spendWindow === '24h') detail.append(element('p', 'note',
    '近 24 小时按账号当日计数与页面开启期间采集的余额快照累计；网关没有逐时账单，缺口部分按请求估算。签到、赠送与充值不计入消耗。'));
  else if (bucket.basis.startsWith('counter')) detail.append(element('p', 'note',
    `${bucket.partial ? '部分账号有' : '按账号'}官方积分计数逐日累计${bucket.through ? `，读数截至 ${time.format(bucket.through)}` : ''}；模型拆分先按账号计数，再按该账号型号用量分摊。领取、充值与周期重置不计入消耗。`));
  return detail;
}

function providerRow(provider, opened, base) {
  const creditsView = view === 'credits';
  const spendView = view === 'spend';
  const isBase = provider.id === report.base;
  const id = creditsView ? provider.bridge : provider.tokenBridges?.[0];
  const selected = creditsView ? provider.selectedBridges ?? [] : provider.tokenBridges ?? [];
  const recent = report.period === 'recent';
  const estimate = creditsView ? (isBase ? provider.models[id] : provider.aggregate)
    : provider.tokenPlan?.[recent ? 'recentEstimate' : 'peak'];
  const row = element('details', 'vendor');
  row.dataset.provider = provider.id;
  row.open = opened.has(provider.id);
  const summary = element('summary');
  summary.append(element('span', 'name', provider.name),
    metric('原始积分', credit(provider.balance), provider.unknown ? `${provider.unknown} 个账号待查` : `${provider.accounts.length} 个账号`));
  if (spendView) {
    const bucket = provider.spend[report.spendWindow];
    const hasSpendData = bucket.total > 0 || bucket.basis !== 'none' || bucket.models.some(m => m.priced > 0);
    summary.append(metric('消耗积分', hasSpendData ? credit(bucket.total) : '—',
      `${spendWindows[report.spendWindow]}${!hasSpendData ? ' · 数据待查' : bucket.total === 0 ? ' · 已记录为零'
        : bucket.estimated > 0 ? ' · 含估算' : ' · 官方计数或实际扣分'}`, 'result'),
    metric('涉及模型', String(bucket.models.length),
      !hasSpendData ? '缺少扣分记录' : bucket.total === 0 ? ''
        : bucket.estimated > 0 ? `实际 ${credit(bucket.actual)} · 估算 ${credit(bucket.estimated)}`
          : '按供应商计数或请求扣分'));
    row.append(summary, spendDetail(provider));
    return row;
  }
  const plan = provider.tokenPlan;
  const target = creditsView ? report.baseModel : report.selectedModel;
  const reference = creditsView && isBase;
  const alias = reference ? id && nameOf(id)
    : selected.length > 1 ? `${nameOf(selected[0])} 等 ${selected.length} 个` : id && nameOf(id);
  summary.append(metric(reference ? '基准型号' : '对应型号', alias || (target ? '展开选型号' : '先选目标型号'),
    provider.enabled ? '' : '未参与合计'));
  const slots = recent ? ['recent'] : ['peak', 'offpeak'];
  for (const slot of slots) {
    const price = slot === 'recent' ? plan?.recentEstimate : plan?.[slot];
    const value = creditsView ? (slot === 'recent' ? provider.equivalent : provider.equivalents?.[slot]) : price?.tokens;
    const subtitle = !provider.enabled || !id ? '' : reference ? '基准供应商'
      : creditsView ? value == null ? !base?.models[report.baseModel]?.[slot === 'recent' ? 'recentEstimate' : slot]?.rate
        ? '基准费率待确认' : '费率或余额待查' : ''
        : status(provider, id, price, slot);
    const format = creditsView ? credit : tokens;
    summary.append(metric(`${periods[slot]}${creditsView ? '折合' : '可用 Token'}`,
      format(provider.enabled ? value : null), subtitle, 'result'));
  }
  row.classList.add(recent ? 'single-rate' : 'dual-rate');
  const detail = detailOf(provider, id, estimate, selected);
  const settings = element('div', 'provider-settings');
  settings.append(participation(provider));
  if (!reference) settings.append(modelSelector(provider, target, selected,
    creditsView ? 'mapping' : 'tokenMapping', !target));
  detail.prepend(settings);
  if (!creditsView && !spendView && provider.tokenPlan?.recent) {
    const plan = provider.tokenPlan;
    detail.append(element('p', 'note', `近 7 天该型号 Token ${tokens(plan.recent)}${plan.cacheShare != null
      ? ` · 缓存占比 ${fmt.format(plan.cacheShare * 100)}%` : ''}。`));
  }
  row.append(summary, detail);
  return row;
}

function refreshModels() {
  const query = byId('search').value.trim().toLowerCase();
  const models = report.models.filter(m => !query || `${m.id} ${m.name}`.toLowerCase().includes(query));
  const entries = models.map(m => [m.id, m.id === m.name?.toLowerCase() ? m.name : `${m.name} · ${m.id}`]);
  if (!models.some(m => m.id === report.selectedModel)) entries.unshift(['', models.length ? '请选择精确型号' : '没有匹配的型号']);
  options(byId('model'), entries, report.selectedModel);
  byId('model').disabled = !models.length;
}

function refreshBaseModels(base) {
  const select = byId('base-model');
  const choices = base ? modelChoices(base, null, '请选择基准精确型号') : [['', '暂无可选型号']];
  if (!choices.some(([id]) => id === report.baseModel)) report.baseModel = null;
  options(select, choices, report.baseModel ?? '');
  select.disabled = choices.length === 1;
}

function render() {
  const creditsView = view === 'credits';
  const spendView = view === 'spend';
  const tokensView = view === 'tokens';
  const base = report.providers.find(p => p.id === report.base);
  byId('report').hidden = false;
  byId('base-field').hidden = !creditsView;
  byId('base-model-field').hidden = !creditsView;
  byId('model-field').hidden = !tokensView;
  byId('periods').hidden = spendView;
  byId('spend-windows').hidden = !spendView;
  for (const button of byId('views').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.view === view);
  const period = report.period === 'recent' ? 'recent' : 'peak';
  for (const button of byId('periods').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.period === period);
  for (const button of byId('spend-windows').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.window === report.spendWindow);
  const included = report.providers.filter(p => p.enabled);
  const compare = !spendView && period !== 'recent';
  const planOf = (p, slot) => p.tokenPlan?.[slot === 'recent' ? 'recentEstimate' : slot];
  const valuesAt = slot => included.map(p => creditsView
    ? slot === 'recent' ? p.equivalent : p.equivalents?.[slot] : planOf(p, slot)?.tokens);
  const spend = report.providers.map(p => p.spend[report.spendWindow]);
  const coverageAt = slot => {
    const count = valuesAt(slot).filter(v => v != null).length;
    const partial = count < included.length || included.some(p => p.unknown > 0 || (creditsView
      ? (slot === 'recent' ? p.aggregate?.status : p.equivalentStatuses?.[slot]) === 'partial'
      : planOf(p, slot)?.status === 'partial'));
    return `${count}/${included.length} 家${partial ? ' · 部分合计' : ''}`;
  };
  const format = creditsView ? credit : tokens;
  byId('total-label').textContent = spendView ? `${spendWindows[report.spendWindow]}消耗积分（各家原始数值合计）`
    : creditsView ? `折合 ${base?.name ?? '基准供应商'} 积分` : '预计可用 Token';
  byId('total').hidden = compare;
  byId('total').textContent = spendView ? credit(sum(spend.map(bucket => bucket.basis === 'none' && !bucket.total
    ? null : bucket.total))) : format(sum(valuesAt('recent')));
  byId('dual').hidden = !compare;
  byId('peak-label').textContent = '高峰';
  byId('offpeak-label').textContent = '低峰';
  byId('peak-total').textContent = format(sum(valuesAt('peak')));
  byId('offpeak-total').textContent = format(sum(valuesAt('offpeak')));
  byId('coverage').textContent = spendView
    ? `已核对 ${credit(sum(spend.map(b => b.actual)))} · 估算补入 ${credit(sum(spend.map(b => b.estimated)))}${spend.some(b => b.partial) ? ' · 部分记录待查' : ''}`
    : creditsView && !report.baseModel ? '先选择基准型号'
    : compare ? `高峰纳入 ${coverageAt('peak')} ／ 低峰纳入 ${coverageAt('offpeak')}` : `近期纳入 ${coverageAt('recent')}`;
  byId('raw').hidden = spendView;
  byId('raw').textContent = `各家原始余额数值合计 ${credit(sum(report.providers.map(p => p.balance)))}`;
  byId('updated').textContent = `读取于 ${time.format(report.now)}`;
  byId('note').textContent = spendView ? '展开供应商查看型号消耗。24 小时为滚动窗口，7 日和 30 日按北京时间自然日统计。计数器可核对供应商总额，型号分摊仍可能是估算。'
    : creditsView
    ? '按相同时段折算：可用 Token × 基准型号每百万 Token 的积分费率 ÷ 100 万。'
    : '按账号估算余额能用多少 Token。每个账号的余额只算一次，多选型号按近期用量加权。';
  byId('mapping-hint').hidden = spendView;
  byId('mapping-hint').textContent = '展开供应商可调整对应型号和参与范围。';
  const candidates = included.filter(p => p.shared?.length && !p.selectedBridges.length).length;
  byId('match-models').hidden = !creditsView || !candidates;
  byId('match-models').textContent = `填入同名型号（${candidates} 家）`;
  options(byId('base'), report.providers.map(p => [p.id, p.name]), report.base);
  refreshBaseModels(base);
  refreshModels();
  const rows = byId('rows');
  const focus = document.activeElement;
  const focusedProvider = focus?.closest('#rows .vendor')?.dataset.provider;
  const opened = new Set([...rows.querySelectorAll('details[open]')].map(node => node.dataset.provider));
  const sorted = [...report.providers].sort((a, b) => {
    if (spendView) return b.spend[report.spendWindow].total - a.spend[report.spendWindow].total ||
      (b.balance ?? -1) - (a.balance ?? -1);
    return Number(b.enabled) - Number(a.enabled) || Number(b.id === report.base) - Number(a.id === report.base) ||
      (creditsView ? 0 : (b.tokenPlan?.peak?.tokens ?? -1) - (a.tokenPlan?.peak?.tokens ?? -1)) ||
      (b.balance ?? -1) - (a.balance ?? -1);
  });
  rows.replaceChildren(...sorted.map(p => providerRow(p, opened, base)));
  if (focusedProvider) {
    const row = [...rows.children].find(node => node.dataset.provider === focusedProvider);
    const control = [...(row?.querySelectorAll('[data-focus]') ?? [])].find(node => node.dataset.focus === focus.dataset.focus);
    (control ?? row?.querySelector('summary'))?.focus({ preventScroll: true });
  }
}

function editorFields() {
  const item = editing.models[byId('edit-model').value];
  const period = byId('edit-period').value;
  const manual = item?.manual[period];
  const automatic = item?.[period]?.rate?.value;
  const value = manual ?? automatic;
  byId('rate').value = value ?? '';
  byId('clear-rate').disabled = manual == null;
  byId('rate-origin').textContent = manual == null
    ? automatic == null ? '尚未算出费率，请填写。' : '当前自动费率已填入；保存后改为手填。'
    : '当前为手填费率；清除后恢复自动计算。';
  byId('rate-hint').textContent = item?.rule
    ? `${item.rule.hours}（北京时间）。填写一档时，可按时段倍率推算另一档。`
    : '该数值表示每处理一百万 Token 扣除的积分。';
  failure(byId('rate-error'), null);
}

function openEditor(provider, selected) {
  editing = provider;
  const choices = modelChoices(provider, view === 'credits' ? report.baseModel : report.selectedModel).slice(1);
  byId('editor-title').textContent = `${provider.name} · 设置费率`;
  options(byId('edit-model'), choices, choices.some(([id]) => id === selected) ? selected : choices[0]?.[0]);
  byId('edit-period').value = report.period;
  editorFields();
  byId('editor').showModal();
}

async function saveRate(value) {
  if (await save({ kind: 'rate', provider: editing.id, model: byId('edit-model').value,
    period: byId('edit-period').value, value }, byId('rate-error'))) byId('editor').close();
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
byId('refresh').onclick = () => change(() => request('api/report?refresh=1'));
byId('match-models').onclick = () => save({ kind: 'matchModels', provider: report.base, value: report.baseModel });
byId('base').onchange = () => save({ kind: 'base', value: byId('base').value });
byId('base-model').onchange = () => save({ kind: 'baseModel', value: byId('base-model').value || null });
byId('model').onchange = () => { if (byId('model').value) save({ kind: 'model', value: byId('model').value }); };
byId('search').oninput = refreshModels;
byId('views').onclick = event => { if (report && event.target.dataset.view) { view = event.target.dataset.view; render(); } };
byId('periods').onclick = event => { if (event.target.dataset.period) save({ kind: 'period', value: event.target.dataset.period }); };
byId('spend-windows').onclick = event => { if (event.target.dataset.window) save({ kind: 'spendWindow', value: event.target.dataset.window }); };
byId('edit-model').onchange = editorFields;
byId('edit-period').onchange = editorFields;
byId('close-editor').onclick = () => byId('editor').close();
byId('clear-rate').onclick = () => saveRate(null);
byId('rate-form').onsubmit = event => { event.preventDefault(); saveRate(byId('rate').valueAsNumber); };
change(() => request('api/report'));

let refreshing = false;
setInterval(async () => {
  if (document.hidden || pending || refreshing || byId('editor').open || byId('report').contains(document.activeElement) &&
      ['SELECT', 'INPUT'].includes(document.activeElement.tagName) && !document.activeElement.matches('[type="checkbox"]')) return;
  refreshing = true;
  const version = revision;
  try {
    const next = await request('api/report?refresh=1');
    if (version === revision) {
      report = next;
      render();
    }
  } catch (error) {
    // Keep the last complete report; the next tick or manual refresh retries.
    if (error?.name === 'SyntaxError') failure(byId('error'), '实时刷新返回了无效数据，请手动刷新。');
  } finally {
    refreshing = false;
  }
}, 15_000);

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="fm-write-token"]').content;
let data;
let showAll = false;
let draft = null;
let mateDraft = null;
let openMate = null;
let matePaints = [];
let pending = null;
let recoveredEdits = window.FMRecovery.take();
let seatFilter = 'all';
let skipAutoFocus = true;
if (window.parent === window) document.documentElement.dataset.theme = 'dark';

const HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'pi-signed', 'grok', 'kimi', 'cursor', 'agy', 'muse', 'rovo', 'omp', 'devin', 'commandcode', 'polytoken', 'cortex', 'kiro', 'hermes'];
// Bundled marks come from the pinned MagPie icon directory in native-icons.json.
const MARK_FILE = {
  claude: 'claudecode-color.svg', codex: 'codex-color.svg', opencode: 'opencode.svg', pi: 'pi.svg', 'pi-signed': 'pi.svg',
  grok: 'xai.svg', kimi: 'kimi.svg', cursor: 'cursor.svg', agy: 'antigravity-color.svg', muse: 'meta-color.svg',
  omp: 'omp.svg', devin: 'devin.svg', commandcode: 'commandcode.svg',
  kiro: 'kiro-color.svg', hermes: 'hermes.svg',
};
// These MagPie files are fill="currentColor". A mask paints them with --fg so light and dark both stay readable.
const MARK_MONO = new Set(['opencode', 'pi', 'pi-signed', 'grok', 'kimi', 'cursor', 'omp', 'devin', 'commandcode', 'hermes']);

function paintMark(el, name) {
  const file = MARK_FILE[name];
  el.dataset.harness = name || 'unknown';
  el.replaceChildren();
  el.classList.toggle('mono', Boolean(file && MARK_MONO.has(name)));
  el.classList.toggle('letter', !file);
  if (!file) {
    el.textContent = (name || '?').slice(0, 1).toUpperCase();
    return;
  }
  if (MARK_MONO.has(name)) return;
  const img = document.createElement('img');
  img.src = `icons/${file}`;
  img.alt = '';
  img.draggable = false;
  el.append(img);
}

function fillEfforts(box, profile, onChange, provider = '') {
  const stamp = `${targetSeat(profile)}|${profile.harness}|${profile.model}|${profile.effort}|${provider}`;
  if (box.dataset.profile === stamp) return;
  box.dataset.profile = stamp; box.replaceChildren(node('span', profile.effort || '读取参数…', 'readonly-note'));
  if (!profile.harness) { box.textContent = '请先选择 Harness'; return; }
  catalogFor(profile).then(data => {
    if (box.dataset.profile !== stamp) return;
    const state = FMModels.effortChoices({ ...profile, provider }, data);
    box.replaceChildren();
    if (!state.known || !state.options.length) {
      const note = node('span', profile.effort ? `${profile.effort} · ${state.known ? '当前值超出范围' : '范围未知'}` : state.known ? '默认' : '范围未知', 'readonly-note');
      note.title = state.reason; box.append(note);
      if (!profile.effort) return;
    }
    const choices = [{ value: '', label: '默认' }, ...state.options.map(o => ({ value: o.value, label: o.label || o.value }))];
    if (profile.effort && !choices.some(o => o.value === profile.effort)) choices.push({ value: profile.effort, label: `${profile.effort}（保留当前值）` });
    if (!state.options.length && !profile.effort) return;
    box.append(FMControls.menu('推理强度', choices, profile.effort || '', value => { profile.effort = value; onChange(); }));
  }).catch(() => { if (box.dataset.profile === stamp) box.replaceChildren(node('span', profile.effort || '参数读取失败', 'readonly-note')); });
}

const node = (tag, text, cls) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
let activeModelPicker;
document.addEventListener('pointerdown', event => {
  if (activeModelPicker && !activeModelPicker.element.contains(event.target)) activeModelPicker.close();
}, true);
window.addEventListener('resize', () => activeModelPicker?.close());
document.addEventListener('scroll', event => {
  if (activeModelPicker && !activeModelPicker.panel.contains(event.target)) activeModelPicker.close();
}, true);
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const homeIndex = () => Number($('home').value) || 0;
const currentHome = () => data?.homes[homeIndex()];

const SEAT_NONE = 'unspecified';
const SEAT_TONES = new Map([['primary', 'c1'], [SEAT_NONE, 'c7']]);
const EXTRA_TONES = ['c2', 'c3', 'c4', 'c5', 'c6'];

function nameOf(rule) {
  if (!rule?.when) return '默认规则';
  const type = rule.when.match(/task-type:\s*([\w-]+)/)?.[1];
  return type || `规则 ${rule.index + 1}`;
}

function seatKey(when) {
  const name = String(when || '').match(/\[seat:\s*([^\]]+)\]/)?.[1]?.trim();
  return name || SEAT_NONE;
}

function seatLabel(key) {
  return key === SEAT_NONE ? '未指定' : key;
}

function toneFor(key) {
  if (SEAT_TONES.has(key)) return SEAT_TONES.get(key);
  let n = 0;
  for (const ch of key) n = (n + ch.charCodeAt(0)) % EXTRA_TONES.length;
  return EXTRA_TONES[n];
}

function say(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text || '';
}

function payload(extra = {}) {
  const home = currentHome();
  return {
    home: homeIndex(),
    baseRevision: home.dispatch.revision,
    rules: draft.rules,
    default: draft.default,
    ...extra,
  };
}

async function post(path, body) {
  if (!window.FMActions.busy) { say('saved', ''); say('sync-result', ''); }
  return window.FMActions.run(path, () => fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FM-Write-Token': token, Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  }));
}

function showDiff(text) {
  const pre = $('diff');
  pre.replaceChildren();
  let oldLine = 0, newLine = 0;
  for (const line of String(text || '').split('\n')) {
    const header = line.match(/^@@ -(\d+),\d+ \+(\d+),\d+ @@/);
    if (header) {
      oldLine = Number(header[1]); newLine = Number(header[2]);
      pre.append(node('div', line, 'diff-hunk'));
      continue;
    }
    const type = line[0];
    const row = node('div', null, `diff-row ${type === '+' ? 'add' : type === '-' ? 'del' : 'context'}`);
    const numbered = [' ', '+', '-'].includes(type);
    row.append(node('span', numbered && type !== '+' ? String(oldLine++) : '', 'diff-number'), node('span', numbered && type !== '-' ? String(newLine++) : '', 'diff-number'), node('span', numbered ? type : '', 'diff-sign'), node('code', numbered ? line.slice(1) || ' ' : line, 'diff-code'));
    pre.append(row);
  }
}

const profileSeats = new WeakMap();
const secondmateProfiles = new WeakSet();
const targetSeat = profile => profileSeats.get(profile)?.() || '';
const isSecondmateCodex = profile => profile.harness === 'codex' && secondmateProfiles.has(profile);
function catalogFor(profile) {
  const catalog = FMModels.catalog(profile.harness, targetSeat(profile));
  return isSecondmateCodex(profile) ? catalog.then(FMModels.secondmateCodexCatalog) : catalog;
}

function modelPicker(profile, onChange, provider = '') {
  const picker = node('div', null, 'model-picker');
  const trigger = node('button', null, 'model-trigger');
  trigger.type = 'button'; trigger.setAttribute('aria-label', '选择模型');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  const panel = node('div', null, 'model-menu'); panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '选择模型');
  const search = node('input'); search.type = 'search'; search.placeholder = '筛选模型名称或 ID…'; search.setAttribute('aria-label', '搜索模型');
  const body = node('div', null, 'model-menu-body');
  const groups = node('div', null, 'model-groups'); groups.setAttribute('aria-label', '模型来源');
  const results = node('div', null, 'model-results'); results.setAttribute('role', 'group'); results.setAttribute('aria-label', '模型列表');
  const scope = node('p', null, 'model-scope'); scope.hidden = true;
  const writes = node('p', null, 'model-writes');
  body.append(groups, results); panel.append(search, body, scope, writes); picker.append(trigger, panel);
  let catalog = [], catalogWarning = '', loading = false, activeGroup = '', request = 0, loadedHarness = '', observed = null;
  const paint = () => {
    trigger.disabled = !profile.harness;
    FMModels.paint(trigger, FMModels.describe(profile, catalog, provider), observed?.customIcons);
  };
  const modelMark = (icons, route) => FMModels.mark(icons, route, observed?.customIcons);
  const favoriteKey = item => item.ref || item.value || item.id;
  let favorites = new Set();
  const favoritesStorage = () => `firstmate.modelFavorites.${targetSeat(profile)}`;
  const isFavorite = item => favorites.has(favoriteKey(item));
  const close = (focus = false) => {
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); request++;
    if (activeModelPicker?.element === picker) activeModelPicker = null;
    if (focus && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  const load = async () => {
    const harness = profile.harness;
    if (!harness) return;
    const seat = targetSeat(profile);
    const response = await catalogFor(profile);
    if (seat !== targetSeat(profile) || harness !== profile.harness || !picker.isConnected) return;
    // A rule that declares provider=codex lists only Codex models, so changing
    // the model cannot leave an unrelated provider behind. Keyed on the harness
    // as well: a rule switched away from Codex keeps that field for now, and it
    // must not narrow the new tool's list.
    const codexOnly = !seat && provider === 'codex' && harness === 'codex';
    catalog = response.models.filter(item => !codexOnly || item.ref?.startsWith('codex/') || (item.served && !item.ref) || FMModels.normalize(item.id).startsWith('codex/'));
    loadedHarness = `${seat}/${harness}`;
    catalogWarning = response.warning || '';
    observed = response;
    paint();
  };
  const valueOf = item => {
    if (isSecondmateCodex(profile)) return item.value;
    return observed?.seat
      ? FMModels.dispatchValue(profile, item, provider)
      : FMModels.valueOf(profile, item, catalog, provider);
  };
  const choose = value => {
    if (profile.model !== value) {
      profile.model = value;
      const state = FMModels.effortChoices({ ...profile, provider }, observed);
      if (state.known && !state.options.some(option => option.value === profile.effort)) profile.effort = '';
      onChange();
    }
    close(true);
    paint();
  };
  const render = () => {
    results.replaceChildren();
    const listed = Boolean(profile.model) && catalog.some(item => valueOf(item) === profile.model);
    const mismatched = !listed && FMModels.shapeMismatch(profile, provider);
    writes.textContent = `当前配置：${profile.model || '（空，使用 Harness 默认模型）'} · 推理强度：${profile.effort || '默认'}${mismatched ? ' · 保留原前缀' : ''}`;
    scope.hidden = !observed;
    if (observed) {
      const read = observed.observedAt ? `，读取于 ${date(observed.observedAt)}` : '';
      scope.textContent = `目录来源：${observed.source}${read}`;
    }
    if (loading || !observed) {
      const status = node('p', loading ? '正在读取模型…' : catalogWarning, 'readonly-note');
      status.setAttribute('role', 'status');
      results.append(status);
      return;
    }
    const query = search.value.trim().toLowerCase();
    if (catalogWarning) results.append(node('p', catalogWarning, 'readonly-note'));
    const ordered = FMModels.modelOrder(catalog, catalog.find(item => valueOf(item) === profile.model)?.value, isFavorite);
    const option = (label, value, icons, caption = '', route = false, item = {}) => {
      const row = node('div', null, 'model-choice');
      const button = node('button', null, 'model-option'); button.type = 'button';
      const selected = value !== undefined && profile.model === value;
      button.setAttribute('aria-pressed', String(selected));
      button.title = value || caption;
      if (value !== undefined) button.dataset.value = value;
      const words = node('span', null, 'model-words'); words.append(node('span', label, 'model-option-name'));
      if (value && value !== label) words.append(node('small', value, 'model-written'));
      if (caption && !item.id) words.append(node('small', caption));
      if (caption && item.id) button.title = `${value} · ${caption}`;
      const meta = node('span', null, 'model-meta');
      if (item.free || item.zero || /(^|[^a-z])free($|[^a-z])/i.test(`${item.id || ''} ${label}`)) meta.append(node('small', '免费', 'model-tag free'));
      if (item.rate) meta.append(node('small', `${item.rateWas ? `${item.rateWas}×→` : ''}${item.rate}×`, 'model-tag'));
      if (item.context) meta.append(node('small', item.context >= 1000000 ? `${+(item.context / 1000000).toFixed(2)}M` : `${Math.round(item.context / 1000)}K`, 'model-tag'));
      if (item.speed?.tps || item.speed?.ttft) meta.append(node('small', item.speed.tps ? `${Math.round(item.speed.tps)} TOKEN/秒` : `${(item.speed.ttft / 1000).toFixed(1)}s`, 'model-tag'));
      if (item.ref || item.via) meta.append(node('small', '经 MagPie', 'model-tag via'));
      else if (item.direct) {
        const throughGateway = item.gatewayId === value;
        const path = node('small', throughGateway ? '原生直连' : '直连，不经 MagPie', 'model-tag');
        path.title = `原生 Agent 直连 ${item.direct}`;
        meta.append(path);
        if (throughGateway) meta.append(node('small', '派工经 MagPie', 'model-tag via'));
      }
      if (item.fast || item.ultra) meta.append(node('small', item.ultra ? '极快' : '快速', 'model-tag'));
      button.disabled = value === undefined;
      const mark = item.disconnect ? FMModels.symbol('disconnect') : modelMark(icons, route);
      button.append(mark, words, meta, node('span', selected ? '✓' : '', 'model-tick'));
      if (!button.disabled) button.addEventListener('click', () => choose(value));
      row.append(button);
      if (item.id) {
        const star = node('button', null, 'model-star');
        star.type = 'button';
        star.setAttribute('aria-label', `收藏 ${label}`);
        star.setAttribute('aria-pressed', String(isFavorite(item)));
        star.append(FMModels.symbol('favorite'));
        star.onclick = () => {
          const key = favoriteKey(item);
          if (isFavorite(item)) favorites.delete(key); else favorites.add(key);
          try { localStorage.setItem(favoritesStorage(), JSON.stringify([...favorites])); } catch {}
          const position = results.scrollTop;
          render();
          results.scrollTop = position;
          (results.querySelector(`.model-choice:has([data-value="${CSS.escape(value)}"]) .model-star`) || groups.querySelector('[aria-pressed=true]'))?.focus({ preventScroll: true });
        };
        row.append(star);
      }
      results.append(row);
    };
    const draw = item => option(item.label, valueOf(item), item.icons,
      item.note && item.note !== item.label ? item.note.replace(/(^| · )via magpie$/, '') : '',
      item.group === 'Routing groups', item);
    if (!query && activeGroup !== 'favorites') {
      option('默认', '', [MARK_FILE[profile.harness]?.replace(/\.svg$/, '') || 'generic'], '使用 Harness 默认模型');
      if (observed.wired) option('断开 MagPie（还原配置）', undefined, [], '在 MagPie Agent 页还原工具配置', false, { disconnect: true });
    }
    const visible = ordered.filter(item => (
      activeGroup === 'favorites' ? isFavorite(item) : !activeGroup || item.provider === activeGroup
    ) && query.split(/\s+/).every(word => `${item.label} ${item.id} ${valueOf(item)} ${item.group || ''} ${item.note || ''}`.toLowerCase().includes(word)));
    if (!query && !activeGroup) {
      const index = visible.findIndex(item => valueOf(item) === profile.model);
      if (index >= 0) draw(visible.splice(index, 1)[0]);
      else if (profile.model) {
        const current = FMModels.describe(profile, [], provider);
        option(current.label, profile.model, current.icons, '当前配置 · 此目录未列出', current.route);
      }
    }
    let lastGroup;
    for (const item of visible) {
      if (!query && item.provider !== lastGroup) results.append(node('p', item.group === 'Routing groups' ? '路由组' : item.group || item.provider, 'model-group-title'));
      lastGroup = item.provider;
      draw(item);
    }
    if (!visible.length && (query || activeGroup)) results.append(node('p', activeGroup === 'favorites' && !query ? '还没有收藏的模型' : '没有匹配的模型', 'empty'));
  };
  const renderGroups = () => {
    groups.replaceChildren();
    const add = (label, value, icons = [], kind) => {
      const button = node('button', null, 'model-group'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(activeGroup === value));
      button.append(kind ? FMModels.symbol(kind) : modelMark(icons));
      button.addEventListener('click', () => { activeGroup = value; renderGroups(); render(); groups.querySelector(`[data-group="${CSS.escape(value)}"]`)?.focus({ preventScroll: true }); });
      button.dataset.group = value; groups.append(button);
    };
    add('全部模型', '', [], 'all');
    add('收藏', 'favorites', [], 'favorite');
    const seen = new Set();
    for (const item of FMModels.modelOrder(catalog, profile.model, isFavorite)) {
      if (seen.has(item.provider)) continue;
      seen.add(item.provider);
      if (item.group === 'Routing groups') add('路由组', item.provider, [], 'route');
      else add(item.group || item.provider, item.provider, item.groupIcon ? [item.groupIcon] : item.icons.slice(0, 1));
    }
  };
  const show = async () => {
    if (!panel.hidden) { close(true); return; }
    FMControls.close(); activeModelPicker?.close(); activeModelPicker = { element: picker, panel, close };
    panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(); const width = Math.min(520, innerWidth - 24);
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const height = Math.min(420, Math.max(below, above));
    panel.style.width = `${width}px`; panel.style.height = `${height}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
    panel.style.top = `${below >= height ? rect.bottom + 5 : Math.max(12, rect.top - height - 5)}px`;
    search.value = ''; activeGroup = ''; loading = true; observed = null; catalog = []; groups.replaceChildren();
    try { favorites = new Set(JSON.parse(localStorage.getItem(favoritesStorage()) || '[]')); } catch { favorites = new Set(); }
    paint(); render();
    search.focus({ preventScroll: true }); const current = ++request;
    try { await load(); if (current === request && !panel.hidden) { loading = false; renderGroups(); render(); } }
    // A failed read keeps the stored value and says so; it must not keep showing
    // the previous read's provenance as if it were current.
    catch (error) { if (current === request) { loading = false; catalog = []; observed = null; catalogWarning = `${error.message} · 当前值原样保留`; paint(); render(); } }
  };
  trigger.addEventListener('click', show);
  trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } });
  search.addEventListener('input', render);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (event.target === search || event.target.matches('.model-option'))) {
      if (event.target === search && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const items = [...results.querySelectorAll('.model-option:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      const item = items[next]; if (!item) return; item.focus({ preventScroll: true });
      const r = item.getBoundingClientRect(), box = results.getBoundingClientRect();
      if (r.top < box.top) results.scrollTop -= box.top - r.top;
      if (r.bottom > box.bottom) results.scrollTop += r.bottom - box.bottom;
    }
  });
  picker.addEventListener('focusout', event => {
    if (event.relatedTarget && !picker.contains(event.relatedTarget) && !panel.hidden) close();
  });
  paint(); queueMicrotask(() => load().catch(() => {}));
  return { element: picker, refresh() {
    if (loadedHarness !== `${targetSeat(profile)}/${profile.harness}`) {
      close(); observed = null; catalog = []; queueMicrotask(() => load().catch(() => {}));
    }
    paint();
  } };
}

function profileFields(profile, onChange, provider = '') {
  const block = node('div', null, 'profile-edit');
  if (currentHome()?.role?.kind === 'secondmate') {
    for (const [label, value] of [['Harness', profile.harness], ['模型', profile.model || '默认模型'], ['推理强度', profile.effort || '默认']]) {
      const row = node('div', null, 'd-row'); row.append(node('span', label), node('span', value)); block.append(row);
    }
    block.refresh = () => {}; return block;
  }
  const harnessRow = node('div', null, 'd-row');
  const modelRow = node('div', null, 'd-row');
  const effortRow = node('div', null, 'd-row');
  const effortBox = node('div', null, 'effort-pick');
  const names = HARNESSES.includes(profile.harness) ? HARNESSES : [profile.harness, ...HARNESSES].filter(Boolean);
  const model = modelPicker(profile, onChange, provider);
  const options = names.map(name => ({ value: name, label: name, render: () => { const mark = node('span', '', 'mark'); paintMark(mark, name); return mark; } }));
  const harness = FMControls.menu('Harness', options, profile.harness, value => {
    profile.harness = value;
    fillEfforts(effortBox, profile, onChange, provider); model.refresh(); onChange();
  });
  harnessRow.append(node('span', 'Harness'), harness);
  modelRow.append(node('span', '模型'), model.element);
  effortRow.append(node('span', '推理强度'), effortBox);
  fillEfforts(effortBox, profile, onChange, provider); block.append(harnessRow, modelRow, effortRow);
  block.refresh = () => { harness.setOptions(options, profile.harness); model.refresh(); fillEfforts(effortBox, profile, onChange, provider); };
  return block;
}

function wireProfile(detail, profile, source, paint, heading) {
  if (heading) detail.append(node('p', heading, 'readonly-note'));
  const block = profileFields(profile, paint, source.provider); detail.append(block); return block;
}

function repaintMates() {
  for (const paint of matePaints) paint();
  filterMates();
}

function addRuleCard(root, spec) {
  const card = node('article', null, 'rule-card');
  const face = node('div', null, 'rule-face');
  const summaryButton = node('button', null, 'rule-summary'); summaryButton.type = 'button';
  const detailsButton = node('button', '详情', 'row-details'); detailsButton.type = 'button';
  summaryButton.setAttribute('aria-expanded', 'false'); detailsButton.setAttribute('aria-expanded', 'false');
  const mark = node('span', '', 'mark');
  const badge = node('span', '', 'seat-badge');
  const who = node('span', null, 'who');
  const line = node('span', null, 'name-line');
  line.append(node('span', '', 'h-label'), node('span', spec.title, 'rule-name'));
  who.append(line, node('span', '', 'sub'));
  const pill = node('span', '', 'effort-pill');
  summaryButton.append(mark, badge, who);
  const seats = data?.catalogSeats || [];
  const selectedSeat = () => {
    const key = seatKey(spec.whenText());
    return key === SEAT_NONE ? 'primary' : key;
  };
  for (const profile of spec.profiles) profileSeats.set(profile, selectedSeat);
  const firstProfile = spec.profiles[0];
  const rowModel = currentHome()?.role?.kind !== 'secondmate' && firstProfile ? modelPicker(firstProfile, () => paint(), spec.sources[0]?.provider) : null;
  const readonlyModel = node('span', null, 'model-trigger readonly-model');
  face.append(summaryButton, detailsButton, rowModel?.element || readonlyModel, pill);
  const detail = node('div', null, 'rule-detail');
  detail.hidden = true;
  const toggle = () => {
    const open = detail.hidden;
    detail.hidden = !open;
    card.classList.toggle('open', open);
    summaryButton.setAttribute('aria-expanded', String(open)); detailsButton.setAttribute('aria-expanded', String(open));
    detailsButton.textContent = open ? '收起' : '详情';
  };
  summaryButton.addEventListener('click', toggle); detailsButton.addEventListener('click', toggle);
  card.append(face, detail);
  const editors = [];
  const paint = () => {
    const profiles = spec.profiles;
    const first = profiles[0] || { harness: '', model: '', effort: '' };
    paintMark(mark, first.harness);
    const summary = who.querySelector('.sub');
    const catalogTarget = `${targetSeat(first)}/${first.harness}`;
    catalogFor(first).then(catalog => {
      if (!summary.isConnected || catalogTarget !== `${targetSeat(first)}/${first.harness}`) return;
      FMModels.paint(summary, FMModels.describe(first, catalog.models, spec.sources[0]?.provider), catalog.customIcons);
      FMModels.paint(readonlyModel, FMModels.describe(first, catalog.models, spec.sources[0]?.provider), catalog.customIcons);
      if (profiles.length > 1) summary.append(node('small', `另有 ${profiles.length - 1} 个候选`));
    }).catch(() => {});
    line.querySelector('.h-label').textContent = first.harness || '未选 Harness';
    FMModels.paint(who.querySelector('.sub'), FMModels.describe(first, [], spec.sources[0]?.provider));
    if (profiles.length > 1) who.querySelector('.sub').append(node('small', `另有 ${profiles.length - 1} 个候选`));
    pill.textContent = first.effort || '不设';
    pill.classList.toggle('is-empty', !first.effort);
    rowModel?.refresh(); FMModels.paint(readonlyModel, FMModels.describe(first, [], spec.sources[0]?.provider));
    for (const editor of editors) editor.refresh();
    const key = seatKey(spec.whenText());
    card.dataset.seat = key;
    badge.dataset.tone = toneFor(key);
    badge.textContent = seatLabel(key);
    card.dataset.filter = `${spec.title} ${seatLabel(key)} ${spec.whenText()} ${spec.why} ${profiles.map(item => `${item.harness} ${item.model} ${item.effort}`).join(' ')}`.toLowerCase();
  };
  detail.append(node('p', spec.useKind === 'array' ? `use 是 ${spec.sources.length} 个候选，顺序保持不变` : 'use 是单个配置', 'readonly-note'));
  spec.sources.forEach((source, index) => {
    editors.push(wireProfile(detail, spec.profiles[index], source, paint, spec.sources.length > 1 ? `候选 ${index + 1}` : ''));
  });
  if (spec.onWhen) {
    const when = node('label', null, 'd-row stack');
    when.append(node('span', '匹配条件 when'));
    const area = node('textarea');
    area.value = spec.whenValue;
    area.rows = 3;
    if (seats.length && currentHome()?.role?.kind === 'primary') {
      const select = node('select');
      select.setAttribute('aria-label', '执行席位');
      for (const id of new Set([SEAT_NONE, 'primary', ...seats, seatKey(area.value)])) {
        const option = node('option', seatLabel(id)); option.value = id; select.append(option);
      }
      select.value = seatKey(area.value);
      select.onchange = () => {
        const text = area.value.replace(/\[seat:\s*[^\]]+\]\s*/, '');
        area.value = select.value === SEAT_NONE ? text : `[seat: ${select.value}] ${text}`;
        area.dispatchEvent(new Event('input'));
      };
      area.addEventListener('input', () => { select.value = seatKey(area.value); });
      const target = node('label', null, 'd-row'); target.append(node('span', '执行席位'), select); detail.append(target);
    }
    area.addEventListener('input', () => { spec.onWhen(area.value); paint(); renderSeatFilters(); filterDispatch(); });
    when.append(area);
    detail.append(when);
  } else if (spec.whenValue !== undefined) {
    const when = node('div', null, 'd-row stack');
    when.append(node('span', '匹配条件 when'), node('p', spec.whenValue, 'why-text when-text'));
    detail.append(when);
  }
  const whyRow = node('div', null, 'd-row');
  whyRow.append(node('span', '说明 why'));
  whyRow.append(node('p', spec.why || '没有 why 说明。保存不会新增或改掉这条说明。', 'why-text'));
  detail.append(whyRow);
  paint();
  root.append(card);
}

function renderDispatch(home, options = {}) {
  const root = $('rules');
  root.replaceChildren();
  $('review').hidden = true;
  pending = null;
  const remoteAuthority = home?.dispatchAuthority;
  const remoteReadOnly = Boolean(home?.remote) && !remoteAuthority;
  const inherited = home?.role?.kind === 'secondmate';
  $('sync').disabled = remoteReadOnly || (inherited ? home.parent?.status !== 'connected' : !home?.dispatch);
  $('sync').hidden = remoteReadOnly;
  $('preview').hidden = remoteReadOnly;
  $('sync').textContent = inherited ? '从大副同步' : '推送已保存的派工规则';
  $('sync-caption').textContent = remoteAuthority ? '保存写入远端大副的派工文件。另行推送后，可查看每个二副 Home 的回执。' : remoteReadOnly ? '这个远端 Home 只读。派工规则没有配置读写入口。' : inherited ? '当前是本机二副。请在大副页面编辑派工规则，再从大副同步。' : '保存写入本机大副的派工文件。另行推送后，可查看每个二副 Home 的回执。';
  if (!home?.dispatch) {
    draft = null;
    $('preview').disabled = true;
    $('restore').hidden = true;
    $('seat-filters').hidden = true;
    $('seat-filters').replaceChildren();
    $('seat-empty').hidden = true;
    root.append(node('div', home?.dispatchError || (remoteReadOnly ? '此远端 Home 的派工文件未读取。' : '没有可编辑的 crew-dispatch.json'), 'empty'));
    return;
  }
  if (!options.keepDraft) draft = {
    rules: home.dispatch.rules.map(rule => ({
      when: rule.when,
      use: rule.use.map(item => ({ harness: item.harness, model: item.model, effort: item.effort })),
    })),
    default: home.dispatch.default ? home.dispatch.default.use.map(item => ({ harness: item.harness, model: item.model, effort: item.effort })) : null,
  };
  home.dispatch.rules.forEach((rule, index) => {
    let whenText = draft.rules[index].when;
    addRuleCard(root, {
      title: nameOf(rule),
      why: rule.why,
      useKind: rule.useKind,
      whenValue: whenText,
      whenText: () => whenText,
      onWhen: inherited ? null : value => { whenText = value; draft.rules[index].when = value; },
      sources: rule.use,
      profiles: draft.rules[index].use,
    });
  });
  if (home.dispatch.default) {
    addRuleCard(root, {
      title: '默认规则',
      why: '',
      useKind: home.dispatch.default.useKind,
      whenText: () => '',
      sources: home.dispatch.default.use,
      profiles: draft.default,
    });
  }
  $('preview').disabled = inherited || remoteReadOnly;
  root.inert = remoteReadOnly;
  const backup = home.dispatch.latestBackup;
  $('restore').hidden = inherited || remoteReadOnly || !backup;
  $('restore').dataset.backup = backup?.id || '';
  renderSeatFilters();
  filterDispatch();
}

function renderSeatFilters() {
  const box = $('seat-filters');
  const cards = [...document.querySelectorAll('#rules .rule-card')];
  if (!draft) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const counts = new Map();
  for (const card of cards) counts.set(card.dataset.seat, (counts.get(card.dataset.seat) || 0) + 1);
  const present = new Set(counts.keys());
  const keys = [...present].filter(key => key !== SEAT_NONE && key !== 'primary').sort((a, b) => a.localeCompare(b));
  if (present.has('primary')) keys.unshift('primary');
  const items = [
    ['all', '全部', cards.length],
    ...keys.map(key => [key, seatLabel(key), counts.get(key) || 0, toneFor(key)]),
    [SEAT_NONE, '未指定', counts.get(SEAT_NONE) || 0, 'c7'],
  ];
  if (!items.some(([key]) => key === seatFilter)) seatFilter = 'all';
  box.hidden = false;
  box.replaceChildren();
  for (const [key, label, count, tone] of items) {
    const btn = node('button');
    btn.type = 'button';
    btn.className = 'seat-filter';
    btn.dataset.seatFilter = key;
    if (tone) btn.dataset.tone = tone;
    btn.setAttribute('aria-pressed', String(seatFilter === key));
    btn.append(node('span', label, 'seat-label'), node('span', String(count), 'seat-count'));
    btn.addEventListener('click', () => {
      seatFilter = key;
      filterDispatch();
    });
    box.append(btn);
  }
}

function filterDispatch() {
  const query = $('search').value.trim().toLowerCase();
  const cards = [...document.querySelectorAll('#rules .rule-card')];
  for (const card of cards) {
    const seatOk = seatFilter === 'all' || card.dataset.seat === seatFilter;
    const textOk = query === '' || String(card.dataset.filter || '').includes(query);
    card.hidden = !(seatOk && textOk);
  }
  for (const btn of document.querySelectorAll('#seat-filters .seat-filter')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.seatFilter === seatFilter));
  }
  const empty = $('seat-empty');
  const noneShown = cards.length > 0 && cards.every(card => card.hidden);
  empty.hidden = !noneShown;
  if (noneShown) empty.textContent = query ? '没有匹配的派工规则' : `没有${seatLabel(seatFilter)}的派工规则`;
}

const auditLabels = { match: '与保存选择一致', difference: '差异待复核', unknown: '缺少核对记录' };
let chartFilter = { role: null, harness: null, status: null };
let chartHome = null;
let showZeroRoles = false;
const chartColors = ['#a5b4fc', '#5cc8b0', '#e5b778', '#ce9be9', '#75b4ec'];
const statusColors = { match: '#a5b4fc', difference: '#e5b778', unknown: '#676b7b' };
const recordRole = record => `${record.dispatchEvidence?.seat || 'unspecified'}/${record.dispatchEvidence?.taskType || 'unspecified'}`;
const roleTitle = group => `${group.seat === 'unspecified' ? '监督席未记录' : group.seat === 'primary' ? '大副' : group.seat} · ${group.taskType === 'unspecified' ? '职责未记录' : group.taskType}`;
function svgNode(tag, attrs = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function renderCharts(tasks, groups, repaint) {
  const root = $('dispatch-charts');
  root.replaceChildren();
  const controls = node('div', null, 'chart-controls');
  controls.append(node('span', '点击条形、圆环或图例筛选；再次点击取消。', 'caption'));
  const reset = node('button', '清除图表筛选', 'secondary');
  reset.disabled = !Object.values(chartFilter).some(Boolean);
  reset.addEventListener('click', () => { chartFilter = { role: null, harness: null, status: null }; repaint(); });
  controls.append(reset);
  const grid = node('div', null, 'chart-grid');
  const roles = node('article', null, 'chart-card');
  roles.append(node('h3', '职责 × 启动任务数'), node('p', '颜色表示保存选择的核对结果，横轴为任务数。', 'caption'));
  const roleTasks = tasks.filter(r => (!chartFilter.harness || r.harness === chartFilter.harness) && (!chartFilter.status || (r.dispatchEvidence?.comparison || 'unknown') === chartFilter.status));
  const roleGroups = [...groups.entries()].map(([key, group]) => ({ key, group, records: roleTasks.filter(r => recordRole(r) === key) })).sort((a, b) => b.records.length - a.records.length);
  const max = Math.max(1, ...roleGroups.map(g => g.records.length));
  const axis = node('div', null, 'chart-axis');
  axis.append(node('span', '0'), node('span', `${max} 个任务`));
  roles.append(axis);
  for (const { key, group, records } of roleGroups.filter(g => showZeroRoles || g.records.length || chartFilter.role === g.key)) {
    const bar = node('button', null, 'role-bar');
    bar.type = 'button';
    bar.setAttribute('aria-pressed', String(chartFilter.role === key));
    bar.setAttribute('aria-label', `${roleTitle(group)}，${records.length} 个任务`);
    bar.title = `${roleTitle(group)}：${records.length} 个保留任务，点击筛选`;
    bar.append(node('span', roleTitle(group), 'bar-label'));
    const track = node('span', null, 'bar-track');
    const stack = node('span', null, 'bar-stack');
    stack.style.width = `${records.length / max * 100}%`;
    for (const [status, label] of Object.entries(auditLabels)) {
      const count = records.filter(r => (r.dispatchEvidence?.comparison || 'unknown') === status).length;
      if (!count) continue;
      const segment = node('span');
      segment.style.width = `${count / records.length * 100}%`;
      segment.style.background = statusColors[status];
      segment.title = `${label}：${count}`;
      stack.append(segment);
    }
    track.append(stack);
    bar.append(track, node('strong', String(records.length), 'bar-count'));
    bar.addEventListener('click', () => { chartFilter.role = chartFilter.role === key ? null : key; repaint(); });
    roles.append(bar);
  }
  const zeros = roleGroups.filter(g => !g.records.length).length;
  if (zeros) {
    const toggle = node('button', showZeroRoles ? '收起零记录职责' : `显示 ${zeros} 项零记录职责`, 'chart-zero');
    toggle.addEventListener('click', () => { showZeroRoles = !showZeroRoles; repaint(); });
    roles.append(toggle);
  }
  const legend = node('div', null, 'chart-status');
  for (const [status, label] of Object.entries(auditLabels)) {
    const button = node('button', null, 'chart-legend');
    const dot = node('i'); dot.style.background = statusColors[status];
    button.append(dot, node('span', label));
    button.setAttribute('aria-pressed', String(chartFilter.status === status));
    button.addEventListener('click', () => { chartFilter.status = chartFilter.status === status ? null : status; repaint(); });
    legend.append(button);
  }
  roles.append(legend);
  const harnesses = node('article', null, 'chart-card');
  harnesses.append(node('h3', '船员 Harness 分布'), node('p', '圆环按保留任务数分配，不是在线船员数。', 'caption'));
  const harnessTasks = tasks.filter(r => (!chartFilter.role || recordRole(r) === chartFilter.role) && (!chartFilter.status || (r.dispatchEvidence?.comparison || 'unknown') === chartFilter.status));
  const svg = svgNode('svg', { viewBox: '0 0 220 220', class: 'crew-donut', role: 'group', 'aria-label': '船员 Harness 分布，可点击圆环筛选' });
  svg.append(svgNode('circle', { cx: 110, cy: 110, r: 77, fill: 'none', stroke: 'var(--line)', 'stroke-width': 27 }));
  const names = [...new Set(tasks.map(r => r.harness || '未记录'))].sort();
  const harnessLegend = node('div', null, 'harness-legend');
  let offset = 0;
  names.forEach((harness, index) => {
    const count = harnessTasks.filter(r => (r.harness || '未记录') === harness).length;
    const fraction = count / (harnessTasks.length || 1);
    const color = chartColors[index % chartColors.length];
    const choose = () => { chartFilter.harness = chartFilter.harness === harness ? null : harness; repaint(); };
    if (count) {
      const slice = svgNode('circle', { cx: 110, cy: 110, r: 77, fill: 'none', stroke: color, 'stroke-width': chartFilter.harness === harness ? 33 : 27, pathLength: 100, 'stroke-dasharray': `${Math.max(.01, fraction * 100 - .7)} ${100 - Math.max(.01, fraction * 100 - .7)}`, 'stroke-dashoffset': -offset * 100, transform: 'rotate(-90 110 110)', tabindex: 0, role: 'button', 'aria-label': `${harness}：${count} 个任务，占 ${Math.round(fraction * 100)}%`, 'aria-pressed': String(chartFilter.harness === harness), class: 'donut-slice' });
      const title = svgNode('title'); title.textContent = `${harness} · ${count} 个任务 · ${Math.round(fraction * 100)}%`;
      slice.append(title); slice.addEventListener('click', choose);
      slice.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(); } });
      svg.append(slice);
    }
    offset += fraction;
    const button = node('button', null, 'chart-legend harness-item');
    button.setAttribute('aria-pressed', String(chartFilter.harness === harness));
    const dot = node('i'); dot.style.background = color;
    button.append(dot, node('span', harness), node('strong', String(count)), node('span', `${Math.round(fraction * 100)}%`, 'caption'));
    button.addEventListener('click', choose); harnessLegend.append(button);
  });
  const total = svgNode('text', { x: 110, y: 107, 'text-anchor': 'middle', class: 'donut-total' }); total.textContent = String(harnessTasks.length);
  const subtitle = svgNode('text', { x: 110, y: 130, 'text-anchor': 'middle', class: 'donut-label' }); subtitle.textContent = '保留任务';
  svg.append(total, subtitle);
  const donutBody = node('div', null, 'donut-body'); donutBody.append(svg, harnessLegend); harnesses.append(donutBody);
  grid.append(roles, harnesses); root.append(controls, grid);
}

function renderAudit(home, records) {
  if (chartHome !== home.path) { chartHome = home.path; chartFilter = { role: null, harness: null, status: null }; }
  const tasks = records.filter(record => ['ship', 'scout'].includes(record.kind));
  const metrics = $('dispatch-summary');
  metrics.replaceChildren();
  for (const [label, count] of [
    ['保留任务', tasks.length],
    ...Object.entries(auditLabels).map(([status, label]) => [label, tasks.filter(record => (record.dispatchEvidence?.comparison || 'unknown') === status).length]),
  ]) {
    const item = node('div', null, 'audit-metric');
    item.append(node('strong', String(count)), node('span', label));
    metrics.append(item);
  }
  const groups = new Map();
  const ensure = (seat, taskType) => {
    const key = `${seat}/${taskType}`;
    if (!groups.has(key)) groups.set(key, { seat, taskType, tasks: [], planned: [] });
    return groups.get(key);
  };
  for (const rule of home.rules.filter(rule => !rule.isDefault)) {
    const taskType = rule.when.match(/task-type:\s*([\w-]+)/)?.[1];
    if (taskType) ensure(seatKey(rule.when), taskType).planned.push(...rule.use);
  }
  for (const record of tasks) {
    const evidence = record.dispatchEvidence || {};
    ensure(evidence.seat || 'unspecified', evidence.taskType || 'unspecified').tasks.push(record);
  }
  const root = $('dispatch-audit');
  root.replaceChildren();
  renderCharts(tasks, groups, () => renderAudit(home, records));
  const selected = tasks.filter(r => (!chartFilter.role || recordRole(r) === chartFilter.role) && (!chartFilter.harness || (r.harness || '未记录') === chartFilter.harness) && (!chartFilter.status || (r.dispatchEvidence?.comparison || 'unknown') === chartFilter.status));
  const hasSelection = Object.values(chartFilter).some(Boolean);
  root.append(node('h3', hasSelection ? `选中任务 · ${selected.length} 个` : '任务明细', 'chart-detail-title'));
  if (!hasSelection) { root.append(node('p', '点击上方图表中的职责、船员或核对图例，在这里查看对应任务。', 'caption')); return; }
  if (!selected.length) root.append(node('p', '当前筛选下未见保留任务记录。', 'caption'));
  for (const group of [...groups.values()].sort((a, b) => b.tasks.length - a.tasks.length)) {
    const visible = selected.filter(r => recordRole(r) === `${group.seat}/${group.taskType}`);
    if (!visible.length) continue;
    const detail = node('details', null, 'audit-group');
    detail.open = true;
    const summary = node('summary');
    const title = node('div');
    title.append(node('strong', `${group.seat === 'unspecified' ? '监督席未记录' : group.seat} · ${group.taskType === 'unspecified' ? '职责未记录' : group.taskType}`));
    const actual = [...new Set(visible.map(record => record.harness || '未记录'))].map(harness => `${harness} × ${visible.filter(record => (record.harness || '未记录') === harness).length}`).join(' / ');
    title.append(node('span', actual ? `实际启动：${actual}` : '未见保留任务记录', 'sub'));
    summary.append(title, node('span', `${visible.length} 个任务`, 'tag'));
    detail.append(summary);
    const content = node('div', null, 'audit-content');
    content.append(node('p', `当前配置候选：${group.planned.map(p => `${p.harness} · ${p.model || '默认模型'}`).join('；') || '无对应的明确职责规则（可能走默认规则）'}`, 'caption'));
    if (visible.length) {
      const bar = node('div', null, 'audit-bar');
      for (const [status, label] of Object.entries(auditLabels)) {
        const count = visible.filter(r => (r.dispatchEvidence?.comparison || 'unknown') === status).length;
        if (!count) continue;
        const segment = node('span', `${label} ${count}`, `audit-${status}`);
        segment.style.flex = String(count);
        bar.append(segment);
      }
      content.append(bar);
    }
    for (const record of visible) {
      const item = node('div', null, 'audit-task');
      const evidence = record.dispatchEvidence;
      item.append(node('strong', record.id), node('span', `${record.harness} · ${record.model || '默认模型'} · ${record.effort || '未记录强度'}`, 'sub'));
      item.append(node('span', `${auditLabels[evidence?.comparison || 'unknown']}${record.override ? ' · 有显式覆盖登记' : ''}`, 'tag'));
      item.append(node('p', `保存的选择：${evidence?.selected ? `${evidence.selected.harness} · ${evidence.selected.model || '默认模型'} · ${evidence.selected.effort || '未指定强度'}` : '无可核对选择'}`, 'caption'));
      item.append(node('p', [record.source, ...(evidence?.sources || [])].join(' · '), 'evidence-source'));
      content.append(item);
    }
    detail.append(content);
    root.append(detail);
  }
  if (!groups.size) root.append(node('div', '没有职责规则或任务记录', 'empty'));
}

function renderSupervisors(home) {
  const root = $('supervisors');
  root.replaceChildren();
  $('primary-count').textContent = home.readable ? (home.role?.kind === 'primary' || home.parent?.status === 'connected' ? '1' : '0') : '—';
  const remote = home.remote;
  const role = home.dispatchAuthority ? '大副 · 远端派工来源' : remote ? home.role?.kind === 'primary' ? '大副 · 远端只读' : home.role?.kind === 'secondmate' ? '二副 · 远端只读' : '身份未核实' : home.role?.kind === 'secondmate' ? '本机二副' : home.role?.kind === 'primary' ? '本机大副' : '身份未核实';
  const readSource = home.readSource || `ssh ${remote?.ssh || '远端'} · 只读`;
  const supervisors = [{ title: `${home.name} · ${role}`, machine: home.machine, home: home.path, source: remote ? (home.readable ? `${readSource} · 读取于 ${date(home.observedAt)}` : readSource) : home.role?.source || '插件明确配置的 Home' }];
  if (home.parent?.status === 'connected') {
    const parent = home.parent;
    supervisors.unshift({ title: `${parent.name} · ${parent.local ? '本机大副' : '远端大副'}`, machine: parent.machine, home: parent.path, source: `已连接大副 v${parent.version} · ${date(parent.observedAt)}` });
  }
  for (const mate of home.secondmate?.mates || []) {
    if (home.hiddenSecondmates?.includes(mate.id)) continue;
    const record = home.records.find(r => r.id === mate.id && r.kind === 'secondmate');
    supervisors.push({ title: `${mate.id} · ${record?.remote ? '远端二副' : '本机二副'}`, machine: record?.location?.machine || '机器未登记', home: record?.location?.home || '工作目录未登记', source: record?.source || '仅见配置名单，未见启动登记' });
  }
  for (const supervisor of supervisors) {
    const card = node('article', null, 'supervisor-card');
    if (remote && supervisor === supervisors[0] && !home.dispatchAuthority) card.dataset.remote = 'read-only';
    card.append(node('strong', supervisor.title), node('span', supervisor.machine, 'tag'), node('code', supervisor.home), node('p', `${supervisor.source}${remote && supervisor === supervisors[0] && !home.dispatchAuthority ? ' · 只读' : ''} · 在线状态未核实`, 'caption'));
    root.append(card);
  }
  if (remote) {
    const note = node('article', null, 'supervisor-card');
    note.append(node('strong', home.dispatchAuthority ? '远端大副派工文件' : '远端只读 Home'), node('span', remote.ssh, 'tag'), node('code', remote.path));
    const message = home.dispatchAuthority ? '请在「派工规则」页管理总派工文件和额度来源。' : home.readable ? '这个 Home 通过既有 SSH 别名读取配置。' : '未能读取远端 Home。';
    note.append(node('p', message, 'caption'));
    root.append(note);
  }
  const supervision = home.supervision;
  if (!supervision) {
    $('supervision-count').textContent = '后台监督：数据接口待刷新';
    const pending = node('article', null, 'supervisor-card');
    pending.append(node('strong', '后台监督助手'), node('span', home.machine, 'tag'), node('p', '当前服务未提供监督数据；不能据此判断助手是否运行。请刷新插件服务。', 'caption'));
    root.append(pending);
    return;
  }
  if (supervision?.read === false) {
    // Not read is not the same as "nothing there": say so instead of rendering
    // everyday local-monitor wording over a remote Home we never inspected.
    $('supervision-count').textContent = '后台监督：未读取远端';
    const card = node('article', null, 'supervisor-card monitor-card');
    card.append(node('strong', '后台监督助手'), node('span', home.machine, 'tag'), node('code', home.path || 'Home 未知'));
    card.append(node('p', '本次只读接入没有读取这个远端 Home 的后台监督配置与心跳；这里不推断它是否启用或运行。', 'caption'));
    root.append(card);
    return;
  }
  const hasEvidence = Boolean(supervision?.host || supervision?.engine || supervision?.heartbeat);
  $('supervision-count').textContent = hasEvidence ? '后台监督：有记录' : '后台监督：未见记录';
  const card = node('article', null, 'supervisor-card monitor-card');
  card.append(node('strong', '后台监督助手'), node('span', home.machine, 'tag'), node('code', home.path || 'Home 未知'));
  const policy = supervision?.policy === 'off' ? '配置：已显式关闭' : supervision?.policy === 'explicit' ? `配置：显式启用 ${supervision.configured?.engine || '默认引擎'} ${supervision.configured?.model || ''}` : '配置：按主控默认；Claude 默认启用，其他 Harness 各有规则';
  card.append(node('p', policy, 'caption'));
  const engine = supervision?.engine;
  card.append(node('p', engine ? `最近引擎记录：${engine.engine || '未记录'} · ${engine.model || '默认模型'}（${date(engine.modified)}）` : '最近引擎记录：未见', 'caption'));
  const host = supervision?.host;
  card.append(node('p', host ? `监督宿主 PID ${host.pid}：${host.pidExists === true ? '检测到进程' : host.pidExists === false ? '未检测到进程' : '无法检测'}；归属及健康未核验` : '监督宿主：未见进程登记，运行状态未知', 'caption'));
  card.append(node('p', supervision?.heartbeat ? `事件 Watcher 最后心跳：${date(supervision.heartbeat)}` : '事件 Watcher：未见心跳记录', 'caption'));
  card.append(node('p', '监督助手和事件 Watcher 不计入二副；心跳时间不等于全链路健康。', 'caption'));
  if (supervision?.sources.length) card.append(node('p', `来源：${supervision.sources.join(' · ')}`, 'evidence-source'));
  if (supervision?.warnings.length) card.append(node('p', supervision.warnings.join('；'), 'caption'));
  root.append(card);
}

function renderRecords() {
  if (!data) return;
  const home = currentHome();
  if (!home) { say('error', '未配置可读取的 Home。请在此插件选项中设置 homes。'); return; }
  const query = $('search').value.trim().toLowerCase();
  const match = value => JSON.stringify(value).toLowerCase().includes(query);
  const shownRecords = home.records.filter(record => record.kind !== 'secondmate' || !home.hiddenSecondmates?.includes(record.id));
  const records = shownRecords.filter(match);
  renderAudit(home, records);
  renderSupervisors(home);
  const dispatchUnread = home.remote && !home.dispatch;
  $('rule-count').textContent = dispatchUnread ? '未读取' : home.rules.length;
  $('rule-count-label').textContent = dispatchUnread ? '远端派工文件' : '条派工规则';
  $('record-count').textContent = shownRecords.length;
  $('quota').textContent = dispatchUnread ? '派工文件未读取' : home.sharedQuota ? '派工已声明共享额度' : '派工未声明共享额度';
  $('records-note').textContent = home.remote
    ? `来源：远端 state/*.meta 的少数字段（${home.readSource || `ssh ${home.remote.ssh} · 只读`}）。最多读取 300 条；未读取远端任务 brief.md 与 dispatch-resolution.json，因此这里不会给出职责或核对结论，记录本身也不是完整历史。`
    : '来源：state/*.meta、任务 brief.md 与 dispatch-resolution.json。最多读取 300 条保留记录；清理、重启或重新解析可能改变记录，不是完整历史。';
  $('rule-source').textContent = dispatchUnread
    ? '来源：远端派工文件未读取'
    : `来源：${home.dispatchAuthority ? `${home.machine} · ` : ''}${home.ruleSource || '无规则文件'}${home.ruleModified ? ` · 修改于 ${date(home.ruleModified)}` : ''}`;
  filterDispatch();
  filterMates();
  $('records').replaceChildren();
  for (const record of (showAll ? records : records.slice(0, 10))) {
    const row = node('tr');
    const title = node('td');
    title.append(node('div', record.id, 'task-name'), node('span', `${record.kind}${record.remote ? ' · 远端登记' : ' · 本机记录'}`, 'sub'));
    title.title = `${record.source} · ${date(record.modified)}`;
    const model = node('td');
    model.append(node('code', record.model || '未记录'));
    const state = node('td');
    state.append(node('span', '未核实', 'pending'));
    row.append(title, node('td', record.harness || '未记录'), model, node('td', record.effort || '未记录'), state);
    $('records').append(row);
  }
  if (!records.length) {
    const row = node('tr');
    const cell = node('td', '没有匹配的启动记录', 'empty');
    cell.colSpan = 5;
    row.append(cell);
    $('records').append(row);
  }
  $('more').hidden = records.length <= 10;
  $('more').textContent = showAll ? '收起记录' : `展开全部 ${records.length} 条记录`;
  $('home-path').textContent = home.path || '不可读取';
  $('observed').textContent = date(data.observedAt);
  const copy = home.dispatchAuthority
    ? { writable: '「派工规则」可保存远端大副的 config/crew-dispatch.json 和 config/quota-source。派工文件通过单独操作推送。', unwritable: '远端大副的副手启动配置、其他设置和启动记录只读。', before: '远端大副用 Firstmate 原生派工校验，核对文件版本后才写入。', backup: '派工备份保存在远端大副主机，保存后在原处读回核对。' }
    : home.remote
    ? { writable: '不能修改任何一项。这个 Home 在远端机器上，本插件只有一条只读 SSH 读取，没有写通道：不能保存派工规则、副手启动配置或设置。', unwritable: '本次只读接入不接触运行中的会话、不重启任何席、不写 state/*.meta；读取到的是保存的配置，不是运行状态。', before: '只在远端执行一条固定的只读命令，读取 config/secondmate-harness 与 state/*.meta 的少数字段；不建临时文件、不写配置文件、不在远端运行解析器。', backup: '不适用：没有写入，也就没有本机备份。' }
    : { writable: '选项里这个 Home 的 config/crew-dispatch.json：规则 when、每个候选的 harness / model / effort，以及 default。另一页改 config/secondmate-harness：各二副的独立配置。保存时会移除旧默认行。两份文件分开保存，没改到的注释和字段会原样留下。', unwritable: 'state/*.meta、运行中的模型、船员和副手的生命周期。保存不会重启任何席，也不会改它当前正在用的配置。', before: '派工用 First Mate 现有的 crew-dispatch 校验。副手启动配置用 fm-harness.sh 的 secondmate 解析器，解析失败会原样显示，不会跳过那一行。写入前展示差异，并确认文件自读取后没有被别人改过。', backup: '备份保存在插件配置的备份目录，保存后会读回核对。' };
  $('sources-writable').textContent = copy.writable;
  $('sources-unwritable').textContent = copy.unwritable;
  $('sources-before').textContent = copy.before;
  $('sources-backup').textContent = copy.backup;
  $('warnings').replaceChildren();
  if (home.warnings.length) $('warnings').append(node('div', home.warnings.join('；'), 'warnings'));
}

const UNSET_MATE = '未设置，将回退到船员默认工具';

function addLaunchCard(root, mate, home) {
  const isSet = mate.source === 'override';
  const card = node('article', null, 'mate-card');
  card.dataset.mate = mate.id;
  const face = node('div', null, 'rule-face');
  const summaryButton = node('button', null, 'rule-summary'); summaryButton.type = 'button';
  const detailsButton = node('button', '详情', 'row-details'); detailsButton.type = 'button';
  const mark = node('span', '', 'mark');
  const badge = node('span', isSet ? '独立配置' : '未设置', 'origin-badge');
  badge.dataset.origin = mate.source;
  const who = node('span', null, 'who');
  const line = node('span', null, 'name-line');
  const harnessLabel = node('span', '', 'h-label');
  harnessLabel.hidden = !isSet;
  line.append(harnessLabel, node('span', mate.id, 'rule-name'));
  who.append(line);
  if (!isSet) who.append(node('span', UNSET_MATE, 'sub mate-fallback'));
  const pill = node('span', '', 'effort-pill');
  summaryButton.append(mark, badge, who);
  const detail = node('div', null, 'mate-detail');
  const setOpen = open => {
    detail.hidden = !open;
    card.classList.toggle('open', open);
    summaryButton.setAttribute('aria-expanded', String(open));
    detailsButton.setAttribute('aria-expanded', String(open));
    detailsButton.textContent = open ? '收起' : '详情';
  };
  setOpen(openMate === mate.id);
  const toggle = () => {
    const open = detail.hidden;
    openMate = open ? mate.id : null;
    setOpen(open);
  };
  summaryButton.addEventListener('click', toggle);
  detailsButton.addEventListener('click', toggle);
  face.append(summaryButton, detailsButton);

  const changeSource = source => {
    Object.assign(mate, { source, harness: '', model: '', effort: '' });
    openMate = mate.id;
    renderMates(home, { keepDraft: true });
    const updated = root.querySelector(`[data-mate="${CSS.escape(mate.id)}"]`);
    updated?.querySelector(source === 'override' ? '[aria-label="Harness"]' : '.mate-configure')?.focus({ preventScroll: true });
  };
  const facts = node('dl', null, 'launch-facts');
  detail.append(facts);
  let rowModel, editor;
  if (isSet) {
    profileSeats.set(mate, () => mate.id);
    secondmateProfiles.add(mate);
    rowModel = modelPicker(mate, repaintMates);
    editor = profileFields(mate, repaintMates);
    face.append(rowModel.element, pill);
    detail.append(node('p', '独立配置在此二副下一次启动时生效。', 'readonly-note'), editor);
    const remove = node('button', '移除独立配置', 'text-btn');
    remove.type = 'button';
    remove.addEventListener('click', () => changeSource('inherit'));
    detail.append(remove);
  } else {
    const configure = node('button', '单独设置', 'mate-configure');
    configure.type = 'button';
    configure.addEventListener('click', () => changeSource('override'));
    face.append(configure);
  }
  const saved = home.secondmate.mates.find(item => item.id === mate.id);
  const record = home.records.find(item => item.kind === 'secondmate' && item.id === mate.id);
  const paint = () => {
    rowModel?.refresh();
    editor?.refresh();
    paintMark(mark, mate.harness);
    harnessLabel.textContent = isSet ? mate.harness || '请选择 Harness' : '';
    pill.textContent = mate.effort || '不设';
    pill.classList.toggle('is-empty', !mate.effort);
    const dirty = mate.source !== saved?.source || (isSet && ['harness', 'model', 'effort'].some(key => mate[key] !== saved[key]));
    const values = isSet ? [
      ['Harness', mate.harness || '请选择 Harness'],
      ['模型', mate.model || '使用 Harness 默认模型'],
      ['推理强度', mate.effort || '使用 Harness 默认强度'],
    ] : [];
    values.push(
      ['配置来源', `${isSet ? '此二副的独立配置' : UNSET_MATE} · ${dirty ? '编辑中，尚未保存' : '读取的文件配置'}`],
      ['工作机器（登记）', record?.location?.machine || '未登记'],
      ['工作 Home（登记）', record?.location?.home || '未登记'],
    );
    facts.replaceChildren();
    for (const [label, value] of values) { const field = node('div'); field.append(node('dt', label), node('dd', value)); facts.append(field); }
    card.dataset.filter = `${mate.id} ${badge.textContent} ${mate.harness} ${mate.model} ${mate.effort}`.toLowerCase();
  };
  matePaints.push(paint);
  paint();
  card.append(face, detail);
  root.append(card);
}

function renderMates(home, options = {}) {
  const root = $('mates');
  root.replaceChildren();
  matePaints = [];
  const pin = home?.secondmate;
  const ready = Boolean(pin && !pin.error);
  $('mate-label').hidden = !ready;
  const isSecondmate = home.role?.kind === 'secondmate';
  const remote = home.remote;
  $('mate-sync').textContent = isSecondmate ? '从大副刷新并同步' : '同步继承配置到二副';
  $('mate-sync').disabled = !home.readable || Boolean(remote) || (isSecondmate && home.parent?.status !== 'connected');
  $('mate-sync').hidden = Boolean(remote);
  document.querySelector('#secondmate-panel .dispatch-bar').hidden = Boolean(remote) && !isSecondmate;
  $('mate-preview').hidden = isSecondmate;
  $('mate-count').textContent = isSecondmate ? '1' : ready ? String(pin.mates.filter(mate => !home.hiddenSecondmates?.includes(mate.id)).length) : '—';
  $('mate-scope').textContent = remote
    ? '这里显示远端 Home 保存的二副启动配置。修改启动配置需在大副本机完成。'
    : isSecondmate
    ? '当前是本机二副。下面读取已配置的大副管理的启动配置。编辑在大副页面完成；同步不会重启会话。'
    : '下面管理二副下一次启动使用的配置。各二副的独立配置由大副持有，保存后无需复制。同步按钮推送继承配置，不改变正在运行的会话。';
  if (isSecondmate) {
    mateDraft = null;
    $('mate-label').hidden = true;
    $('mate-preview').disabled = true;
    $('mate-restore').hidden = true;
    $('mate-empty').hidden = true;
    const parent = home.parent;
    $('mate-source').textContent = parent?.status === 'connected' ? `配置源：${parent.local ? '本机大副' : '远端大副'} · ${parent.machine} · ${parent.path}/config/secondmate-harness · 读取于 ${date(parent.observedAt)}` : '大副连接未建立，无法读取最新启动配置。';
    if (parent?.startup) {
      const item = parent.startup;
      const fallback = item.source !== 'override' && (!item.harness || item.harness === 'default');
      const card = node('article', null, 'mate-card');
      const face = node('div', null, 'rule-face');
      const summary = node('button', null, 'rule-summary'); summary.type = 'button';
      const mark = node('span', '', 'mark'); paintMark(mark, item.harness);
      const badge = node('span', '大副管理', 'origin-badge'); badge.dataset.origin = item.source || 'inherit';
      const who = node('span', null, 'who');
      const line = node('span', null, 'name-line'); line.append(node('span', item.harness || '默认', 'h-label'), node('span', item.id, 'rule-name')); who.append(line);
      if (fallback) who.append(node('span', UNSET_MATE, 'sub mate-fallback'));
      summary.append(mark, badge, who);
      const details = node('button', '详情', 'row-details'); details.type = 'button';
      const model = node('span', null, 'model-trigger readonly-model');
      FMModels.paint(model, FMModels.describe(item));
      if (item.harness && item.harness !== 'default') {
        FMModels.catalog(item.harness).then(catalog => { if (model.isConnected) FMModels.paint(model, FMModels.describe(item, catalog.models)); }).catch(() => {});
      }
      face.append(summary, details, model, node('span', item.effort || '默认', 'effort-pill'));
      const detail = node('div', null, 'mate-detail'); detail.hidden = true;
      detail.append(node('p', item.source === 'override' ? '配置来源：大副为此二副单独设置' : fallback ? UNSET_MATE : '未单独设置，当前使用大副的旧默认行', 'caption'), node('p', `模型 ID：${item.model || '默认'}。由大副管理，影响下一次启动。`, 'caption'));
      const toggle = () => { detail.hidden = !detail.hidden; details.textContent = detail.hidden ? '详情' : '收起'; summary.setAttribute('aria-expanded', String(!detail.hidden)); details.setAttribute('aria-expanded', String(!detail.hidden)); };
      summary.setAttribute('aria-expanded', 'false'); details.setAttribute('aria-expanded', 'false');
      summary.addEventListener('click', toggle); details.addEventListener('click', toggle);
      card.append(face, detail);
      root.append(card);
    }
    return;
  }
  if (remote) {
    mateDraft = null;
    $('mate-label').hidden = true;
    $('mate-preview').hidden = true;
    $('mate-preview').disabled = true;
    $('mate-restore').hidden = true;
    $('mate-empty').hidden = true;
    if (!home.readable) {
      $('mate-source').textContent = '';
      root.append(node('div', home.readError || '远端 Home 读取失败；没有可显示的启动配置。', 'warnings'));
      return;
    }
    $('mate-source').textContent = `来源：${pin.source}${pin.parse === 'plugin' ? ' · 插件按行读取（未在远端运行解析器）' : ''} · 只读`;
    if (pin.error) root.append(node('div', pin.error, 'warnings'));
    const addRemote = (title, fields, note) => {
      const fallback = fields.source === 'inherit' && (!fields.harness || fields.harness === 'default');
      const card = node('article', null, 'mate-card'); card.dataset.readonly = 'true';
      const face = node('div', null, 'rule-face');
      const summary = node('span', null, 'rule-summary');
      const mark = node('span', '', 'mark'); paintMark(mark, fields.harness);
      const badge = node('span', '远端只读', 'origin-badge'); badge.dataset.origin = fields.source || 'override';
      const who = node('span', null, 'who');
      const line = node('span', null, 'name-line'); line.append(node('span', fields.harness || '默认', 'h-label'), node('span', title, 'rule-name')); who.append(line);
      if (fallback) who.append(node('span', UNSET_MATE, 'sub mate-fallback'));
      summary.append(mark, badge, who);
      const pill = node('span', fields.effort || '不设', 'effort-pill'); if (!fields.effort) pill.classList.add('is-empty');
      face.append(summary, pill);
      const detail = node('div', null, 'mate-detail'); detail.hidden = false;
      const facts = node('dl', null, 'launch-facts');
      for (const [label, value] of [['Harness', fields.harness || '未读'], ['模型', fields.model || '使用 Harness 默认模型'], ['推理强度', fields.effort || '使用 Harness 默认强度'], ['配置来源', fields.source === 'override' ? '远端为此二副单独设置' : pin.default?.harness && pin.default.harness !== 'default' ? '未单独设置，当前使用远端的旧默认行' : UNSET_MATE], ...fields.context]) {
        const field = node('div'); field.append(node('dt', label), node('dd', value)); facts.append(field);
      }
      detail.append(facts, node('p', note, 'readonly-note'));
      card.append(face, detail); root.append(card);
      card.dataset.filter = `${title} ${fields.harness || ''} ${fields.model || ''} ${fields.effort || ''}`.toLowerCase();
    };
    for (const mate of pin.mates) {
      if (home.hiddenSecondmates?.includes(mate.id)) continue;
      const record = home.records.find(item => item.kind === 'secondmate' && item.id === mate.id);
      addRemote(mate.id, { ...mate, context: [['工作机器（登记）', record?.location?.machine || '未登记'], ['工作 Home（登记）', record?.location?.home || '未登记']] }, '只读：这些值来自远端 Home 的 config/secondmate-harness 与 state/*.meta，是本插件读取到的配置，不代表正在运行的会话。');
    }
    if (pin.ignoredLines) root.append(node('p', `文件里还有 ${pin.ignoredLines} 行不符合默认行/覆写行格式，插件未采用；请以远端原生解析为准。`, 'caption'));
    filterMates();
    return;
  }
  if (!pin) {
    mateDraft = null;
    $('mate-preview').disabled = true;
    $('mate-restore').hidden = true;
    $('mate-source').textContent = '无法读取副手启动配置。';
    $('mate-empty').hidden = true;
    return;
  }
  $('mate-source').textContent = `来源：${pin.source}${pin.modified ? ` · 修改于 ${date(pin.modified)}` : ''} · 改的是下一次启动，不是正在运行的席`;
  if (pin.absent) $('mate-source').textContent = '首次保存独立配置时将创建 config/secondmate-harness。';
  if (pin.default?.line) {
    const ignored = pin.ignoredLines ? `以及 ${pin.ignoredLines} 行旧解析器忽略的内容` : '';
    root.append(node('p', `旧默认行仍在配置文件中。保存将移除这条默认行${ignored}，未单独设置的二副随后回退到船员默认工具。`, 'notice'));
  }
  const backup = pin.latestBackup;
  $('mate-restore').hidden = !backup;
  $('mate-restore').dataset.backup = backup?.id || '';
  if (pin.error) {
    mateDraft = null;
    $('mate-preview').disabled = true;
    $('mate-empty').hidden = true;
    root.append(node('div', pin.error, 'warnings'));
    return;
  }
  if (!options.keepDraft) {
    mateDraft = {
      mates: pin.mates.map(mate => ({
        id: mate.id,
        source: mate.source,
        harness: mate.source === 'override' ? mate.harness : '',
        model: mate.source === 'override' ? mate.model : '',
        effort: mate.source === 'override' ? mate.effort : '',
      })),
    };
  }
  const visibleMates = mateDraft.mates.filter(mate => !home.hiddenSecondmates?.includes(mate.id));
  for (const mate of visibleMates) addLaunchCard(root, mate, home);
  if (!visibleMates.length) root.append(node('div', '没有发现副手。', 'empty'));
  $('mate-preview').disabled = false;
  filterMates();
}

function filterMates() {
  const query = $('search').value.trim().toLowerCase();
  const cards = [...document.querySelectorAll('#mates .mate-card')];
  for (const card of cards) card.hidden = query !== '' && !String(card.dataset.filter || '').includes(query);
  const empty = $('mate-empty');
  const none = cards.length > 0 && cards.every(card => card.hidden);
  empty.hidden = !none;
  if (none) empty.textContent = '没有匹配的副手';
}

function matePayload(extra = {}) {
  return {
    home: homeIndex(),
    baseRevision: currentHome().secondmate.revision,
    mates: mateDraft.mates.map(mate => ({
      id: mate.id,
      source: mate.source,
      harness: mate.source === 'override' ? mate.harness : '',
      model: mate.source === 'override' ? mate.model : '',
      effort: mate.source === 'override' ? mate.effort : '',
    })),
    ...extra,
  };
}

function render(options = {}) {
  const home = currentHome();
  $('home-context').textContent = home ? `${home.machine} · ${home.role?.kind === 'primary' ? '大副' : home.role?.kind === 'secondmate' ? '二副' : '身份待核实'}` : 'Home 未读取';
  window.FMOverview.render({ homes: data.homes, selected: homeIndex(), observedAt: data.observedAt, selectHome, showView });
  if (!home) return;
  renderRecords();
  renderDispatch(currentHome(), { keepDraft: options.keepDispatchDraft });
  window.FMQuota.render(home, homeIndex(), data?.capabilities?.quotaSource, document.body.dataset.view === 'dispatch', token);
  renderMates(currentHome(), { keepDraft: options.keepMateDraft });
  renderSettings(currentHome());
}

function renderSettings(home) {
  window.FMSettings.render({ home, homeIndex: homeIndex(), post, openReview, onModalChange: updateModals });
}

function updateModals() {
  const top = !$('operation').hidden ? $('operation') : !$('review').hidden ? $('review') : !$('setting-editor').hidden ? $('setting-editor') : null;
  for (const child of document.querySelector('main').children) child.inert = Boolean(top) && child !== top;
  window.FMControls.close();
}

function closeReview() {
  if (window.FMActions.busy) return;
  const returnTo = pending?.returnTo;
  pending = null; $('review').hidden = true; updateModals();
  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (document.activeElement?.closest('.fm-menu')) return;
  const top = !$('operation').hidden ? $('operation') : !$('review').hidden ? $('review') : !$('setting-editor').hidden ? $('setting-editor') : null;
  if (!top) return;
  if (event.key === 'Escape') { event.preventDefault(); top.id === 'operation' ? window.FMActions.close() : top.id === 'review' ? closeReview() : window.FMSettings.close(); }
  if (event.key !== 'Tab') return;
  const controls = [...top.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary')].filter(x => !x.closest('[hidden]'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
});

async function refresh() {
  $('refresh').disabled = true;
  window.FMOverview.refreshState('loading');
  say('error', '');
  try {
    const response = await fetch('api/snapshot', { cache: 'no-store', headers: { 'X-FM-Write-Token': token } });
    if (response.status === 403 && (await response.json().catch(() => null))?.error === 'session_expired') {
      if (data && !recoveredEdits) { reconnect(); return; }
      throw new Error('插件服务已重载，请重新打开页面。');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    if (!data.homes.length) say('error', '请在 MagPie 的插件选项中配置 homes，然后重新打开页面。');
    $('version').textContent = data.pluginVersion ? `v${data.pluginVersion}` : '版本未知';
    const recovery = recoveredEdits; recoveredEdits = null;
    const found = recovery ? data.homes.findIndex(home => home.path === recovery.home) : -1;
    const selected = found >= 0 ? String(found) : $('home').value;
    const index = selected && data.homes[Number(selected)] ? selected : '0';
    paintHomeMenu(index);
    const home = currentHome();
    const sameHome = recovery && home?.path === recovery.home;
    const dispatchOK = sameHome && home.role?.kind === 'primary' && recovery.dispatchRevision === home.dispatch?.revision && Boolean(recovery.draft);
    const mateOK = sameHome && home.role?.kind === 'primary' && recovery.pinRevision === home.secondmate?.revision && Boolean(recovery.mateDraft);
    if (dispatchOK) draft = recovery.draft;
    if (mateOK) mateDraft = recovery.mateDraft;
    render({ keepDispatchDraft: dispatchOK, keepMateDraft: mateOK });
    window.FMOverview.refreshState(data.homes.length ? 'ready' : 'empty');
    if (recovery) {
      const settingsOK = !recovery.settings || (sameHome && window.FMSettings.restore(recovery.settings));
      const complete = sameHome && (!recovery.draft || dispatchOK) && (!recovery.mateDraft || mateOK) && settingsOK;
      [...document.querySelectorAll('[data-tab]')].find(button => button.dataset.tab === recovery.tab)?.click();
      say(complete ? 'saved' : 'error', complete ? '服务已重新连接，编辑已保留。请重新预览或同步；没有自动重试写入。' : '服务已重连，但配置来源或版本已变化。旧草稿未覆盖新配置，可展开对照。');
      if (!complete) {
        const details = node('details'); details.append(node('summary', '查看保留的编辑'), node('pre', JSON.stringify({ draft: recovery.draft, mateDraft: recovery.mateDraft, settings: recovery.settings }, null, 2))); $('error').after(details);
      }
    }
  } catch (error) {
    say('error', `读取失败：${error.message}`);
    window.FMOverview.refreshState('error');
  } finally {
    $('refresh').disabled = false;
    parkInitialFocus();
  }
}

function parkInitialFocus() {
  if (!skipAutoFocus) return;
  if (document.activeElement === $('home')) $('home').blur();
}

function noteUserFocusIntent() {
  skipAutoFocus = false;
}

addEventListener('keydown', noteUserFocusIntent, true);
addEventListener('pointerdown', noteUserFocusIntent, true);
addEventListener('focusin', event => {
  if (event.target === $('home')) parkInitialFocus();
}, true);
addEventListener('load', parkInitialFocus);

function openReview(result, request, title, note, route, returnTo) {
  pending = { route, body: request, returnTo };
  $('review-error').hidden = true;
  $('review-title').textContent = title;
  $('review-note').textContent = note;
  $('diff-file').textContent = route === 'settings' ? result.file : route === 'secondmate' ? 'config/secondmate-harness' : 'config/crew-dispatch.json';
  let expanded = false;
  $('diff-context').textContent = '展开整个文件';
  $('diff-context').disabled = !result.fullDiff || result.fullDiff === result.diff;
  $('diff-context').onclick = () => {
    expanded = !expanded;
    showDiff(expanded ? result.fullDiff : result.diff);
    $('diff-context').textContent = expanded ? '只看改动附近' : '展开整个文件';
  };
  showDiff(result.diff);
  $('review').hidden = false;
  $('confirm').disabled = false;
  updateModals();
  $('cancel').focus({ preventScroll: true });
}

$('preview').addEventListener('click', async () => {
  if (!draft) return;
  $('preview').disabled = true;
  say('error', '');
  say('saved', '');
  try {
    const request = payload();
    const result = await post('api/dispatch/preview', request);
    if (result.unchanged) {
      say('saved', '没有需要保存的改动。');
      $('review').hidden = true;
      return;
    }
    openReview(result, { ...request, nextRevision: result.nextRevision }, '确认保存派工规则', '校验已通过。确认后写入所选大副 Home 的派工文件。推送需另行点击。', 'dispatch', $('preview'));
  } catch (error) {
    $('review').hidden = true;
    say('error', error.message);
  } finally {
    $('preview').disabled = false;
  }
});

$('restore').addEventListener('click', async () => {
  const id = $('restore').dataset.backup;
  if (!id || !currentHome()?.dispatch) return;
  $('restore').disabled = true;
  say('error', '');
  say('saved', '');
  try {
    const request = { home: homeIndex(), baseRevision: currentHome().dispatch.revision, restore: id };
    const result = await post('api/dispatch/preview', request);
    openReview(result, { ...request, nextRevision: result.nextRevision }, '确认恢复备份', `将用备份 ${id} 覆盖当前配置。恢复后可另行推送。`, 'dispatch', $('restore'));
  } catch (error) {
    say('error', error.message);
  } finally {
    $('restore').disabled = false;
  }
});

$('mate-preview').addEventListener('click', async () => {
  if (!mateDraft) return;
  $('mate-preview').disabled = true;
  say('error', '');
  say('saved', '');
  try {
    const request = matePayload();
    const result = await post('api/secondmate/preview', request);
    if (result.unchanged) {
      say('saved', '没有需要保存的改动。');
      $('review').hidden = true;
      return;
    }
    openReview(result, request, '确认写入副手启动配置', '展示改动及前后 8 行上下文，可展开整个文件。左右行号分别对应修改前后；敏感配置已隐藏。注释会保留，确认后才写入，仅影响副手下一次启动。', 'secondmate', $('mate-preview'));
  } catch (error) {
    $('review').hidden = true;
    say('error', error.message);
  } finally {
    $('mate-preview').disabled = false;
  }
});

$('mate-restore').addEventListener('click', async () => {
  const id = $('mate-restore').dataset.backup;
  if (!id || !currentHome()?.secondmate) return;
  $('mate-restore').disabled = true;
  say('error', '');
  say('saved', '');
  try {
    const request = { home: homeIndex(), baseRevision: currentHome().secondmate.revision, restore: id };
    const result = await post('api/secondmate/preview', request);
    openReview(result, request, '确认恢复副手启动配置', `将用备份 ${id} 覆盖 config/secondmate-harness。备份中的旧默认行也会恢复。校验通过后才会写入。正在运行的席不会因此改变。`, 'secondmate', $('mate-restore'));
  } catch (error) {
    say('error', error.message);
  } finally {
    $('mate-restore').disabled = false;
  }
});

$('cancel').addEventListener('click', closeReview);

function showSync(result) {
  const labels = { pushed: '已推送', unchanged: '已一致', skipped: '跳过', error: '失败', unknown: '未知', removed: '已移除' };
  const items = (result.targets || []).map(item => `${item.id}：${labels[item.dispatch] || '未知'}${item.reread === 'sent' ? '，已发送重读通知' : item.reread === 'failed' ? '，重读通知失败' : ''}`);
  say('sync-result', `同步结果：${result.message}${items.length ? ` ${items.join('；')}` : ''}`);
}

$('sync').addEventListener('click', async () => {
  const home = currentHome();
  const inherited = home?.role?.kind === 'secondmate';
  if (inherited ? home.parent?.status !== 'connected' : !home?.dispatch) return;
  $('sync').disabled = true;
  say('sync-result', inherited ? '正在从大副同步…' : '正在推送已保存的规则…');
  try {
    const result = await post('api/dispatch/sync', { home: homeIndex(), baseRevision: home.dispatch?.revision });
    showSync(result.sync);
    if (inherited) await refresh();
  } catch (error) { say('error', error.message); }
  finally { $('sync').disabled = false; }
});

$('mate-sync').addEventListener('click', async () => {
  const home = currentHome();
  if (!home) return;
  $('mate-sync').disabled = true;
  say('sync-result', home.role?.kind === 'secondmate' ? '正在刷新大副启动配置并同步继承配置…' : '正在同步已保存的继承配置…');
  try {
    const result = await post('api/secondmate/sync', { home: homeIndex(), baseRevision: home.secondmate?.revision });
    showSync(result.sync);
    await refresh();
  } catch (error) { say('error', error.message); }
  finally { $('mate-sync').disabled = false; }
});

$('confirm').addEventListener('click', async () => {
  if (!pending) return;
  $('confirm').disabled = true;
  say('error', '');
  const dispatchSaved = pending.route === 'dispatch';
  const home = currentHome();
  try {
    const result = await post(`api/${pending.route}/commit`, pending.body);
    if (dispatchSaved) home.dispatch.revision = result.revision;
    const settingsSaved = pending.route === 'settings';
    pending = null;
    $('review').hidden = true;
    if (settingsSaved) window.FMSettings.close();
    updateModals();
    say('saved', result.unchanged ? '没有需要保存的改动。' : dispatchSaved ? '派工规则已保存并读回核对。点击「推送已保存的派工规则」可分发给各二副。' : '已保存，并读回核对过。');
    if (result.sync) showSync(result.sync);
    await refresh();
  } catch (error) {
    say('sync-result', '');
    $('review-error').textContent = error.message; $('review-error').hidden = false;
    $('confirm').disabled = Boolean(error.operationUnknown);
  }
});

window.FMActions.onChange = updateModals;
function reconnect() {
  const home = currentHome();
  try {
    window.FMRecovery.keep({ home: home?.path || '', dispatchRevision: home?.dispatch?.revision, pinRevision: home?.secondmate?.revision, draft, mateDraft, settings: window.FMSettings.capture(), tab: document.body.dataset.view });
    location.reload();
  } catch (error) { say('error', error.message); }
}
window.FMActions.onReconnect = reconnect;
window.FMActions.onReconcile = () => { closeReview(); refresh(); };
$('refresh').addEventListener('click', refresh);
for (const button of document.querySelectorAll('[data-settings-tab]')) {
  button.addEventListener('click', () => {
    const destination = document.querySelector(`[data-tab="${button.dataset.settingsTab}"]`);
    destination.click();
    destination.focus();
  });
}

function paintHomeMenu(index) {
  $('home').disabled = !data.homes.length;
  $('home').setOptions(data.homes.map((home, i) => ({
    value: String(i), label: home.name,
    note: home.role?.kind === 'secondmate' ? '二副' : home.role?.kind === 'primary' ? '大副' : '待核实',
  })), data.homes.length ? index : '');
}

function selectHome(index) {
  paintHomeMenu(index);
  $('home').dispatchEvent(new Event('change'));
}

$('home').addEventListener('change', () => { showAll = false; say('saved', ''); say('sync-result', ''); render(); });
$('search').addEventListener('input', renderRecords);
$('more').addEventListener('click', () => { showAll = !showAll; renderRecords(); });

function showView(view) {
  document.body.dataset.view = view;
  for (const item of document.querySelectorAll('[data-tab]')) {
    const selected = item.dataset.tab === view;
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
    $(`${item.dataset.tab}-panel`).hidden = !selected;
  }
  window.FMOverview.viewChanged(view);
  if (view === 'dispatch') window.FMQuota.activate();
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => showView(button.dataset.tab));
}

window.FMControls.bindMenu($('home'), [], '', () => $('home').dispatchEvent(new Event('change')));
$('home').disabled = true;
refresh();

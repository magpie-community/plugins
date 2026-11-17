import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('./settings.html', import.meta.url), 'utf8');
const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1]
  .replaceAll('__KIMI_SETTINGS_HEADER__', 'x-fixture-session');
const boot = await readFile(new URL('./page/boot.js', import.meta.url), 'utf8');
const bootHtml = await readFile(new URL('./page/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({
  enabled: true, primaryModel: 'fixture/main', secondaryModel: '', status: 'connected',
  appliedPrimaryModel: 'fixture/main',
  models: [{ id: 'fixture/main', name: 'Main' }, { id: 'fixture/other', name: 'Other' }, { id: 'fixture/auxiliary', name: 'Auxiliary' }],
});

// Reproduce radio clicks, checked state and disabled buttons with plain nodes.
// The page never gets a browser, a network connection or a DOM dependency.
class Element {
  constructor(tagName, attributes = '', all = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map([...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    this.disabled = /\bdisabled\b/.test(attributes);
    this.type = /\btype="([^"]+)"/.exec(attributes)?.[1] || '';
    this.children = []; this.listeners = new Map(); this.dataset = {};
    this.value = ''; this.checked = false; this._text = ''; this.all = all;
    all.push(this);
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value; this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) { for (const callback of this.listeners.get(name) || []) callback({ target: this, preventDefault() {} }); }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'radio') {
      for (const other of this.all) if (other.tagName === 'INPUT' && other.name === this.name) other.checked = false;
      this.checked = true; this.dispatch('change');
    }
    this.dispatch('click');
    if (this.tagName === 'BUTTON' && this.type === 'submit') this.form?.dispatch('submit');
  }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

function fakeTimers() {
  let now = 0, nextId = 0, destroyed = false;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      if (!destroyed) pending.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    get now() { return now; },
    get pending() { return pending.size; },
    destroy() { destroyed = true; pending.clear(); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
  };
}

async function bootPage(lang) {
  const timers = fakeTimers(), attempts = [];
  const nodes = { heading: new Element('h1'), message: new Element('p'), retry: new Element('button') };
  nodes.retry.hidden = true;
  const document = { documentElement: {}, getElementById: id => nodes[id] };
  let reachable = false, destroyed = false;
  await runInNewContext(boot, {
    URL, document, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    window: { magpie: { ready: Promise.resolve({ dark: true, lang }), options: { get: async () => ({ settingsPort: 9999 }) }, service: '/prefix/_magpie/service/' } },
    location: {
      href: 'https://magpie.example/plugin/index.html', hostname: 'magpie.example',
      replace(href) {
        attempts.push({ href, at: timers.now });
        // Successful navigation destroys the original document and its timers.
        if (reachable) { destroyed = true; timers.destroy(); }
      },
    },
  });
  return {
    timers, attempts, document, node: id => nodes[id],
    get destroyed() { return destroyed; },
    setReachable(value) { reachable = value; },
  };
}

async function page({ lang = 'en', state = initial(), failures = 0, failureCode = 'connection_changed', saveStatus = 'waiting_kimi_idle' } = {}) {
  state = structuredClone(state);
  const nodes = new Map(), all = [];
  const stack = [];
  for (const match of html.slice(0, html.indexOf('<script')).matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
    if (match[1]) { stack.pop(); continue; }
    const element = new Element(match[2], match[3], all);
    const id = /\bid="([^"]+)"/.exec(match[3])?.[1];
    if (id) nodes.set(id, element);
    stack.at(-1)?.appendChild(element);
    if (!['meta', 'input', 'link', 'br', 'hr'].includes(match[2])) stack.push(element);
  }
  nodes.get('save').form = nodes.get('settings-form');
  const document = {
    baseURI: `http://127.0.0.1:3491/?lang=${encodeURIComponent(lang)}`,
    documentElement: new Element('html', '', all), title: '',
    getElementById: id => nodes.get(id), querySelector: () => ({ content: 'fixture-session' }),
    createElement: tagName => new Element(tagName, '', all),
  };
  const calls = [];
  runInNewContext(script, {
    URL, document,
    fetch: async (url, options) => {
      assert.equal(url.href, 'http://127.0.0.1:3491/api/settings');
      assert.equal(options.headers['x-fixture-session'], 'fixture-session');
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      calls.push({ method: options.method, body });
      if (options.method === 'POST') {
        if (failures-- > 0) {
          if (failureCode === 'settings_partially_saved') state.primaryModel = body.primaryModel;
          return { ok: false, json: async () => ({ error: failureCode }) };
        }
        Object.assign(state, body, { status: saveStatus });
        if (body.secondaryModel === '') Object.assign(state, { secondaryReasoningEffort: '', secondaryContextTokens: null });
      }
      return { ok: true, json: async () => structuredClone(state) };
    },
  });
  await tick();
  const node = id => nodes.get(id);
  const radios = id => {
    assert.ok(node(id), `${id} must provide a radio group`);
    return descendants(node(id)).filter(item => item.tagName === 'INPUT' && item.type === 'radio');
  };
  return {
    node, state, document, radios,
    selected: id => radios(id).find(input => input.checked)?.value ?? '',
    posts: () => calls.filter(call => call.method === 'POST').map(call => call.body),
    async choose(id, value) {
      assert.ok(node(id), `${id} must provide a radio group`);
      assert.equal(node(id).tagName, 'FIELDSET', `${id} must offer radio rows rather than a native select`);
      const input = radios(id).find(item => item.value === value);
      assert.ok(input, `${id} must offer ${value}`);
      assert.equal(input.disabled, false);
      input.click(); await tick();
    },
    async save() { node('save').click(); await tick(); },
    async refresh() { node('refresh').click(); await tick(); },
    async enter(id, value) {
      const input = node(id);
      assert.ok(input, `${id} must provide a token input`);
      assert.equal(input.type, 'number'); assert.equal(input.disabled, false);
      input.value = String(value); input.dispatch('input'); await tick();
    },
  };
}

const words = {
  en: { title: 'Kimi Work models', primary: 'Primary model', secondary: 'Secondary model', save: 'Save', dirty: /unsaved/i, saved: /settings saved/i, applied: /configuration is applied/i, retained: /kept/i, unavailable: /Saved; currently unavailable/, connect: /connect.*Kimi/i, partial: /Primary model changed; remaining model preferences were not saved/ },
  zh: { title: 'Kimi Work 模型', primary: '主模型', secondary: '辅助模型', save: '保存', dirty: /未保存/, saved: /配置已保存/, applied: /配置已应用/, retained: /保留/, unavailable: /已保存，当前不可用/, connect: /先.*接通/, partial: /主模型已更改，其余模型偏好未保存/ },
};
const optInCopy = {
  en: {
    description: 'Choose a primary model. Select a secondary model to enable role routing for new Agent subtasks.',
    off: 'Use native subagents (role routing off)',
    guidance: 'With a secondary model selected, new Agent calls use it only when both model and subagent_type are omitted. An explicit native subagent_type without model keeps its native profile. Use model="primary" or model="native" for an explicit choice.',
    primaryOnly: 'The primary model is applied. Native subagents are used; role routing is off.',
  },
  zh: {
    description: '选择主模型；只有选择辅助模型后，才会启用新建 Agent 子任务的角色路由。',
    off: '使用原生子代理（不启用角色路由）',
    guidance: '选择辅助模型后，只有同时省略 model 和 subagent_type 的新建 Agent 调用才默认使用辅助模型。明确指定原生 subagent_type 且省略 model 时，保留原生类型。可用 model="primary" 或 model="native" 明确选择。',
    primaryOnly: '主模型已应用。子代理使用原生行为，角色路由未启用。',
  },
};

for (const lang of ['en', 'zh']) {
  const w = words[lang];
  test(`${lang}: primary radio rows save only the changed primary model`, async () => {
    const p = await page({ lang });
    assert.equal(p.node('primary').tagName, 'FIELDSET', 'model choices must use radio rows rather than native select');
    assert.equal(p.document.documentElement.lang, lang);
    assert.equal(p.document.title, w.title);
    assert.equal(p.node('primary-label').textContent, w.primary);
    assert.equal(p.node('secondary-label').textContent, w.secondary);
    assert.equal(p.node('save').textContent, w.save);
    assert.equal(p.node('description').textContent, optInCopy[lang].description);
    assert.equal(p.node('guidance').textContent, optInCopy[lang].guidance);
    assert.equal(p.radios('secondary').find(input => input.value === '').parentElement.textContent, optInCopy[lang].off);
    if (lang === 'en') {
      assert.ok(html.includes(`<p id="description" class="muted">${optInCopy.en.description}</p>`));
      assert.ok(html.includes(`<p id="guidance" class="guidance">${optInCopy.en.guidance}</p>`));
    }
    assert.equal(p.node('path-guidance').textContent, lang === 'zh'
      ? 'Windows 下若无法自动定位 Magpie，可在插件选项 magpiePath 指定当前 Magpie 可执行文件。'
      : 'If Magpie cannot be located automatically on Windows, you can set magpiePath in the plugin options to the current Magpie executable.');
    await p.choose('primary', 'fixture/other');
    assert.equal(p.node('save').disabled, false);
    assert.match(p.node('notice').textContent, w.dirty);
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other' }]);
    assert.equal(p.selected('primary'), 'fixture/other');
    assert.equal(p.node('save').disabled, true);
  });
  test(`${lang}: one button saves both models and native-off choice sends only secondary`, async () => {
    const p = await page({ lang });
    await p.choose('primary', 'fixture/other'); await p.choose('secondary', 'fixture/auxiliary'); await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other', secondaryModel: 'fixture/auxiliary' }]);
    await p.choose('secondary', ''); await p.save();
    assert.deepEqual(p.posts().at(-1), { secondaryModel: '' });
  });
  test(`${lang}: unchanged settings and a missing primary cannot save`, async () => {
    const p = await page({ lang });
    await p.save(); assert.deepEqual(p.posts(), []);
    const empty = await page({ lang, state: { ...initial(), primaryModel: '' } });
    assert.equal(empty.node('save').disabled, true);
    await empty.save(); assert.deepEqual(empty.posts(), []);
    assert.equal(empty.radios('primary').some(input => input.value === ''), false);
  });
  test(`${lang}: saved is not applied until connected and both IDs match`, async () => {
    const state = { ...initial(), secondaryModel: 'fixture/auxiliary' }; delete state.appliedPrimaryModel;
    const p = await page({ lang, state, saveStatus: 'connected' });
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    await p.choose('primary', 'fixture/other'); await p.save();
    assert.match(p.node('notice').textContent, w.saved);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    Object.assign(p.state, { appliedPrimaryModel: 'fixture/other', appliedSecondaryModel: 'fixture/auxiliary', status: 'waiting_kimi_idle' });
    await p.refresh(); assert.doesNotMatch(p.node('application').textContent, w.applied);
    p.state.status = 'connected'; await p.refresh();
    assert.match(p.node('application').textContent, w.applied);
  });
  test(`${lang}: primary-only confirmation survives saves and refreshes without confirming a secondary`, async () => {
    const state = initial(); delete state.appliedSecondaryModel;
    const p = await page({ lang, state, saveStatus: 'connected' });
    const primaryOnly = optInCopy[lang].primaryOnly;
    assert.equal(p.node('application').textContent, primaryOnly);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    await p.refresh(); assert.equal(p.node('application').textContent, primaryOnly);
    await p.choose('primary', 'fixture/other');
    assert.match(p.node('application').textContent, w.dirty);
    assert.notEqual(p.node('application').textContent, primaryOnly);
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other' }]);
    assert.match(p.node('notice').textContent, w.saved);
    assert.notEqual(p.node('application').textContent, primaryOnly);
    p.state.appliedPrimaryModel = 'fixture/other';
    await p.refresh(); assert.equal(p.node('application').textContent, primaryOnly);
    for (const status of ['secondary_model_waiting_session', 'secondary_model_unsupported_runtime', 'secondary_config_unsupported']) {
      p.state.status = status; await p.refresh();
      assert.notEqual(p.node('application').textContent, primaryOnly);
      assert.doesNotMatch(p.node('application').textContent, w.applied);
    }
    p.state.status = 'connected'; await p.refresh();
    await p.choose('secondary', 'fixture/auxiliary'); await p.save();
    assert.deepEqual(p.posts().at(-1), { secondaryModel: 'fixture/auxiliary' });
    assert.notEqual(p.node('application').textContent, primaryOnly);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    await p.choose('secondary', ''); await p.save();
    assert.equal(p.node('application').textContent, primaryOnly);
    p.state.appliedSecondaryModel = 'fixture/main'; await p.refresh();
    assert.notEqual(p.node('application').textContent, primaryOnly);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    p.state.appliedSecondaryModel = 'fixture/other'; await p.refresh();
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    assert.notEqual(p.node('application').textContent, primaryOnly);
    p.state.appliedSecondaryModel = ''; await p.refresh();
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    assert.notEqual(p.node('application').textContent, primaryOnly);
  });
  test(`${lang}: a failed save keeps radio drafts for retry`, async () => {
    const p = await page({ lang, failures: 1 });
    await p.choose('primary', 'fixture/other'); await p.choose('secondary', 'fixture/auxiliary'); await p.save();
    assert.equal(p.selected('primary'), 'fixture/other'); assert.equal(p.selected('secondary'), 'fixture/auxiliary');
    assert.equal(p.node('save').disabled, false);
    assert.match(p.node('notice').textContent, w.retained); assert.match(p.node('application').textContent, w.dirty);
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other', secondaryModel: 'fixture/auxiliary' }, { primaryModel: 'fixture/other', secondaryModel: 'fixture/auxiliary' }]);
  });
  test(`${lang}: unsupported runtime cannot confirm stale applied model IDs`, async () => {
    const p = await page({ lang, state: { ...initial(), secondaryModel: 'fixture/auxiliary', appliedSecondaryModel: 'fixture/auxiliary', status: 'secondary_model_unsupported_runtime' } });
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    assert.equal(p.node('connection').textContent, lang === 'zh'
      ? '当前 Kimi 运行时暂不支持辅助模型，主模型仍可用。'
      : 'This Kimi runtime does not currently support a secondary model. The primary model remains available.');
    assert.equal(p.node('primary').disabled, false);
  });
  test(`${lang}: waiting for a session cannot confirm stale applied IDs and keeps both models editable`, async () => {
    const p = await page({ lang, state: { ...initial(), secondaryModel: 'fixture/auxiliary', appliedSecondaryModel: 'fixture/auxiliary', status: 'secondary_model_waiting_session' }, saveStatus: 'secondary_model_waiting_session' });
    const waiting = lang === 'zh'
      ? '设置已保存。请先在 Work 会话中发送一条消息，待会话空闲后确认副模型配置已载入。'
      : 'Settings are saved. Send a message in a Work conversation, then wait for it to become idle so the secondary model configuration can be confirmed.';
    assert.equal(p.state.appliedPrimaryModel, p.state.primaryModel);
    assert.equal(p.state.appliedSecondaryModel, p.state.secondaryModel);
    assert.equal(p.node('connection').textContent, waiting);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    assert.equal(p.node('primary').disabled, false);
    assert.equal(p.node('secondary').disabled, false);
    await p.choose('primary', 'fixture/other'); await p.choose('secondary', 'fixture/main'); await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other', secondaryModel: 'fixture/main' }]);
    assert.match(p.node('notice').textContent, w.saved);
    assert.equal(p.node('connection').textContent, waiting);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    Object.assign(p.state, { appliedPrimaryModel: 'fixture/other', appliedSecondaryModel: 'fixture/main' });
    await p.refresh();
    assert.equal(p.node('connection').textContent, waiting);
    assert.doesNotMatch(p.node('application').textContent, w.applied);
    assert.equal(p.node('primary').disabled, false);
    assert.equal(p.node('secondary').disabled, false);
    p.state.status = 'connected'; await p.refresh();
    assert.match(p.node('application').textContent, w.applied);
  });
  test(`${lang}: partial failure refresh retains only the unsaved secondary`, async () => {
    const p = await page({ lang, failures: 1, failureCode: 'settings_partially_saved' });
    await p.choose('primary', 'fixture/other'); await p.choose('secondary', 'fixture/auxiliary'); await p.save();
    assert.match(p.node('notice').textContent, w.partial); assert.doesNotMatch(p.node('notice').textContent, w.saved);
    await p.refresh();
    assert.equal(p.selected('primary'), 'fixture/other'); assert.equal(p.selected('secondary'), 'fixture/auxiliary');
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/other', secondaryModel: 'fixture/auxiliary' }, { secondaryModel: 'fixture/auxiliary' }]);
  });
  test(`${lang}: unavailable saved IDs remain visible and can be replaced or cleared`, async () => {
    const p = await page({ lang, state: { ...initial(), primaryModel: 'removed/main', secondaryModel: 'removed/auxiliary' } });
    for (const [id, value] of [['primary', 'removed/main'], ['secondary', 'removed/auxiliary']]) {
      assert.equal(p.selected(id), value);
      const radio = p.radios(id).find(item => item.value === value);
      assert.equal(radio.disabled, true); assert.match(radio.parentElement.textContent, w.unavailable);
      assert.ok(radio.parentElement.textContent.includes(value));
    }
    await p.choose('primary', 'fixture/main'); await p.choose('secondary', ''); await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/main', secondaryModel: '' }]);
  });
  test(`${lang}: disconnected settings ask for connection before edits`, async () => {
    const p = await page({ lang, state: { ...initial(), enabled: false, status: 'disconnected', models: [] } });
    assert.equal(p.node('primary').disabled, true); assert.equal(p.node('secondary').disabled, true);
    assert.equal(p.node('save').disabled, true); assert.match(p.node('models-hint').textContent, w.connect);
  });
  test(`${lang}: fixed adapter codes have local text and unknown codes never become copy`, async () => {
    const p = await page({ lang });
    for (const code of ['connected', 'disconnected', 'waiting_kimi', 'waiting_kimi_idle', 'waiting_kimi_ready', 'restored_waiting_kimi',
      'catalog_sync_failed', 'catalog_unavailable', 'kimi_config_changed', 'invalid_gateway', 'invalid_connection',
      'unsupported_kimi_config', 'library_path_conflict', 'adapter_lock_invalid', 'adapter_lock_unavailable',
      'kimi_control_unavailable', 'kimi_control_timeout', 'kimi_control_closed', 'kimi_control_rejected',
      'secondary_config_unsupported', 'secondary_model_unavailable', 'secondary_model_reload_failed', 'secondary_model_waiting_session', 'secondary_model_unsupported_runtime', 'agent_profile_conflict', 'adapter_failed']) {
      p.state.status = code; await p.refresh();
      const shown = p.node('connection').textContent;
      assert.notEqual(shown, code); assert.equal(shown.includes('_'), false, code);
      assert.ok(lang === 'zh' ? /[\u3400-\u9fff]/.test(shown) : !/[\u3400-\u9fff]/.test(shown), code);
      assert.doesNotMatch(shown, /status is unavailable|状态暂不可用/);
    }
    for (const unknown of ['future_internal_status', 'constructor']) {
      p.state.status = unknown; await p.refresh();
      assert.equal(p.node('connection').textContent, lang === 'zh' ? 'Kimi 状态暂不可用，请刷新检查。' : 'Kimi status is unavailable. Refresh to check again.');
    }
  });
}

test('disconnected settings only clear the saved secondary preference without a primary', async () => {
  for (const lang of ['en', 'zh']) {
    const p = await page({ lang, state: { ...initial(), enabled: false, primaryModel: '', secondaryModel: 'fixture/auxiliary', status: 'disconnected' }, saveStatus: 'disconnected' });
    assert.equal(p.node('primary').disabled, true);
    for (const input of [...p.radios('primary'), ...p.radios('secondary').filter(input => input.value)]) {
      assert.equal(input.disabled, true);
      input.click();
    }
    assert.equal(p.selected('primary'), '');
    assert.equal(p.selected('secondary'), 'fixture/auxiliary');
    await p.save(); assert.deepEqual(p.posts(), []);
    await p.choose('secondary', '');
    assert.equal(p.node('save').disabled, false);
    assert.match(p.node('notice').textContent, words[lang].dirty);
    await p.save();
    assert.deepEqual(p.posts(), [{ secondaryModel: '' }]);
    assert.equal(p.state.primaryModel, ''); assert.equal(p.state.enabled, false);
    assert.equal(p.node('primary').disabled, true);
    assert.equal(p.node('secondary').disabled, true);
    await p.save(); assert.deepEqual(p.posts(), [{ secondaryModel: '' }]);
  }
});

test('all 52 available models remain actionable without a native select', async () => {
  const state = { ...initial(), models: Array.from({ length: 52 }, (_, i) => ({ id: `fixture/model-${i}`, name: `Model ${i}` })) };
  state.primaryModel = state.models[0].id;
  const p = await page({ state });
  assert.equal(p.radios('primary').length, 52); assert.equal(p.radios('secondary').length, 53);
  await p.choose('primary', 'fixture/model-51'); await p.save();
  assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/model-51' }]);
});

test('boot forwards ready.lang, theme and the relative service URL', async () => {
  for (const lang of ['en', 'zh', 'zh-TW']) {
    let target;
    const timers = fakeTimers();
    const nodes = { heading: {}, message: {}, retry: new Element('button') }, document = { documentElement: {}, getElementById: id => nodes[id] };
    await runInNewContext(boot, {
      URL, document, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      window: { magpie: { ready: Promise.resolve({ dark: true, lang, language: 'wrong-field' }), options: { get: async () => ({ settingsPort: 9999 }) }, service: '/_magpie/service/' } },
      location: { href: 'https://magpie.example/plugin/index.html', hostname: 'magpie.example', replace: value => { target = new URL(value); } },
    });
    assert.equal(target.origin, 'https://magpie.example'); assert.equal(target.pathname, '/_magpie/service/');
    assert.equal(target.searchParams.get('lang'), lang); assert.equal(target.searchParams.get('theme'), 'dark');
    assert.equal(document.documentElement.lang, lang.startsWith('zh') ? 'zh' : 'en');
  }
});

test('boot defaults to English and localizes the remote-host explanation', async () => {
  for (const lang of [undefined, 'en', 'zh']) {
    let target;
    const message = {}, document = { documentElement: {}, getElementById: () => message };
    await runInNewContext(boot, {
      URL, document, window: { magpie: { ready: Promise.resolve({ lang }) } },
      location: { href: 'https://magpie.example/plugin/index.html', hostname: 'magpie.example', replace: value => { target = value; } },
    });
    assert.equal(target, undefined);
    assert.match(message.textContent, lang === 'zh' ? /未获得设置服务地址/ : /No settings service address/);
  }
});

for (const lang of ['en', 'zh']) {
  test(`${lang}: boot retries a refused navigation and recovers when the service becomes reachable`, async () => {
    const p = await bootPage(lang);
    assert.equal(p.attempts.length, 1);
    assert.equal(p.node('retry').hidden, true);
    p.timers.advance(2999);
    assert.equal(p.attempts.length, 1, 'a refused navigation waits three seconds before retrying');
    p.setReachable(true);
    p.timers.advance(1);
    assert.equal(p.attempts.length, 2, 'the surviving document retries after the service starts');
    assert.deepEqual(p.attempts.map(attempt => attempt.at), [0, 3000]);
    assert.equal(p.attempts[1].href, p.attempts[0].href);
    const target = new URL(p.attempts[1].href);
    assert.equal(target.pathname, '/prefix/_magpie/service/');
    assert.equal(target.searchParams.get('lang'), lang);
    assert.equal(target.searchParams.get('theme'), 'dark');
    assert.equal(target.searchParams.get('uiOrigin'), 'https://magpie.example');
    assert.equal(p.destroyed, true);
    assert.equal(p.timers.pending, 0);
    p.timers.advance(30000);
    assert.equal(p.attempts.length, 2, 'the destroyed document cannot navigate again');
  });

  test(`${lang}: boot stops after three refused navigations and manual retry gets a fresh attempt budget`, async () => {
    const p = await bootPage(lang);
    p.timers.advance(6000);
    assert.equal(p.attempts.length, 3);
    assert.deepEqual(p.attempts.map(attempt => attempt.at), [0, 3000, 6000]);
    assert.equal(p.node('retry').hidden, true);
    p.timers.advance(3000);
    assert.equal(p.attempts.length, 3, 'automatic attempts are bounded');
    assert.equal(p.timers.pending, 0);
    assert.equal(p.node('retry').hidden, false);
    assert.equal(p.node('retry').textContent, lang === 'zh' ? '重试' : 'Retry');
    assert.equal(p.node('message').textContent, lang === 'zh'
      ? '未能打开设置服务。请稍候，然后点击“重试”。'
      : 'The settings service could not be opened. Wait a moment, then select Retry.');
    assert.match(bootHtml, /<button\b[^>]*\bid="retry"[^>]*\btype="button"[^>]*\bhidden/);
    p.timers.advance(30000);
    assert.equal(p.attempts.length, 3);

    p.node('retry').click();
    assert.equal(p.attempts.length, 4);
    assert.equal(p.node('retry').hidden, true);
    assert.equal(p.node('message').textContent, lang === 'zh' ? '正在连接设置服务…' : 'Connecting to the settings service…');
    p.timers.advance(9000);
    assert.equal(p.attempts.length, 6, 'manual retry restores all three attempts');
    assert.equal(p.node('retry').hidden, false);
    assert.equal(p.timers.pending, 0);

    p.setReachable(true);
    p.node('retry').click();
    assert.equal(p.attempts.length, 7);
    assert.equal(p.destroyed, true);
    assert.equal(p.timers.pending, 0);
  });
}

const optionState = () => ({
  ...initial(), secondaryModel: 'fixture/main', appliedSecondaryModel: 'fixture/main',
  primaryReasoningEffort: '', secondaryReasoningEffort: '', primaryContextTokens: null, secondaryContextTokens: null,
  primaryOptionsStatus: 'applied', secondaryOptionsStatus: 'applied',
  models: [
    { id: 'fixture/main', name: 'Main', reasoningEfforts: ['low', 'high'], contextWindow: 262144 },
    { id: 'fixture/other', name: 'Other', reasoningEfforts: ['medium'], contextWindow: 65536 },
    { id: 'fixture/auxiliary', name: 'Auxiliary', reasoningEfforts: ['low', 'high'], contextWindow: 131072 },
    { id: 'fixture/unknown', name: 'Unknown', reasoningEfforts: [], contextWindow: null },
  ],
});
const optionCopy = {
  en: { reasoning: 'Primary reasoning effort', context: 'Primary context input budget (counted/estimated)', defaultEffort: 'Use Magpie/provider default', defaultContext: 'No additional input budget', unknownEffort: /does not list configurable reasoning efforts/, unknownContext: /does not publish a context limit/, unsupported: /not supported/, invalidContext: /positive whole number|must not exceed/, inactive: /Native subtasks use the primary settings/, unconfirmed: /not confirmed/, dirty: /unsaved/, applied: /Subsequent requests use this plugin's model options and input budget rules/ },
  zh: { reasoning: '主模型思考强度', context: '主模型上下文输入预算（计数／估算）', defaultEffort: '交给 Magpie／供应方默认', defaultContext: '不额外限制输入', unknownEffort: /未列出可配置的思考强度/, unknownContext: /未公布上下文上限/, unsupported: /不支持/, invalidContext: /正整数|不能超过/, inactive: /原生子任务沿用主设置/, unconfirmed: /尚未确认/, dirty: /未保存/, applied: /后续请求使用本插件的模型参数和输入预算规则/ },
};
const budgetCopy = {
  en: {
    secondary: 'Secondary context input budget (counted/estimated)',
    guidance: "Only external inference input is limited. This does not expand or change Kimi's native compaction window. Input is checked using Magpie counts or estimates. An over-budget inference request is rejected, and Kimi may attempt automatic compaction. If recovery fails, increase or remove the budget, shorten the input, or start a new conversation. This plugin does not trim history; native compaction may reduce details from earlier messages in subsequent inference. Paid plugins keep their existing authorization, billing, and data-request paths.",
    reasoning: "Choose an effort listed by the model catalog. A reasoning effort fixed in Magpie's routing configuration takes precedence.",
    cap: 'The model catalog publishes a limit of 262144 tokens.',
    error: 'The input count could not be obtained, or the current message format is unsupported. This inference request was not sent. Retry or remove the additional input budget.',
  },
  zh: {
    secondary: '辅助模型上下文输入预算（计数／估算）',
    guidance: '仅限制外部推理输入，不扩大或改变 Kimi 原生压缩窗口。按 Magpie 计数／估算检查；超预算拒绝本次推理，Kimi 可能尝试自动压缩。恢复失败时需调高或取消预算、缩短输入或新建会话。插件不裁剪历史；原生压缩可能减少后续推理中的早期细节。付费插件保持原授权、计费和数据请求通路。',
    reasoning: '选择模型目录列出的思考强度。Magpie 路由中固定的思考强度优先。',
    cap: '模型目录公布上限为 262144 tokens。',
    error: '无法取得输入计数或当前消息格式不受支持；本次推理未发送，可重试或取消额外预算。',
  },
};

for (const lang of ['en', 'zh']) {
  const w = optionCopy[lang];
  test(`${lang}: catalog options are independent for the same primary and secondary model`, async () => {
    const p = await page({ lang, state: optionState() });
    assert.equal(p.node('primary-reasoning-label')?.textContent, w.reasoning);
    assert.equal(p.node('primary-context-label')?.textContent, w.context);
    for (const role of ['primary', 'secondary']) {
      assert.deepEqual(p.radios(`${role}-reasoning`).map(input => input.value), ['', 'low', 'high']);
      assert.equal(p.node(`${role}-reasoning`).tagName, 'FIELDSET');
      assert.equal(p.node(`${role}-context`).tagName, 'FIELDSET');
      assert.equal(p.selected(`${role}-context`), 'catalog');
      assert.equal(p.node(`${role}-context-tokens`).min, '1');
      assert.equal(p.node(`${role}-context-tokens`).step, '1');
      assert.equal(p.node(`${role}-context-tokens`).max, '262144');
      assert.equal(p.node(`${role}-context-tokens`).disabled, true);
    }
    assert.doesNotMatch(html, /<select\b/i);
    assert.match(html, /<label\b[^>]*\bfor="primary-context-tokens"/);
    assert.match(html, /id="primary-context-tokens"[^>]*aria-describedby="primary-context-hint context-guidance"/);
    await p.choose('primary-reasoning', 'high'); await p.choose('secondary-reasoning', 'low');
    await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 196608);
    await p.choose('secondary-context', 'custom'); await p.enter('secondary-context-tokens', 32768);
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: 'high', secondaryReasoningEffort: 'low', primaryContextTokens: 196608, secondaryContextTokens: 32768 }]);
    assert.equal(p.selected('primary-reasoning'), 'high'); assert.equal(p.selected('secondary-reasoning'), 'low');
    assert.equal(p.node('primary-context-tokens').value, '196608'); assert.equal(p.node('secondary-context-tokens').value, '32768');
    assert.equal(p.node('save').disabled, true);
  });

  test(`${lang}: option defaults explicitly reset to provider default and no additional input budget`, async () => {
    const p = await page({ lang, state: { ...optionState(), primaryReasoningEffort: 'high', primaryContextTokens: 65536 } });
    assert.equal(p.selected('primary-reasoning'), 'high'); assert.equal(p.selected('primary-context'), 'custom');
    assert.ok(p.radios('primary-reasoning').find(input => input.value === '').parentElement.textContent.includes(w.defaultEffort));
    assert.ok(p.radios('primary-context').find(input => input.value === 'catalog').parentElement.textContent.includes(w.defaultContext));
    await p.choose('primary-reasoning', ''); await p.choose('primary-context', 'catalog'); await p.save();
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: '', primaryContextTokens: null }]);
  });

  test(`${lang}: model switches retain invalid option drafts until the user corrects them`, async () => {
    const p = await page({ lang, state: optionState() });
    await p.choose('primary-reasoning', 'high'); await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 196608);
    await p.choose('primary', 'fixture/other');
    assert.equal(p.selected('primary-reasoning'), 'high');
    assert.equal(p.radios('primary-reasoning').find(input => input.value === 'high').disabled, true);
    assert.equal(p.node('primary-context-tokens').value, '196608');
    assert.match(p.node('primary-reasoning-hint').textContent, w.unsupported);
    assert.match(p.node('primary-context-hint').textContent, w.invalidContext);
    assert.equal(p.node('save').disabled, true);
    await p.save(); assert.deepEqual(p.posts(), []);
    await p.refresh();
    assert.equal(p.selected('primary'), 'fixture/other'); assert.equal(p.selected('primary-reasoning'), 'high');
    assert.equal(p.node('primary-context-tokens').value, '196608'); assert.equal(p.node('save').disabled, true);
    await p.choose('primary', 'fixture/main');
    assert.equal(p.selected('primary-reasoning'), 'high'); assert.equal(p.node('primary-context-tokens').value, '196608');
    assert.equal(p.node('save').disabled, false);
    await p.save(); assert.deepEqual(p.posts(), [{ primaryReasoningEffort: 'high', primaryContextTokens: 196608 }]);
  });

  test(`${lang}: unknown capabilities disable unsupported controls and preserve old API model edits`, async () => {
    const old = await page({ lang });
    assert.deepEqual(old.radios('primary-reasoning').map(input => input.value), ['']);
    assert.equal(old.radios('primary-context').find(input => input.value === 'custom').disabled, true);
    assert.equal(old.node('primary-context-tokens').disabled, true);
    assert.equal(old.node('primary-context-tokens').max, '');
    assert.match(old.node('primary-reasoning-hint').textContent, w.unknownEffort);
    assert.match(old.node('primary-context-hint').textContent, w.unknownContext);
    await old.choose('primary', 'fixture/other'); await old.save();
    assert.deepEqual(old.posts(), [{ primaryModel: 'fixture/other' }]);

    const p = await page({ lang, state: optionState() });
    await p.choose('primary-reasoning', 'high'); await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 4096);
    await p.choose('primary', 'fixture/unknown');
    assert.equal(p.node('save').disabled, true); assert.equal(p.node('primary-context-tokens').value, '4096');
    assert.equal(p.node('primary-context-tokens').disabled, true);
    assert.match(p.node('primary-context-hint').textContent, w.unknownContext);
    await p.choose('primary-reasoning', ''); await p.choose('primary-context', 'catalog'); await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/unknown', primaryReasoningEffort: '', primaryContextTokens: null }]);
  });

  test(`${lang}: context drafts require positive safe integers within the real catalog cap`, async () => {
    const p = await page({ lang, state: optionState() });
    await p.choose('primary-context', 'custom');
    for (const value of ['', 0, -1, 1.5, 262145, 9007199254740992]) {
      await p.enter('primary-context-tokens', value);
      assert.equal(p.node('save').disabled, true, `invalid token draft ${value}`);
      assert.equal(p.node('primary-context-tokens').getAttribute('aria-invalid'), 'true');
      assert.match(p.node('primary-context-hint').textContent, w.invalidContext);
      await p.save();
    }
    assert.deepEqual(p.posts(), []);
    await p.enter('primary-context-tokens', 1); await p.save();
    assert.deepEqual(p.posts(), [{ primaryContextTokens: 1 }]);
    await p.enter('primary-context-tokens', 262144); await p.save();
    assert.deepEqual(p.posts().at(-1), { primaryContextTokens: 262144 });
    assert.equal(p.node('primary-context-tokens').getAttribute('aria-invalid'), 'false');
  });

  test(`${lang}: failed saves and refreshes retain all independent option drafts`, async () => {
    const p = await page({ lang, state: optionState(), failures: 1 });
    await p.choose('primary-reasoning', 'high'); await p.choose('secondary-reasoning', 'low');
    await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 131072);
    await p.choose('secondary-context', 'custom'); await p.enter('secondary-context-tokens', 32768);
    const expected = { primaryReasoningEffort: 'high', secondaryReasoningEffort: 'low', primaryContextTokens: 131072, secondaryContextTokens: 32768 };
    await p.save(); assert.match(p.node('notice').textContent, words[lang].retained);
    await p.refresh();
    assert.equal(p.selected('primary-reasoning'), 'high'); assert.equal(p.selected('secondary-reasoning'), 'low');
    assert.equal(p.node('primary-context-tokens').value, '131072'); assert.equal(p.node('secondary-context-tokens').value, '32768');
    assert.equal(p.node('save').disabled, false); assert.match(p.node('primary-options-status').textContent, w.dirty);
    await p.save(); assert.deepEqual(p.posts(), [expected, expected]);
  });

  test(`${lang}: disabling the secondary model keeps its draft inactive and accepts the server reset`, async () => {
    const p = await page({ lang, state: { ...optionState(), secondaryReasoningEffort: 'low', secondaryContextTokens: 8192 } });
    await p.choose('secondary-reasoning', 'high'); await p.enter('secondary-context-tokens', 16384);
    await p.choose('secondary', '');
    assert.equal(p.node('secondary-reasoning').disabled, true); assert.equal(p.node('secondary-context').disabled, true);
    assert.equal(p.node('secondary-context-tokens').disabled, true);
    assert.match(p.node('secondary-options-hint').textContent, w.inactive);
    await p.refresh();
    assert.equal(p.selected('secondary'), ''); assert.equal(p.selected('secondary-reasoning'), 'high');
    assert.equal(p.node('secondary-context-tokens').value, '16384');
    await p.save(); assert.deepEqual(p.posts(), [{ secondaryModel: '' }]);
    assert.equal(p.selected('secondary-reasoning'), ''); assert.equal(p.selected('secondary-context'), 'catalog');
    assert.equal(p.state.secondaryReasoningEffort, ''); assert.equal(p.state.secondaryContextTokens, null);
    assert.equal(p.node('save').disabled, true);
  });

  test(`${lang}: disconnected roles disable option edits without preventing secondary removal`, async () => {
    const p = await page({ lang, state: { ...optionState(), enabled: false, status: 'disconnected', primaryReasoningEffort: 'removed', primaryContextTokens: 999999 } });
    for (const role of ['primary', 'secondary']) {
      assert.ok(p.node(`${role}-reasoning`), `${role} reasoning controls must exist`);
      assert.equal(p.node(`${role}-reasoning`).disabled, true); assert.equal(p.node(`${role}-context`).disabled, true);
      assert.equal(p.node(`${role}-context-tokens`).disabled, true);
      assert.equal(p.node(`${role}-context-tokens`).getAttribute('aria-invalid'), 'false');
      for (const input of [...p.radios(`${role}-reasoning`), ...p.radios(`${role}-context`)]) assert.equal(input.disabled, true);
    }
    await p.choose('secondary', ''); await p.save();
    assert.deepEqual(p.posts(), [{ secondaryModel: '' }]);
  });

  test(`${lang}: per-role option statuses are readback only and never inferred from model application`, async () => {
    const p = await page({ lang, state: optionState(), saveStatus: 'connected' });
    assert.ok(p.node('primary-options-status'), 'primary option application needs its own readback status');
    const expected = lang === 'zh' ? {
      not_configured: /使用 Magpie／供应方默认.*保存可设置独立参数/, pending: /等待 Kimi 确认/, applied: w.applied,
      context_unavailable: /无法确认独立上下文预算/, unavailable: /模型能力或连接当前不可用/,
    } : {
      not_configured: /Using Magpie\/provider defaults.*Save to set independent role options/, pending: /waiting for Kimi confirmation/, applied: w.applied,
      context_unavailable: /cannot confirm an independent context budget/, unavailable: /model capabilities or connection are unavailable/,
    };
    for (const [code, pattern] of Object.entries(expected)) {
      p.state.primaryOptionsStatus = code; p.state.secondaryOptionsStatus = 'pending'; await p.refresh();
      assert.match(p.node('primary-options-status').textContent, pattern);
      assert.match(p.node('secondary-options-status').textContent, expected.pending);
      if (code !== 'applied') assert.doesNotMatch(p.node('primary-options-status').textContent, w.applied);
    }
    for (const code of [undefined, 'future_option_status', 'constructor']) {
      p.state.primaryOptionsStatus = code; await p.refresh();
      assert.match(p.node('primary-options-status').textContent, w.unconfirmed);
    }
    p.state.primaryOptionsStatus = 'applied'; await p.refresh();
    await p.choose('primary-reasoning', 'high');
    assert.match(p.node('primary-options-status').textContent, w.dirty);
    assert.doesNotMatch(p.node('primary-options-status').textContent, w.applied);
    await p.save(); assert.deepEqual(p.posts(), [{ primaryReasoningEffort: 'high' }]);
  });

  test(`${lang}: malformed or unknown catalog limits never invent custom capability`, async () => {
    for (const contextWindow of [null, 0, -1, 1.5, 9007199254740992]) {
      const state = optionState(); state.models[0].contextWindow = contextWindow;
      state.models[0].reasoningEfforts = undefined;
      const p = await page({ lang, state });
      assert.equal(p.radios('primary-context').find(input => input.value === 'custom').disabled, true, `invalid catalog limit ${contextWindow}`);
      assert.equal(p.node('primary-context-tokens').max, '');
      assert.match(p.node('primary-context-hint').textContent, w.unknownContext);
      assert.deepEqual(p.radios('primary-reasoning').map(input => input.value), ['']);
    }
  });

  test(`${lang}: unchecked or disabled option events cannot change the draft`, async () => {
    const p = await page({ lang, state: optionState() });
    p.radios('primary-reasoning').find(input => input.value === 'high').dispatch('change');
    p.node('primary-context-tokens').value = '32768'; p.node('primary-context-tokens').dispatch('input');
    await tick();
    assert.equal(p.node('save').disabled, true);
    await p.refresh();
    assert.equal(p.selected('primary-reasoning'), ''); assert.equal(p.selected('primary-context'), 'catalog');
    await p.choose('primary', 'fixture/unknown');
    const custom = p.radios('primary-context').find(input => input.value === 'custom');
    custom.checked = true; custom.dispatch('change');
    await p.refresh(); assert.equal(p.selected('primary-context'), 'catalog');
  });

  test(`${lang}: saving disables every role option and cannot alter the in-flight draft`, async () => {
    const p = await page({ lang, state: optionState(), failures: 1 });
    await p.choose('primary-reasoning', 'high'); await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 8192);
    p.node('save').click();
    for (const role of ['primary', 'secondary']) {
      assert.equal(p.node(`${role}-reasoning`).disabled, true); assert.equal(p.node(`${role}-context`).disabled, true);
      assert.equal(p.node(`${role}-context-tokens`).disabled, true);
      for (const input of [...p.radios(`${role}-reasoning`), ...p.radios(`${role}-context`)]) assert.equal(input.disabled, true);
    }
    const low = p.radios('primary-reasoning').find(input => input.value === 'low');
    low.checked = true; low.dispatch('change');
    p.node('primary-context-tokens').value = '16384'; p.node('primary-context-tokens').dispatch('input');
    await tick(); await p.refresh();
    assert.equal(p.selected('primary-reasoning'), 'high'); assert.equal(p.node('primary-context-tokens').value, '8192');
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: 'high', primaryContextTokens: 8192 }]);
  });

  test(`${lang}: changing a model explicitly binds unchanged valid options to that model`, async () => {
    const p = await page({ lang, state: { ...optionState(), primaryReasoningEffort: 'low', primaryContextTokens: 65536 } });
    await p.choose('primary', 'fixture/auxiliary');
    assert.equal(p.selected('primary-reasoning'), 'low'); assert.equal(p.node('primary-context-tokens').value, '65536');
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryModel: 'fixture/auxiliary', primaryReasoningEffort: 'low', primaryContextTokens: 65536 }]);
    await p.choose('secondary', 'fixture/auxiliary'); await p.save();
    assert.deepEqual(p.posts().at(-1), { secondaryModel: 'fixture/auxiliary', secondaryReasoningEffort: '', secondaryContextTokens: null });
  });

  test(`${lang}: unavailable native context control reports an error and retains the option draft`, async () => {
    const p = await page({ lang, state: optionState(), failures: 1, failureCode: 'context_control_unavailable' });
    await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 8192); await p.save();
    assert.ok(p.node('notice').textContent.includes(lang === 'zh'
      ? '当前 Kimi 运行时无法控制上下文预算，本次参数未保存。'
      : 'This Kimi runtime cannot control the context budget. The change was not saved.'));
    assert.match(p.node('notice').textContent, words[lang].retained);
    assert.doesNotMatch(p.node('notice').textContent, words[lang].saved);
    assert.equal(p.selected('primary-context'), 'custom'); assert.equal(p.node('primary-context-tokens').value, '8192');
    assert.equal(p.node('save').disabled, false);
  });

  test(`${lang}: fresh default options can be explicitly saved with the existing Save button`, async () => {
    const p = await page({ lang, state: { ...optionState(), primaryOptionsStatus: 'not_configured', secondaryOptionsStatus: 'not_configured' } });
    assert.equal(p.node('save').disabled, false, 'provider defaults can be explicitly persisted for each role');
    for (const role of ['primary', 'secondary']) {
      assert.equal(p.selected(`${role}-reasoning`), ''); assert.equal(p.selected(`${role}-context`), 'catalog');
      assert.match(p.node(`${role}-options-status`).textContent, lang === 'zh' ? /使用 Magpie／供应方默认.*保存可设置独立参数/ : /Using Magpie\/provider defaults.*Save to set independent role options/);
      assert.doesNotMatch(p.node(`${role}-options-status`).textContent, w.applied);
      p.state[`${role}OptionsStatus`] = 'pending';
    }
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: '', primaryContextTokens: null, secondaryReasoningEffort: '', secondaryContextTokens: null }]);
    assert.equal(p.node('save').disabled, true);
    assert.match(p.node('primary-options-status').textContent, lang === 'zh' ? /等待 Kimi 确认/ : /waiting for Kimi confirmation/);
    assert.doesNotMatch(p.node('primary-options-status').textContent, w.applied);
  });

  test(`${lang}: a non-thinking model can explicitly save provider default without initializing an absent secondary role`, async () => {
    const state = { ...optionState(), secondaryModel: '', primaryOptionsStatus: 'not_configured', secondaryOptionsStatus: 'not_configured' };
    state.models[0].reasoningEfforts = []; state.models[0].contextWindow = null;
    const p = await page({ lang, state });
    assert.deepEqual(p.radios('primary-reasoning').map(input => input.value), ['']);
    assert.equal(p.node('secondary-reasoning').disabled, true);
    assert.equal(p.node('save').disabled, false);
    p.state.primaryOptionsStatus = 'pending';
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: '', primaryContextTokens: null }]);
    assert.equal(p.node('save').disabled, true);
  });

  test(`${lang}: old API responses cannot initialize option defaults or enable an empty Save`, async () => {
    const state = { ...optionState(), primaryOptionsStatus: 'not_configured', secondaryOptionsStatus: 'not_configured' };
    for (const role of ['primary', 'secondary']) {
      delete state[`${role}ReasoningEffort`]; delete state[`${role}ContextTokens`];
    }
    const p = await page({ lang, state });
    assert.equal(p.node('save').disabled, true);
    await p.save(); assert.deepEqual(p.posts(), []);
  });

  test(`${lang}: default initialization cannot bypass connection or invalid context guards`, async () => {
    const state = { ...optionState(), primaryOptionsStatus: 'not_configured', secondaryOptionsStatus: 'not_configured' };
    const disconnected = await page({ lang, state: { ...state, enabled: false, status: 'disconnected' } });
    assert.equal(disconnected.node('save').disabled, true);
    await disconnected.save(); assert.deepEqual(disconnected.posts(), []);
    const unavailable = await page({ lang, state: { ...state, primaryModel: 'missing/model', secondaryModel: '' } });
    assert.equal(unavailable.node('save').disabled, true);
    await unavailable.save(); assert.deepEqual(unavailable.posts(), []);
    const invalid = await page({ lang, state: { ...state, primaryContextTokens: 262145 } });
    assert.equal(invalid.node('save').disabled, true);
    await invalid.save(); assert.deepEqual(invalid.posts(), []);
  });

  test(`${lang}: context labels and guidance describe counted or estimated input budgets without changing the native window`, async () => {
    const p = await page({ lang, state: optionState() });
    assert.equal(p.node('primary-context-label').textContent, w.context);
    assert.equal(p.node('secondary-context-label').textContent, budgetCopy[lang].secondary);
    for (const role of ['primary', 'secondary']) {
      assert.equal(p.radios(`${role}-context`).find(input => input.value === 'catalog').parentElement.textContent, w.defaultContext);
      assert.match(p.node(`${role}-context`).getAttribute('aria-describedby'), /context-guidance/);
      assert.match(p.node(`${role}-context-tokens`).getAttribute('aria-describedby'), /context-guidance/);
    }
    assert.equal(p.node('context-guidance')?.textContent, budgetCopy[lang].guidance);
    if (lang === 'en') assert.ok(html.includes(`<p id="context-guidance" class="muted option-note">${budgetCopy.en.guidance}</p>`));
    assert.equal(p.node('primary-context-hint').textContent, budgetCopy[lang].cap);
    assert.match(p.node('primary-options-status').textContent, w.applied);
  });

  test(`${lang}: unavailable input counts report that inference was not sent and keep the budget draft`, async () => {
    const p = await page({ lang, state: optionState(), failures: 1, failureCode: 'context_count_unavailable' });
    await p.choose('primary-context', 'custom'); await p.enter('primary-context-tokens', 8192); await p.save();
    assert.ok(p.node('notice').textContent.includes(budgetCopy[lang].error));
    assert.match(p.node('notice').textContent, words[lang].retained);
    assert.doesNotMatch(p.node('notice').textContent, words[lang].saved);
    assert.equal(p.node('primary-context-tokens').value, '8192'); assert.equal(p.selected('primary-context'), 'custom');
    assert.equal(p.node('save').disabled, false);
    assert.deepEqual(p.posts(), [{ primaryContextTokens: 8192 }]);
  });

  test(`${lang}: reasoning hints explain that a fixed Magpie routing effort takes precedence`, async () => {
    const p = await page({ lang, state: optionState() });
    for (const role of ['primary', 'secondary']) assert.equal(p.node(`${role}-reasoning-hint`).textContent, budgetCopy[lang].reasoning);
  });

  test(`${lang}: unavailable projected defaults can repair a single non-thinking catalog model`, async () => {
    const state = {
      ...optionState(), secondaryModel: '', primaryOptionsStatus: 'unavailable', secondaryOptionsStatus: 'unavailable',
      models: [{ id: 'fixture/main', name: 'Main', reasoningEfforts: [], contextWindow: null }],
    };
    const p = await page({ lang, state });
    assert.deepEqual(p.radios('primary-reasoning').map(input => input.value), ['']);
    assert.equal(p.selected('primary-reasoning'), ''); assert.equal(p.selected('primary-context'), 'catalog');
    assert.equal(p.node('primary-context-tokens').disabled, true);
    assert.equal(p.node('save').disabled, false, 'projected defaults need an explicit repair operation');
    p.state.primaryOptionsStatus = 'pending';
    await p.save();
    assert.deepEqual(p.posts(), [{ primaryReasoningEffort: '', primaryContextTokens: null }]);
    assert.equal(p.node('save').disabled, true);
  });

  test(`${lang}: unavailable recovery cannot initialize disconnected or absent models or clear invalid drafts`, async () => {
    const state = { ...optionState(), secondaryModel: '', primaryOptionsStatus: 'unavailable', secondaryOptionsStatus: 'unavailable' };
    for (const override of [{ enabled: false, status: 'disconnected' }, { primaryModel: 'removed/model' }]) {
      const p = await page({ lang, state: { ...state, ...override } });
      assert.equal(p.node('save').disabled, true);
      await p.save(); assert.deepEqual(p.posts(), []);
    }
    const effort = await page({ lang, state });
    await effort.choose('primary-reasoning', 'high'); await effort.choose('primary', 'fixture/unknown');
    assert.equal(effort.selected('primary-reasoning'), 'high'); assert.equal(effort.node('save').disabled, true);
    await effort.save(); assert.deepEqual(effort.posts(), []);
    const context = await page({ lang, state });
    await context.choose('primary-context', 'custom'); await context.enter('primary-context-tokens', 196608);
    await context.choose('primary', 'fixture/other');
    assert.equal(context.node('primary-context-tokens').value, '196608'); assert.equal(context.node('save').disabled, true);
    await context.save(); assert.deepEqual(context.posts(), []);
  });
}

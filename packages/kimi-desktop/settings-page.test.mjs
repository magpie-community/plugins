import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('./settings.html', import.meta.url), 'utf8');
const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1]
  .replaceAll('__KIMI_SETTINGS_HEADER__', 'x-fixture-session');
const boot = await readFile(new URL('./page/boot.js', import.meta.url), 'utf8');
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
      }
      return { ok: true, json: async () => structuredClone(state) };
    },
  });
  await tick();
  const node = id => nodes.get(id);
  const radios = id => descendants(node(id)).filter(item => item.tagName === 'INPUT' && item.type === 'radio');
  return {
    node, state, document, radios,
    selected: id => radios(id).find(input => input.checked)?.value ?? '',
    posts: () => calls.filter(call => call.method === 'POST').map(call => call.body),
    async choose(id, value) {
      assert.equal(node(id).tagName, 'FIELDSET', `${id} must offer radio rows rather than a native select`);
      const input = radios(id).find(item => item.value === value);
      assert.ok(input, `${id} must offer ${value}`);
      assert.equal(input.disabled, false);
      input.click(); await tick();
    },
    async save() { node('save').click(); await tick(); },
    async refresh() { node('refresh').click(); await tick(); },
  };
}

const words = {
  en: { title: 'Kimi Work models', primary: 'Primary model', secondary: 'Secondary model', save: 'Save', dirty: /unsaved/i, saved: /settings saved/i, applied: /configuration is applied/i, retained: /kept/i, unavailable: /Saved; currently unavailable/, connect: /connect.*Kimi/i, partial: /Primary model saved; secondary model was not saved/ },
  zh: { title: 'Kimi Work 模型', primary: '主模型', secondary: '辅助模型', save: '保存', dirty: /未保存/, saved: /配置已保存/, applied: /配置已应用/, retained: /保留/, unavailable: /已保存，当前不可用/, connect: /先.*接通/, partial: /主模型已保存，辅助模型未保存/ },
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
    const nodes = { heading: {}, message: {} }, document = { documentElement: {}, getElementById: id => nodes[id] };
    await runInNewContext(boot, {
      URL, document,
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

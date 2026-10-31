(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { languageFor, translate } = aeliosI18n;
  let language = 'en', busy = false, confirmed = false, savedOptions = null, baseline = '', routes = [];
  const t = (key) => translate(language, key);
  const text = (value) => typeof value === 'string' ? value : '';
  const list = (value) => Array.isArray(value) ? value.join(', ') : '';
  function message(key, error = false) {
    const el = $('result');
    el.dataset.message = key; el.dataset.error = String(error); el.textContent = t(key); el.hidden = false;
  }
  function collect() {
    return {
      url: $('url').value, key: $('key').value, keyEnv: $('key-env').value,
      identity: $('identity').value, agents: $('agents').value,
      recall: $('recall').checked, record: $('record').checked, allowRemote: $('allow-remote').checked,
      routes: routes.map((route) => ({ identity: route.identity, models: route.models, agents: route.agents, original: route.original }))
    };
  }
  const fingerprint = () => JSON.stringify(collect());
  const dirty = () => fingerprint() !== baseline;
  function paintState() {
    const key = busy ? 'saving' : dirty() ? 'unsaved' : 'loaded';
    $('state').dataset.message = key; $('state').textContent = t(key); $('state').dataset.dirty = String(dirty());
    $('save').disabled = busy || !savedOptions;
    $('test').disabled = busy || !savedOptions;
    $('editor').disabled = busy || !savedOptions;
    $('add-route').disabled = busy || routes.length >= 64;
  }
  function secret() {
    const shown = $('key').type === 'text';
    $('show-key').textContent = t(shown ? 'hide' : 'show');
    $('show-key').setAttribute('aria-label', `${t(shown ? 'hide' : 'show')} ${t('key')}`);
    $('show-key').setAttribute('aria-pressed', String(shown));
  }
  function routeButton(key, symbol, action, disabled) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'quiet route-action'; button.textContent = symbol;
    button.title = t(key); button.setAttribute('aria-label', t(key)); button.disabled = disabled;
    button.onclick = action;
    return button;
  }
  function renderRoutes() {
    $('routes').replaceChildren();
    $('empty-routes').hidden = routes.length > 0;
    routes.forEach((route, index) => {
      const row = document.createElement('fieldset'); row.className = 'route';
      const legend = document.createElement('legend'); legend.textContent = `${t('priority')} ${index + 1}`; row.append(legend);
      const actions = document.createElement('div'); actions.className = 'route-actions';
      const move = (offset) => {
        [routes[index], routes[index + offset]] = [routes[index + offset], routes[index]];
        renderRoutes(); changed(); $(`route-${index + offset}-identity`).focus();
      };
      actions.append(routeButton('up', '↑', () => move(-1), index === 0), routeButton('down', '↓', () => move(1), index === routes.length - 1), routeButton('remove', '×', () => {
        routes.splice(index, 1); renderRoutes(); changed();
        if (routes.length) $(`route-${Math.min(index, routes.length - 1)}-identity`).focus(); else $('add-route').focus();
      }, false));
      row.append(actions);
      const fields = document.createElement('div'); fields.className = 'route-fields';
      for (const [name, label, placeholder] of [['identity', 'routeIdentity', 'personal'], ['models', 'models', 'claude-*, gpt-*'], ['agents', 'routeAgents', 'claude-code, codex']]) {
        const wrapper = document.createElement('label'); const caption = document.createElement('span'); caption.textContent = t(label);
        const input = document.createElement('input'); input.id = `route-${index}-${name}`; input.value = route[name]; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false;
        if (name === 'identity') input.maxLength = 64;
        input.oninput = () => { route[name] = input.value; changed(); };
        wrapper.append(caption, input); fields.append(wrapper);
      }
      row.append(fields); $('routes').append(row);
    });
    $('add-route').disabled = busy || routes.length >= 64;
  }
  function fill(options) {
    $('url').value = text(options.serverUrl); $('key').value = text(options.apiKey); $('key').type = 'password';
    $('key-env').value = text(options.apiKeyEnv); $('identity').value = text(options.identity); $('agents').value = list(options.agents);
    $('recall').checked = options.recall !== false; $('record').checked = options.record === true; $('allow-remote').checked = options.allowRemote === true;
    routes = Array.isArray(options.routes) ? options.routes.map((route) => ({ identity: text(route?.identity), models: list(route?.models), agents: list(route?.agents), original: route && typeof route === 'object' ? { ...route } : {} })) : [];
    renderRoutes(); secret(); baseline = fingerprint(); paintState();
  }
  function changed() {
    document.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
    $('result').hidden = true; paintState();
  }
  function paint() {
    language = languageFor(window.magpie?.theme?.lang || navigator.language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = language === 'zh' ? 'Aelios · 设置' : 'Aelios · Settings';
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    document.querySelectorAll('[data-message]').forEach((el) => { el.textContent = t(el.dataset.message); });
    secret(); renderRoutes(); if (savedOptions) paintState();
  }
  $('show-key').onclick = () => { $('key').type = $('key').type === 'password' ? 'text' : 'password'; secret(); };
  $('form').addEventListener('input', (event) => { if (!event.target.closest('.route')) changed(); });
  $('add-route').onclick = () => {
    if (routes.length >= 64) return;
    routes.push({ identity: '', models: '', agents: '', original: {} }); renderRoutes(); changed(); $(`route-${routes.length - 1}-identity`).focus();
  };
  // Magpie frames a page with allow-scripts but not allow-forms, so a submit
  // button is blocked before the handler runs. Save is a click, and the form
  // never submits; Enter in a text field saves through the same path.
  $('form').onsubmit = (event) => event.preventDefault();
  $('form').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.closest('.route') || !['INPUT'].includes(event.target.tagName) || event.target.type === 'checkbox') return;
    event.preventDefault(); save();
  });
  async function save() {
    if (busy || !savedOptions) return;
    const values = collect();
    try { aeliosForm.build(savedOptions, values); } catch (error) { validationError(error); return; }
    busy = true; paintState(); message('saving');
    let candidate;
    try {
      const latest = await magpie.options.get();
      candidate = aeliosForm.build(latest, values);
      await magpie.options.set(candidate);
      // Read the authoritative state even after an acknowledged write.
      savedOptions = await magpie.options.get(); confirmed = true;
      fill(savedOptions); message('saved');
    } catch (error) {
      try {
        savedOptions = await magpie.options.get(); confirmed = true;
        // A write can succeed even when the bridge response is rejected.
        if (candidate && equivalent(candidate, savedOptions)) { fill(savedOptions); message('saved'); }
        else if (error.field || ['invalidAdvanced', 'invalidOptions'].includes(error.message)) validationError(error);
        else message('saveFailed', true);
      } catch { confirmed = false; message('reconcileFailed', true); }
    } finally { busy = false; paintState(); }
  }
  $('save').onclick = save;
  function equivalent(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a); if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && equivalent(a[key], b[key]));
  }
  function validationError(error) {
    message(error.message || 'invalidOptions', true);
    const field = error.field && $(error.field);
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  $('test').onclick = async () => {
    if (busy || !savedOptions) return;
    if (dirty() || !confirmed) { message('saveFirst', true); return; }
    busy = true; paintState();
    try {
      savedOptions = await magpie.options.get(); confirmed = true;
      // A different window may have changed the saved options; reflect those.
      fill(savedOptions);
      const port = savedOptions.port;
      const localService = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3481}`;
      const target = new URL(`${magpie.service || localService}`.replace(/\/+$/, '') + '/test');
      target.searchParams.set('lang', language);
      location.assign(target.href);
    } catch { message('testFailed', true); }
    finally { busy = false; paintState(); }
  };
  paint();
  if (!window.magpie) { message('bridgeFailed', true); $('state').textContent = t('bridgeFailed'); return; }
  magpie.ready.then(async () => {
    paint(); magpie.onTheme(paint);
    try { savedOptions = await magpie.options.get(); confirmed = true; fill(savedOptions); }
    catch { message('loadFailed', true); $('state').dataset.message = 'loadFailed'; $('state').textContent = t('loadFailed'); }
  }).catch(() => { message('bridgeFailed', true); $('state').dataset.message = 'bridgeFailed'; $('state').textContent = t('bridgeFailed'); });
})();

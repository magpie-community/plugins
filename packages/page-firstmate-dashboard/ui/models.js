(() => {
  const fallback = { codex: 'codex-color', claude: 'claudecode-color', anthropic: 'anthropic', openai: 'openai', 'opencode-go': 'opencode', 'opencode-zen': 'opencode', grok: 'xai', xai: 'xai', cursor: 'cursor', deepseek: 'deepseek-color', gemini: 'gemini-color', google: 'google-color', antigravity: 'antigravity-color', kimi: 'kimi', moonshot: 'moonshot', qwen: 'qwen-color', minimax: 'minimax-color', zhipu: 'zhipu-color', zai: 'zai', mistral: 'mistral-color' };
  const png = new Set(["aigocode", "alma", "app-alma", "app-cc-switch", "apple-touch-icon", "atomcode", "avibe", "cindy", "crush", "gpustack", "hanako", "icon-512", "kimi-code-desktop", "kun", "lody", "mlx-serve", "mothx", "openbot", "rtk", "snow", "typesafe", "zcode", "zoo-code"]);
  const normalize = value => String(value || '').replace(/^(?:magpie\/)?mac\//, '').replace(/^magpie\//, '');
  // A dispatch model string is two layers: the MagPie catalog id (provider/id)
  // and the prefix the launching tool needs in front of it. The prefix follows
  // the harness the rule is being saved for, never the model already stored
  // there: a leftover mac/ or magpie/ from another tool would otherwise stick
  // to every new pick, and switching harness would hand the new tool the old
  // tool's prefix. mac/ is neither always valid nor always wrong: it belongs to
  // the gateway that lists it, so it is never added here and never doubled.
  const PREFIX = new Map([
    // pi --list-models magpie lists these ids under provider magpie, and
    // ~/.pi/agent/models.json holds provider "magpie" with id group/deepseek-flash.
    ['pi', 'magpie/'],
    ['pi-signed', 'magpie/'],
    // config/secondmate-harness records claude launches as
    // "mate <id>: claude magpie/<catalog id>", while the claude CLI's own model
    // surface is the bare id, so only the repository convention is established
    // here. Reported as such instead of claimed as verified.
    ['claude', 'magpie/'],
  ]);
  // The prefix this rule's harness writes, or the prefix it strips, plus what
  // establishes it. Display evidence only: it never edits a stored value, and a
  // value that does not carry it is kept and named, not renamed.
  function scopeOf(profile = {}, provider = '') {
    const harness = String(profile.harness ?? '').trim();
    const prefix = PREFIX.get(harness) || '';
    return {
      harness,
      prefix,
      // A codex rule that declares provider=codex keeps its pre-existing bare-ID
      // behavior (config/crew-dispatch.json already holds codex/gpt-6-astra). The
      // field is preserved; it only strips while the rule is still a codex rule.
      strip: harness === 'codex' && String(provider ?? '').trim() === 'codex' ? 'codex/' : '',
      basis: PREFIX.has(harness) ? (harness === 'claude' ? 'config' : 'cli') : harness === 'codex' ? 'cli' : 'none',
    };
  }
  // The exact value a candidate writes. Built from the catalog id in the shape
  // this harness needs, so an id that already carries the prefix (a mac/ gateway
  // id, or a magpie/ id) is never prefixed twice and the stored value never
  // decides the shape.
  function valueFor(id, profile = {}, provider = '') {
    const catalogId = String(id ?? '').trim();
    if (!catalogId) return '';
    const { prefix, strip } = scopeOf(profile, provider);
    if (strip && catalogId.startsWith(strip)) return catalogId.slice(strip.length);
    if (!prefix) return catalogId;
    return catalogId.startsWith(prefix) ? catalogId : `${prefix}${catalogId}`;
  }
  // A value is in the expected shape when it carries the prefix this rule
  // writes, or carries none when the rule strips one instead. This is a hint
  // about a stored value, never a rename: the value is kept as it is.
  function shapeMismatch(profile = {}, provider = '') {
    const stored = String(profile.model ?? '');
    if (!stored) return false;
    const { prefix, strip } = scopeOf(profile, provider);
    if (prefix) return !stored.startsWith(prefix);
    return Boolean(strip) && stored.startsWith(strip);
  }
  const cache = new Map();
  function catalog(harness, seat = '') {
    const key = JSON.stringify([seat, harness]);
    const old = cache.get(key);
    if (old && Date.now() - old.at < 30000) return old.promise;
    const token = document.querySelector('meta[name="fm-write-token"]').content;
    const promise = fetch(`api/models?harness=${encodeURIComponent(harness)}${seat ? `&seat=${encodeURIComponent(seat)}` : ''}`, { cache: 'no-store', headers: { 'X-FM-Write-Token': token } }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '模型目录读取失败');
      return data;
    }).catch(error => { cache.delete(key); throw error; });
    cache.set(key, { promise, at: Date.now() });
    return promise;
  }
  function describe(profile, models = [], provider = '') {
    const id = normalize(profile.model);
    const actual = String(profile.model || '').replace(/^magpie\//, '');
    const item = models.find(m => m.value === profile.model || m.gatewayId === profile.model) || models.find(m => m.id === actual) || models.find(m => normalize(m.id) === id || (provider === 'codex' && normalize(m.id) === `codex/${id}`) || (!id.includes('/') && normalize(m.id) === `${profile.harness}/${id}`));
    const family = id.includes('/') ? id.split('/')[0] : provider || profile.harness;
    return { label: item?.label || profile.model || '默认模型', icons: item?.icons?.length ? item.icons : fallback[family] ? [fallback[family]] : [], route: family === 'group', id: profile.model || '', provider: item?.group || family };
  }
  function valueOf(profile, item, catalog, provider = '') {
    // A native Agent field already states the value its own tool writes.
    if (item.exact) return item.value;
    if (item.value !== undefined) return provider === 'codex' && item.ref?.startsWith('codex/') ? item.ref.slice(6) : item.value;
    return valueFor(item.id, profile, provider);
  }
  function dispatchValue(profile, item, provider) {
    if (profile.harness === 'codex' && provider !== 'codex' && item.gatewayId) return item.gatewayId;
    return item.value;
  }
  function secondmateCodexCatalog(data) {
    const values = new Set(data.models.map(item => item.value));
    const models = [];
    for (const { gatewayId, ...item } of data.models) {
      models.push(item);
      // MagPie Agent can expose the direct choice and fold the corresponding
      // CLI gateway ID into its metadata. Startup offers each saved value.
      if (!item.direct || !gatewayId || values.has(gatewayId)) continue;
      values.add(gatewayId);
      models.push({
        id: gatewayId, value: gatewayId, ref: gatewayId,
        label: item.label, icons: item.icons, groupIcon: item.groupIcon,
        group: item.group, provider: item.provider,
        parameterKnown: item.parameterKnown, parameters: item.parameters,
      });
    }
    return { ...data, models, source: `${data.source} + magpie models` };
  }
  // Adapted from MagPie app.js oneRowPerModel/openPicker (741d502d2, MIT).
  function modelOrder(models, current, isFavorite) {
    const byValue = new Map(models.map(item => [item.value, item]));
    const omit = new Set();
    for (const item of models) {
      const alias = byValue.get(item.alias);
      if (alias) omit.add(item.value === current || (alias.value !== current && isFavorite(item) && !isFavorite(alias)) ? alias : item);
    }
    const visible = models.filter(item => !omit.has(item));
    const routes = visible.filter(item => item.group === 'Routing groups');
    const rest = visible.filter(item => item.group !== 'Routing groups');
    return [...routes, ...rest.filter(item => !item.direct), ...rest.filter(item => item.direct)];
  }
  function symbol(kind) {
    const dot = (x, y) => `M${x - 1.4} ${y}a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0`;
    const paths = {
      all: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
      favorite: 'm8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z',
      disconnect: 'M2.5 2.5l11 11M9.5 2l-2 2m5 1-2 2m-5-1-1 1a3 3 0 0 0 4 4l1-1M5 11l-2 2',
      route: [dot(2.9, 8), dot(13.1, 3.4), dot(13.1, 8), dot(13.1, 12.6), 'M4.3 8h7.4', 'M4.3 8c2.6 0 3.2-4.6 5.8-4.6h1.6', 'M4.3 8c2.6 0 3.2 4.6 5.8 4.6h1.6'].join(' '),
      generic: 'M8 2.2 13.2 5.1v5.8L8 13.8 2.8 10.9V5.1Z M8 8v5.8 M2.8 5.1 8 8l5.2-2.9',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 16 16',width:'16',height:'16',fill:'none',stroke:'currentColor','stroke-width':'1.4','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[kind] || paths.generic); svg.append(path); return svg;
  }
  function mark(icons = [], route = false, customIcons = {}) {
    const stack = document.createElement('span'); stack.className = `provider-mark${route ? ' route-mark' : ''}`;
    stack.setAttribute('aria-hidden', 'true');
    for (const icon of icons.slice(0, 3)) {
      if (!/^(?:[a-z0-9-]+|file:[a-f0-9]{8,64}\.(?:png|webp|jpe?g|svg))$/i.test(icon)) continue;
      const part = document.createElement('span'); part.className = 'provider-disc'; part.dataset.icon = icon;
      const custom = icon.startsWith('file:');
      const url = custom ? customIcons[icon] || `provider-icons/${icon.slice(5)}` : `icons/${icon}.${png.has(icon) ? 'png' : 'svg'}`;
      if (icon === 'generic') part.append(symbol('generic'));
      else if (custom || icon.endsWith('-color') || png.has(icon)) {
        const img = document.createElement('img'); img.src = url; img.alt = ''; img.draggable = false;
        img.addEventListener('error', () => { part.replaceChildren(symbol('generic')); part.classList.add('generic'); }); part.append(img);
      } else { part.classList.add('provider-mono'); part.style.setProperty('--provider-icon', `url("${url}")`); }
      stack.append(part);
    }
    if (!stack.childElementCount) {
      const generic = document.createElement('span'); generic.className = 'provider-disc generic'; generic.append(symbol(route ? 'route' : 'generic')); stack.append(generic);
    }
    if (icons.length > 3) { const more = document.createElement('small'); more.textContent = `+${icons.length - 3}`; stack.append(more); }
    return stack;
  }
  function paint(target, presentation, customIcons) {
    const label = document.createElement('span'); label.className = 'model-name'; label.textContent = presentation.label;
    target.replaceChildren(mark(presentation.icons, presentation.route, customIcons), label);
    target.title = `${presentation.provider || ''}${presentation.id ? ` · ${presentation.id}` : ''}`;
  }
  function effortChoices(profile, data) {
    if (!profile.model) return { options: [], known: true, reason: '使用 Harness 默认模型与强度' };
    const item = data.models.find(m => dispatchValue(profile, m, profile.provider) === profile.model || valueOf(profile, m, data.models, profile.provider) === profile.model || normalize(m.id) === normalize(profile.model));
    if (data.metadata !== 'native' || !item) return { options: [], known: false, reason: '目录没有这个模型的参数定义；保留当前值' };
    if (!item.parameterKnown) return { options: [], known: false, reason: '缺少这个模型的参数元数据；保留当前值' };
    const options = item.parameters.filter(o => o.value && (o.value !== 'ultra' || (['pi', 'pi-signed'].includes(profile.harness) && profile.model.startsWith('codex-native/'))));
    return { options, known: true, reason: options.length ? '' : '模型没有可配置的推理强度' };
  }
  window.FMModels = { catalog, describe, paint, mark, normalize, scopeOf, valueFor, valueOf, dispatchValue, secondmateCodexCatalog, modelOrder, shapeMismatch, effortChoices, symbol };
})();

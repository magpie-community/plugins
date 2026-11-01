// Released hosts use a best-effort field merge; read/modify/write is not
// atomic across processes.
const {languageFor, languageTags, translate} = nowledgeMemI18n;
const validateExplicitOptions = globalThis.__nowledgeMemValidateOptions;
const $ = (id) => document.getElementById(id);
let language = 'en', busy = false, savedOptions = null, draftOptions = null, baseline = null, draftOpen = false, clearKey = false;
const resets = new Set(), resetButtons = new Map();
const t = (key) => translate(language, key);
function message(id, key, error = false) {
 const el = $(id); el.dataset.message = key; el.textContent = t(key); el.dataset.error = String(error); el.hidden = false;
}
const result = (key, error = false) => message('result', key, error);
const fields = [
 ['url','serverUrl','text'], ['space','spaceId','text'], ['agent','agentId','text'], ['host-agent','hostAgentId','text'], ['key-env','apiKeyEnv','text'],
 ['skip-agents','skipAgents','list'],
 ['recall','recall','bool',true], ['recall-remote','recallRemote','bool',false], ['context','contextBundle','bool',true], ['capture','capture','bool',false], ['capture-remote','captureRemote','bool',false],
 ['capture-tools','captureTools','bool',true], ['capture-filter','captureFilter','filter','off'], ['capture-cindy','captureCindy','bool',false],
 ['max-memories','maxMemories','number',5,1,20], ['max-bytes','maxBytes','number',6000,512,32768],
 ['request-timeout','requestTimeoutMs','number',1500,50,5000], ['recall-backoff','recallBackoffMs','number',30000,100,300000],
 ['gateway-timeout','gatewayTimeoutMs','number',1000,100,10000], ['port','port','number',3479,1024,65535], ['insecure','allowInsecureHttp','bool',false],
];
function summary() {
 if (!savedOptions) return;
 $('summary-url').textContent = savedOptions.serverUrl || t('localDefault');
 $('summary-space').textContent = savedOptions.spaceId || t('defaultSpace');
 $('summary-recall').textContent = savedOptions.recall === false ? t('off') : t('on');
 $('summary-skip').textContent = skipList(savedOptions.skipAgents).join(', ') || t('none');
 $('summary-capture').checked = savedOptions.capture === true;
 $('summary-capture').disabled = busy;
 $('capture-state').textContent = savedOptions.capture === true ? t('on') : t('off');
}
function skipList(value) {
 const names = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\n]/) : [];
 return names.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean);
}
function validUrl(raw, insecure) {
 let url; try { url = new URL(raw); } catch { return false }
 const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (url.protocol !== 'http:' || local || insecure);
}
function testService() {
 const service = window.magpie?.service;
 if (typeof service === 'string' && /^https?:\/\//.test(service)) return service.replace(/\/+$/, '');
 const port = Number(savedOptions?.port);
 return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3479}`;
}
function valueOf(id, kind) { return kind === 'bool' ? $(id).checked : kind === 'filter' ? $(id).checked ? 'human' : 'off' : $(id).value; }
function snapshotForm() { return Object.fromEntries(fields.map(([id,,kind]) => [id, valueOf(id, kind)])); }
function paintReset(id, name) {
 const entry = resetButtons.get(id); if (!entry || !draftOptions) return;
 entry.button.hidden = resets.has(id) || !Object.hasOwn(draftOptions, name);
 entry.button.disabled = $(id).disabled;
 const fieldName = entry.label.querySelector?.('strong')?.textContent || entry.label.querySelector?.('span')?.textContent || id;
 const label = `${t('useDefault')}: ${fieldName}`;
 entry.button.setAttribute('aria-label',label); entry.button.setAttribute('title',label);
}
function attachOrigins() {
 for (const [id,name,kind,fallback] of fields) {
  if (resetButtons.has(id)) continue;
  const input = $(id), label = input.closest?.('label'); if (!label) continue;
  const wrapper = element('div'), reset = element('button');
  wrapper.className = 'field-wrap'; label.before(wrapper); wrapper.append(label,reset);
  reset.type = 'button'; reset.className = 'option-reset'; reset.textContent = '×';
  reset.onclick = () => {
   resets.add(id);
   if (kind === 'bool') input.checked = fallback;
   else if (kind === 'filter') input.checked = fallback === 'human';
   else input.value = '';
   if (id === 'capture-filter') syncFilter();
   if (id === 'recall' || id === 'capture') syncRemote();
   paintReset(id,name); input.focus();
  };
  const edited = () => {
   resets.delete(id);
   paintReset(id,name);
  };
  input.addEventListener('input',edited); input.addEventListener('change',edited);
  resetButtons.set(id,{button:reset,label});
 }
}
function element(tag, key) {
 const el = document.createElement(tag);
 if (key) { el.dataset.t = key; el.textContent = t(key); }
 return el;
}
function fill(options) {
 resets.clear(); attachOrigins();
 for (const [id,name,kind,fallback] of fields) {
  if (kind === 'bool') $(id).checked = options[name] ?? fallback;
  else if (kind === 'list') $(id).value = skipList(options[name]).join(', ');
  else if (kind === 'filter') $(id).checked = (options[name] ?? fallback) === 'human';
  else $(id).value = options[name] == null ? '' : String(options[name]);
 }
 clearKey = false; $('key').value = ''; $('key').type = 'password';
 baseline = {fields:snapshotForm()};
 for (const [id,name] of fields) paintReset(id,name);
 syncFilter(); syncRemote(); paintSecret(); paintKeyAction();
}
function paintSecret() {
 const visible = $('key').type === 'text', label = t(visible ? 'hideKey' : 'showKey');
 $('show-key').setAttribute('aria-label',label); $('show-key').setAttribute('title',label); $('show-key').setAttribute('aria-pressed',String(visible));
}
$('show-key').onclick = () => { $('key').type = $('key').type === 'password' ? 'text' : 'password'; paintSecret(); };
$('settings').onclose = () => { $('key').type = 'password'; paintSecret(); };
function paintKeyAction() {
 const present = typeof draftOptions?.apiKey === 'string' && !!draftOptions.apiKey.trim();
 $('key').placeholder = t(present && !clearKey ? 'keySaved' : 'keyNotSet');
 $('key-clear').hidden = !present;
 $('key-clear').textContent = t(clearKey ? 'keyUndo' : 'keyRemove');
 $('key-clear').setAttribute('aria-pressed',String(clearKey));
}
$('key-clear').onclick = () => { clearKey = !clearKey; if (clearKey) $('key').value = ''; paintKeyAction(); };
$('key').oninput = () => { if ($('key').value) clearKey = false; paintKeyAction(); };
function syncFilter() {
 $('capture-cindy').disabled = !$('capture-filter').checked;
 $('capture-tools').disabled = $('capture-filter').checked;
 paintReset('capture-cindy','captureCindy');
 paintReset('capture-tools','captureTools');
}
$('capture-filter').onchange = syncFilter;
function syncRemote() {
 $('recall-remote').disabled = !$('recall').checked;
 $('capture-remote').disabled = !$('capture').checked;
 paintReset('recall-remote','recallRemote');
 paintReset('capture-remote','captureRemote');
}
$('recall').onchange = syncRemote;
$('capture').onchange = syncRemote;
function close() { if (!busy) $('settings').close(); }
$('configure').onclick = async () => {
 if (busy || !savedOptions) return;
 if (!draftOpen) {
  try {
   const snap = {options:await magpie.options.get()};
   if (!snap || !snap.options) throw new Error('missing options');
   draftOptions = snap.options; savedOptions = snap.options; $('result').hidden = true; fill(draftOptions); summary(); draftOpen = true;
   $('save').disabled = false;
  } catch { message('configured','loadFailed',true); return; }
 }
 $('settings').showModal();
};
$('close').onclick = close;
$('cancel').onclick = () => { if (!busy) { draftOpen = false; $('key').value = ''; close(); } };
$('settings').oncancel = (event) => { if (busy) event.preventDefault(); };
function paint() {
 language = languageFor(magpie.theme?.lang || navigator.language); document.documentElement.lang = languageTags[language];
 $('close').setAttribute('aria-label',t('close')); paintSecret(); summary();
 document.querySelectorAll('[data-message]').forEach((el) => { el.textContent = t(el.dataset.message); });
 document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
 if (draftOptions) { paintKeyAction(); for (const [id,name] of fields) paintReset(id,name); }
}
magpie.ready.then(async () => {
 paint(); magpie.onTheme(paint);
 try {
  savedOptions = await magpie.options.get(); summary();
  message('configured', savedOptions.serverUrl ? 'loaded' : 'notConfigured');
  $('configure').disabled = false; $('test-saved').disabled = false;
 } catch { message('configured','loadFailed',true); }
}).catch(() => { paint(); message('configured','bridgeFailed',true); });
function nextOptions() {
 const next = {...draftOptions};
 for (const [id,name,kind,,min,max] of fields) {
  const current = valueOf(id,kind);
  if (resets.has(id)) { delete next[name]; continue; }
  if (current === baseline.fields[id]) continue;
  if (kind === 'bool' || kind === 'filter') next[name] = current;
  else if (kind === 'list') {
   const names = skipList(current);
   if (names.length) next[name] = names; else delete next[name];
  }
  else if (kind === 'number') {
   if (current === '') delete next[name];
   else { const n = Number(current); if (!Number.isInteger(n) || n < min || n > max) throw new Error('invalidOption'); next[name] = n; }
  } else if (current.trim()) next[name] = current.trim(); else delete next[name];
 }
 if (next.serverUrl && !validUrl(next.serverUrl, next.allowInsecureHttp === true)) throw new Error('invalidUrl');
 if (next.apiKeyEnv && !/^NMEM_[A-Za-z0-9_]+$/.test(next.apiKeyEnv)) throw new Error('invalidOption');
 if (clearKey) delete next.apiKey;
 else if ($('key').value) {
  const key = $('key').value.trim().replace(/^Bearer\s+/i,'');
  if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('invalidKey');
  next.apiKey = key;
 }
 // Validate the explicit values before saving; environment values are
 // resolved separately by the hook.
 validateExplicitOptions(next);
 for (const [name,min,max] of [['gatewayTimeoutMs',100,10000],['port',1024,65535]]) {
  const v = next[name];
  if (v != null && (!Number.isInteger(name === 'port' ? Number(v) : v) || Number(v) < min || Number(v) > max)) throw new Error('invalidOption');
 }
 if (next.allowInsecureHttp !== undefined && typeof next.allowInsecureHttp !== 'boolean') throw new Error('invalidOption');
 return next;
}
function optionChanges(next) {
 const changes = [], same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
 const change = (path, value, present) => changes.push(present ? {path,value} : {path,remove:true});
 for (const name of [...fields.map(([,name])=>name), 'apiKey']) {
  const before = Object.hasOwn(draftOptions,name), after = Object.hasOwn(next,name);
  if (before !== after || (after && !same(draftOptions[name],next[name]))) change([name],next[name],after);
 }
 return changes;
}
async function save(event) {
 event.preventDefault(); if (busy || !draftOptions) return;
 let next; try { next = nextOptions(); } catch (err) { result(err.message || 'invalidOption',true); return; }
 busy = true; $('save').disabled = true; $('close').disabled = true; $('cancel').disabled = true;
 try {
  const changes = optionChanges(next);
  const current = await magpie.options.get();
  // This detects changes since opening the draft, but the subsequent set is
  // not atomic with this read on released hosts.
  if (changes.some(({path}) => !sameAtPath(draftOptions,current,path))) { result('conflict',true); return; }
  // Enabling a gate must not silently activate a newly changed remote grant
  // or send credentials to a newly changed HTTP endpoint.
  const dependencies = [];
  if (next.recall !== false && draftOptions.recall === false) dependencies.push(['recallRemote']);
  if (next.capture === true && draftOptions.capture !== true) dependencies.push(['captureRemote']);
  if (next.allowInsecureHttp === true && draftOptions.allowInsecureHttp !== true) dependencies.push(['serverUrl']);
  if (dependencies.some((path) => !sameAtPath(draftOptions,current,path))) { result('conflict',true); return; }
  const merged = applyChanges(current,changes);
  validateExplicitOptions(merged);
  await magpie.options.set(merged);
  savedOptions = merged; draftOptions = merged; fill(draftOptions); summary();
  message('configured','configurationSaved'); result('saveSucceeded');
 } catch { result('saveFailed',true); }
 finally { busy = false; $('save').disabled = false; $('close').disabled = false; $('cancel').disabled = false; summary(); }
}
function valueAtPath(root,path) {
 let value = root;
 for (const key of path) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) return {present:false};
  value = value[key];
 }
 return {present:true,value};
}
function sameAtPath(a,b,path) {
 const x = valueAtPath(a,path), y = valueAtPath(b,path);
 return x.present === y.present && (!x.present || JSON.stringify(x.value) === JSON.stringify(y.value));
}
function applyChanges(current,changes) {
 const out = {...current};
 for (const {path,value,remove} of changes) {
  let target = out;
  for (const key of path.slice(0,-1)) {
   const existing = Object.hasOwn(target,key) && target[key] && typeof target[key] === 'object' ? target[key] : {};
   const copy = {...existing};
   Object.defineProperty(target,key,{value:copy,writable:true,enumerable:true,configurable:true});
   target = copy;
  }
  const key = path.at(-1);
  if (remove) delete target[key];
  else Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
 }
 return out;
}
$('summary-capture').onchange = async () => {
 if (busy || !savedOptions) return;
 const enabled = $('summary-capture').checked;
 busy = true; $('summary-capture').disabled = true; $('configure').disabled = true;
 message('capture-feedback','saving');
 try {
  const current = await magpie.options.get();
  const next = {...current,capture:enabled};
  await magpie.options.set(next); savedOptions = next;
  message('capture-feedback',enabled ? 'captureEnabled' : 'captureDisabled');
 } catch {
  try { savedOptions = await magpie.options.get(); } catch { /* keep the last confirmed value */ }
  message('capture-feedback','captureFailed',true);
 } finally {
  busy = false; $('configure').disabled = false; summary();
 }
};
$('test-saved').onclick = () => {
 if (!savedOptions) return;
 if (!validUrl(savedOptions.serverUrl || 'http://127.0.0.1:14242', savedOptions.allowInsecureHttp === true)) {
  message('configured','invalidUrl',true); return;
 }
 const target = new URL(testService() + '/test'); target.searchParams.set('lang',language); location.assign(target.href);
};
$('save').onclick = save;
$('form').onsubmit = (event) => event.preventDefault();
$('form').onkeydown = (event) => { if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.type !== 'checkbox') save(event); };
$('save').disabled = false;

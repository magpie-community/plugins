// This page uses the host's conditional-write bridge. Older hosts remain
// readable, but cannot safely save a stale form over another editor.
const {languageFor, languageTags, translate} = nowledgeMemI18n;
const validateExplicitOptions = globalThis.__nowledgeMemValidateOptions;
delete globalThis.__nowledgeMemValidateOptions;
const $ = (id) => document.getElementById(id);
let language = 'en', busy = false, canWrite = false, savedOptions = null, version = '', draftOptions = null, baseline = null, draftOpen = false, rows = [], policiesValid = true;
const resets = new Set(), origins = new Map();
const t = (key) => translate(language, key);
function message(id, key, error = false) {
 const el = $(id); el.dataset.message = key; el.textContent = t(key); el.dataset.error = String(error); el.hidden = false;
}
const result = (key, error = false) => message('result', key, error);
const fields = [
 ['url','serverUrl','text'], ['space','spaceId','text'], ['agent','agentId','text'], ['host-agent','hostAgentId','text'], ['key-env','apiKeyEnv','text'],
 ['recall','recall','bool',true], ['context','contextBundle','bool',true], ['capture','capture','bool',false],
 ['capture-tools','captureTools','bool',true], ['capture-filter','captureFilter','choice','off'], ['capture-cindy','captureCindy','bool',false],
 ['max-memories','maxMemories','number',5,1,20], ['max-bytes','maxBytes','number',6000,512,32768],
 ['request-timeout','requestTimeoutMs','number',1500,50,5000], ['recall-backoff','recallBackoffMs','number',30000,100,300000],
 ['gateway-timeout','gatewayTimeoutMs','number',1000,100,10000], ['port','port','number',3479,1024,65535], ['insecure','allowInsecureHttp','bool',false],
];
function summary() {
 if (!savedOptions) return;
 $('summary-url').textContent = savedOptions.serverUrl || t('localDefault');
 $('summary-space').textContent = savedOptions.spaceId || t('defaultSpace');
 $('summary-recall').textContent = savedOptions.recall === false ? t('off') : t('on');
 $('summary-capture').checked = savedOptions.capture === true;
 $('summary-capture').disabled = true; // edit through the versioned form
 $('capture-state').textContent = savedOptions.capture === true ? t('on') : t('off');
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
function valueOf(id, kind) { return kind === 'bool' ? $(id).checked : $(id).value; }
function snapshotForm() { return Object.fromEntries(fields.map(([id,,kind]) => [id, valueOf(id, kind)])); }
function policyValues() { return rows.map((r) => ({ id: r.id.value.trim(), spaceId: r.space.value.trim(), mode: r.mode.value })); }
function paintOrigin(id, name) {
 const note = origins.get(id); if (!note) return;
 const inherited = name === 'serverUrl' || name === 'apiKeyEnv';
 const empty = Object.hasOwn(draftOptions, name) && (draftOptions[name] === null || draftOptions[name] === '');
 note.dataset.t = resets.has(id) || !Object.hasOwn(draftOptions, name) ? inherited ? 'inherited' : 'defaultValue' : empty ? 'explicitEmpty' : 'explicitValue';
 note.textContent = t(note.dataset.t);
}
function attachOrigins() {
 for (const [id,name,kind,fallback] of fields) {
  if (origins.has(id)) continue;
  const input = $(id), label = input.closest?.('label'); if (!label) continue;
  const note = element('small'), reset = element('button','useDefault');
  reset.type = 'button'; reset.className = 'secondary option-reset';
  reset.onclick = () => {
   resets.add(id);
   if (kind === 'bool') input.checked = fallback;
   else if (kind === 'choice') input.value = fallback;
   else input.value = '';
   if (id === 'capture-filter') $('capture-cindy').disabled = input.value !== 'human';
   paintOrigin(id,name);
  };
  const edited = () => {
   resets.delete(id);
   if (baseline && valueOf(id,kind) === baseline.fields[id]) paintOrigin(id,name);
   else { note.dataset.t = 'explicitValue'; note.textContent = t('explicitValue'); }
  };
  input.addEventListener('input',edited); input.addEventListener('change',edited);
  label.append(note,reset); origins.set(id,note);
 }
}
function element(tag, key) {
 const el = document.createElement(tag);
 if (key) { el.dataset.t = key; el.textContent = t(key); }
 return el;
}
function addPolicy(value = {}) {
 const box = element('div'); box.className = 'policy-row';
 const idLabel = element('label'), spaceLabel = element('label'), modeLabel = element('label');
 const id = element('input'), space = element('input'), mode = element('select');
 id.value = value.id ?? ''; space.value = value.spaceId ?? '';
 idLabel.append(element('span','keyId'), id); spaceLabel.append(element('span','keySpace'), space);
 for (const [v,k] of [['none','keyNone'],['read','keyRead'],['write','keyWrite'],['both','keyBoth']]) {
  const option = element('option',k); option.value = v; mode.append(option);
 }
 mode.value = value.mode ?? 'none'; modeLabel.append(element('span','keyMode'), mode);
 const remove = element('button','removeKey'); remove.type = 'button'; remove.className = 'secondary';
 const row = {box,id,space,mode}; remove.onclick = () => { rows = rows.filter((r) => r !== row); box.remove(); };
 box.append(idLabel,spaceLabel,modeLabel,remove); $('key-policies').append(box); rows.push(row);
}
function fill(options) {
 resets.clear(); attachOrigins();
 for (const [id,name,kind,fallback] of fields) {
  if (kind === 'bool') $(id).checked = options[name] ?? fallback;
  else if (kind === 'choice') $(id).value = options[name] ?? fallback;
  else $(id).value = options[name] == null ? '' : String(options[name]);
 }
 $('key-action').value = 'keep'; $('key').value = ''; $('key').type = 'password';
 rows = []; $('key-policies').replaceChildren(); policiesValid = true;
 const policies = options.keyPolicies ?? {};
 if (!policies || typeof policies !== 'object' || Array.isArray(policies)) policiesValid = false;
 else for (const [id,p] of Object.entries(policies)) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.recall !== 'boolean' || typeof p.capture !== 'boolean' || (p.spaceId !== undefined && (typeof p.spaceId !== 'string' || !p.spaceId.trim()))) { policiesValid = false; break; }
  addPolicy({id, spaceId:p.spaceId ?? '', mode:p.recall ? p.capture ? 'both' : 'read' : p.capture ? 'write' : 'none'});
 }
 baseline = {fields:snapshotForm(), policies:JSON.stringify(policyValues())};
 for (const [id,name] of fields) paintOrigin(id,name);
 $('key').disabled = true; $('capture-cindy').disabled = $('capture-filter').value !== 'human'; paintSecret();
 if (!policiesValid) result('invalidPolicy', true);
}
function paintSecret() {
 const visible = $('key').type === 'text', label = t(visible ? 'hideKey' : 'showKey');
 $('show-key').setAttribute('aria-label',label); $('show-key').setAttribute('title',label); $('show-key').setAttribute('aria-pressed',String(visible));
}
$('show-key').onclick = () => { $('key').type = $('key').type === 'password' ? 'text' : 'password'; paintSecret(); };
$('key-action').onchange = () => { $('key').disabled = $('key-action').value !== 'replace'; };
$('capture-filter').onchange = () => { $('capture-cindy').disabled = $('capture-filter').value !== 'human'; };
$('add-policy').onclick = () => addPolicy();
function close() { if (!busy) $('settings').close(); }
$('configure').onclick = async () => {
 if (busy || !savedOptions) return;
 if (!draftOpen) {
  try {
   const snap = canWrite ? await magpie.options.snapshot() : {options:await magpie.options.get(),version:''};
   if (!snap || (canWrite && (typeof snap.version !== 'string' || !snap.version)) || !snap.options) throw new Error('unsupported');
   draftOptions = snap.options; version = snap.version; savedOptions = snap.options; $('result').hidden = true; fill(draftOptions); summary(); draftOpen = true;
   $('save').disabled = !canWrite; $('add-policy').disabled = !canWrite;
   if (!canWrite) result('unsupported',true);
  } catch { message('configured','unsupported',true); return; }
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
}
magpie.ready.then(async () => {
 paint(); magpie.onTheme(paint);
 try {
  savedOptions = await magpie.options.get(); summary();
  message('configured', savedOptions.serverUrl ? 'loaded' : 'notConfigured');
  $('configure').disabled = false; $('test-saved').disabled = false;
  canWrite = typeof magpie.options.snapshot === 'function' && typeof magpie.options.compareAndPatch === 'function';
  if (!canWrite) message('configured','unsupported',true);
 } catch { message('configured','loadFailed',true); }
}).catch(() => { paint(); message('configured','bridgeFailed',true); });
function nextOptions() {
 const next = {...draftOptions};
 for (const [id,name,kind,,min,max] of fields) {
  const current = valueOf(id,kind);
  if (resets.has(id)) { delete next[name]; continue; }
  if (current === baseline.fields[id]) continue;
  if (kind === 'bool' || kind === 'choice') next[name] = current;
  else if (kind === 'number') {
   if (current === '') delete next[name];
   else { const n = Number(current); if (!Number.isInteger(n) || n < min || n > max) throw new Error('invalidOption'); next[name] = n; }
  } else if (current.trim()) next[name] = current.trim(); else delete next[name];
 }
 if (next.serverUrl && !validUrl(next.serverUrl, next.allowInsecureHttp === true)) throw new Error('invalidUrl');
 if (next.apiKeyEnv && !/^NMEM_[A-Za-z0-9_]+$/.test(next.apiKeyEnv)) throw new Error('invalidOption');
 if ($('key-action').value === 'clear') delete next.apiKey;
 if ($('key-action').value === 'replace') {
  const key = $('key').value.trim().replace(/^Bearer\s+/i,'');
  if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('invalidKey');
  next.apiKey = key;
 }
 const policies = policyValues();
 if (!policiesValid) throw new Error('invalidPolicy');
 if (JSON.stringify(policies) !== baseline.policies) {
  const seen = new Set(), out = Object.create(null);
  for (const p of policies) {
   if (!p.id || p.id.length > 256 || /\s/.test(p.id) || p.id.startsWith('sk-magpie-') || seen.has(p.id) || (p.mode !== 'none' && !p.spaceId)) throw new Error('keyPolicyInvalid');
   seen.add(p.id);
   const original = Object.hasOwn(draftOptions.keyPolicies ?? {}, p.id) ? draftOptions.keyPolicies[p.id] : {};
   out[p.id] = {...original, recall:p.mode === 'read' || p.mode === 'both', capture:p.mode === 'write' || p.mode === 'both'};
   if (p.spaceId) out[p.id].spaceId = p.spaceId; else delete out[p.id].spaceId;
  }
  if (policies.length) next.keyPolicies = out; else delete next.keyPolicies;
 }
 // Share the hook's explicit-option validator; host-only fields have their
 // own bounds because they are consumed by Magpie rather than Mem.
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
 const before = draftOptions.keyPolicies ?? {}, after = next.keyPolicies ?? {};
 for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (!Object.hasOwn(after,id)) { change(['keyPolicies',id],undefined,false); continue; }
  for (const key of ['recall','capture','spaceId']) {
   const had = Object.hasOwn(before[id] ?? {},key), has = Object.hasOwn(after[id],key);
   if (had !== has || (has && !same(before[id]?.[key],after[id][key]))) change(['keyPolicies',id,key],after[id][key],has);
  }
 }
 return changes;
}
async function save(event) {
 event.preventDefault(); if (busy || !canWrite || !draftOptions) return;
 let next; try { next = nextOptions(); } catch (err) { result(err.message || 'invalidOption',true); return; }
 busy = true; $('save').disabled = true; $('close').disabled = true; $('cancel').disabled = true;
 try {
  const answer = await magpie.options.compareAndPatch(version,optionChanges(next));
  if (answer?.conflict) { result('conflict',true); return; }
  if (!answer || typeof answer.version !== 'string' || !answer.options) throw new Error('invalid response');
  savedOptions = answer.options; draftOptions = answer.options; version = answer.version; fill(draftOptions); summary();
  message('configured','configurationSaved'); result('saveSucceeded');
 } catch { result('saveFailed',true); }
 finally { busy = false; $('save').disabled = false; $('close').disabled = false; $('cancel').disabled = false; }
}
$('test-saved').onclick = () => {
 if (!savedOptions) return;
 const target = new URL(testService() + '/test'); target.searchParams.set('lang',language); location.assign(target.href);
};
$('save').onclick = save;
$('form').onsubmit = (event) => event.preventDefault();
$('form').onkeydown = (event) => { if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.type !== 'checkbox') save(event); };
$('save').disabled = false;

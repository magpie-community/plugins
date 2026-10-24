// Only the official configuration bridge is used; no service requests or host actions.
const {languageFor, languageTags, translate} = powercontextI18n;
const $ = (id) => document.getElementById(id);
let language = 'en', busy = false, savedOptions = null, pendingCapture = null;
const t = (key, parameters) => translate(language, key, parameters);
function message(id, key, error = false) {
 const el = $(id);
 el.dataset.message = key;
 el.textContent = t(key);
 el.dataset.error = String(error);
 el.hidden = false;
}
const result = (key, error = false) => message("result", key, error);
function summary() {
 if (!savedOptions) return;
 $("summary-url").textContent = savedOptions.serverUrl || t("notConfigured");
 $("summary-scope").textContent = savedOptions.scopeId || "—";
 const maxBytes = savedOptions.maxBytes ?? 8000;
 const validBudget = Number.isInteger(maxBytes) && maxBytes >= 512 && maxBytes <= 32768;
 $("budget-limit").textContent = validBudget ? t("budgetLimit", {bytes:maxBytes.toLocaleString(languageTags[language])}) : t("invalidBudget");
 const capture = $("summary-capture");
 capture.checked = pendingCapture ?? savedOptions.capture === true;
 $("capture-state").textContent = savedOptions.capture === true ? t("on") : t("off");
 capture.title = t("captureHelp");
}
function fill(options) {
 $("url").value = options.serverUrl || ""; $("scope").value = options.scopeId || "";
 $("auth").value = (options.authorization || "").replace(/^Bearer\s+/i, "");
 $("auth").type = "password";
 paintSecret();
}
function paintSecret() {
 const visible = $("auth").type === "text";
 const label = t(visible ? "hideKey" : "showKey");
 $("show-auth").setAttribute("aria-label", label);
 $("show-auth").setAttribute("title", label);
 $("show-auth").setAttribute("aria-pressed", String(visible));
}
$("show-auth").onclick = () => { $("auth").type = $("auth").type === "password" ? "text" : "password"; paintSecret(); };
$("settings").onclose = () => { $("auth").value = ""; $("auth").type = "password"; paintSecret(); };
function close() { if (!busy) $("settings").close(); }
$("configure").onclick = () => { fill(savedOptions); $("result").hidden = true; $("settings").showModal(); };
$("close").onclick = close;
$("cancel").onclick = close;
$("deployment").onclick = () => { $("docs-feedback").hidden = true; $("deployment-dialog").showModal(); };
$("deployment-close").onclick = () => $("deployment-dialog").close();
$("deployment-done").onclick = () => $("deployment-dialog").close();
$("settings").oncancel = (event) => { if (busy) event.preventDefault(); };
function paint() {
 language = languageFor(magpie.theme?.lang || navigator.language);
 document.documentElement.lang = languageTags[language];
 $("close").setAttribute("aria-label", t("close"));
 $("deployment-close").setAttribute("aria-label", t("close"));
 paintSecret();
 summary();
 document.querySelectorAll("[data-message]").forEach((el) => { el.textContent = t(el.dataset.message); });
 document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
}
magpie.ready.then(async () => {
 paint();
 magpie.onTheme(paint);
 try {
  const options = await magpie.options.get();
  savedOptions = options; fill(options); summary();
  message("configured", options.serverUrl ? "loaded" : "notConfigured");
  $("save").disabled = false; $("configure").disabled = false; $("summary-capture").disabled = false;
 } catch { message("configured", "loadFailed", true); }
}).catch(() => { paint(); message("configured", "bridgeFailed", true); });
$("copy-docs").onclick = () => {
 const selection = window.getSelection(), range = document.createRange();
 range.selectNodeContents($("docs")); selection.removeAllRanges(); selection.addRange(range);
 let copied = false;
 // The released sandbox has no clipboard bridge; use user-initiated copy with a selection fallback.
 try { copied = document.execCommand("copy"); } catch { /* Keep the address selected for manual copying. */ }
 if (copied) selection.removeAllRanges();
 message("docs-feedback", copied ? "copied" : "copyFallback");
};
const save = async (event) => {
 event.preventDefault(); if (busy) return;
 let url;
 try { url = new URL($("url").value.trim()); } catch { /* validated below */ }
 if (!url || !["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === "http:" && !["localhost","127.0.0.1","[::1]"].includes(url.hostname))) {
  result("invalidUrl", true); $("url").focus(); return;
 }
 const scopeId = $("scope").value.trim();
 if (!scopeId) {
  result("invalidScope", true); return;
 }
 const token = $("auth").value.trim().replace(/^Bearer\s+/i, "");
 if (token && /[\s\u0000-\u001f\u007f]/.test(token)) {
  result("invalidKey", true); $("auth").focus(); return;
 }
 busy = true; $("save").disabled = true; $("close").disabled = true; $("cancel").disabled = true;
 try {
  const previous = await magpie.options.get();
  // Read again before merging to preserve options not exposed by this form.
  const next = {...previous, serverUrl:url.href, scopeId};
  if (token) next.authorization = `Bearer ${token}`;
  else delete next.authorization;
  await magpie.options.set(next);
  savedOptions = next; summary();
  message("configured", "configurationSaved");
  result("saveSucceeded");
 } catch { result("saveFailed", true); }
 finally { busy = false; $("save").disabled = false; $("close").disabled = false; $("cancel").disabled = false; }
};

$("save").onclick = save;
$("form").onsubmit = (event) => event.preventDefault();
$("form").onkeydown = (event) => {
 if (event.key === "Enter" && event.target.tagName === "INPUT" && event.target.type !== "checkbox") save(event);
};

$("summary-capture").onchange = async () => {
 if (busy || !savedOptions) return;
 const enabled = $("summary-capture").checked;
 pendingCapture = enabled;
 busy = true;
 $("summary-capture").disabled = true; $("configure").disabled = true;
 message("capture-feedback", "saving");
 try {
  const previous = await magpie.options.get();
  const next = {...previous, capture:enabled};
  await magpie.options.set(next);
  savedOptions = next;
  message("capture-feedback", enabled ? "captureEnabled" : "captureDisabled");
 } catch {
  // A rejected bridge response may follow a completed write; reconcile when possible.
  try { savedOptions = await magpie.options.get(); } catch { /* Retain the last confirmed configuration. */ }
  message("capture-feedback", "captureFailed", true);
 } finally {
  pendingCapture = null; summary(); busy = false;
  $("summary-capture").disabled = false; $("configure").disabled = false;
 }
};

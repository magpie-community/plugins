// Only the official configuration bridge is used. The connection test is a
// local loopback page the frame navigates to, because the page's sandbox has
// no network (connect-src 'none'); it receives this form's values in
// window.name and never saves them.
const {languageFor, languageTags, translate} = nowledgeMemI18n;
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
 $("summary-url").textContent = savedOptions.serverUrl || t("localDefault");
 $("summary-space").textContent = savedOptions.spaceId || t("defaultSpace");
 $("summary-recall").textContent = savedOptions.recall === false ? t("off") : t("on");
 const capture = $("summary-capture");
 capture.checked = pendingCapture ?? savedOptions.capture === true;
 $("capture-state").textContent = savedOptions.capture === true ? t("on") : t("off");
 capture.title = t("captureHelp");
 $("mcp-url").textContent = mcpAddress();
}
// The Mem MCP server is added to Magpie's Library once; the MCP hub then gives
// every agent its tools. This page only shows the address.
function mcpAddress() {
 const base = savedOptions?.serverUrl || "http://127.0.0.1:14242";
 try {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, "") + "/mcp";
  return url.href;
 } catch { return "http://127.0.0.1:14242/mcp" }
}
function validUrl(raw) {
 let url;
 try { url = new URL(raw); } catch { return null }
 const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
 if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === "http:" && !loopback)) return null;
 return url;
}
function formUrl(fallback = "") {
 return validUrl($("url").value.trim() || fallback);
}
function testService() {
 const service = window.magpie?.service;
 if (typeof service === "string" && /^https?:\/\//.test(service)) return service.replace(/\/+$/, "");
 const port = Number(savedOptions?.port);
 return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3479}`;
}
function fill(options) {
 $("url").value = options.serverUrl || "";
 $("space").value = options.spaceId || "";
 $("agent").value = options.agentId || "";
 $("key").value = (options.apiKey || "").replace(/^Bearer\s+/i, "");
 $("key").type = "password";
 $("recall").checked = options.recall !== false;
 $("context").checked = options.contextBundle !== false;
 $("capture").checked = options.capture === true;
 $("remote").checked = options.recallRemote === true || options.captureRemote === true;
 paintSecret();
}
function paintSecret() {
 const visible = $("key").type === "text";
 const label = t(visible ? "hideKey" : "showKey");
 $("show-key").setAttribute("aria-label", label);
 $("show-key").setAttribute("title", label);
 $("show-key").setAttribute("aria-pressed", String(visible));
}
$("show-key").onclick = () => { $("key").type = $("key").type === "password" ? "text" : "password"; paintSecret(); };
$("settings").onclose = () => { $("key").value = ""; $("key").type = "password"; paintSecret(); };
function close() { if (!busy) $("settings").close(); }
$("configure").onclick = () => { fill(savedOptions); $("result").hidden = true; $("settings").showModal(); };
$("close").onclick = close;
$("cancel").onclick = close;
$("settings").oncancel = (event) => { if (busy) event.preventDefault(); };
function paint() {
 language = languageFor(magpie.theme?.lang || navigator.language);
 document.documentElement.lang = languageTags[language];
 $("close").setAttribute("aria-label", t("close"));
 $("show-key").setAttribute("aria-label", t("showKey"));
 paintSecret();
 summary();
 document.querySelectorAll("[data-message]").forEach((el) => { el.textContent = t(el.dataset.message); });
 document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
}
$("copy-mcp").onclick = () => {
 const selection = window.getSelection(), range = document.createRange();
 range.selectNodeContents($("mcp-url")); selection.removeAllRanges(); selection.addRange(range);
 let copied = false;
 try { copied = document.execCommand("copy"); } catch { /* Keep the address selected for manual copying. */ }
 if (copied) selection.removeAllRanges();
 message("mcp-feedback", copied ? "copied" : "copyFallback");
};
magpie.ready.then(async () => {
 paint();
 magpie.onTheme(paint);
 try {
  const options = await magpie.options.get();
  savedOptions = options; fill(options); summary();
  message("configured", options.serverUrl ? "loaded" : "notConfigured");
  $("save").disabled = false; $("configure").disabled = false; $("test-saved").disabled = false; $("summary-capture").disabled = false;
 } catch { message("configured", "loadFailed", true); }
}).catch(() => { paint(); message("configured", "bridgeFailed", true); });
const save = async (event) => {
 event.preventDefault(); if (busy) return;
 const url = formUrl();
 if (!url) { result("invalidUrl", true); $("url").focus(); return }
 const space = $("space").value.trim();
 const agent = $("agent").value.trim();
 const key = $("key").value.trim().replace(/^Bearer\s+/i, "");
 if (key && /[\s\u0000-\u001f\u007f]/.test(key)) {
  result("invalidKey", true); $("key").focus(); return;
 }
 busy = true; $("save").disabled = true; $("close").disabled = true; $("cancel").disabled = true;
 try {
  const previous = await magpie.options.get();
  // Read again before merging to preserve options not exposed by this form.
  const next = {...previous, serverUrl: url.href, recall: $("recall").checked, contextBundle: $("context").checked, capture: $("capture").checked, recallRemote: $("remote").checked, captureRemote: $("remote").checked};
  if (space) next.spaceId = space;
  else delete next.spaceId;
  if (agent) next.agentId = agent;
  else delete next.agentId;
  if (key) next.apiKey = key;
  else delete next.apiKey;
  await magpie.options.set(next);
  savedOptions = next; summary();
  message("configured", "configurationSaved");
  result("saveSucceeded");
 } catch { result("saveFailed", true); }
 finally { busy = false; $("save").disabled = false; $("close").disabled = false; $("cancel").disabled = false; }
};

$("test-saved").onclick = () => {
 if (!savedOptions) return;
 const url = validUrl(savedOptions.serverUrl || "http://127.0.0.1:14242");
 if (!url) { message("configured", "invalidUrl", true); return }
 const key = String(savedOptions.apiKey || "").replace(/^Bearer\s+/i, "");
 window.name = JSON.stringify({ serverUrl: url.href, apiKey: key, spaceId: savedOptions.spaceId || "", lang: language, returnTo: location.href.split("?")[0] });
 location.assign(testService() + "/test");
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
  const next = {...previous, capture: enabled};
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

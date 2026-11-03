// FRP Connect's page: the form and the frpc.toml it makes, and the buttons
// that start and stop frpc.
//
// The page reaches its part (this plugin, on 127.0.0.1) with the key the
// host gave it: every request but the page's own files carries it. It is
// the only way to start a tunnel, and nothing here sends the auth token
// anywhere but to this computer.

const { word } = window.FrpI18n;

let t = (name) => word("en", name);
let key = "";
let mode = "form";
let binary = "download";
let auth = "token";
let transport = "tcp";

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TYPES = ["tcp", "udp", "http", "https"];

// api goes to the part, with the key; where the page is served through
// magpie (a browser's window), magpie.service is that way in.
function api(path, body) {
  const base = (window.magpie && magpie.service) || "";
  const url = base.replace(/\/$/, "") + path;
  return fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "x-frp-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  }).then((r) => r.json());
}

// ---- the form ---------------------------------------------------------

function proxyRow(p = {}) {
  const el = document.createElement("div");
  el.className = "proxy";
  el.innerHTML = `
    <div class="line first">
      <label><span data-t="name"></span>
        <input data-k="name" type="text" placeholder="magpie" value="${esc(p.name)}" autocomplete="off" />
      </label>
      <label><span data-t="type"></span>
        <span class="segmented ptype" role="group">
          ${TYPES.map((ty) => `<button type="button" data-ptype="${ty}" aria-pressed="${ty === (p.type || "tcp")}">${ty}</button>`).join("")}
        </span>
      </label>
    </div>
    <div class="line">
      <label><span data-t="localIP"></span>
        <input data-k="localIP" type="text" placeholder="127.0.0.1" value="${esc(p.localIP ?? "127.0.0.1")}" autocomplete="off" />
      </label>
      <label><span data-t="localPort"></span>
        <input data-k="localPort" type="number" min="1" max="65535" placeholder="3425" value="${esc(p.localPort ?? "")}" />
      </label>
      <label class="port"><span data-t="remotePort"></span>
        <input data-k="remotePort" type="number" min="1" max="65535" placeholder="6000" value="${esc(p.remotePort ?? "")}" />
      </label>
    </div>
    <div class="line domains">
      <label><span data-t="customDomains"></span>
        <input data-k="customDomains" type="text" value="${esc(Array.isArray(p.customDomains) ? p.customDomains.join(", ") : p.customDomains ?? "")}" autocomplete="off" />
      </label>
      <label><span data-t="subdomain"></span>
        <input data-k="subdomain" type="text" value="${esc(p.subdomain ?? "")}" autocomplete="off" />
      </label>
    </div>
    <button class="del ghost" type="button" data-t="remove"></button>
  `;
  wordsIn(el);
  el.querySelector(".del").addEventListener("click", () => {
    el.remove();
    preview();
  });
  el.querySelectorAll("[data-ptype]").forEach((b) =>
    b.addEventListener("click", () => {
      el.querySelectorAll("[data-ptype]").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      shape(el);
      preview();
    }),
  );
  el.querySelectorAll("input").forEach((i) => i.addEventListener("input", preview));
  shape(el);
  return el;
}

// shape shows the fields a proxy's type uses: a tcp/udp one has a remote
// port, an http/https one a domain or a subdomain.
function shape(el) {
  const type = el.querySelector('[data-ptype][aria-pressed="true"]')?.dataset.ptype || "tcp";
  const web = type === "http" || type === "https";
  el.querySelector(".port").hidden = web;
  el.querySelector(".domains").hidden = !web;
}

function readProxy(el) {
  const get = (k) => el.querySelector(`[data-k="${k}"]`)?.value ?? "";
  const type = el.querySelector('[data-ptype][aria-pressed="true"]')?.dataset.ptype || "tcp";
  return {
    name: get("name"),
    type,
    localIP: get("localIP"),
    localPort: get("localPort"),
    remotePort: get("remotePort"),
    customDomains: get("customDomains"),
    subdomain: get("subdomain"),
  };
}

function read() {
  return {
    configMode: mode,
    frpcToml: $("frpcToml").value,
    frpcBinary: binary,
    frpcPath: $("frpcPath").value.trim(),
    autoStart: $("autoStart").checked,
    serverAddr: $("serverAddr").value.trim(),
    serverPort: $("serverPort").value.trim() || 7000,
    authMethod: auth,
    authToken: $("authToken").value,
    transport,
    proxies: [...document.querySelectorAll("#proxies .proxy")].map(readProxy),
  };
}

// ---- the frpc.toml, the same lines as lib/toml.mjs (a test holds the two
// together): whichever of the two is read, frpc runs the same file ------

const q = (v) => (typeof v === "number" ? String(v) : JSON.stringify(String(v)));

function port(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function buildToml(cfg) {
  const L = [];
  L.push(`serverAddr = ${q(cfg.serverAddr || "")}`);
  L.push(`serverPort = ${q(port(cfg.serverPort) ?? 7000)}`);
  L.push("loginFailExit = false");
  if (cfg.authToken) {
    L.push(`auth.method = ${q(cfg.authMethod || "token")}`);
    L.push(`auth.token = ${q(cfg.authToken)}`);
  }
  if (cfg.transport && cfg.transport !== "tcp") {
    L.push(`transport.protocol = ${q(cfg.transport)}`);
  }
  L.push("");
  for (const p of cfg.proxies) {
    const lp = port(p.localPort);
    if (!p.name || !lp) continue;
    L.push("[[proxies]]");
    L.push(`name = ${q(p.name)}`);
    L.push(`type = ${q(p.type || "tcp")}`);
    L.push(`localIP = ${q(p.localIP || "127.0.0.1")}`);
    L.push(`localPort = ${q(lp)}`);
    if (p.type === "http" || p.type === "https") {
      if (p.subdomain) L.push(`subdomain = ${q(p.subdomain)}`);
      const ds = (Array.isArray(p.customDomains) ? p.customDomains : String(p.customDomains || "").split(/[\s,]+/))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (ds.length) L.push(`customDomains = [${ds.map(q).join(", ")}]`);
    } else if (port(p.remotePort)) {
      L.push(`remotePort = ${q(port(p.remotePort))}`);
    }
    L.push("");
  }
  return L.join("\n").trimEnd() + "\n";
}

function unquote(v) {
  let s = String(v ?? "").trim();
  const hash = s.search(/[ \t]#/);
  if (hash >= 0) s = s.slice(0, hash).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

function domains(v) {
  const s = String(v ?? "").trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean).join(",");
  }
  return unquote(v);
}

function parseToml(text) {
  const out = { serverAddr: "", serverPort: 7000, authMethod: "token", authToken: "", transport: "tcp", proxies: [] };
  let current = null;
  let common = false;
  const top = (k, v) => {
    switch (k) {
      case "serverAddr": case "server_addr": out.serverAddr = v; break;
      case "serverPort": case "server_port": out.serverPort = Number(v) || v; break;
      case "protocol": out.transport = v; break;
      case "token": out.authToken = v; out.authMethod = "token"; break;
      case "method": out.authMethod = v; break;
    }
  };
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[\[proxies\]\]$/.test(line)) {
      if (current) out.proxies.push(current);
      current = {};
      common = false;
      continue;
    }
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      if (current) out.proxies.push(current);
      current = null;
      common = section[1].trim() === "common";
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const parts = kv[1].split(".");
    if (parts.length === 2 && (parts[0] === "auth" || parts[0] === "transport")) {
      top(parts[1], unquote(kv[2]));
      continue;
    }
    if (!current) {
      if (!common) top(kv[1], unquote(kv[2]));
      continue;
    }
    const v = unquote(kv[2]);
    switch (kv[1]) {
      case "name": current.name = v; break;
      case "type": current.type = v; break;
      case "localIP": case "local_ip": current.localIP = v; break;
      case "localPort": case "local_port": current.localPort = Number(v) || v; break;
      case "remotePort": case "remote_port": current.remotePort = Number(v) || v; break;
      case "customDomains": case "custom_domains": current.customDomains = domains(kv[2]); break;
      case "subdomain": current.subdomain = v; break;
    }
  }
  if (current) out.proxies.push(current);
  return out;
}

function fill(parsed) {
  $("serverAddr").value = parsed.serverAddr ?? "";
  $("serverPort").value = parsed.serverPort ?? 7000;
  setAuth(parsed.authMethod || "token");
  $("authToken").value = parsed.authToken ?? "";
  setTransport(parsed.transport || "tcp");
  const list = $("proxies");
  list.replaceChildren();
  for (const p of parsed.proxies?.length ? parsed.proxies : [{}]) list.append(proxyRow(p));
}

function preview() {
  if (mode === "form") $("preview").textContent = buildToml(read());
}

function setMode(next) {
  if (next === mode) return;
  if (next === "toml") $("frpcToml").value = buildToml(read());
  else fill(parseToml($("frpcToml").value));
  mode = next;
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("formMode").hidden = mode !== "form";
  $("tomlMode").hidden = mode !== "toml";
  preview();
}

function setBinary(next) {
  binary = next;
  for (const b of document.querySelectorAll("[data-binary]")) b.setAttribute("aria-pressed", String(b.dataset.binary === binary));
  $("frpcPathRow").hidden = binary !== "local";
}

function setAuth(next) {
  auth = next === "" ? "" : "token";
  for (const b of document.querySelectorAll("[data-auth]")) {
    b.setAttribute("aria-pressed", String((b.dataset.auth || "") === auth));
  }
}

function setTransport(next) {
  transport = next || "tcp";
  for (const b of document.querySelectorAll("[data-transport]")) {
    b.setAttribute("aria-pressed", String(b.dataset.transport === transport));
  }
}

// ---- the part's answers ----------------------------------------------

function render(s) {
  if (!s) return;
  if (s.binary && binary === "download") {
    $("frpcInfo").textContent = s.binary.ready
      ? `${s.binary.path} (${s.version || "frpc"})`
      : t("downloadInfo");
  }
  $("log-meta").textContent = [
    s.running ? `${t("running")} · ${t("pid")} ${s.pid}` : t("stopped"),
    s.version ? `frpc ${s.version}` : "",
    `${t("logFile")}: ${s.logPath || ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const log = $("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = s.log || t("noLog");
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function say(what) {
  const r = what.result || {};
  const error = what.error;
  let line;
  if (error) line = `${t("failed")}${error}`;
  else if (what.action === "verify") line = r.ok ? t("verifyOk") : `${t("verifyBad")}：${r.stderr || r.stdout || r.why || r.error || ""}`;
  else if (what.action === "start" || what.action === "restart") {
    line = r.started ? `${t("started")} · ${t("pid")} ${r.pid}` : r.alreadyRunning ? `${t("already")} · ${t("pid")} ${r.pid}` : t("startFailed");
  } else if (what.action === "stop") line = r.stopped ? t("stoppedAction") : t("wasStopped");
  else line = what.action;
  $("action-status").textContent = line;
}

async function act(action) {
  $("action-status").textContent = t("submitted");
  try {
    const answer = await api("/api/action", { action });
    say({ action, ...answer });
    render(answer.state);
    return answer.result?.ok;
  } catch (e) {
    $("action-status").textContent = `${t("failed")}${e.message}`;
    return undefined;
  }
}

// ---- what the page does ----------------------------------------------

function wordsIn(root = document) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
}

async function load() {
  await magpie.ready;
  t = (name) => word(magpie.theme?.lang, name);
  document.documentElement.lang = magpie.theme?.lang || "en";
  wordsIn();

  const o = (await magpie.options.get()) ?? {};
  mode = o.configMode === "toml" ? "toml" : "form";
  binary = o.frpcBinary === "local" ? "local" : "download";
  key = o.__frpKey ?? "";
  $("serverAddr").value = o.serverAddr ?? "";
  $("serverPort").value = o.serverPort ?? 7000;
  setAuth(o.authMethod ?? "token");
  $("authToken").value = o.authToken ?? "";
  setTransport(o.transport ?? "tcp");
  $("frpcPath").value = o.frpcPath ?? "";
  $("frpcToml").value = o.frpcToml ?? "";
  $("autoStart").checked = o.autoStart === true;
  const list = $("proxies");
  list.replaceChildren();
  for (const p of Array.isArray(o.proxies) && o.proxies.length ? o.proxies : [{}]) list.append(proxyRow(p));

  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("formMode").hidden = mode !== "form";
  $("tomlMode").hidden = mode !== "toml";
  setBinary(binary);
  preview();

  if (!key) {
    $("action-status").textContent = t("noKey");
    return;
  }
  try {
    render(await api("/api/state"));
  } catch (e) {
    $("action-status").textContent = `${t("failed")}${e.message}`;
  }
}

// save writes the options; magpie reloads the plugin with them, so the
// token reaches frpc's own folder and nothing else.
// The key is the host's, not an option: it goes back into the options as it
// came, so saving a form leaves nothing of it behind in plugins.json either.
async function save() {
  try {
    const o = (await magpie.options.get()) ?? {};
    const keep = Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("__")));
    await magpie.options.set({ ...keep, ...read() });
    $("status").textContent = t("saved");
  } catch (e) {
    $("status").textContent = `${t("failed")}${e.message}`;
  }
}

$("add").addEventListener("click", () => {
  $("proxies").append(proxyRow({}));
  preview();
});
$("save").addEventListener("click", save);
$("verify").addEventListener("click", () => act("verify"));
$("start").addEventListener("click", () => act("start"));
$("stop").addEventListener("click", () => act("stop"));
$("restart").addEventListener("click", () => act("restart"));

$("reveal").addEventListener("click", () => {
  const field = $("authToken");
  const shown = field.type === "text";
  field.type = shown ? "password" : "text";
  $("reveal").textContent = t(shown ? "show" : "hide");
  $("reveal").setAttribute("aria-pressed", String(!shown));
});

["serverAddr", "serverPort", "authToken", "frpcPath", "frpcToml"].forEach((id) => {
  const el = $(id);
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", preview);
});
$("autoStart").addEventListener("change", preview);
for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
for (const b of document.querySelectorAll("[data-binary]")) b.addEventListener("click", () => setBinary(b.dataset.binary));
for (const b of document.querySelectorAll("[data-auth]")) b.addEventListener("click", () => { setAuth(b.dataset.auth || ""); preview(); });
for (const b of document.querySelectorAll("[data-transport]")) b.addEventListener("click", () => { setTransport(b.dataset.transport); preview(); });

let poll = null;
function watch() {
  const seen = () => (magpie.visible === false ? null : api("/api/state").then(render).catch(() => {}));
  clearInterval(poll);
  poll = setInterval(seen, 3000);
  magpie.onVisibility?.(() => (magpie.visible ? seen() : null));
}

load()
  .then(watch)
  .catch((e) => {
    $("status").textContent = `${t("failed")}${e.message}`;
  });

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c]);

const TYPES = ["tcp", "udp", "http", "https"];

function proxyRow(p = {}) {
  const el = document.createElement("div");
  el.className = "proxy";
  el.innerHTML = `
    <div class="line">
      <input data-k="name" type="text" placeholder="名称，如 magpie" value="${esc(p.name)}" />
      <select data-k="type">
        ${TYPES.map((t) => `<option value="${t}" ${t === (p.type || "tcp") ? "selected" : ""}>${t}</option>`).join("")}
      </select>
    </div>
    <div class="line">
      <input data-k="localIP" type="text" placeholder="127.0.0.1" value="${esc(p.localIP ?? "127.0.0.1")}" />
      <input data-k="localPort" type="number" placeholder="本地端口" value="${esc(p.localPort ?? "")}" />
      <input data-k="remotePort" class="rport" type="number" placeholder="远端端口(tcp/udp)" value="${esc(p.remotePort ?? "")}" />
    </div>
    <div class="line http" data-http>
      <input data-k="customDomains" type="text" placeholder="customDomains，逗号分隔" value="${esc(p.customDomains ?? "")}" />
      <input data-k="subdomain" type="text" placeholder="subdomain 可选" value="${esc(p.subdomain ?? "")}" />
    </div>
    <button class="del" type="button">删除</button>
  `;

  el.querySelector(".del").addEventListener("click", () => {
    el.remove();
    renderPreview();
  });
  el.querySelector('select[data-k="type"]').addEventListener("change", () => {
    sync(el);
    renderPreview();
  });
  el.querySelectorAll("input").forEach((i) => i.addEventListener("input", renderPreview));
  sync(el);
  return el;
}

function sync(el) {
  const type = el.querySelector('select[data-k="type"]').value;
  const isHttp = type === "http" || type === "https";
  el.querySelector(".rport").style.display = isHttp ? "none" : "";
  el.querySelector("[data-http]").style.display = isHttp ? "" : "none";
}

function readProxy(el) {
  const get = (k) => el.querySelector(`[data-k="${k}"]`)?.value ?? "";
  return {
    name: get("name"),
    type: get("type"),
    localIP: get("localIP"),
    localPort: get("localPort"),
    remotePort: get("remotePort"),
    customDomains: get("customDomains"),
    subdomain: get("subdomain"),
  };
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "form";
}

function currentFrpcMode() {
  return document.querySelector('input[name="frpcMode"]:checked')?.value || "download";
}

function readConfig() {
  return {
    configMode: currentMode(),
    frpcToml: $("frpcToml").value,
    frpcMode: currentFrpcMode(),
    frpcPath: $("frpcPath").value.trim(),
    autoConnect: $("autoConnect").checked,
    serverAddr: $("serverAddr").value.trim(),
    serverPort: $("serverPort").value.trim() ? Number($("serverPort").value) : 7000,
    authMethod: $("authMethod").value,
    authToken: $("authToken").value.trim(),
    transport: $("transport").value,
    proxies: [...document.querySelectorAll("#proxies .proxy")].map(readProxy),
  };
}

function buildToml(cfg) {
  const q = (v) => (typeof v === "number" ? String(v) : JSON.stringify(String(v)));
  const port = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  };
  const L = [];
  L.push(`serverAddr = ${q(cfg.serverAddr || "")}`);
  L.push(`serverPort = ${q(port(cfg.serverPort) ?? 7000)}`);
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
    if (!p.name || !p.type || lp === null) continue;
    L.push("[[proxies]]");
    L.push(`name = ${q(p.name)}`);
    L.push(`type = ${q(p.type)}`);
    L.push(`localIP = ${q(p.localIP || "127.0.0.1")}`);
    L.push(`localPort = ${q(lp)}`);
    if (p.type === "http" || p.type === "https") {
      if (p.subdomain) L.push(`subdomain = ${q(p.subdomain)}`);
      const ds = (p.customDomains || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (ds.length) L.push(`customDomains = [${ds.map(q).join(", ")}]`);
    } else if (port(p.remotePort) !== null) {
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
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function parseDomains(v) {
  let s = String(v ?? "").trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
    return s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean).join(",");
  }
  return unquote(v);
}

function parseToml(text) {
  const out = { serverAddr: "", serverPort: 7000, authMethod: "token", authToken: "", transport: "tcp", proxies: [] };
  let current = null;
  let inCommon = false;

  const setTop = (key, value) => {
    switch (key) {
      case "serverAddr": case "server_addr": out.serverAddr = value; break;
      case "serverPort": case "server_port": out.serverPort = value; break;
      case "protocol": out.transport = value; break;
      case "token": out.authToken = value; out.authMethod = "token"; break;
      case "method": out.authMethod = value; break;
    }
  };

  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const tomlProxy = line.match(/^\[\[proxies\]\]\s*$/);
    const iniSection = line.match(/^\[(.+)\]$/);
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);

    if (tomlProxy) {
      if (current) out.proxies.push(current);
      current = {};
      inCommon = false;
      continue;
    }
    if (iniSection) {
      if (current) out.proxies.push(current);
      const name = iniSection[1].trim();
      inCommon = name === "common";
      current = inCommon ? null : { name };
      continue;
    }
    if (!kv) continue;

    const key = kv[1].trim();
    const val = kv[2];
    const parts = key.split(".");
    if (parts.length === 2 && (parts[0] === "auth" || parts[0] === "transport")) {
      setTop(parts[1], unquote(val));
      continue;
    }

    if (current) {
      const v = unquote(val);
      switch (key) {
        case "name": current.name = v; break;
        case "type": current.type = v; break;
        case "localIP": case "local_ip": current.localIP = v; break;
        case "localPort": case "local_port": current.localPort = v; break;
        case "remotePort": case "remote_port": current.remotePort = v; break;
        case "customDomains": case "custom_domains": current.customDomains = parseDomains(val); break;
        case "subdomain": current.subdomain = v; break;
      }
    } else if (!inCommon) {
      setTop(key, unquote(val));
    }
  }
  if (current) out.proxies.push(current);
  return out;
}

function applyTomlToForm(parsed) {
  $("serverAddr").value = parsed.serverAddr ?? "";
  $("serverPort").value = parsed.serverPort ?? 7000;
  $("authMethod").value = parsed.authMethod || "token";
  $("authToken").value = parsed.authToken ?? "";
  $("transport").value = parsed.transport || "tcp";
  const list = $("proxies");
  list.innerHTML = "";
  const proxies = parsed.proxies && parsed.proxies.length ? parsed.proxies : [{}];
  proxies.forEach((p) => list.appendChild(proxyRow(p)));
}

function renderPreview() {
  if (currentMode() === "form") {
    $("preview").textContent = buildToml(readConfig());
  }
}

function syncMode() {
  const mode = currentMode();
  $("formMode").hidden = mode !== "form";
  $("tomlMode").hidden = mode !== "toml";
  renderPreview();
  syncFrpcMode();
}

function convertMode(target) {
  if (target === "toml") {
    $("frpcToml").value = buildToml(readConfig());
  } else if (target === "form") {
    applyTomlToForm(parseToml($("frpcToml").value));
  }
  syncMode();
}

function renderFrpcInfo(frpc, download) {
  const el = $("frpcDownloadInfo");
  if (!el || currentFrpcMode() !== "download") return;

  const parts = [];
  if (download) {
    if (download.state === "downloading") {
      parts.push(`正在下载 frpc… ${download.percent}%`);
    } else if (download.state === "extracting") {
      parts.push("正在解压 frpc…");
    } else if (download.state === "error") {
      parts.push(`下载失败：${download.error || ""}`);
    }
  }
  if (frpc && frpc.path) {
    const src =
      frpc.source === "bundled" ? "内置" : frpc.source === "downloaded" ? "已下载" : frpc.source;
    parts.push(`${src}：${frpc.path}${frpc.version ? `（${frpc.version}）` : ""}`);
  } else if (!download || (download.state !== "downloading" && download.state !== "extracting")) {
    parts.push("点「启动」或「校验」后会按需自动下载 frpc。");
  }
  el.textContent = parts.join(" · ");
}

function syncFrpcMode() {
  const mode = currentFrpcMode();
  $("frpcPathRow").hidden = mode !== "local";
  $("frpcDownloadInfo").hidden = mode !== "download";
  if (mode === "download") {
    renderFrpcInfo(window.__FRP_LOG__?.frpc, window.__FRP_LOG__?.download);
  }
}

function renderLog() {
  const s = window.__FRP_LOG__;
  if (!s) return;
  $("log-meta").textContent =
    (s.running ? `运行中 (pid ${s.pid})` : "未运行") +
    ` · 日志文件: ${s.logPath || ""}`;
  const log = $("log");
  log.textContent = s.tail || "(暂无日志)";
  log.scrollTop = log.scrollHeight;
  renderAction(s.lastAction);
  renderFrpcInfo(s.frpc, s.download);
}

function renderAction(la) {
  const el = $("action-status");
  if (!el) return;
  if (!la) {
    el.textContent = "";
    return;
  }
  const labels = { start: "启动", stop: "停止", restart: "重启", verify: "校验" };
  const label = labels[la.action] || la.action;
  if (la.error) {
    el.textContent = `${label}失败：${la.error}`;
    return;
  }
  const r = la.result || {};
  if (la.action === "verify") {
    el.textContent = r.ok
      ? "校验通过：" + (r.stdout || "")
      : "校验未通过：" + (r.stderr || r.stdout || r.error || "");
  } else if (la.action === "start" || la.action === "restart") {
    if (r.alreadyRunning) el.textContent = `${label}：已在运行 (pid ${r.pid})`;
    else if (r.started) el.textContent = `${label}：已启动 (pid ${r.pid})`;
    else el.textContent = `${label}：启动后立即退出，见日志`;
  } else if (la.action === "stop") {
    el.textContent = r.stopped ? `${label}：已停止` : `${label}：未在运行`;
  }
}

async function doAction(action) {
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  $("action-status").textContent = "已提交，正在生效…";
  await magpie.options.set({ ...readConfig(), requestAction: { action, nonce } });
  setTimeout(pollLog, 800);
}

let lastLogScript = null;
function pollLog() {
  const s = document.createElement("script");
  s.src = `_log.js?t=${Date.now()}`;
  s.onload = renderLog;
  s.onerror = () => {};
  document.head.appendChild(s);
  if (lastLogScript) lastLogScript.remove();
  lastLogScript = s;
}

async function load() {
  await magpie.ready;
  const o = (await magpie.options.get()) ?? {};
  const mode = o.configMode === "toml" ? "toml" : "form";
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $("frpcToml").value = o.frpcToml ?? "";
  $("serverAddr").value = o.serverAddr ?? "";
  $("serverPort").value = o.serverPort ?? 7000;
  $("authMethod").value = o.authMethod ?? "token";
  $("authToken").value = o.authToken ?? "";
  $("transport").value = o.transport ?? "tcp";
  $("frpcPath").value = o.frpcPath ?? "";
  const frpcMode = o.frpcMode === "local" ? "local" : "download";
  const frpcRadio = document.querySelector(`input[name="frpcMode"][value="${frpcMode}"]`);
  if (frpcRadio) frpcRadio.checked = true;
  $("autoConnect").checked = o.autoConnect === true;

  const list = $("proxies");
  list.innerHTML = "";
  const proxies = Array.isArray(o.proxies) && o.proxies.length ? o.proxies : [{}];
  proxies.forEach((p) => list.appendChild(proxyRow(p)));
  syncMode();
}

async function save() {
  await magpie.options.set(readConfig());
  $("status").textContent =
    "已保存，插件会自动重载。启动/停止/状态请让智能体调用 frp-connect_start / stop / status。";
}

$("add").addEventListener("click", () => {
  $("proxies").appendChild(proxyRow({}));
  renderPreview();
});
$("save").addEventListener("click", save);
$("verify").addEventListener("click", () => doAction("verify"));
$("start").addEventListener("click", () => doAction("start"));
$("stop").addEventListener("click", () => doAction("stop"));
$("restart").addEventListener("click", () => doAction("restart"));
$("refresh-log").addEventListener("click", () => pollLog());

["serverAddr", "serverPort", "authMethod", "authToken", "transport", "frpcPath"].forEach((id) => {
  const el = $(id);
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", renderPreview);
});
$("autoConnect").addEventListener("change", renderPreview);
document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener("change", () => convertMode(r.value));
});
document.querySelectorAll('input[name="frpcMode"]').forEach((r) => {
  r.addEventListener("change", syncFrpcMode);
});

load().catch((e) => {
  $("status").textContent = "加载失败：" + e.message;
});
pollLog();
setInterval(pollLog, 3000);

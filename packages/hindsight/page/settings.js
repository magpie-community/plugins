const $ = id => document.getElementById(id);
const DEFAULTS = Object.freeze({
  hindsight_api: "http://127.0.0.1:8888",
  bank: "hermes",
  recall_max_tokens: 1024,
  capture: false,
  agents: Object.freeze([]),
  gatewayTimeoutMs: 5000,
  allowRemote: false,
  allowInsecureHttp: false
});
const SERVICE_PORT = 3482;
let savedOptions = {};
let busy = false;
let dirty = false;
let loaded = false;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function setBusy(value) {
  busy = value;
  $("save").disabled = busy || !loaded;
  $("test-connection").disabled = busy || !loaded;
}

function invalid(field, message) {
  const error = new Error(message);
  error.field = field;
  throw error;
}

function apiUrl() {
  const raw = $("hindsight_api").value.trim();
  let url;
  try { url = new URL(raw); }
  catch { invalid("hindsight_api", "请输入有效的 Hindsight API 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalid("hindsight_api", "API 地址只允许 HTTP/HTTPS，且不能包含凭据、查询参数或片段。");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback && !$("allowInsecureHttp").checked)
    invalid("allowInsecureHttp", "非 loopback 明文 HTTP 需要同时勾选安全例外；建议使用 HTTPS。");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function agents() {
  const values = $("agents").value.split(/[,，]/).map(value => value.trim()).filter(Boolean);
  if (values.length > 64 || values.some(value => value.length > 128 || /[\x00-\x1f\x7f]/.test(value)))
    invalid("agents", "Agents 最多 64 项，每项不超过 128 字符且不能包含控制字符。");
  return [...new Set(values)];
}

function integer(id, min, max, label) {
  const value = Number($(id).value);
  if (!Number.isInteger(value) || value < min || value > max)
    invalid(id, `${label}必须是 ${min}–${max} 之间的整数。`);
  return value;
}

function readForm() {
  const bank = $("bank").value.trim();
  if (!bank || bank.length > 128 || /[/?#\x00-\x1f\x7f]/.test(bank))
    invalid("bank", "Bank 不能为空，且不能包含 / ? # 或控制字符。");
  return {
    hindsight_api: apiUrl(),
    bank,
    recall_max_tokens: integer("recall_max_tokens", 1, 16384, "召回最大 Token 数"),
    capture: $("capture").checked,
    agents: agents(),
    gatewayTimeoutMs: integer("gatewayTimeoutMs", 100, 10000, "网关超时"),
    allowRemote: $("allowRemote").checked,
    allowInsecureHttp: $("allowInsecureHttp").checked
  };
}

function updateSummary(options) {
  $("status-bank").textContent = typeof options.bank === "string" && options.bank ? options.bank : DEFAULTS.bank;
  const list = Array.isArray(options.agents) ? options.agents : [];
  $("status-agents").textContent = list.length ? list.join(", ") : "全部（默认跳过 hermes / dsh）";
  $("status-api").textContent = "尚未测试";
}

function fillForm(options) {
  $("hindsight_api").value = options.hindsight_api ?? DEFAULTS.hindsight_api;
  $("bank").value = options.bank ?? DEFAULTS.bank;
  $("recall_max_tokens").value = options.recall_max_tokens ?? DEFAULTS.recall_max_tokens;
  $("capture").checked = options.capture === true;
  $("agents").value = Array.isArray(options.agents) ? options.agents.join(", ") : "";
  $("gatewayTimeoutMs").value = options.gatewayTimeoutMs ?? DEFAULTS.gatewayTimeoutMs;
  $("allowRemote").checked = options.allowRemote === true;
  $("allowInsecureHttp").checked = options.allowInsecureHttp === true;
  updateSummary(options);
}

async function load() {
  try {
    savedOptions = await magpie.options.get() || {};
    fillForm(savedOptions);
    loaded = true;
    dirty = false;
    setBusy(false);
    status("配置已读取 · 尚未测试连接");
  } catch {
    setBusy(true);
    status("无法读取配置，请检查 Magpie 插件页面接口。", true);
  }
}

magpie.ready.then(load).catch(() => status("Magpie 页面接口不可用。", true));

$("form").addEventListener("input", () => {
  if (!loaded || busy) return;
  dirty = true;
  status("有未保存的修改。");
});

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !loaded) return;
  let values;
  try { values = readForm(); }
  catch (error) {
    status(error.message || "配置无效。", true);
    $(error.field)?.focus();
    return;
  }
  setBusy(true);
  status("正在保存…");
  const next = { ...savedOptions, ...values };
  try {
    const saved = await magpie.options.set(next);
    savedOptions = saved && typeof saved === "object" ? saved : next;
    updateSummary(savedOptions);
    dirty = false;
    status("配置已保存 · 可以测试连接");
  } catch {
    status("保存失败，请稍后重试。", true);
  } finally {
    setBusy(false);
  }
});

$("test-connection").addEventListener("click", () => {
  if (busy || !loaded) return;
  if (dirty) {
    status("请先保存修改，再测试已保存的连接。", true);
    return;
  }
  const port = Number.isInteger(savedOptions.port) && savedOptions.port >= 1024 && savedOptions.port <= 65535
    ? savedOptions.port : SERVICE_PORT;
  const base = magpie.service || `http://127.0.0.1:${port}`;
  setBusy(true);
  status("正在打开连接测试…");
  try { location.assign(`${base.replace(/\/+$/, "")}/test`); }
  catch {
    setBusy(false);
    status("无法打开连接测试服务。", true);
  }
});

window.addEventListener("pageshow", event => {
  if (!event.persisted || !loaded) return;
  setBusy(false);
  status("已返回设置；连接结果以测试页为准。");
});

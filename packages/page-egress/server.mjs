import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  projectState, recordCheck, bindingPayload, changedFields, validateAddress
} from "./model.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function requestJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const data = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = transport.request(url, {
      method: options.method || "GET",
      headers: {
        ...options.headers,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) request.destroy(new Error("Magpie 返回的数据过大"));
      });
      response.on("end", () => {
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        resolve({ status: response.statusCode, body, headers: response.headers });
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error("Magpie 请求超时")));
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

export class NativeAPI {
  constructor(base, key) {
    this.base = new URL(base);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password) throw new Error("管理地址无效");
    this.key = key;
    this.cookie = "";
  }

  async raw(route, options = {}) {
    if (!route.startsWith("/api/") && route !== "/") throw new Error("不支持的管理路径");
    const url = new URL(route, this.base);
    return requestJSON(url, options);
  }

  async call(route, body) {
    if (!this.cookie) {
      if (!this.key) throw Object.assign(new Error("插件服务缺少 Magpie 管理凭据，请检查服务器配置"), { status: 503 });
      const signIn = new URL("/", this.base);
      signIn.searchParams.set("k", this.key);
      const login = await requestJSON(signIn);
      if (login.status !== 303) throw new Error("Magpie 管理认证失败");
      this.cookie = (login.headers["set-cookie"] || []).map((cookie) => cookie.split(";")[0]).join("; ");
    }
    let result = await this.raw(route, {
      method: body === undefined ? "GET" : "POST", body,
      headers: { Cookie: this.cookie }
    });
    if (result.status === 401) {
      this.cookie = "";
      throw Object.assign(new Error("Magpie 管理会话失效，请重试"), { status: 503 });
    }
    if (result.status >= 400 || result.body?.error) {
      const status = result.status >= 400 ? result.status : 400;
      const error = result.body?.error;
      throw Object.assign(new Error(typeof error === "string" ? error : `Magpie 操作失败（HTTP ${status}）`), { status });
    }
    return result.body;
  }
}

async function loadJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function bodyJSON(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 32 * 1024) throw Object.assign(new Error("请求过大"), { status: 413 });
  }
  try { return JSON.parse(text); } catch { throw new Error("请求 JSON 无效"); }
}

export async function createManager(options) {
  const directory = options.directory;
  const stateDirectory = options.stateDirectory || path.join(directory, "egress-manager");
  const api = options.api || new NativeAPI(
    options.apiBase || process.env.MAGPIE_EGRESS_API_BASE || "http://127.0.0.1:3430",
    options.webKey || process.env.MAGPIE_WEB_KEY
  );
  const historyFile = path.join(stateDirectory, "history.json");
  const history = await loadJSON(historyFile, { proxies: {}, events: [] });
  if (!history.proxies || !Array.isArray(history.events)) throw new Error("出口检测记录损坏，请先恢复 history.json");
  let serial = Promise.resolve();
  let lastListing = null;
  let lastListingAt = 0;
  const pendingChecks = new Map();
  const proxyVersions = new Map();
  function exclusive(operation) {
    const next = serial.then(operation);
    serial = next.catch(() => {});
    return next;
  }
  async function listing(refresh = false) {
    if (!refresh && lastListing && Date.now() - lastListingAt < 30000) return lastListing;
    lastListing = await api.call("/api/providers?last=1");
    if (!lastListing?.providers) lastListing = await api.call("/api/providers");
    lastListingAt = Date.now();
    return lastListing;
  }
  async function stored() {
    const document = await loadJSON(path.join(directory, "providers.json"));
    if (!Array.isArray(document.providers)) throw new Error("不支持的 Magpie 供应商配置格式");
    return document.providers;
  }
  async function state(refresh = false) {
    const [settings, providers, rows] = await Promise.all([api.call("/api/settings"), stored(), listing(refresh)]);
    return projectState(settings, rows, providers, history);
  }
  async function persist() { await atomicJSON(historyFile, history); }
  async function backup(filename) {
    const folder = path.join(stateDirectory, "backups");
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = path.join(folder, `${Date.now()}-${randomBytes(3).toString("hex")}-${filename}`);
    await fs.copyFile(path.join(directory, filename), destination);
    await fs.chmod(destination, 0o600);
    const files = (await fs.readdir(folder)).sort().reverse();
    for (const filename of files.slice(40)) await fs.unlink(path.join(folder, filename));
  }
  async function check(id) {
    if (pendingChecks.has(id)) return pendingChecks.get(id);
    const operation = (async () => {
      const settings = await api.call("/api/settings");
      if (!(settings.proxies || []).some((proxy) => proxy.id === id)) throw new Error("代理已不存在，请刷新页面");
      const version = proxyVersions.get(id) || 0;
      let result;
      try {
        const native = await api.call("/api/proxies/test", { id });
        result = {
          ok: !!native.ok && !!isIP(native.ip || ""), ip: isIP(native.ip || "") ? native.ip : "",
          loc: String(native.loc || "").slice(0, 8),
          ms: Number(native.ms) || 0, at: Number(native.at) || Math.floor(Date.now() / 1000),
          ...(!native.ok || !isIP(native.ip || "") ? { error: "代理连接失败或未返回有效 IP，请检查地址、白名单或认证信息" } : {})
        };
      } catch {
        result = { ok: false, error: "代理检测失败，请稍后重试", at: Math.floor(Date.now() / 1000) };
      }
      await exclusive(async () => {
        if ((proxyVersions.get(id) || 0) !== version) {
          result = { ok: false, error: "代理设置已变化，请重新检测" };
          return;
        }
        recordCheck(history, id, result);
        await persist();
      });
      return result;
    })();
    pendingChecks.set(id, operation);
    try { return await operation; } finally { pendingChecks.delete(id); }
  }
  async function checkAll() {
    const settings = await api.call("/api/settings");
    const results = [];
    for (const proxy of settings.proxies || []) results.push({ id: proxy.id, ...await check(proxy.id) });
    return results;
  }
  async function bind(input) {
    return exclusive(async () => {
      const current = await state(true);
      const provider = current.providers.find((item) => item.id === input.provider);
      if (!provider?.editable) throw new Error("供应商未保存到本机，请先在 Magpie 中配置供应商");
      const providers = await stored();
      const original = providers.find((item) => item.id === input.provider);
      const payload = bindingPayload(original, input, provider, current.proxies);
      await backup("providers.json");
      await api.call("/api/provider/save", payload);
      lastListing = null;
      const after = (await stored()).find((item) => item.id === input.provider);
      if (!after) throw new Error("保存后未找到供应商，请检查 Magpie");
      const expected = input.kind === "provider" ? (after.proxy || "") === input.choice :
        (after.accountProxies?.[input.account] || "") === input.choice;
      const unexpected = changedFields(original, after).filter((field) => !["proxy", "accountProxies"].includes(field));
      if (!expected || unexpected.length) {
        throw Object.assign(new Error(`保存后校验异常，已保留备份，请检查供应商设置${unexpected.length ? `（字段：${unexpected.join("、")}）` : ""}`), { status: 500 });
      }
      history.events.unshift({
        type: "binding", provider: input.provider, account: input.kind === "provider" ? "" : input.account,
        choice: input.choice, at: Date.now()
      });
      history.events = history.events.slice(0, 100);
      await persist();
      return { ok: true };
    });
  }
  async function saveProxy(input) {
    return exclusive(async () => {
      const name = String(input.name || "").trim();
      if (!name || name.length > 80) throw new Error("代理名称长度应为 1–80 个字符");
      const url = validateAddress(String(input.url || "").trim());
      const settings = await api.call("/api/settings");
      if (input.id && !(settings.proxies || []).some((proxy) => proxy.id === input.id)) throw new Error("代理已不存在");
      const payload = { name, url, user: String(input.user || "") };
      if (input.id) payload.id = input.id;
      if (input.pass !== undefined) payload.pass = String(input.pass);
      await backup("settings.json");
      const result = await api.call("/api/proxies/save", payload);
      const saved = (result.proxies || []).find((proxy) => input.id ? proxy.id === input.id :
        !(settings.proxies || []).some((previous) => previous.id === proxy.id));
      if (saved) {
        proxyVersions.set(saved.id, (proxyVersions.get(saved.id) || 0) + 1);
        const previous = history.proxies[saved.id] || {};
        history.proxies[saved.id] = { expectedIp: previous.expectedIp || "" };
        await persist();
      }
      return { ok: true };
    });
  }
  async function removeProxy(id) {
    return exclusive(async () => {
      await backup("settings.json");
      await api.call("/api/proxies/delete", { id });
      proxyVersions.set(id, (proxyVersions.get(id) || 0) + 1);
      delete history.proxies[id];
      await persist();
      return { ok: true };
    });
  }
  async function acknowledge(id) {
    return exclusive(async () => {
      const proxy = history.proxies[id];
      if (!proxy?.last?.ok || !proxy.lastGood?.ip) throw new Error("请先成功检测代理");
      proxy.expectedIp = proxy.lastGood.ip;
      history.events.unshift({ type: "acknowledge", proxy: id, at: Date.now() });
      history.events = history.events.slice(0, 100);
      await persist();
      return { ok: true };
    });
  }
  return { state, check, checkAll, bind, saveProxy, removeProxy, acknowledge };
}

export async function startService(options = {}) {
  const port = Number(options.port || 3479);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("出口管理页面端口无效");
  const manager = await createManager(options);
  const token = randomBytes(32).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const staticFiles = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "application/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
  };
  const routes = {
    "/api/check": (body) => manager.check(body.id),
    "/api/check-all": () => manager.checkAll(),
    "/api/binding": (body) => manager.bind(body),
    "/api/proxies/save": (body) => manager.saveProxy(body),
    "/api/proxies/delete": (body) => manager.removeProxy(body.id),
    "/api/acknowledge": (body) => manager.acknowledge(body.id)
  };
  function json(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (!allowedHosts.has(request.headers.host)) return json(response, 403, { error: "请求主机无效" });
      const origin = request.headers.origin;
      if (origin && origin !== "null" && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
        return json(response, 403, { error: "请求来源无效" });
      }
      if (origin === "null") response.setHeader("Access-Control-Allow-Origin", "null");
      const route = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Egress-Token");
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && staticFiles[route]) {
        const [filename, contentType] = staticFiles[route];
        let content = await fs.readFile(path.join(root, "ui", filename), "utf8");
        if (route === "/") content = content.replace("__EGRESS_TOKEN__", token);
        response.writeHead(200, { "Content-Type": contentType });
        response.end(content);
        return;
      }
      const supplied = String(request.headers["x-egress-token"] || "");
      if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return json(response, 403, { error: "请重新打开出口 IP 页面" });
      }
      if (route === "/api/state" && request.method === "GET") return json(response, 200, await manager.state());
      if (routes[route] && request.method === "POST") return json(response, 200, await routes[route](await bodyJSON(request)));
      json(response, 404, { error: "接口不存在" });
    } catch (error) {
      const message = String(error.message || "");
      const safe = /[\u3400-\u9fff]/u.test(message) && !/https?:\/\/|socks5?:\/\/|Bearer |sk-/.test(message);
      json(response, Number(error.status) || 400, { error: safe ? message : "操作失败，请检查 Magpie 服务和插件服务器配置" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  let checking = false;
  async function background() {
    if (checking || !options.webKey && !process.env.MAGPIE_WEB_KEY && !options.api) return;
    checking = true;
    try { await manager.checkAll(); } catch {}
    finally { checking = false; }
  }
  const timer = setInterval(background, Math.max(60, Number(options.intervalSeconds) || 300) * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return { server, manager, port };
}

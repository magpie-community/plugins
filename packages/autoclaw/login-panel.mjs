import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { _internal } from "./index.mjs";

export const LOGIN_PORT = 18741;
const HOST = "https://autoglm-api.autoglm.ai";
const REDIRECT_PORT = 18432;
const TTL = 10 * 60_000;
const MAX_BODY = 32_768;
const secret = () => randomBytes(24).toString("hex");
const equal = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function required(response, label) {
  if (response.code !== 0 || !response.data) throw new Error(`${label}失败：${response.msg ?? `code ${response.code}`}`);
  return response.data;
}

async function bodyOf(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) throw new Error("请求必须使用 JSON");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请求格式错误");
  return data;
}

// 完成码只在进程内引用凭据；浏览器不会拿到 access/refresh token。
export async function createLoginPanel({ port = LOGIN_PORT, now = Date.now, call = _internal.callEnvelope, profile = _internal.fetchUserProfile } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("AutoClaw loginPort 必须是 1–65535 的端口号");
  const csrf = secret();
  const sessions = new Map();
  const tickets = new Map();
  // 面板自己的公网地址只有页面知道：Magpie 的代理把 Host 改写成 127.0.0.1，
  // 服务端无法从请求推断，所以由页面在加载时上报（见 page/login.js）。
  let panelAddress = null;
  function prune() {
    for (const [id, value] of sessions) if (now() >= value.expires) sessions.delete(id);
    for (const [id, value] of tickets) if (now() >= value.expires) tickets.delete(id);
  }
  const post = (path, data) => call(path, { base: HOST, method: "POST", body: JSON.stringify(data) });
  const baseOf = (s) => ({ source_id: "autoclaw", device_id: s.deviceId, navigate_uri: s.redirect });
  const reply = (res, status, data) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "null" });
    res.end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/") {
      const html = readFileSync(new URL("./page/login.html", import.meta.url), "utf8").replace("__PANEL_CSRF__", csrf);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && path === "/login.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(readFileSync(new URL("./page/login.js", import.meta.url)));
      return;
    }
    if (req.method === "OPTIONS" && path.startsWith("/api/")) {
      res.writeHead(204, { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type, x-autoclaw-panel", "Vary": "Origin" });
      res.end();
      return;
    }
    if (req.method !== "POST" || !path.startsWith("/api/")) { reply(res, 404, { error: "接口不存在" }); return; }
    if (!equal(req.headers["x-autoclaw-panel"], csrf)) { reply(res, 403, { error: "请重新打开 AutoClaw 登录面板" }); return; }
    try {
      prune();
      const data = await bodyOf(req);
      if (path === "/api/address") {
        // 只接受面板自己的地址：Magpie Web 的代理路径，或桌面版的本机服务地址。
        // 否则弹窗里的链接会变成可被改写的钓鱼入口（CSRF 头只有面板页面拿得到，但仍做白名单）。
        const value = String(data.url ?? "").trim();
        if (value.length > 300) throw new Error("面板地址过长");
        const url = new URL(value);
        const proxied = url.pathname.endsWith("/") && /^\/_magpie\/plugin\/[^/]+\/_magpie\/service\/$/.test(url.pathname);
        const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/";
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash || !url.hostname || !(proxied || local)) {
          throw new Error("面板地址无效");
        }
        panelAddress = { href: url.href, at: now() };
        reply(res, 200, { ok: true });
        return;
      }
      if (path === "/api/start") {
        if (!["google", "zai"].includes(data.vendor)) throw new Error("请选择 Google 或 z.ai");
        if (sessions.size + tickets.size >= 100) throw new Error("待完成的登录过多，请稍后重试");
        const config = required(await post("/userapi/overseasv1/oauth-captcha-config", {}), "获取安全验证配置");
        const id = secret();
        const s = { vendor: data.vendor, deviceId: _internal.newDeviceId(), redirect: `http://localhost:${REDIRECT_PORT}/auth/callback-${data.vendor}`, config, expires: now() + TTL, busy: false, expectedState: null };
        sessions.set(id, s);
        reply(res, 200, { id, config });
        return;
      }
      if (path === "/api/cancel") { sessions.delete(data.id); reply(res, 200, { ok: true }); return; }
      const s = sessions.get(data.id);
      if (!s) throw new Error("登录已过期或已结束，请重新开始");
      if (s.busy) throw new Error("请求正在处理，请等待");
      s.busy = true;
      try {
        if (path === "/api/authorize") {
          if (s.expectedState) throw new Error("授权链接已经生成，请完成当前授权或重新开始");
          if (s.config.enabled && (typeof data.receipt !== "string" || !data.receipt.trim())) throw new Error("请先完成安全验证");
          const request = baseOf(s);
          if (data.receipt) request.ali_captcha_verify_param = data.receipt;
          const dataUrl = required(await post(`/userapi/overseasv1/${s.vendor}-oauth-url`, request), "获取授权链接");
          const address = dataUrl.oauth_url ?? dataUrl.url ?? dataUrl.login_url ?? dataUrl.auth_url ?? dataUrl.verify_url;
          if (typeof address !== "string" || /[\r\n]|&(?:amp|#38|#x26);/i.test(address)) throw new Error("授权链接包含换行或 HTML 转义，请重新获取");
          const url = new URL(address);
          const state = url.searchParams.get("state");
          if (url.protocol !== "https:" || url.username || url.password || !state || url.searchParams.getAll("state").length !== 1) throw new Error("上游授权链接无效或缺少 state，请重新开始");
          if (url.hostname === "accounts.google.com") {
            for (const key of ["client_id", "redirect_uri", "response_type", "scope"]) {
              if (!url.searchParams.get(key) || url.searchParams.getAll(key).length !== 1) throw new Error(`Google 授权链接缺少或重复 ${key}，请重新获取`);
            }
            if (url.searchParams.get("redirect_uri") !== s.redirect || url.searchParams.get("response_type") !== "code") throw new Error("Google 授权链接的 redirect_uri 或 response_type 与本次登录不一致，请重新获取");
          }
          s.expectedState = state;
          reply(res, 200, { url: address, diagnostics: {
            vendor: s.vendor, host: url.hostname, clientId: url.searchParams.get("client_id"),
            redirectUri: url.searchParams.get("redirect_uri"), responseType: url.searchParams.get("response_type"),
            scope: url.searchParams.get("scope"), hasState: true, urlLength: address.length,
          } });
          return;
        }
        if (path === "/api/finish") {
          let callback;
          try { callback = new URL(data.callback); } catch { throw new Error("请粘贴浏览器地址栏中的完整回调地址"); }
          const expected = new URL(s.redirect);
          if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash) throw new Error("回调地址与本次登录方式不匹配");
          const code = callback.searchParams.get("code");
          if (!s.expectedState || !equal(callback.searchParams.get("state"), s.expectedState) || callback.searchParams.getAll("state").length !== 1) throw new Error("回调 state 不匹配，请使用本次授权的回调地址");
          if (callback.searchParams.get("error")) throw new Error("授权已取消，请重新开始");
          if (!code || callback.searchParams.getAll("code").length !== 1) throw new Error("回调地址缺少唯一的 code 参数");
          // 授权码最多交换一次。上游失败后重新授权，避免重放已消耗的 code。
          sessions.delete(data.id);
          const tokenData = required(await post(`/userapi/overseasv1/${s.vendor}-oauth-login`, { ...baseOf(s), code, state: s.expectedState }), "登录");
          const tokens = _internal.tokenFields(tokenData);
          const user = await profile(tokens.access, HOST, s.deviceId);
          const name = _internal.accountDisplayName(user, `${s.vendor} 账号`);
          const ticket = secret();
          tickets.set(ticket, { expires: now() + TTL, result: { type: "success", ...tokens, email: name, accountId: name, uid: user?.userId, deviceId: s.deviceId, apiHost: HOST } });
          reply(res, 200, { ticket, name });
          return;
        }
        reply(res, 404, { error: "接口不存在" });
      } finally { s.busy = false; }
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.unref();
  return {
    port: server.address().port,
    async close() { sessions.clear(); tickets.clear(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
    method: {
      type: "oauth", label: "AutoClaw 网页登录（面板，Google / z.ai）",
      async authorize() {
        // 面板刚被打开过就给出它的真实地址：Docker / VPS 用户在弹窗里直接点开，
        // 不必先关窗口再去侧栏找。地址带插件页令牌，所以只回给这一刻的登录框，
        // 且 10 分钟内没有页面再次上报就作废。
        const href = panelAddress && now() - panelAddress.at < TTL ? panelAddress.href : "";
        return {
          url: href, method: "code",
          instructions: href
            ? "已打开 AutoClaw 登录面板（链接在下）。在面板里选 Google 或 z.ai，完成安全验证并复制授权链接到新标签页打开；授权后回到面板粘贴回调地址，再把面板显示的一次性完成码粘贴到下面的输入框。"
            : "右键点击 AutoClaw 供应商，选择「添加 AutoClaw 账户（打开登录面板）」，或在侧栏「插件 → AutoClaw 登录」打开面板。完成面板中的授权后，粘贴一次性完成码保存账户。Docker／远程部署无需开放额外端口。",
          async callback(value) {
            prune();
            const ticket = String(value ?? "").trim();
            const entry = tickets.get(ticket);
            if (!entry) return { type: "failed", error: "完成码无效、已使用或已过期，请重新在 AutoClaw 登录面板完成授权" };
            tickets.delete(ticket);
            return entry.result;
          },
        };
      },
      async callback(value) {
        const a = await this.authorize();
        return a.callback(value);
      },
    },
  };
}

// 宿主 loadPlugins() 只要包里任一导出函数抛错，就丢弃整包 hooks；端口被占时
// 会连带让已有账号与 provider 都消失（no plugin signs in to autoclaw）。
// 因此插件加载阶段不 await 监听：这里把启动收敛到一个可重试的 Promise，
// authorize/callback 用到面板时才启动，失败以宿主的 {type:"failed"} 返回。
export function createLoginMethod({ port = LOGIN_PORT, factory = createLoginPanel } = {}) {
  let panel = null;
  let starting = null;
  const failure = (error) => {
    const why = error instanceof Error ? error.message : String(error ?? "unknown error");
    return {
      type: "failed",
      error: `AutoClaw 登录面板启动失败（端口 ${port}）：${why}；检查 loginPort 或重启 Magpie 后在「插件 → AutoClaw 登录」重新打开面板`,
    };
  };
  async function ensure() {
    if (panel) return panel;
    if (!starting) {
      starting = Promise.resolve()
        .then(() => factory({ port }))
        .then((created) => { panel = created; return created; })
        .finally(() => { starting = null; });
    }
    return starting;
  }
  return {
    // 预热由宿主并行等待：服务启动完成再返回 hooks，但失败不能变成 rejection，
    // 也不能让宿主丢弃整包 auth；下一次 authorize 会重新尝试。
    warm() { return ensure().catch(() => {}); },
    method: {
      type: "oauth", label: "AutoClaw 网页登录（面板，Google / z.ai）",
      async authorize(...args) {
        try { return await (await ensure()).method.authorize(...args); }
        catch (error) { return failure(error); }
      },
      async callback(...args) {
        try { return await (await ensure()).method.callback(...args); }
        catch (error) { return failure(error); }
      },
    },
    async close() {
      const pending = starting;
      if (pending) { try { await pending; } catch { /* 启动失败无需关闭 */ } }
      if (panel) { const created = panel; panel = null; await created.close(); }
    },
  };
}

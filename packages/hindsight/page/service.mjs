// Magpie pages have no network access. This loopback service checks only the
// saved plugin options; the page cannot supply a URL, bank or request payload.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { testConnection } from "./probe.mjs";

const DEFAULT_PORT = 3482;
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-hindsight-token";
let running;
let pluginOptions = {};

function page(port) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="hindsight-token" content="${TOKEN}"><title>Hindsight · 连接测试</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;background:#0b1016;color:#e6edf3}
body{max-width:620px;margin:0 auto;padding:32px 20px}main{padding:22px;border:1px solid #263442;border-radius:12px;background:#111922}
h1{margin:0 0 8px;font-size:20px}p{color:#8b9aaa;line-height:1.6}strong{color:#e6edf3}code{color:#5eead4}
button{margin:8px 8px 0 0;padding:7px 14px;border:1px solid #5eead4;border-radius:7px;background:#5eead4;color:#062622;font:inherit;cursor:pointer}
button.secondary{border-color:#263442;background:transparent;color:#e6edf3}button:disabled{opacity:.45}
#state{min-height:48px;margin:16px 0;padding:12px;border:1px solid #263442;border-radius:8px;background:#0e151d;white-space:pre-wrap}
</style></head><body><main>
<h1>Hindsight API 连接测试</h1>
<p>使用插件已保存的配置调用 <code>GET /health</code>。测试不会读取记忆内容，也不会传递或显示密钥。</p>
<div id="state" role="status" aria-live="polite">点击下方“开始测试”检查 API 与数据库可达性。</div>
<button id="run" type="button">开始测试</button><button id="back" class="secondary" type="button">返回设置</button>
</main><script>
(() => {
  const state = document.getElementById("state");
  const run = document.getElementById("run");
  const token = document.querySelector('meta[name="hindsight-token"]').content;
  const messages = {
    connected: "连接正常：Hindsight API 可达，数据库已连接。",
    unavailable: "连接失败：API 不可达、数据库未就绪或请求超时。",
    unauthorized: "连接失败：API 拒绝了健康检查请求。",
    invalid: "连接失败：响应不是可识别的 Hindsight 健康状态，请检查 API 地址。",
    "invalid-options": "无法测试：已保存的插件配置无效，请返回设置检查。"
  };
  run.addEventListener("click", async () => {
    run.disabled = true;
    state.textContent = "正在测试连接…";
    try {
      const response = await fetch(location.href, {
        method: "POST",
        credentials: "omit",
        headers: { "x-hindsight-token": token, "Accept": "application/json" }
      });
      const result = await response.json();
      state.textContent = result.ok
        ? "连接成功：API 与数据库可用。\\nbank：" + (result.bank || "hermes") + "\\n耗时：" + (result.ms ?? "—") + " ms"
        : (messages[result.code] || "连接失败：测试服务返回了未知状态。") + "\\nbank：" + (result.bank || "hermes") + "\\n耗时：" + (result.ms ?? "—") + " ms";
    } catch {
      state.textContent = "连接失败：本地测试服务没有响应。";
    } finally {
      run.disabled = false;
    }
  });
  document.getElementById("back").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else state.textContent = "请关闭此测试页并重新打开插件设置。";
  });
})();
</script></body></html>`;
}

function html(port) {
  return new Response(page(port), { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:${port} http://localhost:${port}`
  } });
}

function cors(origin) {
  return origin === "null" ? {
    "Access-Control-Allow-Origin": "null",
    "Access-Control-Allow-Headers": TOKEN_HEADER,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  } : {};
}

async function handle(req, server) {
  const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
  if (!hosts.includes(req.headers.get("host")?.toLowerCase()))
    return new Response("Forbidden", { status: 403 });
  if (new URL(req.url).pathname !== "/test")
    return new Response("Not found", { status: 404 });
  if (req.method === "GET") return html(server.port);
  if (req.method !== "POST" && req.method !== "OPTIONS")
    return new Response("Method not allowed", { status: 405 });
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== "null" && !hosts.some(host => origin === `http://${host}`))
    return new Response("Forbidden", { status: 403 });
  const headers = { ...cors(origin), "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const supplied = Buffer.from(req.headers.get(TOKEN_HEADER) || "");
  const expected = Buffer.from(TOKEN);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return Response.json({ ok: false, code: "forbidden" }, { status: 403, headers });
  return Response.json(await testConnection(pluginOptions), { headers });
}

export default {
  id: "magpie-hindsight",
  async server(_input, options) {
    const port = options?.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      console.warn("[magpie-hindsight] Invalid connection test port. Choose a port from 1024 to 65535 in plugin settings.");
      return {};
    }
    if (running?.port === port) {
      pluginOptions = options ?? {};
      return {};
    }
    let server;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
    } catch {
      console.warn(`[magpie-hindsight] Connection test could not listen on port ${port}. Choose a free port in plugin settings.`);
      return {};
    }
    running?.stop(true);
    running = server;
    pluginOptions = options ?? {};
    return { close() {
      if (running !== server) return;
      server.stop(true);
      running = undefined;
    } };
  }
};

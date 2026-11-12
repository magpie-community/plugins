import { createServer } from "node:http";
import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { agentView, setAgents } from "./agents.mjs";
import { fault } from "./catalog.mjs";
import { VERSION } from "./version.mjs";
import { PORT } from './runtime.mjs';
export { PORT };
const UI = new URL("./ui/", import.meta.url);
const assetTypes = { "app.js": "text/javascript", "magpie.css": "text/css", "route.html": "text/html",
  "vendor/dsh/route.css": "text/css", "vendor/dsh/search-log.css": "text/css",
  ...Object.fromEntries((fs.existsSync(new URL("./ui/vendor/dsh/logos/", import.meta.url)) ? fs.readdirSync(new URL("./ui/vendor/dsh/logos/", import.meta.url)) : [])
    .filter(name => /^[\w-]+\.(svg|png)$/.test(name)).map(name => [`vendor/dsh/logos/${name}`, name.endsWith(".svg") ? "image/svg+xml" : "image/png"])) };
async function readBody(req) {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 160_000) throw fault("请求过大"); }
  try { return JSON.parse(text || "{}"); } catch { throw fault("请求格式不正确"); }
}
export function createService(center, { agents = agentView, applyAgents = setAgents } = {}) {
  const token = randomBytes(24).toString("hex");
  return createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || "")) throw fault("仅允许本机访问", "HOST_DENIED", 403);
      const origin = req.headers.origin;
      if (origin && origin !== "null" && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
        throw fault("请求来源不允许", "ORIGIN_DENIED", 403);
      res.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(req.url, "http://127.0.0.1");
      const route = url.pathname.replace(/^\/+/, "");
      if (req.method === "GET" && route === "health") {
        send(200, { plugin: "magpie-search-center", version: VERSION, service: "dsh-ui-port" }); return;
      }
      if (route.startsWith("api/")) {
        // Only APIs need CORS for Magpie's opaque sandbox. The HTML containing
        // the nonce is never CORS-readable by an arbitrary null-origin page.
        res.setHeader("Access-Control-Allow-Origin", origin || "null");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Search-Center");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && (route === "" || assetTypes[route])) {
        const name = route || "route.html";
        let body = fs.readFileSync(fileURLToPath(new URL(name, UI)));
        if (name === "route.html") body = body.toString("utf8").replace("__TOKEN__", token).replaceAll("__VERSION__", VERSION);
        res.setHeader("Content-Security-Policy",
          `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:${req.socket.localPort}; img-src 'self' data:; object-src 'none'; base-uri 'none'`);
        res.writeHead(200, { "Content-Type": assetTypes[name] + "; charset=utf-8", "Cache-Control": "no-store" });
        res.end(body); return;
      }
      const provided = String(req.headers["x-search-center"] || "");
      if (Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
        // Old pages poll state to discover a new version, but cannot know the
        // new process nonce. Return only public version/reload metadata here;
        // never return settings, history, credentials or the replacement nonce.
        if (req.method === "GET" && route === "api/state" && provided) {
          send(200, { uiVersion: VERSION, sessionExpired: true }); return;
        }
        throw fault("页面会话已更新，请刷新", "TOKEN_REQUIRED", 403);
      }
      if (req.method === "GET" && route === "api/state") {
        send(200, { ...(await center.snapshot()), agents: agents(), uiVersion: VERSION }); return;
      }
      if (req.method === "POST" && route === "api/policy") { send(200, await center.savePolicy(await readBody(req))); return; }
      if (req.method === "POST" && route === "api/sync") { send(200, await center.syncInherited()); return; }
      if (req.method === "POST" && route === "api/channel") { send(200, await center.saveChannel(await readBody(req))); return; }
      if (req.method === "POST" && route === "api/models") { send(200, await center.discoverModels()); return; }
      if (req.method === "POST" && route === "api/quota") { send(200, await center.queryQuota(await readBody(req))); return; }
      if (req.method === "POST" && route === "api/test") {
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableEnded) controller.abort(); });
        send(200, await center.search(await readBody(req), { origin: "页面测试", abort: controller.signal })); return;
      }
      if (req.method === "POST" && route === "api/refresh") { send(200, await center.publicCapabilities(true)); return; }
      if (req.method === "POST" && route === "api/agents") { send(200, await applyAgents((await readBody(req)).ids)); return; }
      send(404, { error: "页面不存在" });
    } catch (error) { send(error.status || 500, { error: error.status ? error.message : "服务暂时不可用", code: error.code || "INTERNAL" }); }
  });
}

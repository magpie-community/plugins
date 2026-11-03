import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  meta,
  projectLimits,
  resetProjectKey,
  revealSecret,
  updateProject,
  usageBundle,
} from "./projects.mjs";
import { pluginDataDir } from "./paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const UI_ROOT = join(ROOT, "ui");
function defaultPort() {
  return Number(process.env.MAGPIE_PROJECT_KEYS_PORT || 3491);
}

// Magpie 沙盒 iframe 导航到本服务后仍是 opaque origin（Origin: null）。
// API 需要 CORS + 页内注入的一次性口令（HTML 本身不带 CORS，外人读不到）。
const TOKEN = randomBytes(32).toString("hex");
// 端口被占时用来确认对面真的是这个插件，而不是随便一个自报 service 名的进程。
const NONCE = randomBytes(16).toString("hex");
const TOKEN_HEADER = "x-magpie-projects-token";
const MAX_BODY_BYTES = 1 << 20;
// 实际监听的端口在 startServer 里补进来；这里不预置，避免 import 时的环境变量
// 决定后续所有实例（同一进程里可以先后起多个端口）。
const OWN = new Set();
const HOSTS = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function originAllowed(req) {
  const o = req.headers.origin;
  return o === undefined || o === "null" || OWN.has(o);
}

function hostAllowed(req) {
  return HOSTS.has(String(req.headers.host || "").toLowerCase());
}

function tokenOK(req) {
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function corsHeaders(req) {
  const o = req.headers?.origin;
  const allow = o === "null" ? "null" : o && OWN.has(o) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type, " + TOKEN_HEADER,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    vary: "Origin",
  };
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  res.writeHead(status, {
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(res.req || {}),
    ...headers,
  });
  res.end(payload);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    "content-type": "application/json; charset=utf-8",
  });
}

async function readJSON(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) throw httpError(413, "请求体过大");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "请求体过大");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体不是有效的 JSON");
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeUIPath(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const full = normalize(join(UI_ROOT, rel));
  if (full !== UI_ROOT && !full.startsWith(UI_ROOT + sep)) return null;
  return full;
}

function injectToken(html) {
  const boot =
    `<script>window.__MAGPIE_PROJECTS_TOKEN__=${JSON.stringify(TOKEN)};window.__MAGPIE_PROJECTS_TOKEN_HEADER__=${JSON.stringify(TOKEN_HEADER)};</script>`;
  if (html.includes("</head>")) return html.replace("</head>", boot + "</head>");
  return boot + html;
}

async function serveStatic(req, res, urlPath) {
  let file;
  try {
    file = safeUIPath(urlPath === "/" ? "/index.html" : urlPath);
  } catch (e) {
    if (e instanceof URIError) return send(res, 400, "invalid URL encoding");
    throw e;
  }
  if (!file) return send(res, 403, "forbidden");
  try {
    let data = await readFile(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    // HTML 不带 CORS，避免外站读到注入的口令；API 才 CORS。
    if (extname(file) === ".html" || urlPath === "/") {
      data = Buffer.from(injectToken(data.toString("utf8")), "utf8");
      // No CORS on HTML so foreign pages cannot read the injected token.
      res.writeHead(200, {
        "content-type": type,
        "content-length": data.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      return res.end(data);
    }
    send(res, 200, data, { "content-type": type });
  } catch {
    if (urlPath === "/" || !extname(urlPath)) {
      try {
        let data = await readFile(join(UI_ROOT, "index.html"));
        data = Buffer.from(injectToken(data.toString("utf8")), "utf8");
        res.writeHead(200, {
          "content-type": MIME[".html"],
          "content-length": data.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        return res.end(data);
      } catch {
        /* fall */
      }
    }
    send(res, 404, "not found");
  }
}

async function handleAPI(req, res, pathname, listenPort) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (!originAllowed(req) || !hostAllowed(req)) {
    return sendJSON(res, 403, { error: "只服务于 Magpie 窗口里的钥匙柜页" });
  }
  if (pathname !== "/api/health" && !tokenOK(req)) {
    return sendJSON(res, 403, { error: "缺少页面口令" });
  }

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      let uiOk = false;
      try {
        await readFile(join(UI_ROOT, "index.html"));
        uiOk = true;
      } catch {
        uiOk = false;
      }
      return sendJSON(res, 200, {
        ok: uiOk,
        service: "page-project-keys",
        port: listenPort,
        uiOk,
        nonce: NONCE,
        pid: process.pid,
      });
    }
    if (req.method === "GET" && pathname === "/api/meta") {
      return sendJSON(res, 200, await meta());
    }
    if (req.method === "GET" && pathname === "/api/usage") {
      const u = new URL(req.url, "http://127.0.0.1");
      const fresh = u.searchParams.get("fresh") === "1";
      // 首屏 softMs 短：避免 magpie usage CLI（≈4–6s）堵住打开；后台继续拉。
      const softRaw = u.searchParams.get("softMs");
      const softMs = softRaw == null ? (fresh ? 0 : 1200) : Number(softRaw);
      return sendJSON(
        res,
        200,
        await usageBundle(u.searchParams.get("period") || "today", {
          softMs: Number.isFinite(softMs) ? softMs : 1200,
          fresh,
        })
      );
    }
    if (req.method === "GET" && pathname === "/api/projects") {
      return sendJSON(res, 200, { projects: await listProjects() });
    }
    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await readJSON(req);
      const project = await createProject(body);
      return sendJSON(res, 201, { project });
    }

    const one = pathname.match(/^\/api\/projects\/([^/]+)(\/[a-z]+)?$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const action = one[2] || "";
      if (req.method === "GET" && !action) {
        const project = await getProject(id);
        if (!project) return sendJSON(res, 404, { error: "钥匙不存在" });
        return sendJSON(res, 200, { project });
      }
      if (req.method === "GET" && action === "/limits") {
        return sendJSON(res, 200, await projectLimits(id));
      }
      if (req.method === "PATCH" && !action) {
        const body = await readJSON(req);
        return sendJSON(res, 200, { project: await updateProject(id, body) });
      }
      if (req.method === "DELETE" && !action) {
        return sendJSON(res, 200, await deleteProject(id));
      }
      if (req.method === "POST" && action === "/reset") {
        return sendJSON(res, 200, { project: await resetProjectKey(id) });
      }
      if (req.method === "POST" && action === "/reveal") {
        return sendJSON(res, 200, await revealSecret(id));
      }
    }

    return sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    const msg = e?.message || String(e);
    // 业务错误在抛出处带 status（400/413）；其余按服务端错误处理。
    const status = Number(e?.status) || 500;
    return sendJSON(res, status, { error: msg });
  }
}

function serverInfoPath(port) {
  return join(pluginDataDir(), `server-${port}.json`);
}

async function writeServerInfo(port) {
  try {
    const body = JSON.stringify({ nonce: NONCE, pid: process.pid, port }, null, 2) + "\n";
    await writeFile(serverInfoPath(port), body, { encoding: "utf8", mode: 0o600 });
  } catch {
    // 写不了就只影响「复用」判定，不影响服务本身。
  }
}

async function readServerInfo(port, { attempts = 1 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(await readFile(serverInfoPath(port), "utf8"));
    } catch {
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return null;
}

async function clearServerInfo(port) {
  const info = await readServerInfo(port);
  if (info && info.nonce === NONCE && Number(info.port) === Number(port)) {
    await unlink(serverInfoPath(port)).catch(() => {});
  }
}

async function probeExisting(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return { ok: false, reason: `health HTTP ${res.status}` };
    const body = await res.json();
    if (body?.service !== "page-project-keys") {
      return { ok: false, reason: "port held by another service" };
    }
    // service 名谁都能自报；只复用留下 matching nonce 的那个实例。
    const info = await readServerInfo(port, { attempts: 20 });
    if (!info || Number(info.port) !== Number(port) || body?.nonce !== info.nonce) {
      return { ok: false, reason: "端口被其它进程占用（不是这个钥匙柜服务）" };
    }
    if (body?.uiOk === false) {
      return { ok: false, reason: "existing listener cannot serve UI (stale process?)" };
    }
    // Also require the HTML route itself, not just health.
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
    });
    if (!page.ok) return { ok: false, reason: `UI HTTP ${page.status}` };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// Magpie 更新时先起新宿主、再由旧宿主退出。新宿主此刻若「复用」旧实例，
// 旧宿主一退出端口就空了，页面从此连不上。复用后持续探活：旧实例消失就
// 自己接管同一个端口。
const reuseWatchers = new Map();

function watchReusedPort(port) {
  if (reuseWatchers.has(port)) return;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const probe = await probeExisting(port);
      if (probe.ok) return;
      const info = await startServer({ options: { port } }).catch(() => null);
      if (info && !info.reused) {
        console.log(`[page-project-keys] took over http://127.0.0.1:${port}`);
        clearInterval(timer);
        reuseWatchers.delete(port);
      }
    } finally {
      busy = false;
    }
  }, 2000);
  timer.unref?.();
  reuseWatchers.set(port, timer);
}

export function startServer({ options } = {}) {
  const port = Number(options?.port) || defaultPort();
  OWN.add("http://127.0.0.1:" + port);
  OWN.add("http://localhost:" + port);
  HOSTS.add("127.0.0.1:" + port);
  HOSTS.add("localhost:" + port);

  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;
      res.setHeader("Referrer-Policy", "no-referrer");

      if (pathname.startsWith("/api/")) {
        return handleAPI(req, res, pathname, port);
      }
      return serveStatic(req, res, pathname);
    });

    server.on("error", async (err) => {
      if (err.code === "EADDRINUSE") {
        const probe = await probeExisting(port);
        if (probe.ok) {
          resolvePromise({ port, reused: true, server: null });
          watchReusedPort(port);
          return;
        }
        reject(
          new Error(
            `端口 ${port} 已被占用，且现有进程不可用：${probe.reason}。请结束旧 node 后再开插件。`
          )
        );
        return;
      }
      reject(err);
    });

    server.on("close", () => {
      clearServerInfo(port).catch(() => {});
    });

    server.listen(port, "127.0.0.1", async () => {
      await writeServerInfo(port);
      resolvePromise({ port, reused: false, server });
    });
  });
}

// 本地页面服务：只监听 127.0.0.1，照搬 chat 的防护模型。
// - 每进程随机 32 字节 token，经首页 HTML 的 boot 数据块注入，/api/* 全部要求带它；
//   Origin 只认缺失、"null"（sandbox 框架）或自身，Host 只认本服务实际绑定的端口
//   （防 DNS 重绑定）。首页响应带 CSP，页面数据一律 textContent 渲染。
// - store 损坏 → fatal：服务照起让页面显示原因，但绝不启动调度、拒绝一切写操作。
// - 单实例锁被别人持有 → lockedBy：页面只读展示，同样不启动调度。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path, { basename, extname, join, resolve } from "node:path";
import { fetchCatalog } from "./gateway";
import { validateTask } from "./rules";
import { Scheduler, CONFLICT_MESSAGE, NOT_FOUND_MESSAGE, type TaskInput } from "./scheduler";
import { acquireLock, openStore, StoreError, type Store } from "./store";
import { errText } from "./types";

/** 页面请求 /api/* 用的口令头 */
export const TOKEN_HEADER = "x-window-warmup-token";
/** 本插件服务的自标记响应头：所有响应都带，识别「这是窗口预热的服务」 */
export const MARKER_HEADER = "x-window-warmup";
/** 启动前探测已有实例的超时：挂着不响应的服务按「不是本插件」处理 */
const PROBE_TIMEOUT_MS = 2_000;
/** JSON 请求体上限：任务字段都很小，超限必然不是页面发的 */
const BODY_LIMIT = 64 * 1024;

/**
 * 探测端口上有没有本插件的服务在应答（所有响应都带 MARKER_HEADER）。
 * plugin.ts 启动前用它识别「已经在跑」；锁冲突时用它确认持有者是否真在服务。
 */
export async function alreadyServing(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.headers.get(MARKER_HEADER) === "1";
  } catch {
    return false; // 没人听或探测不通：按未运行处理
  }
}

export interface ServiceOptions {
  /** 监听端口；0 = 让系统挑空闲端口（测试用） */
  port: number;
  /** 数据目录（state.json 与 service.lock 所在） */
  dir: string;
  /** Magpie 网关地址 */
  base: string;
  /** 界面静态文件目录；缺省按运行位置解析（源码态 ../dist/ui，构建产物态 ./ui） */
  uiDir?: string;
  /** 锁冲突时的持有者确认，仅测试注入；缺省探测本服务端口上有无本插件在应答 */
  confirmLockAlive?: (pid: number) => Promise<boolean>;
}

export interface ServiceHandle {
  /** 实际绑定端口（port 0 时由系统分配） */
  port: number;
  /** 停止：先停排程、等发送收尾，再释放单实例锁，最后关 HTTP */
  stop(): Promise<void>;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function readBody(req: Request): Promise<unknown> {
  // 边读边计数：超限立即取消读取，不先把整个请求体收进内存
  let text = "";
  if (req.body) {
    const decoder = new TextDecoder();
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error("请求体太大");
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求不是合法的 JSON");
  }
}

/**
 * file 是否落在 root 目录之内（不含 root 自身）。
 * 不能拼 `${root}/` 比前缀：Windows 上 resolve 出来是反斜杠，所有静态文件都会被误判越界而 404。
 */
export function insideDir(root: string, file: string, p: typeof path = path): boolean {
  const rel = p.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}

export async function startService(opts: ServiceOptions): Promise<ServiceHandle> {
  const uiDir =
    opts.uiDir ??
    resolve(import.meta.dir, basename(import.meta.dir) === "src" ? "../dist/ui" : "ui");

  // 打开状态文件：损坏不抛给宿主，而是进 fatal 态（页面显示原因，调度与写接口全关）
  let fatal: string | null = null;
  let store: Store | undefined;
  try {
    store = await openStore(opts.dir);
  } catch (e) {
    if (e instanceof StoreError) fatal = e.message;
    else throw e;
  }

  let scheduler: Scheduler | null = null;
  let lockRelease: (() => Promise<void>) | null = null;
  let lockedBy: number | null = null;
  if (!fatal && store) {
    const lock = await acquireLock(opts.dir, {
      // pid 活 ≠ 持有者真在跑：容器/整机重启后 pid 常被无关进程复用（比如 magpie 自己），
      // 持久卷上的旧锁就成了假阳性，服务会错误进入只读、调度停摆。持有者必须
      // 真的在应答本插件的标记头才认，否则按陈旧锁接管。
      confirmAlive: opts.confirmLockAlive ?? (() => alreadyServing(opts.port)),
    });
    if (lock.ok) lockRelease = lock.release;
    else lockedBy = lock.pid; // pid 0 = 持有者身份无法判断
  }

  const token = randomBytes(32).toString("hex");
  let stopped = false;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: opts.port,
      async fetch(req: Request): Promise<Response> {
        let res: Response;
        try {
          res = await handle(req);
        } catch (e) {
          // 兜底错误也要带 CORS：否则沙箱页只看到 Failed to fetch，读不到原因
          res = json({ error: errText(e) }, 500, corsHeaders(req.headers.get("origin")));
        }
        // 所有响应都带自标记：plugin.ts 启动前探测它，识别「本插件已在运行」
        res.headers.set(MARKER_HEADER, "1");
        return res;
      },
    });
  } catch (e) {
    await lockRelease?.(); // 端口被占等绑定失败：把刚抢到的锁还回去
    throw e;
  }

  // HTTP 起好才启动调度；锁不是自己的就不调度
  if (!fatal && store && lockedBy === null) {
    scheduler = new Scheduler({ store, base: opts.base });
    scheduler.start();
  }

  const ownOrigins = (): string[] => [
    `http://127.0.0.1:${server.port}`,
    `http://localhost:${server.port}`,
  ];

  function tokenOK(got: string | null): boolean {
    const a = Buffer.from(got ?? "");
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // 响应侧 CORS（照 chat）：magpie 的插件页跑在 sandbox="allow-scripts" 框架里，
  // origin 是 opaque，对 http://127.0.0.1:port 的取回全是跨源请求——API 与非 index
  // 静态资源的响应没有 ACAO，浏览器直接拦掉 body，页面什么都读不到。
  // Origin 缺失或 "null" 时给 "null"，自身来源则原样反射。
  function corsHeaders(origin: string | null): Record<string, string> {
    const allow = origin && ownOrigins().includes(origin) ? origin : "null";
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      vary: "Origin",
      "cache-control": "no-store",
    };
  }

  function guardedState(): unknown {
    if (fatal !== null) {
      return { fatal, tasks: [], runs: [], next: {}, timeline: [], saveError: null };
    }
    if (lockedBy !== null) {
      return { lockedBy, tasks: [], runs: [], next: {}, timeline: [], saveError: null };
    }
    return scheduler!.snapshot();
  }

  /** 调度器抛错 → HTTP 状态码；未知错误一律 400 带原因 */
  function opError(e: unknown, cors: Record<string, string>): Response {
    const msg = errText(e);
    if (msg === NOT_FOUND_MESSAGE) return json({ error: msg }, 404, cors);
    if (msg === CONFLICT_MESSAGE) return json({ error: msg }, 409, cors);
    return json({ error: msg }, 400, cors);
  }

  /** 请求体读不出来是客户端的事：太大/不是 JSON 记 400，不落到外层兜底 500 */
  async function readBodyChecked(
    req: Request,
    cors: Record<string, string>,
  ): Promise<{ value: unknown } | { error: Response }> {
    try {
      return { value: await readBody(req) };
    } catch (e) {
      return { error: json({ error: errText(e) }, 400, cors) };
    }
  }

  function readonlyBlock(cors: Record<string, string>): Response | null {
    if (fatal !== null) {
      return json({ error: `服务处于故障状态，先修复数据文件：${fatal}` }, 503, cors);
    }
    if (lockedBy !== null) {
      const who = lockedBy > 0 ? `（进程 ${lockedBy}）` : "";
      return json({ error: `另一个实例正在运行${who}，本页只读` }, 503, cors);
    }
    return null;
  }

  /** 新建（id 缺省）或全量更新任务：读请求体 → 校验 → 交给调度器 */
  async function saveTask(
    req: Request,
    cors: Record<string, string>,
    id: string | undefined,
  ): Promise<Response> {
    const input = await readBodyChecked(req, cors);
    if ("error" in input) return input.error;
    const checked = validateTask(input.value, new Date());
    if ("error" in checked) return json({ error: checked.error, field: checked.field }, 400, cors);
    const task: TaskInput = id === undefined ? checked.task : { ...checked.task, id };
    try {
      return json(await scheduler!.upsert(task), 200, cors);
    } catch (e) {
      return opError(e, cors);
    }
  }

  async function api(req: Request, url: URL, origin: string | null): Promise<Response> {
    // 每个 API 响应（含错误）都必须带 CORS：magpie 的插件页跑在 sandbox 框架里，
    // origin 是 opaque，浏览器发来的 Origin 是字面量 "null"，对 http://127.0.0.1:port
    // 的 fetch 全是跨源请求——响应没有 ACAO，页面连错误信息都读不到。
    const cors = corsHeaders(origin);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/state") return json(guardedState(), 200, cors);
    if (req.method === "GET" && path === "/api/catalog") {
      try {
        return json(await fetchCatalog(opts.base), 200, cors);
      } catch (e) {
        return json({ error: errText(e) }, 502, cors);
      }
    }
    const blocked = readonlyBlock(cors);
    if (blocked) return blocked;
    const runMatch = /^\/api\/tasks\/([^/]+)\/run$/.exec(path);
    const idMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (path === "/api/tasks" && req.method === "POST") return saveTask(req, cors, undefined);
    if (idMatch && req.method === "PUT") return saveTask(req, cors, decodeURIComponent(idMatch[1]));
    if (idMatch && req.method === "DELETE") {
      try {
        await scheduler!.remove(decodeURIComponent(idMatch[1]));
      } catch (e) {
        return opError(e, cors);
      }
      return json({ ok: true }, 200, cors);
    }
    if (runMatch && req.method === "POST") {
      try {
        return json(await scheduler!.runNow(decodeURIComponent(runMatch[1])), 200, cors);
      } catch (e) {
        return opError(e, cors);
      }
    }
    return json({ error: `没有这个接口：${path}` }, 404, cors);
  }

  async function serveIndex(req: Request, url: URL): Promise<Response> {
    const nonce = randomBytes(16).toString("base64");
    // token 与主题一起进 boot 数据块；JSON 里的 < 转义掉，杜绝提前闭合脚本标签。
    // lang 透传给页面跟随 magpie 的界面语言；只放行字母与连字符（BCP-47 标签的形态），
    // 其余字符一律不带，异常值交给页面回退中文。
    const bootData: Record<string, string> = {
      token,
      theme: url.searchParams.get("theme") ?? "",
      tokens: url.searchParams.get("tokens") ?? "",
    };
    const lang = url.searchParams.get("lang") ?? "";
    if (/^[a-zA-Z-]{2,10}$/.test(lang)) bootData.lang = lang;
    const boot = JSON.stringify(bootData).replaceAll("<", "\\u003c");
    let html: string;
    try {
      html = await readFile(join(uiDir, "index.html"), "utf8");
    } catch {
      html =
        "<!doctype html><title>窗口预热</title><p>界面还没构建：先在包目录运行 bun run build。</p>";
    }
    html = html.replace(
      "</head>",
      `<script type="application/json" id="boot" nonce="${nonce}">${boot}</script>\n</head>`,
    );
    // connect-src 不能只写 'self'：页面在 sandbox 框架里是 opaque origin，WebKit（iOS / macOS
    // Safari、经 magpie web 打开的 PWA）的 'self' 什么都匹配不上，/api/* 全被 CSP 拦掉；
    // Chromium 按 URL 匹配所以没事。经 magpie web 转发时 Host 已被改成 127.0.0.1，服务端
    // 也无从得知页面的真实地址，只能放宽到 http/https。脚本仍只认 nonce 与本服务自身，
    // 渲染一律 textContent，放宽 connect-src 不额外打开注入口。
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; ` +
        "connect-src 'self' http: https:; frame-ancestors *",
    };
    // HEAD 只给头不带体（安全头与 GET 一致），语义上不把整页带上
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }

  async function serveStatic(req: Request, url: URL, origin: string | null): Promise<Response> {
    // 非 index 的静态资源照 chat 带 CORS：页面是 opaque origin 时，
    // type="module" 的脚本固定以 CORS 模式获取，没有 ACAO 连 app.js 都加载不了。
    const cors = corsHeaders(origin);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "方法不支持" }, 405, cors);
    }
    // index 里带着口令，绝不能带 CORS——别的页面读不到它
    if (url.pathname === "/" || url.pathname === "/index.html") return serveIndex(req, url);
    const decoded = decodeURIComponent(url.pathname);
    const root = resolve(uiDir);
    const file = resolve(root, `.${decoded}`);
    if (!insideDir(root, file) || decoded.includes("..")) {
      return new Response("没有这个文件", { status: 404, headers: cors });
    }
    const asset = Bun.file(file);
    if (!(await asset.exists())) return new Response("没有这个文件", { status: 404, headers: cors });
    return new Response(asset, {
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...cors,
      },
    });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const own = `127.0.0.1:${server.port}`;
    const host = (req.headers.get("host") ?? "").toLowerCase();
    // 端口 0 时必须用实际绑定端口校验，Host 头张冠李戴直接拒绝（DNS 重绑定防护）
    if (host !== own && host !== `localhost:${server.port}`) {
      return new Response("只服务于本机页面", { status: 403 });
    }
    const origin = req.headers.get("origin");
    // magpie 页面跑在 sandbox 框架里，Origin 是字面量 "null"；直接打开时是本服务自己
    if (origin && origin !== "null" && !ownOrigins().includes(origin)) {
      return json({ error: "只服务于 magpie 窗口里的页面" }, 403, corsHeaders(origin));
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOK(req.headers.get(TOKEN_HEADER))) {
        return json({ error: "口令不对：请重新打开窗口预热页" }, 401, corsHeaders(origin));
      }
      return api(req, url, origin);
    }
    return serveStatic(req, url, origin);
  }

  return {
    port: server.port ?? 0,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      scheduler?.stop();
      await scheduler?.flush();
      await lockRelease?.();
      server.stop(true);
    },
  };
}

// 本地服务的失败测试：端口 0、假网关、临时目录，不发任何真实请求。
// 覆盖：静态首页注入 boot JSON、鉴权（token/Host/Origin）、CRUD 与立即发送往返、
// 状态文件损坏（fatal）、单实例锁被占（lockedBy）。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import plugin from "../src/plugin";
import { buildAll } from "../scripts/build";
import { alreadyServing, insideDir, startService, type ServiceHandle } from "../src/server";
import { fakeGateway, type FakeGateway } from "./fake-gateway";

beforeAll(async () => {
  await buildAll(); // 服务从 dist/ui 提供静态资源，先构建一次
});

const services: ServiceHandle[] = [];
const gateways: FakeGateway[] = [];
const dirs: string[] = [];
afterAll(async () => {
  while (services.length) await services.pop()!.stop();
  for (const gw of gateways.splice(0)) gw.stop();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const MODELS = [{ id: "p1/m1", owned_by: "p1", reasoning: false }];

interface Harness {
  svc: ServiceHandle;
  token: string;
  boot: Record<string, unknown>;
  dir: string;
  gw: FakeGateway;
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

async function harness(
  opts: {
    state?: string;
    lockPid?: number;
    confirmLockAlive?: (pid: number) => Promise<boolean>;
  } = {},
): Promise<Harness> {
  const gw = fakeGateway({ models: MODELS });
  gateways.push(gw);
  const dir = await mkdtemp(join(tmpdir(), "sm-server-test-"));
  dirs.push(dir);
  if (opts.state !== undefined) await writeFile(join(dir, "state.json"), opts.state);
  if (opts.lockPid !== undefined) await writeFile(join(dir, "service.lock"), String(opts.lockPid));
  const svc = await startService({
    port: 0,
    dir,
    base: gw.base,
    confirmLockAlive: opts.confirmLockAlive,
  });
  services.push(svc);
  const base = `http://127.0.0.1:${svc.port}`;
  const html = await (await fetch(base)).text();
  const m = /<script type="application\/json" id="boot"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`首页缺少 boot 数据块：${html.slice(0, 200)}`);
  const boot = JSON.parse(m[1]) as Record<string, unknown>;
  const token = String(boot.token ?? "");
  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "x-window-warmup-token": token,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  return { svc, token, boot, dir, gw, api };
}

const DAILY = {
  name: "早报",
  provider: "p1",
  account: "acct-1",
  model: "p1/m1",
  message: "hi",
  trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
};

test("首页注入 nonce boot JSON（含 token）并带 CSP", async () => {
  const { svc, token } = await harness();
  const res = await fetch(`http://127.0.0.1:${svc.port}/?theme=dark`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  const nonce = /id="boot"[^>]*\bnonce="([^"]+)"/.exec(html)?.[1];
  expect(nonce).toBeTruthy();
  const bootData = JSON.parse(
    /<script type="application\/json" id="boot"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1],
  ) as { theme?: string };
  expect(bootData.theme).toBe("dark");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  // sandbox 框架里 WebKit 的 'self' 匹配不上 opaque origin，必须另带 scheme 源，否则 Safari 下 /api/* 全被拦
  expect(csp).toContain("connect-src 'self' http: https:");
  expect(csp).toContain("frame-ancestors *");
  expect(csp).toContain(`nonce-${nonce}`);
  expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 字节 hex
  expect(token).not.toContain("<");
  // 本插件服务的自标记：plugin.ts 启动前探测它，识别「已经在跑」
  expect(res.headers.get("x-window-warmup")).toBe("1");
  // 首页带着口令，绝不能带 CORS——别的页面读不到它
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("CORS：沙箱页（Origin null）能读到 API、错误与模块脚本，自身来源原样反射", async () => {
  const { svc, api } = await harness();
  const base = `http://127.0.0.1:${svc.port}`;
  // API 200：null 反射
  const ok = await api("/api/state", { headers: { origin: "null" } });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("access-control-allow-origin")).toBe("null");
  expect(ok.headers.get("access-control-allow-headers")).toContain("x-window-warmup-token");
  // 无 Origin（同源 GET、带 token）也放行并给 ACAO null
  const noOrigin = await api("/api/state");
  expect(noOrigin.status).toBe(200);
  expect(noOrigin.headers.get("access-control-allow-origin")).toBe("null");
  // 错误响应（401/400）同样带 ACAO，否则沙箱页只看到 Failed to fetch
  const unauth = await fetch(`${base}/api/state`);
  expect(unauth.status).toBe(401);
  expect(unauth.headers.get("access-control-allow-origin")).toBe("null");
  const invalid = await api("/api/tasks", { method: "POST", body: "{}", headers: { origin: "null" } });
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("access-control-allow-origin")).toBe("null");
  // 自身 Origin 原样反射
  const own = await api("/api/state", { headers: { origin: `http://127.0.0.1:${svc.port}` } });
  expect(own.headers.get("access-control-allow-origin")).toBe(`http://127.0.0.1:${svc.port}`);
  // 非法 Origin 仍在入口被拒
  expect((await api("/api/state", { headers: { origin: "https://evil.test" } })).status).toBe(403);
  // 非法 Origin 的 403 也不外泄该来源（ACAO 落到 null，浏览器照样拦）
  const rejected = await api("/api/state", { headers: { origin: "https://evil.test" } });
  expect(rejected.headers.get("access-control-allow-origin")).toBe("null");
  // 模块脚本固定以 CORS 模式获取：opaque origin 下没有 ACAO 连 app.js 都加载不了
  const js = await fetch(`${base}/app.js`, { headers: { origin: "null" } });
  expect(js.status).toBe(200);
  expect(js.headers.get("access-control-allow-origin")).toBe("null");
  const css = await fetch(`${base}/style.css`, { headers: { origin: "null" } });
  expect(css.headers.get("access-control-allow-origin")).toBe("null");
  // OPTIONS 预检保持可用
  const pre = await fetch(`${base}/api/state`, { method: "OPTIONS", headers: { origin: "null" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("null");
});

test("/api/state 鉴权：缺 token → 401，带 token → 200 空状态", async () => {
  const { svc } = await harness();
  const base = `http://127.0.0.1:${svc.port}`;
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  expect(
    (await fetch(`${base}/api/state`, { headers: { "x-window-warmup-token": "bad" } })).status,
  ).toBe(401);
  const ok = await fetch(base + "/api/state", {
    headers: { "x-window-warmup-token": "x".repeat(64) },
  });
  // 错 token 也是 401；正确 token 才 200 —— 用 harness 的 api 再验一次
  expect(ok.status).toBe(401);
  const h = await harness();
  const state = (await (await h.api("/api/state")).json()) as Record<string, unknown>;
  expect(state.tasks).toEqual([]);
  expect(state.runs).toEqual([]);
  expect(state.saveError).toBeNull();
  expect(state.fatal ?? null).toBeNull();
});

test("Host 与 Origin 校验：错 Host 403、外站 Origin 403、Origin null 放行", async () => {
  const { svc, api } = await harness();
  const base = `http://127.0.0.1:${svc.port}`;
  const evil = (await fetch(base + "/api/state", {
    headers: { host: `evil.test:${svc.port}`, "x-window-warmup-token": "x".repeat(64) },
  })).status;
  expect(evil).toBe(403);
  expect(
    (await api("/api/state", { headers: { origin: "https://evil.test" } })).status,
  ).toBe(403);
  expect((await api("/api/state", { headers: { origin: "null" } })).status).toBe(200);
  expect((await api("/api/state", { headers: { host: `localhost:${svc.port}` } })).status).toBe(200);
});

test("POST /api/tasks 非法 → 400 且带 field", async () => {
  const { api } = await harness();
  const r1 = (await (await api("/api/tasks", { method: "POST", body: "{}" })).json()) as {
    error: string;
    field?: string;
  };
  expect(r1.field).toBe("name");
  const res3 = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ ...DAILY, trigger: { kind: "alien" } }),
  });
  expect(res3.status).toBe(400);
});

test("model 为空串（自动选模型）可通过 API 保存", async () => {
  const { api } = await harness();
  const res = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ ...DAILY, model: "" }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { model: string }).model).toBe("");
});

test("完整 CRUD 与立即发送往返", async () => {
  const { api } = await harness();
  // 新建
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(DAILY) });
  expect(created.status).toBe(200);
  const task = (await created.json()) as { id: string; createdAt: string; updatedAt: string };
  expect(task.id).toBeTruthy();
  // 列表可见
  interface StateShape {
    tasks: { id: string }[];
    runs: { taskId: string; outcome: string; reason: string; source: string }[];
    next: Record<string, string | null>;
    timeline: { taskId: string }[];
  }
  let state = (await (await api("/api/state")).json()) as StateShape;
  expect(state.tasks.map((t) => t.id)).toEqual([task.id]);
  expect(state.next[task.id]).toBeTruthy();
  expect(state.timeline.some((p) => p.taskId === task.id)).toBe(true);
  // 更新
  const renamed = await api(`/api/tasks/${task.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...DAILY, name: "晚报" }),
  });
  expect(renamed.status).toBe(200);
  const afterRename = (await renamed.json()) as { name: string; updatedAt: string };
  expect(afterRename.name).toBe("晚报");
  expect(afterRename.updatedAt >= task.updatedAt).toBe(true);
  // 停用：next 为 null，不进时间轴
  await api(`/api/tasks/${task.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...DAILY, name: "晚报", enabled: false }),
  });
  state = (await (await api("/api/state")).json()) as StateShape;
  expect(state.next[task.id]).toBeNull();
  expect(state.timeline.some((p) => p.taskId === task.id)).toBe(false);
  await api(`/api/tasks/${task.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...DAILY, name: "晚报", enabled: true }),
  });
  // 立即发送：先返回 running 记录，随后落为 ok
  const run = await api(`/api/tasks/${task.id}/run`, { method: "POST" });
  expect(run.status).toBe(200);
  expect(((await run.json()) as { outcome: string }).outcome).toBe("running");
  let finished: { outcome: string; reason: string; source: string } | undefined;
  for (let i = 0; i < 100; i++) {
    const s = (await (await api("/api/state")).json()) as {
      runs: { taskId: string; outcome: string; reason: string; source: string }[];
    };
    const mine = s.runs.find((r) => r.taskId === task.id);
    if (mine && mine.outcome !== "running") {
      finished = mine;
      break;
    }
    await Bun.sleep(30);
  }
  expect(finished?.outcome).toBe("ok");
  expect(finished?.reason).toBe("");
  expect(finished?.source).toBe("manual");
  // 发送中再点一次 → 409（换个长延迟任务验证）
  // 删除
  expect((await api(`/api/tasks/${task.id}`, { method: "DELETE" })).status).toBe(200);
  state = (await (await api("/api/state")).json()) as StateShape;
  expect(state.tasks).toEqual([]);
  expect(state.runs).toEqual([]);
  expect((await api(`/api/tasks/${task.id}`, { method: "DELETE" })).status).toBe(404);
});

test("发送进行中重复 run → 409", async () => {
  const gw = fakeGateway({
    models: MODELS,
    chat: { delayMs: 400 },
  });
  gateways.push(gw);
  const dir = await mkdtemp(join(tmpdir(), "sm-server-test-"));
  dirs.push(dir);
  const svc = await startService({ port: 0, dir, base: gw.base });
  services.push(svc);
  const bootHtml = await (await fetch(`http://127.0.0.1:${svc.port}/`)).text();
  const token = String(
    JSON.parse(
      /<script type="application\/json" id="boot"[^>]*>([\s\S]*?)<\/script>/.exec(bootHtml)![1],
    ).token,
  );
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${svc.port}${path}`, {
      ...init,
      headers: { "x-window-warmup-token": token, ...init.headers },
    });
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(DAILY) });
  const task = (await created.json()) as { id: string };
  const first = await api(`/api/tasks/${task.id}/run`, { method: "POST" });
  expect(first.status).toBe(200);
  const second = await api(`/api/tasks/${task.id}/run`, { method: "POST" });
  expect(second.status).toBe(409);
  for (let i = 0; i < 100; i++) {
    const s = (await (await api("/api/state")).json()) as {
      runs: { outcome: string }[];
    };
    if (s.runs.every((r) => r.outcome !== "running")) break;
    await Bun.sleep(30);
  }
});

test("状态文件损坏 → /api/state 返回 fatal，不启动调度，原文件不动", async () => {
  const broken = '{"version":1,"tasks":';
  const { api, dir } = await harness({ state: broken });
  const state = (await (await api("/api/state")).json()) as {
    fatal?: string;
    tasks: unknown[];
  };
  expect(typeof state.fatal).toBe("string");
  expect(state.fatal).toBeTruthy();
  expect(state.tasks).toEqual([]);
  expect((await api("/api/tasks", { method: "POST", body: JSON.stringify(DAILY) })).status).toBe(
    503,
  );
  expect(await readFile(join(dir, "state.json"), "utf8")).toBe(broken);
});

test("不认识的版本号同样 fatal", async () => {
  const { api } = await harness({ state: '{"version":2,"tasks":[],"runs":[],"marks":{}}' });
  const state = (await (await api("/api/state")).json()) as { fatal?: string };
  expect(state.fatal).toContain("版本");
});

test("锁被占（持有者确认在服务）→ /api/state 返回 lockedBy，不启动调度", async () => {
  const { api } = await harness({ lockPid: process.pid, confirmLockAlive: async () => true });
  const state = (await (await api("/api/state")).json()) as {
    lockedBy?: number;
    fatal?: string;
    tasks: unknown[];
  };
  expect(state.lockedBy).toBe(process.pid);
  expect(state.fatal ?? null).toBeNull();
  expect(state.tasks).toEqual([]);
  expect((await api("/api/tasks", { method: "POST", body: JSON.stringify(DAILY) })).status).toBe(
    503,
  );
});

test("锁被占但持有者并未在服务（pid 被复用）→ 接管陈旧锁，正常读写", async () => {
  // Docker 上容器重建后 pid 会被无关进程（比如 magpie 自己）复用，卷上的旧锁是假阳性；
  // 缺省确认走端口探测，port 0 必然无人应答 → 必须接管而不是只读
  const h = await harness({ lockPid: process.pid });
  const state = (await (await h.api("/api/state")).json()) as { lockedBy?: number };
  expect(state.lockedBy ?? null).toBeNull();
  const res = await h.api("/api/tasks", { method: "POST", body: JSON.stringify(DAILY) });
  expect(res.status).toBe(200);
});

test("alreadyServing 只认带本插件标记头的响应", async () => {
  const marker = Bun.serve({
    port: 0,
    fetch: () => new Response("x", { headers: { "x-window-warmup": "1" } }),
  });
  const plain = Bun.serve({ port: 0, fetch: () => new Response("x") });
  try {
    expect(await alreadyServing(marker.port ?? 0)).toBe(true);
    expect(await alreadyServing(plain.port ?? 0)).toBe(false);
  } finally {
    marker.stop(true);
    plain.stop(true);
  }
  expect(await alreadyServing(0)).toBe(false); // 没人听：按未运行处理
});

test("GET /api/catalog 走网关并透传目录", async () => {
  const { api } = await harness();
  const catalog = (await (await api("/api/catalog")).json()) as {
    providers: { id: string; models: { id: string }[]; autoModel: string | null }[];
  };
  expect(catalog.providers.map((p) => p.id)).toEqual(["p1"]);
  expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["p1/m1"]);
  expect(catalog.providers[0].autoModel).toBe("p1/m1");
});

test("GET / 提供 app.js 与 style.css", async () => {
  const { svc } = await harness();
  const base = `http://127.0.0.1:${svc.port}`;
  const js = await fetch(`${base}/app.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(await js.text()).toContain("statusOf");
  const css = await fetch(`${base}/style.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("css");
  expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404);
});

test("超大请求体：边读边计数，超限 → 400（不是兜底 500）", async () => {
  const { api } = await harness();
  const res = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ pad: "x".repeat(70_000) }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("请求体太大");
});

test("HEAD / 与 GET 同状态同安全头，不带响应体", async () => {
  const { svc } = await harness();
  const res = await fetch(`http://127.0.0.1:${svc.port}/`, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(await res.text()).toBe("");
});

test("坏时区任务不拖垮页面：/api/state 200，坏任务可从页面删除", async () => {
  // 手工编辑 state.json 塞入坏时区任务（store 校验只查非空字符串，挡不住）
  const bad = {
    id: "t-bad", name: "坏时区", enabled: true, provider: "p1", account: "", model: "p1/m1",
    message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Mars/Olympus" },
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  };
  const state = JSON.stringify({
    version: 1, tasks: [bad], runs: [],
    marks: { "t-bad": { lastDue: null, resetKeys: [] } },
  });
  const { api } = await harness({ state });
  const res = await api("/api/state");
  expect(res.status).toBe(200); // 修复前：snapshot 抛 invalid time zone → 500，页面不可用
  const view = (await res.json()) as {
    fatal?: string;
    tasks: { id: string }[];
    next: Record<string, string | null>;
    timeline: { taskId: string }[];
  };
  expect(view.fatal ?? null).toBeNull();
  expect(view.tasks.map((t) => t.id)).toEqual(["t-bad"]);
  expect(view.next["t-bad"]).toBeNull();
  expect(view.timeline.some((p) => p.taskId === "t-bad")).toBe(false);
  // 页面删得掉坏任务，删完状态恢复
  expect((await api("/api/tasks/t-bad", { method: "DELETE" })).status).toBe(200);
  const after = (await (await api("/api/state")).json()) as { tasks: { id: string }[] };
  expect(after.tasks).toEqual([]);
});

test("静态文件目录判定按平台分隔符：Windows 下 ui 目录内文件可读，越界仍拒绝", () => {
  const winRoot = "C:\\Users\\me\\scheduled-messages\\dist\\ui";
  expect(insideDir(winRoot, win32.resolve(winRoot, "./style.css"), win32)).toBe(true);
  expect(insideDir(winRoot, win32.resolve(winRoot, "./app.js"), win32)).toBe(true);
  expect(insideDir(winRoot, win32.resolve(winRoot, "../plugin.js"), win32)).toBe(false);
  expect(insideDir(winRoot, "C:\\Users\\me\\scheduled-messages\\dist\\ui-evil\\x.js", win32)).toBe(false);
  expect(insideDir(winRoot, winRoot, win32)).toBe(false);
  expect(insideDir("/srv/ui", "/srv/ui/app.js", posix)).toBe(true);
  expect(insideDir("/srv/ui", "/srv/ui-evil/app.js", posix)).toBe(false);
});

// ---------- 端口探测（plugin.ts）：已有实例不重开，被占不静默 ----------

/** 在测试期间把数据目录指到指定路径 */
function withDir(dir: string): () => void {
  const saved = process.env.WINDOW_WARMUP_DIR;
  process.env.WINDOW_WARMUP_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.WINDOW_WARMUP_DIR;
    else process.env.WINDOW_WARMUP_DIR = saved;
  };
}

test("端口探测：已有本插件的服务（带标记头）→ 直接返回，不重开数据目录", async () => {
  const marker = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("{}", { headers: { "x-window-warmup": "1" } }),
  });
  // 故意用不存在的目录：startService 一旦被调就会 mkdir 出来
  const dir = join(tmpdir(), `ww-plugin-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const restore = withDir(dir);
  try {
    expect(await plugin.server(null, { port: marker.port })).toEqual({});
  } finally {
    restore();
    marker.stop(true);
  }
  expect(await stat(dir).then(() => true, () => false)).toBe(false);
});

test("端口探测：端口空闲 → 照常启动，响应带标记头", async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = probe.port;
  probe.stop(true);
  const dir = await mkdtemp(join(tmpdir(), "ww-plugin-run-"));
  dirs.push(dir);
  const restore = withDir(dir);
  try {
    expect(await plugin.server(null, { port })).toEqual({});
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get("x-window-warmup")).toBe("1");
  } finally {
    restore();
  }
});

test("端口探测：被别的服务（无标记头）占用 → 抛原错误，不静默成功", async () => {
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not ours") });
  const dir = await mkdtemp(join(tmpdir(), "ww-plugin-clash-"));
  dirs.push(dir);
  const restore = withDir(dir);
  try {
    await expect(plugin.server(null, { port: other.port })).rejects.toThrow();
  } finally {
    restore();
    other.stop(true);
  }
});

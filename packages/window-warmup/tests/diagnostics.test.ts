// 诊断导出：端到端起服务（假网关 + 临时 Magpie 配置/缓存目录），断言导出能还原排错现场，
// 且账号、key、任务名等隐私原文一个字节都不出现。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseView, buildDiagnostics } from "../src/diagnostics";
import { Scheduler } from "../src/scheduler";
import { startService, type ServiceHandle } from "../src/server";
import type { Run, Task } from "../src/types";
import { fakeGateway, type FakeGateway } from "./fake-gateway";

const KEY_RAW = "sk-test-SECRET-9f8e7d6c5b";
const FP = createHash("sha256").update(KEY_RAW, "utf8").digest("hex").slice(0, 10);
const EMAIL = "someone.private@example.com";
const KEY_NAME = "我的私钥名字";
const TASK_NAME = "私人任务名";
const CARD_LABEL = "Private Display Name";
const LEAK = "Bearer abcdefghijklmnopqrstuvwxyz0123456789 at /home/alice/.config";

let root = "";
let saved: Record<string, string | undefined> = {};
let gw: FakeGateway;
let svc: ServiceHandle;
let api: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ww-diag-"));
  saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  await mkdir(join(root, "config", "magpie"), { recursive: true });
  await mkdir(join(root, "cache", "magpie", "models"), { recursive: true });
  await writeFile(
    join(root, "config", "magpie", "providers.json"),
    JSON.stringify({
      providers: [
        { id: "antigravity", key: "ag-raw-key-should-not-leak", models: ["gemini-3.8-flash"] },
        { id: "remote", key: KEY_RAW, keyName: KEY_NAME, accountModels: { [FP]: ["m1"], [EMAIL]: ["m1"] } },
      ],
    }),
  );
  // antigravity 的缓存只有分档变体（真实形态），remote 的缓存按 key 指纹区分可见性
  await writeFile(
    join(root, "cache", "magpie", "models", "antigravity.json"),
    JSON.stringify({ models: [{ ID: "gemini-3.8-flash-high" }, { ID: "gemini-3.8-flash-low" }] }),
  );
  await writeFile(
    join(root, "cache", "magpie", "models", "remote.json"),
    JSON.stringify({ models: [{ ID: "m1", Keys: [FP] }] }),
  );
  gw = fakeGateway({
    models: [
      { id: "antigravity/gemini-3.8-flash", owned_by: "antigravity", reasoning: true, reasoning_levels: ["low", "high"] },
      { id: "remote/m1", owned_by: "remote", reasoning: false },
    ],
    quotas: [
      { provider: "antigravity", user: EMAIL, name: CARD_LABEL, windows: [{ name: "5h", used: 0, resetsAt: null }] },
      { provider: "remote/~keys", user: KEY_NAME, windows: [{ name: "5h", used: 10, resetsAt: null }] },
    ],
    chat: { status: 400, body: { error: { message: `upstream rejected ${EMAIL}: ${LEAK}` } } },
  });
  const dir = join(root, "data");
  svc = await startService({ port: 0, dir, base: gw.base });
  const base = `http://127.0.0.1:${svc.port}`;
  const html = await (await fetch(base)).text();
  const token = String(JSON.parse(/id="boot"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]).token);
  api = (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: { "x-window-warmup-token": token, "content-type": "application/json", ...init.headers },
    });
});

afterAll(async () => {
  await svc?.stop();
  gw?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

const daily = { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" };

test("导出还原排错现场，且不含账号、key、任务名等隐私原文", async () => {
  const created = (await (
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        name: TASK_NAME, enabled: true, provider: "antigravity", account: EMAIL, model: "", message: "hi", trigger: daily,
      }),
    })
  ).json()) as { id: string };
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      name: TASK_NAME, enabled: true, provider: "remote", account: FP, model: "", message: "hi", trigger: daily,
    }),
  });
  // 立即发送一次拿到一条失败记录：上游报错里夹着邮箱、Bearer 口令与家目录
  await api(`/api/tasks/${created.id}/run`, { method: "POST" });
  for (let i = 0; i < 50; i++) {
    const st = (await (await api("/api/state")).json()) as { runs: { outcome: string }[] };
    if (st.runs.length && st.runs[0].outcome !== "running") break;
    await Bun.sleep(20);
  }

  expect(await (await fetch(`http://127.0.0.1:${svc.port}/api/diagnostics`)).status).toBe(401);
  const res = await api("/api/diagnostics");
  expect(res.status).toBe(200);
  const text = await res.text();
  for (const secret of [KEY_RAW, "ag-raw-key", FP, EMAIL, KEY_NAME, TASK_NAME, CARD_LABEL, "abcdefghijklmnop", "alice"]) {
    expect(text).not.toContain(secret);
  }
  const d = JSON.parse(text) as {
    schema: string;
    tasks: { provider: string; account: string; accountKind: string; sendPreview: Record<string, unknown> }[];
    runs: { reason: string; outcome: string }[];
    providers: {
      id: string;
      modelCache: { id: string; keys: string[] }[] | null;
      providersJson: { chosen: string[]; keys: { alias: string }[]; accountModels: Record<string, string[]> } | null;
      quotaCards: { account: string; viaKey: boolean }[];
      catalog: { accounts: { id: string; kind: string; models: string[] | null }[] } | null;
    }[];
  };
  expect(d.schema).toBe("window-warmup-diagnostics/1");

  const ag = d.providers.find((p) => p.id === "antigravity")!;
  const remote = d.providers.find((p) => p.id === "remote")!;
  const agTask = d.tasks.find((t) => t.provider === "antigravity")!;
  const remoteTask = d.tasks.find((t) => t.provider === "remote")!;
  // 同一个账号/同一把 key 在任务、额度卡、目录、accountModels、缓存可见性里是同一个别名
  expect(agTask.account).toMatch(/^acct-\d+$/);
  expect(agTask.accountKind).toBe("login");
  expect(ag.quotaCards[0].account).toBe(agTask.account);
  const agLogin = ag.catalog!.accounts.find((a) => a.kind === "login")!;
  expect(agLogin.id).toBe(agTask.account);
  const keyAlias = remote.providersJson!.keys[0].alias;
  expect(keyAlias).toMatch(/^key-\d+$/);
  expect(remoteTask.account).toBe(keyAlias);
  expect(remote.quotaCards[0]).toMatchObject({ account: keyAlias, viaKey: true });
  expect(remote.modelCache![0].keys).toEqual([keyAlias]);
  expect(Object.keys(remote.providersJson!.accountModels).sort()).toEqual([agTask.account, keyAlias].sort());
  // 原始输入与计算结果都在：缓存是分档变体、启用清单是合并名、目录与发送预演选中合并名
  expect(ag.modelCache!.map((m) => m.id)).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
  expect(ag.providersJson!.chosen).toEqual(["gemini-3.8-flash"]);
  expect(agLogin.models).toEqual(["antigravity/gemini-3.8-flash"]);
  expect(agTask.sendPreview).toMatchObject({ model: "antigravity/gemini-3.8-flash", pin: agTask.account, effort: "low" });
  // 执行记录原因保留可读的报错，敏感片段被抹掉
  expect(d.runs[0].outcome).toBe("failed");
  expect(d.runs[0].reason).toContain("upstream rejected");
  expect(d.runs[0].reason).toContain(agTask.account);
  expect(d.runs[0].reason).toContain("Bearer <redacted>");
  expect(d.runs[0].reason).toContain("/home/<user>");
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", name: TASK_NAME, enabled: true, provider: "antigravity", account: EMAIL, model: "", message: "hi",
  trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over,
});
const run = (i: number, reason: string): Run => ({
  id: `r${i}`, taskId: "t1", source: "manual", due: null, startedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  endedAt: null, outcome: "failed", reason, effort: null, model: null, ms: 0, resetKey: null,
});

test("自由文本脱敏：邮箱、key 形态串、URL 口令参数、长口令、Windows 家目录都被抹掉；超长截断并注明原长", async () => {
  const reasons = [
    "mail other.person@corp.example.org failed",
    "key sk-live-0123456789abcdef rejected",
    "GET https://x.test/v1?api_key=SEKRIT123&model=m1 401",
    "cookie eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0abcdef",
    "open C:\\Users\\bob\\AppData failed",
    `long ${"z ".repeat(400)}`,
  ];
  const d = (await buildDiagnostics({
    base: gw.base, dir: join(root, "data"), tasks: [task()], runs: reasons.map((r, i) => run(i, r)),
    marks: {}, scheduler: null, fatal: null, lockedBy: null,
  })) as { runs: { reason: string }[]; tasks: { sendPreview: unknown }[] };
  const text = JSON.stringify(d);
  for (const secret of ["other.person", "sk-live-0123", "SEKRIT123", "eyJhbGciOiJIUzI1NiJ9", "bob", EMAIL, TASK_NAME]) {
    expect(text).not.toContain(secret);
  }
  const got = d.runs.map((r) => r.reason);
  expect(got[0]).toContain("<email>");
  expect(got[1]).toContain("<key>");
  expect(got[2]).toContain("api_key=<redacted>&model=m1");
  expect(got[3]).toContain("<token>");
  expect(got[4]).toContain("C:\\Users\\<user>");
  expect(got[5]).toContain("（截断，原长");
  expect(got[5].length).toBeLessThan(450);
  // 没有调度器（fatal/只读实例）时预演如实说明，不让导出失败
  expect(d.tasks[0].sendPreview).toEqual({ error: "调度器未运行" });
});

test("体积上限：每任务只留最近 20 条执行记录；单个列表超 200 条截断并记入 truncated", async () => {
  const many = fakeGateway({
    models: Array.from({ length: 250 }, (_, i) => ({ id: `bulk/m${i}`, owned_by: "bulk", reasoning: false })),
  });
  try {
    const d = (await buildDiagnostics({
      base: many.base, dir: join(root, "data"), tasks: [task()], runs: Array.from({ length: 30 }, (_, i) => run(i, `r${i}`)),
      marks: {}, scheduler: null, fatal: null, lockedBy: null,
    })) as { runs: { id: string }[]; providers: { id: string; v1Models: unknown[] }[]; truncated: string[] };
    expect(d.runs.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i + 10}`));
    expect(d.providers.find((p) => p.id === "bulk")!.v1Models).toHaveLength(200);
    expect(d.truncated.some((t) => t.startsWith("providers.bulk.v1Models：共 250 条"))).toBe(true);
  } finally {
    many.stop();
  }
});

test("网关地址：本机回环原样导出，其余只标注「非本机地址」（纯函数，不建连接）", () => {
  expect(baseView("http://127.0.0.1:3425")).toBe("http://127.0.0.1:3425");
  expect(baseView("http://localhost:3425/")).toBe("http://localhost:3425");
  expect(baseView("http://[::1]:3425")).toBe("http://[::1]:3425");
  expect(baseView("http://127.0.0.2:3425")).toBe("<非本机地址>");
  expect(baseView("https://magpie.example.com")).toBe("<非本机地址>");
  expect(baseView("not a url")).toBe("<无法解析>");
});

test("网关连不上不让导出失败，原因记在 gateway 里", async () => {
  // 刚释放的 127.0.0.1 端口：各系统都立即拒绝连接，不会等读超时（127.0.0.2 在 macOS 上不在 lo0，会挂到超时）
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const d = (await buildDiagnostics({
    base: `http://127.0.0.1:${port}`, dir: join(root, "data"), tasks: [], runs: [], marks: {},
    scheduler: null, fatal: null, lockedBy: null,
  })) as { gateway: { base: string; models: string; catalog: string } };
  expect(d.gateway.base).toBe(`http://127.0.0.1:${port}`);
  expect(d.gateway.models).not.toMatch(/^ok/);
  expect(d.gateway.catalog).not.toBe("ok");
});

test("落盘失败的原因（Bun 报错带 state.json 完整路径）同样脱敏，家目录用户名不出现", async () => {
  const t = task();
  const store = {
    data: { version: 1 as const, tasks: [t], runs: [] as Run[], marks: {} },
    save: async () => {
      throw new Error("EACCES: permission denied, open '/home/alice/.config/magpie/window-warmup/state.json.tmp'");
    },
  };
  const scheduler = new Scheduler({ store, base: gw.base });
  await scheduler.runNow(t.id);
  await scheduler.flush();
  expect(scheduler.snapshot().saveError).toContain("/home/alice/");
  const d = (await buildDiagnostics({
    base: gw.base, dir: join(root, "data"), tasks: store.data.tasks, runs: store.data.runs, marks: {},
    scheduler, fatal: null, lockedBy: null,
  })) as { service: { saveError: string | null } };
  expect(d.service.saveError).toContain("/home/<user>/.config");
  expect(JSON.stringify(d)).not.toContain("alice");
});

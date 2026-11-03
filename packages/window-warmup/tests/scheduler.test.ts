// 调度器的失败测试：注入假时钟、假定时器与假网关函数，不发任何真实请求。
// 单个定时器有 10 分钟封顶，跨长时段的断言一律看 snapshot().next（语义到期点）而非定时器 at。
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CachedModel, KeyDirectoryEntry } from "../src/magpie-files";
import { openStore, type Store, type TaskMarks } from "../src/store";
import { Scheduler, type TaskInput } from "../src/scheduler";
import type { QuotaEntry, RawModel, Run, SendResult, Task } from "../src/types";

// 测试进程绝不读真实用户的 Magpie 配置：把默认目录推导用的 XDG 钉到临时位置
process.env.XDG_CONFIG_HOME = join(tmpdir(), "window-warmup-test-magpie-config");
process.env.XDG_CACHE_HOME = join(tmpdir(), "window-warmup-test-magpie-cache");

const HOUR = 3_600_000;
const T0 = "2026-10-31T05:00:00+08:00"; // 周六 05:00，上海
const ms = (iso: string) => new Date(iso).getTime();

/** 不思考的模型：effort 应为 null，请求不带 reasoning_effort */
const M1: RawModel = { id: "m1", owned_by: "p1", reasoning: false };

function dailyTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "早报", enabled: true, provider: "openai", account: "",
    model: "m1", message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
    ...over,
  };
}

interface SendCall {
  task: Pick<Task, "id" | "model">;
  /** 调度器按统一账号规则算好的账号头值；null = 不带头 */
  pin: string | null;
  effort: string | null;
  signal: AbortSignal;
}

interface TimerRec { fn: () => void; at: number; cancelled: boolean }

interface HarnessOpts {
  models?: RawModel[];
  quotas?: () => { entries: QuotaEntry[] };
  /** 单卡刷新的替身（改写 quotas 的数据源模拟 Magpie 重读了卡）；不传 = 空操作 */
  refresh?: (provider: string, user: string) => void | Promise<void>;
  sendImpl?: (call: SendCall) => Promise<SendResult>;
  /** 复用已有数据目录（模拟重启续跑） */
  dir?: string;
  /** 假时钟起点（默认 T0；续跑时传上个 harness 的当前时刻） */
  startISO?: string;
  /** 包装 store，模拟落盘失败 */
  storeWrap?: (s: Store) => Store;
  /** providers.json 目录的替身（指纹与 accountModels）；不传 = 读不出 */
  keyDir?: Map<string, KeyDirectoryEntry>;
  /** 直接注入 keyDirFn（延迟 resolve 等竞态测试用）；优先于 keyDir */
  keyDirFn?: () => Promise<Map<string, KeyDirectoryEntry> | null>;
  /** 供应商 → 模型缓存替身；不传 = 没有缓存 */
  modelCache?: (providerId: string) => CachedModel[] | null;
}

interface Harness {
  scheduler: Scheduler;
  store: Store;
  sendCalls: SendCall[];
  models: RawModel[];
  quotasCalls: number;
  /** 单卡刷新调用：[供应商, 账号] */
  refreshCalls: [string, string][];
  advance: (delta: number) => void;
  now: () => Date;
  fireDue: () => void;
  pendingTimers: () => TimerRec[];
  flush: () => Promise<void>;
  dir: string;
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await rm(cleanupDirs.pop()!, { recursive: true, force: true });
});

async function harness(opts: HarnessOpts = {}): Promise<Harness> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "sched-test-")));
  cleanupDirs.push(dir);
  let nowMs = ms(opts.startISO ?? T0);
  const advance = (delta: number) => { nowMs += delta; };
  const now = () => new Date(nowMs);

  const timers: TimerRec[] = [];
  const setTimer = (fn: () => void, delayMs: number) => {
    const rec: TimerRec = { fn, at: nowMs + Math.max(0, delayMs), cancelled: false };
    timers.push(rec);
    return () => { rec.cancelled = true; };
  };
  const fireDue = () => {
    for (let round = 0; round < 3; round++) {
      const due = timers.filter((t) => !t.cancelled && t.at <= nowMs);
      if (due.length === 0) break;
      for (const t of due) { t.cancelled = true; t.fn(); }
    }
  };
  const pendingTimers = () => timers.filter((t) => !t.cancelled);

  const sendCalls: SendCall[] = [];
  const sendFn = async (
    _base: string,
    task: Pick<Task, "id" | "model">,
    pin: string | null,
    effort: string | null,
    signal: AbortSignal,
  ): Promise<SendResult> => {
    const call: SendCall = { task, pin, effort, signal };
    sendCalls.push(call);
    return opts.sendImpl ? opts.sendImpl(call) : { outcome: "ok", reason: "", ms: 2 };
  };

  const models = opts.models ?? [M1];
  let quotasCalls = 0;
  const quotasFn = opts.quotas
    ? async () => {
        quotasCalls += 1;
        return { at: now(), entries: opts.quotas!().entries };
      }
    : undefined;
  const refreshCalls: [string, string][] = [];
  const refreshCardFn = async (_base: string, provider: string, user: string) => {
    refreshCalls.push([provider, user]);
    await opts.refresh?.(provider, user);
  };

  const rawStore = await openStore(dir);
  const store = opts.storeWrap ? opts.storeWrap(rawStore) : rawStore;
  const scheduler = new Scheduler({
    store,
    base: "http://gateway.test",
    now,
    setTimer,
    sendFn,
    modelsFn: async () => models,
    ...(quotasFn ? { quotasFn } : {}),
    refreshCardFn,
    // key 目录与模型缓存一律注入替身，测试进程不碰真实文件
    keyDirFn: opts.keyDirFn ?? (async () => opts.keyDir ?? null),
    modelCacheFn: async (pid) => opts.modelCache?.(pid) ?? null,
  });
  return {
    scheduler, store, sendCalls, models,
    get quotasCalls() { return quotasCalls; },
    refreshCalls,
    advance, now, fireDue, pendingTimers, flush: () => scheduler.flush(), dir,
  };
}

/** 启动并把假时钟推到每天 06:00 的到期点触发一轮 */
async function firedDaily(h: Harness): Promise<void> {
  h.scheduler.start();
  h.advance(HOUR); // 05:00 → 06:00
  h.fireDue();
  await h.flush();
}

test("daily 到点发送一次并记录 ok，下次到期点设在次日", async () => {
  const h = await harness();
  const id = (await h.scheduler.upsert(dailyTask())).id;
  h.scheduler.start();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.pendingTimers()).toHaveLength(1);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms("2026-10-31T06:00:00+08:00")).toISOString());

  await firedDaily(h);

  expect(h.sendCalls).toHaveLength(1);
  expect(h.sendCalls[0].task.id).toBe(id);
  expect(h.sendCalls[0].effort).toBeNull(); // 模型不思考
  const run = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(run.outcome).toBe("ok");
  expect(run.source).toBe("schedule");
  expect(run.due).toBe(new Date(ms("2026-10-31T06:00:00+08:00")).toISOString());
  expect(h.store.data.marks[id].lastDue).toBe(run.due);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms("2026-11-01T06:00:00+08:00")).toISOString());

  // 落盘内容一致
  const onDisk = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8")) as { runs: Run[] };
  expect(onDisk.runs[0].outcome).toBe("ok");
});

test("调用 send 前已落盘 running 记录与 lastDue", async () => {
  let diskDuringSend = "";
  let dirRef = "";
  const h = await harness({
    sendImpl: async () => {
      diskDuringSend = await readFile(join(dirRef, "state.json"), "utf8");
      return { outcome: "ok", reason: "", ms: 1 };
    },
  });
  dirRef = h.dir;
  await h.scheduler.upsert(dailyTask());
  await firedDaily(h);

  const disk = JSON.parse(diskDuringSend) as { runs: Run[]; marks: Record<string, TaskMarks> };
  expect(disk.runs[0].outcome).toBe("running");
  expect(disk.runs[0].endedAt).toBeNull();
  expect(disk.marks[h.store.data.tasks[0].id].lastDue).toBe(disk.runs[0].due);
  expect(h.store.data.runs[0].outcome).toBe("ok");
});

test("启动时把遗留的 running 记录改判 unknown（Magpie 中途退出）", async () => {
  const h = await harness();
  const task = await h.scheduler.upsert(dailyTask());
  h.store.data.runs.push({
    id: "stale", taskId: task.id, source: "schedule", due: "2026-10-31T06:00:00.000Z",
    startedAt: "2026-10-31T06:00:00.000Z", endedAt: null, outcome: "running",
    reason: "", effort: null, model: null, ms: null, resetKey: null,
  });
  await h.store.save();

  h.scheduler.start();
  await h.flush();

  expect(h.store.data.runs[0].outcome).toBe("unknown");
  expect(h.store.data.runs[0].reason).toBe("Magpie 在发送中途退出，结果未知");
  const reopened = await openStore(h.dir);
  expect(reopened.data.runs[0].outcome).toBe("unknown");
});

test("发送失败不改 enabled、原因可读，下一时刻照常再发", async () => {
  const h = await harness({
    sendImpl: async () => ({ outcome: "failed", reason: "HTTP 403：账号不对", ms: 3 }),
  });
  const id = (await h.scheduler.upsert(dailyTask())).id;
  await firedDaily(h);

  expect(h.sendCalls).toHaveLength(1);
  const run = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(run.outcome).toBe("failed");
  expect(run.reason).toBe("HTTP 403：账号不对");
  expect(h.store.data.tasks[0].enabled).toBe(true);

  h.advance(HOUR * 24);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(2);
});

test("睡眠跨 3 个 every 点只补发一次（source=catchup）", async () => {
  const h = await harness();
  const id = (await h.scheduler.upsert(dailyTask({
    name: "循环", trigger: { kind: "every", hours: 1, anchor: T0 },
  }))).id;
  h.scheduler.start(); // 定时点 T0+1h
  h.advance(3 * HOUR + 60_000); // 睡到 T0+3h+1m
  h.fireDue();
  await h.flush();

  expect(h.sendCalls).toHaveLength(1);
  const run = h.store.data.runs[0];
  expect(run.source).toBe("catchup");
  expect(run.due).toBe(new Date(ms(T0) + 3 * HOUR).toISOString());
  // 补发后下一个点顺延
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms(T0) + 4 * HOUR).toISOString());
});

test("编辑任务后不补发编辑前错过的点", async () => {
  const h = await harness();
  const task = await h.scheduler.upsert(dailyTask({
    name: "循环", trigger: { kind: "every", hours: 1, anchor: T0 },
  }));
  h.scheduler.start();
  h.advance(2.5 * HOUR); // T0+1h、T0+2h 已错过但尚未唤醒
  await h.scheduler.upsert({ ...task, name: "改名" }); // 编辑 → updatedAt=现在，旧到期点作废
  h.advance(0.5 * HOUR); // 到 T0+3h：编辑后的第一个常规点
  h.fireDue();
  await h.flush();

  expect(h.sendCalls).toHaveLength(1);
  const run = h.store.data.runs[0];
  expect(run.source).toBe("schedule");
  expect(run.due).toBe(new Date(ms(T0) + 3 * HOUR).toISOString());
});

test("window：同一 resetKey 只发一次；空闲窗口同一小时不重试，下个小时可再试", async () => {
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
        windows: [{ name: "5h", used: 0, resetsAt: null }], // 空闲窗口：立即到期
      }],
    }),
  });
  await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }));
  h.scheduler.start();
  h.fireDue(); // 启动即取快照：空闲 → 立即发送
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.runs[0].resetKey).toMatch(/^idle:/);

  h.advance(11 * 60_000);
  h.fireDue(); // 同一小时刷新 → 同一 resetKey → 不再发
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);

  h.advance(HOUR); // 跨入下一个小时：评估前先刷新 → 新小时的 idle key → 空闲窗口按小时重试
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(2);
  expect(h.store.data.runs[1].resetKey).toBe("idle:2026-10-30T22:00:00.000Z");

  h.advance(11 * 60_000); // 同一小时已试过 → 不再发
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(2);
});

test("window：账号在但窗口暂时不在 → 瞬态，不记失败，下一轮刷新继续等", async () => {
  // 插件供应商的用量读取会瞬断（卡时有时无），按失败上报只会刷一屏红字
  let windows = [{ name: "week", used: 1, resetsAt: null }]; // 没有 5h 窗口
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false, windows,
      }],
    }),
  });
  await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }));
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.runs).toHaveLength(0); // 不记失败

  h.advance(10 * 60_000);
  h.fireDue(); // 依旧没有 5h 窗口 → 仍不记失败、不发送
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.runs).toHaveLength(0);

  // 额度里出现 5h 空闲窗口 → 正常开窗发送（快照新鲜 + 空闲 + 未发过 → 立即）
  windows = [{ name: "5h", used: 0, resetsAt: null }];
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("window：resetsAt 在未来 → 到期点为 resetsAt+30s，按 resetsAt 去重", async () => {
  const resetAt = new Date(ms(T0) + 2 * HOUR);
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
        windows: [{ name: "5h", used: 3, resetsAt: resetAt.toISOString() }],
      }],
    }),
  });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue(); // 启动即取快照并排程
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(resetAt.getTime() + 30_000).toISOString());

  h.advance(2 * HOUR + 30_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.runs[0].resetKey).toBe(resetAt.toISOString());
  expect(h.store.data.runs[0].due).toBe(new Date(resetAt.getTime() + 30_000).toISOString());
  expect(h.sendCalls[0].pin).toBe("acct-yang"); // 订阅账号名原样作头值
});

test("发送进行中再次到期 → 记一次「上一次发送还没结束，本次跳过」；runNow 冲突", async () => {
  const h = await harness({ sendImpl: () => new Promise(() => {}) }); // 永不返回
  await h.scheduler.upsert(dailyTask());
  h.scheduler.start();
  h.advance(HOUR);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.runs[0].outcome).toBe("running");

  h.advance(HOUR * 24);
  h.fireDue(); // 上一次还没结束 → 跳过
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  const skip = h.store.data.runs[1];
  expect(skip.outcome).toBe("failed");
  expect(skip.reason).toBe("上一次发送还没结束，本次跳过");
  expect(skip.source).toBe("schedule");

  await expect(h.scheduler.runNow(h.store.data.tasks[0].id)).rejects.toThrow(/还没结束/);
});

test("runNow 立即发送：source=manual、due 为空、不影响计划", async () => {
  const h = await harness();
  const id = (await h.scheduler.upsert(dailyTask())).id;
  h.scheduler.start();
  const run = await h.scheduler.runNow(id);
  await h.flush();

  expect(run.source).toBe("manual");
  expect(run.due).toBeNull();
  expect(run.outcome).toBe("ok");
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.marks[id].lastDue).toBeNull(); // 不影响计划
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms("2026-10-31T06:00:00+08:00")).toISOString());
});

test("进行中禁用 → 请求被 abort，记录 unknown「任务已停用，发送被取消」", async () => {
  const h = await harness({
    sendImpl: (call) =>
      new Promise((resolve) => {
        call.signal.addEventListener("abort", () =>
          resolve({ outcome: "unknown", reason: "发送被取消", ms: 1 }),
        );
      }),
  });
  const task = await h.scheduler.upsert(dailyTask());
  h.scheduler.start();
  h.advance(HOUR);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls[0].signal.aborted).toBe(false);

  await h.scheduler.upsert({ ...task, enabled: false });
  expect(h.sendCalls[0].signal.aborted).toBe(true);
  const run = h.store.data.runs[0];
  expect(run.outcome).toBe("unknown");
  expect(run.reason).toBe("任务已停用，发送被取消");
  expect(h.store.data.tasks[0].enabled).toBe(false);
});

test("删除进行中的任务 → 任务、记录、marks 全清，异步完成不会加回来", async () => {
  const h = await harness({
    sendImpl: (call) =>
      new Promise((resolve) => {
        call.signal.addEventListener("abort", () =>
          resolve({ outcome: "unknown", reason: "发送被取消", ms: 1 }),
        );
      }),
  });
  const task = await h.scheduler.upsert(dailyTask());
  h.scheduler.start();
  h.advance(HOUR);
  h.fireDue();
  await h.flush();
  expect(h.store.data.runs[0].outcome).toBe("running");

  await h.scheduler.remove(task.id);
  expect(h.store.data.tasks).toHaveLength(0);
  expect(h.store.data.runs).toHaveLength(0);
  expect(h.store.data.marks[task.id]).toBeUndefined();
  const reopened = await openStore(h.dir);
  expect(reopened.data.tasks).toHaveLength(0);
  expect(reopened.data.runs).toHaveLength(0);

  h.advance(HOUR * 24);
  h.fireDue(); // 迟到的发送收尾/补发评估都不应把记录加回来
  await h.flush();
  const again = await openStore(h.dir);
  expect(again.data.runs).toHaveLength(0);
  expect(again.data.tasks).toHaveLength(0);
});

test("思考档位动态：两次发送之间模型档位变化，分别记录当次档位，任务不存档位字段", async () => {
  const h = await harness({
    models: [{ id: "m1", owned_by: "p1", reasoning: true, reasoning_levels: ["none", "high"] }],
  });
  const id = (await h.scheduler.upsert(dailyTask())).id;
  await firedDaily(h);
  expect(h.sendCalls[0].effort).toBe("none");
  expect(h.store.data.runs[0].effort).toBe("none");

  h.models[0].reasoning_levels = ["low", "high"];
  h.advance(HOUR * 24);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls[1].effort).toBe("low");
  expect(h.store.data.runs[1].effort).toBe("low");

  const onDisk = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8")) as {
    tasks: Array<Record<string, unknown>>;
  };
  expect("effort" in onDisk.tasks[0]).toBe(false);
  expect("reasoning" in onDisk.tasks[0]).toBe(false);
});

test("模型从目录消失 → failed「模型 X 已不在 Magpie 的模型列表里」，不调用 send", async () => {
  const h = await harness();
  const id = (await h.scheduler.upsert(dailyTask())).id;
  h.models.length = 0; // 目录里没有该模型了
  await firedDaily(h);

  expect(h.sendCalls).toHaveLength(0);
  const run = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(run.outcome).toBe("failed");
  expect(run.reason).toBe("模型 m1 已不在 Magpie 的模型列表里");
});

test("model 为空 → 每次发送前现选供应商模型，发送与 run.model 都用当次选中的", async () => {
  const h = await harness({
    models: [
      { id: "p1/gpt-5", owned_by: "p1", reasoning: false },
      { id: "p1/gpt-5-mini", owned_by: "p1", reasoning: false },
      { id: "p2/m", owned_by: "p2", reasoning: false }, // 别家供应商不参与
    ],
  });
  const id = (await h.scheduler.upsert(dailyTask({ provider: "p1", model: "" }))).id;
  await firedDaily(h);

  expect(h.sendCalls[0].task.model).toBe("p1/gpt-5-mini");
  expect(h.sendCalls[0].effort).toBeNull();
  const first = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(first.outcome).toBe("ok");
  expect(first.model).toBe("p1/gpt-5-mini");

  // 目录变了下一次发送跟着变（与思考档位一样现算，任务里只存 ""）
  h.models.length = 0;
  h.models.push({ id: "p1/gpt-5-flash", owned_by: "p1", reasoning: false });
  h.advance(HOUR * 24);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls[1].task.model).toBe("p1/gpt-5-flash");
  expect(h.store.data.runs.filter((r) => r.taskId === id)[1].model).toBe("p1/gpt-5-flash");

  // 落盘的任务保持 model: ""，不写死选中值
  const onDisk = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8")) as {
    tasks: Array<Record<string, unknown>>;
  };
  expect(onDisk.tasks[0].model).toBe("");
});

test("model 为空且既无缓存也无模型 → failed「供应商 X 还没有模型列表」，不调用 send", async () => {
  const h = await harness({ models: [{ id: "p2/m", owned_by: "p2", reasoning: false }] });
  const id = (await h.scheduler.upsert(dailyTask({ provider: "p1", model: "" }))).id;
  await firedDaily(h);

  expect(h.sendCalls).toHaveLength(0);
  const run = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(run.outcome).toBe("failed");
  expect(run.reason).toBe("供应商 p1 还没有模型列表，无法自动选模型");
  expect(run.model).toBeNull();
});

test("固定 model 的任务照旧直发，run.model 记当次模型", async () => {
  const h = await harness();
  const id = (await h.scheduler.upsert(dailyTask())).id;
  await firedDaily(h);
  expect(h.sendCalls[0].task.model).toBe("m1");
  expect(h.store.data.runs.find((r) => r.taskId === id)!.model).toBe("m1");
});

test("snapshot：next 与 timeline 反映各任务的下一个执行点，停用任务为 null", async () => {
  const h = await harness();
  const a = await h.scheduler.upsert(dailyTask());
  const b = await h.scheduler.upsert(dailyTask({ name: "停用", enabled: false }));
  h.scheduler.start();

  const view = h.scheduler.snapshot();
  expect(view.next[a.id]).toBe(new Date(ms("2026-10-31T06:00:00+08:00")).toISOString());
  expect(view.next[b.id]).toBeNull();
  expect(view.timeline.map((p) => p.taskId)).toEqual([a.id]);
  expect(view.runs).toEqual([]);
  expect(view.tasks).toHaveLength(2);
});

test("落盘失败 → 不发送、错误可见；恢复持久化后同一到期点不双发", async () => {
  let failSave = false;
  const h = await harness({
    storeWrap: (s) => ({
      get data() {
        return s.data;
      },
      save: () => (failSave ? Promise.reject(new Error("模拟磁盘写失败")) : s.save()),
    }),
  });
  const id = (await h.scheduler.upsert(dailyTask())).id;
  await h.flush();
  failSave = true;

  h.scheduler.start();
  h.advance(HOUR); // 06:00 到期
  h.fireDue();
  await h.flush();

  expect(h.sendCalls).toHaveLength(0); // 持久化没成立就不发请求
  const run = h.store.data.runs.find((r) => r.taskId === id)!;
  expect(run.outcome).toBe("failed");
  expect(run.reason).toBe("状态文件写不进去，本次不发送：模拟磁盘写失败");
  expect(h.store.data.tasks[0].enabled).toBe(true); // 失败不暂停
  expect(h.scheduler.snapshot().saveError).toContain("模拟磁盘写失败"); // 对外可见

  // 恢复持久化：下一个到期点照常发送（不自动补发已作废的点），错误随之清除
  failSave = false;
  h.advance(HOUR * 24);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.scheduler.snapshot().saveError).toBeNull();

  // 重启读到的是恢复后的完整状态：旧点已消费、记录齐全，不会再发第二次
  const h2 = await harness({ dir: h.dir, startISO: h.now().toISOString() });
  h2.scheduler.start();
  h2.fireDue();
  await h2.flush();
  expect(h2.sendCalls).toHaveLength(0);
  expect(h2.store.data.marks[id].lastDue).toBe(new Date(ms(T0) + HOUR * 25).toISOString());
  expect(h2.store.data.runs.map((r) => r.outcome)).toEqual(["failed", "ok"]);
});

test("window：同一份旧 resetsAt 刷新/跨小时/重启均不重发，新 resetsAt 才再触发", async () => {
  let resetsAt = new Date(ms(T0) + 2 * HOUR);
  const quotas = () => ({
    entries: [{
      provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
      windows: [{ name: "5h", used: 3, resetsAt: resetsAt.toISOString() }],
    }],
  });
  const h = await harness({ quotas });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush(); // 取快照、排程到 R+30s
  expect(h.sendCalls).toHaveLength(0);

  h.advance(2 * HOUR + 30_000);
  h.fireDue();
  await h.flush(); // R+30s：发送第 1 次
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.runs[0].resetKey).toBe(resetsAt.toISOString());

  h.advance(10 * 60_000); // 强刷后 R 已过：同一旧 R 不当新空闲事件
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);

  h.advance(HOUR); // 跨小时，快照仍是同一份旧 R
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  // R 之外还消费了重置所在小时的 idle key（缓存丢掉 resetsAt 时同一小时不再发）
  expect(h.store.data.marks[id].resetKeys).toEqual([
    resetsAt.toISOString(),
    "idle:2026-10-30T23:00:00.000Z",
  ]);

  // 重启：盘上已消费 R，同一旧 R 依旧不重发
  const h2 = await harness({ dir: h.dir, startISO: h.now().toISOString(), quotas });
  h2.scheduler.start();
  h2.fireDue();
  await h2.flush();
  expect(h2.sendCalls).toHaveLength(0);

  // Magpie 公布新的重置时间，且到刷新时它已过 → 评估前先刷新，按新 R 立即开窗
  //（不再拿旧快照空转一轮：评估永远基于刚刷新的数据）
  resetsAt = new Date(h2.now().getTime() + 8 * 60_000);
  h2.advance(10 * 60_000);
  h2.fireDue();
  await h2.flush();
  expect(h2.sendCalls).toHaveLength(1);
  expect(h2.store.data.runs.at(-1)!.resetKey).toBe(resetsAt.toISOString());
  expect(h2.store.data.marks[id].resetKeys).toContain(resetsAt.toISOString());
});

test("window：评估前先刷新——手动发送刚把窗口开起来，旧快照的空闲不再触发第二次", async () => {
  // idle=true 时额度里是没开始的窗口（无 resetsAt）；手动发送后窗口开始，出现未来 resetsAt
  let idle = true;
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
        windows: [{
          name: "5h", used: idle ? 0 : 1,
          resetsAt: idle ? null : new Date(h.now().getTime() + 5 * HOUR).toISOString(),
        }],
      }],
    }),
  });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  // 快照新鲜 + 空闲窗口 + 本轮没发过 → 保存即发送，不再等 10 分钟
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.runs[0].resetKey).toMatch(/^idle:/);

  // 等待期间用户手动又发了一次，窗口开始（resetsAt 出现）；下一个唤醒先刷新再评估
  idle = false;
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1); // 不按旧快照的空闲再发
  // 快照里的 resetsAt 是刷新时刻 + 5 小时，到期点再 + 30 秒宽限
  expect(h.scheduler.snapshot().next[id]).toBe(
    new Date(h.now().getTime() + 5 * HOUR + 30_000).toISOString(),
  );
});

test("window：实际重置发送后，同小时内缓存丢掉 resetsAt 不再按 idle key 二次发送", async () => {
  const resetAt = new Date(ms(T0) + 2 * HOUR); // 07:00+08:00
  let entries: QuotaEntry[] = [{
    provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
    windows: [{ name: "5h", used: 3, resetsAt: resetAt.toISOString() }],
  }];
  const h = await harness({ quotas: () => ({ entries }) });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush(); // 排程到 R+30s

  h.advance(2 * HOUR + 30_000); // 07:00:30 发送第 1 次（key=R）
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);

  // 额度缓存把 resetsAt 丢成 null（同一实际重置周期内）
  entries = [{
    provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
    windows: [{ name: "5h", used: 0, resetsAt: null }],
  }];
  h.advance(10 * 60_000); // 07:10:30 刷新拿到新快照
  h.fireDue();
  await h.flush();
  h.advance(10 * 60_000); // 07:20:30 用新快照评估
  h.fireDue();
  await h.flush();
  // 修复前：idle key 与 R 互不认账 → 这里多一次付费发送
  expect(h.sendCalls).toHaveLength(1);
  // 发送那次已把重置所在小时的 idle key 一并消费
  const sendHour = new Date(
    Math.floor(new Date(ms(T0) + 2 * HOUR + 30_000).getTime() / HOUR) * HOUR,
  ).toISOString();
  expect(h.store.data.marks[id].resetKeys).toContain(`idle:${sendHour}`);
});

test("window：不可解析的 resetsAt 按空闲每小时限频，key 不用原始字符串", async () => {
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
        windows: [{ name: "5h", used: 0, resetsAt: "not-a-date" }],
      }],
    }),
  });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.marks[id].resetKeys[0]).toMatch(/^idle:/);

  h.advance(10 * 60_000); // 同一小时 → 限频不再发
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);

  h.advance(HOUR); // 跨小时 → 先刷出新小时的快照
  h.fireDue();
  await h.flush();
  h.advance(10 * 60_000); // 用新小时快照评估 → 可再试一次，key 仍是 idle:
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(2);
  expect(h.store.data.runs.at(-1)!.resetKey).toMatch(/^idle:/);
});

test("单个任务调度出错：每小时只记一次失败，且不拖垮其他任务", async () => {
  const h = await harness();
  await h.scheduler.upsert(dailyTask());
  // 绕过校验直接塞坏时区任务（模拟系统时区库变更后 state.json 里的旧时区失效）
  h.store.data.tasks.push({
    id: "t-bad", name: "坏时区", enabled: true, provider: "openai", account: "",
    model: "m1", message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Mars/Olympus" },
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  });
  h.scheduler.start(); // 修复前：rearm 对坏任务抛错 → 定时器排不出来，整个调度停摆
  h.advance(HOUR); // 06:00
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1); // 好任务照常发送
  const badRuns = () => h.store.data.runs.filter((r) => r.taskId === "t-bad");
  expect(badRuns()).toHaveLength(1);
  expect(badRuns()[0].reason).toContain("调度出错");

  h.advance(10 * 60_000); // 同一小时再醒 → 不重复记
  h.fireDue();
  await h.flush();
  expect(badRuns()).toHaveLength(1);
});

test("坏时区任务不拖垮 snapshot：该任务 next 置空、不进时间轴，好任务照常", async () => {
  const h = await harness();
  const good = (await h.scheduler.upsert(dailyTask())).id;
  // 绕过校验直接塞坏时区任务（模拟系统时区库变更后 state.json 里的旧时区失效）
  h.store.data.tasks.push({
    id: "t-bad", name: "坏时区", enabled: true, provider: "openai", account: "",
    model: "m1", message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Mars/Olympus" },
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  });
  h.scheduler.start(); // rearm 已有守卫，start 不受影响
  const view = h.scheduler.snapshot(); // 修复前：抛 invalid time zone → GET /api/state 500
  expect(view.tasks.map((t) => t.id)).toContain("t-bad"); // 任务仍在列表，页面才删得掉
  expect(view.next["t-bad"]).toBeNull();
  expect(view.timeline.some((p) => p.taskId === "t-bad")).toBe(false);
  expect(view.next[good]).toBe(new Date(ms("2026-10-31T06:00:00+08:00")).toISOString());
  expect(view.timeline.some((p) => p.taskId === good)).toBe(true);
});

// ---------- 统一账号规则接入调度器（key 目录与模型缓存注入替身） ----------

const fingerprint = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);

test("自动模型按账号列表选：key 账号按缓存 Keys 与 accountModels 过滤，并带上 P#指纹 头", async () => {
  const fp1 = fingerprint("sk-test-AAAA11");
  const fp2 = fingerprint("sk-test-BBBB22");
  const h = await harness({
    models: [
      { id: "p1/m-one", owned_by: "p1", reasoning: false },
      { id: "p1/m-two", owned_by: "p1", reasoning: false },
    ],
    keyDir: new Map([
      [
        "p1",
        {
          keys: [{ fingerprint: fp1, name: "GLM" }, { fingerprint: fp2, name: "免费flash" }],
          accountModels: { [fp1]: ["m-one"] },
        },
      ],
    ]),
    modelCache: () => [{ id: "m-one", keys: [fp1] }, { id: "m-two", keys: [fp2] }],
  });
  await h.scheduler.upsert(dailyTask({ provider: "p1", model: "", account: fp1 }));
  await firedDaily(h);
  // m-two 的 Keys 不含 fp1 → 第 1 层剔除；accountModels 限定 m-one
  expect(h.sendCalls[0].task.model).toBe("p1/m-one");
  expect(h.sendCalls[0].pin).toBe(`p1#${fp1}`); // 启用 key ≥2 把 → <P>#指纹
  expect(h.sendCalls[0].effort).toBeNull();
  expect(h.store.data.runs[0].model).toBe("p1/m-one");
});

test("只有一把 key 时指纹账号不发账号头；旧任务里存的 key 名原样发", async () => {
  const fp1 = fingerprint("sk-test-AAAA11");
  const h = await harness({
    models: [{ id: "p1/m-one", owned_by: "p1", reasoning: false }],
    keyDir: new Map([["p1", { keys: [{ fingerprint: fp1, name: "GLM" }], accountModels: {} }]]),
    modelCache: () => [{ id: "m-one", keys: [] }],
  });
  await h.scheduler.upsert(dailyTask({ provider: "p1", model: "", account: fp1 }));
  await firedDaily(h);
  expect(h.sendCalls[0].pin).toBeNull(); // 单把 key：候选 ID 就是供应商 id，不带头

  const h2 = await harness({
    models: [{ id: "p1/m-one", owned_by: "p1", reasoning: false }],
    keyDir: new Map([["p1", { keys: [{ fingerprint: fp1, name: "免费flash" }], accountModels: {} }]]),
    modelCache: () => [{ id: "m-one", keys: [] }],
  });
  await h2.scheduler.upsert(dailyTask({ provider: "p1", model: "", account: "免费flash" }));
  await firedDaily(h2);
  expect(h2.sendCalls[0].pin).toBe("免费flash"); // 旧数据兼容：key 名原样作头值
});

test("空账号自动选模型：不带头，用「自动选账号」的模型列表（不受单把 key 的 Keys 限制）", async () => {
  const h = await harness({
    models: [
      { id: "p1/m-one", owned_by: "p1", reasoning: false },
      { id: "p1/m-one-flash", owned_by: "p1", reasoning: false },
    ],
    keyDir: new Map([
      ["p1", { keys: [{ fingerprint: fingerprint("sk-test-AAAA11"), name: "GLM" }], accountModels: {} }],
    ]),
    modelCache: () => [{ id: "m-one", keys: [fingerprint("sk-test-AAAA11")] }, { id: "m-one-flash", keys: [] }],
  });
  await h.scheduler.upsert(dailyTask({ provider: "p1", model: "" }));
  await firedDaily(h);
  expect(h.sendCalls[0].pin).toBeNull();
  expect(h.sendCalls[0].task.model).toBe("p1/m-one-flash");
});

test("窗口任务用统一账号列表找窗口：key 账号按指纹反查 key 名再匹配 ~keys 卡", async () => {
  const fp1 = fingerprint("sk-test-AAAA11");
  const entries: QuotaEntry[] = [
    {
      provider: "p1", account: "GLM", label: "GLM", viaKey: true,
      windows: [{ name: "5h", used: 0, resetsAt: null }], // 空闲窗口：立即到期
    },
  ];
  const h = await harness({
    quotas: () => ({ entries }),
    keyDir: new Map([["p1", { keys: [{ fingerprint: fp1, name: "GLM" }], accountModels: {} }]]),
    modelCache: () => [{ id: "m-one", keys: [] }],
    models: [{ id: "p1/m-one", owned_by: "p1", reasoning: false }],
  });
  await h.scheduler.upsert(
    dailyTask({ provider: "p1", model: "", account: fp1, trigger: { kind: "window", window: "5h" } }),
  );
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.sendCalls[0].pin).toBeNull(); // 目录里只有 1 把 key：指纹账号不发头
});

test("key 目录比额度快照后到 → 首轮不误报「额度里没有账号」，到齐后照常发送（竞态回归）", async () => {
  const fp1 = fingerprint("sk-test-AAAA11");
  const entries: QuotaEntry[] = [
    {
      provider: "p1", account: "GLM", label: "GLM", viaKey: true,
      windows: [{ name: "5h", used: 0, resetsAt: null }], // 空闲窗口：立即到期
    },
  ];
  const keyDir = new Map([
    ["p1", { keys: [{ fingerprint: fp1, name: "GLM" }], accountModels: {} }],
  ]);
  const h = await harness({
    quotas: () => ({ entries }),
    models: [{ id: "p1/m-one", owned_by: "p1", reasoning: false }],
    modelCache: () => [{ id: "m-one", keys: [] }],
    // key 目录读取（真实文件 I/O 的形态）慢于额度快照返回
    keyDirFn: () => new Promise((resolve) => setTimeout(() => resolve(keyDir), 20)),
  });
  await h.scheduler.upsert(
    dailyTask({ provider: "p1", model: "", account: fp1, trigger: { kind: "window", window: "5h" } }),
  );
  h.scheduler.start();
  h.fireDue(); // 首轮 tick：额度先落，key 目录 20ms 后到
  await h.flush();

  // 修复前：keyDirMap 还是 null → 指纹解析不出 key 名 → 记「额度里没有账号 <指纹>」且不发送
  const failed = h.store.data.runs.filter((r) => r.outcome === "failed");
  expect(failed.some((r) => r.reason.includes("额度里没有账号"))).toBe(false);
  expect(h.sendCalls).toHaveLength(1);
  expect(h.sendCalls[0].pin).toBeNull(); // 目录里只有 1 把 key：不发头
});

test("window：窗口在计时但额度卡瞬断丢了 resetsAt → 不当空闲重发", async () => {
  // 插件供应商的用量读取时好时坏：同一扇正在计时的窗口，这一轮读出来没有 resetsAt，
  // 看起来像空闲。0.2.2 之前会按「空闲立即发」重发一次；记住最近见过的重置时间后能分清
  let resetsAt: string | null = new Date(ms(T0) + 11 * HOUR).toISOString(); // 未来
  const h = await harness({
    quotas: () => ({
      entries: [{
        provider: "openai", account: "acct-yang", label: "Y", viaKey: false,
        windows: [{ name: "5h", used: 1, resetsAt }],
      }],
    }),
  });
  const id = (await h.scheduler.upsert(dailyTask({
    name: "开窗", trigger: { kind: "window", window: "5h" }, account: "acct-yang",
  }))).id;
  h.scheduler.start();
  h.fireDue(); // 读到未来 resetsAt → 记下并排程到 R+30s
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);

  resetsAt = null; // 卡瞬断
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(0); // 不当空闲发送

  resetsAt = new Date(ms(T0) + 11 * HOUR).toISOString(); // 卡恢复
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms(T0) + 11 * HOUR + 30_000).toISOString());
});

// ---------- 额度缓存滞后（Docker 实机 2026-11-02）：magpie web 无托盘时只在路由请求那一刻读卡，
// 读到的是发送前的空闲，之后无人再读；插件跨整点把旧空闲当新事件，每次开窗后都多发一次 ----------

interface Card { readAt: string; resetsAt: string | null }

function zcodeCard(card: () => Card): () => { entries: QuotaEntry[] } {
  return () => ({
    entries: [{
      provider: "zcode", account: "a@b.c", label: "A", viaKey: false, readAt: card().readAt,
      windows: [{ name: "5 hours", used: 0, resetsAt: card().resetsAt }],
    }],
  });
}

const zcodeWindowTask = () => dailyTask({
  name: "开窗", provider: "zcode", account: "a@b.c", trigger: { kind: "window", window: "5 hours" },
});

test("window：发送后缓存一直停在发送前的空闲读数 → 跨整点也不重发", async () => {
  // 单卡刷新也没拿到新读数（替身空操作）：readAt 早于上次发送，空闲不可信，宁可不发
  const card: Card = { readAt: new Date(ms(T0)).toISOString(), resetsAt: null };
  const h = await harness({ quotas: zcodeCard(() => card) });
  await h.scheduler.upsert(zcodeWindowTask());
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);

  for (let i = 0; i < 18; i++) { // 3 小时，跨 3 个整点
    h.advance(10 * 60_000);
    h.fireDue();
    await h.flush();
  }
  expect(h.sendCalls).toHaveLength(1);
  expect(h.refreshCalls.length).toBeGreaterThan(0); // 期间一直在设法拿新读数
  expect(h.refreshCalls.every(([p, u]) => p === "zcode" && u === "a@b.c")).toBe(true);
});

test("window：到期先单卡刷新，刷新后看到窗口已在计时 → 不发，排到新的 resetsAt+30s", async () => {
  const reset = new Date(ms(T0) + 3 * HOUR).toISOString();
  let card: Card = { readAt: new Date(ms(T0) - 2 * HOUR).toISOString(), resetsAt: null };
  const h: Harness = await harness({
    quotas: zcodeCard(() => card),
    refresh: () => { card = { readAt: h.now().toISOString(), resetsAt: reset }; },
  });
  const id = (await h.scheduler.upsert(zcodeWindowTask())).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.refreshCalls).toEqual([["zcode", "a@b.c"]]);
  expect(h.sendCalls).toHaveLength(0);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms(reset) + 30_000).toISOString());
});

test("window：发送 60 秒后单卡刷新拿到新 resetsAt 精确排程；到期后新读数为空闲才再发", async () => {
  let card: Card = { readAt: new Date(ms(T0)).toISOString(), resetsAt: null };
  let opened: string | null = null; // 厂商侧：发送开窗后的重置时间
  const h: Harness = await harness({
    quotas: zcodeCard(() => card),
    refresh: () => {
      const live = opened !== null && ms(opened) > h.now().getTime() ? opened : null;
      card = { readAt: h.now().toISOString(), resetsAt: live };
    },
    sendImpl: async () => {
      opened = new Date(h.now().getTime() + 5 * HOUR).toISOString();
      return { outcome: "ok", reason: "", ms: 2 };
    },
  });
  const id = (await h.scheduler.upsert(zcodeWindowTask())).id;
  h.scheduler.start();
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.refreshCalls).toHaveLength(0); // 读数刚读的，不必再刷
  // 发送后唤醒排在 60 秒后，专门去拿开窗后的读数
  expect(h.pendingTimers().some((t) => t.at === ms(T0) + 60_000)).toBe(true);

  h.advance(60_000);
  h.fireDue();
  await h.flush();
  expect(h.refreshCalls).toHaveLength(1);
  expect(h.scheduler.snapshot().next[id]).toBe(new Date(ms(opened!) + 30_000).toISOString());

  h.advance(5 * HOUR - 60_000 + 30_000); // 到 resetsAt+30s
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(2);
});

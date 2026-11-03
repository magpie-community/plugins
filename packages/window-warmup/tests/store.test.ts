// store 与单实例锁的失败测试：损坏拒启动且不覆盖原文件、原子写入、按任务截断、锁的活性判断。
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, migrateLegacyState, openStore, StoreError, type TaskMarks } from "../src/store";
import type { Run, Task } from "../src/types";

const t1: Task = {
  id: "t1", name: "早报", enabled: true, provider: "openai", account: "",
  model: "m1", message: "hi",
  trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
  createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
};

function runFixture(over: Partial<Run> = {}): Run {
  return {
    id: "r1", taskId: "t1", source: "schedule", due: null,
    startedAt: "2026-10-30T06:00:00.000Z", endedAt: "2026-10-30T06:00:05.000Z",
    outcome: "ok", reason: "", effort: null, model: null, ms: 5, resetKey: null,
    ...over,
  };
}

function stateJson(tasks: Task[], runs: Run[], marks: Record<string, TaskMarks>): string {
  return JSON.stringify({ version: 1, tasks, runs, marks });
}

let dirs: string[] = [];
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sched-store-"));
  dirs.push(dir);
  return dir;
}

describe("openStore", () => {
  test("空目录得到全新状态；保存后重开内容一致", async () => {
    const dir = await newDir();
    const s = await openStore(dir);
    expect(s.data).toEqual({ version: 1, tasks: [], runs: [], marks: {} });

    const run = runFixture();
    s.data.tasks.push(t1);
    s.data.runs.push(run);
    s.data.marks["t1"] = { lastDue: "2026-10-30T06:00:00.000Z", resetKeys: ["k1"] };
    await s.save();

    const s2 = await openStore(dir);
    expect(s2.data).toEqual({ version: 1, tasks: [t1], runs: [run], marks: { t1: { lastDue: "2026-10-30T06:00:00.000Z", resetKeys: ["k1"] } } });
  });

  test("只留 .tmp（模拟 rename 前崩溃）→ 原文件完整可用，且下次保存覆盖 tmp", async () => {
    const dir = await newDir();
    const good = stateJson([t1], [runFixture()], {});
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), good);
    await writeFile(join(dir, "state.json.tmp"), "{坏了");

    const s = await openStore(dir);
    expect(s.data.tasks.map((t) => t.id)).toEqual(["t1"]);
    s.data.tasks.push({ ...t1, id: "t2" });
    await s.save();

    const s2 = await openStore(dir);
    expect(s2.data.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("非法 JSON → StoreError 且原文件字节不变", async () => {
    const dir = await newDir();
    const broken = '{"version":1,"tasks":[';
    await writeFile(join(dir, "state.json"), broken);

    await expect(openStore(dir)).rejects.toThrow(StoreError);
    await expect(openStore(dir)).rejects.toThrow(/JSON/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(broken);
  });

  test("version:2 → StoreError 且原文件不变", async () => {
    const dir = await newDir();
    const future = JSON.stringify({ version: 2, tasks: [], runs: [], marks: {} });
    await writeFile(join(dir, "state.json"), future);

    await expect(openStore(dir)).rejects.toThrow(StoreError);
    await expect(openStore(dir)).rejects.toThrow(/版本/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(future);
  });

  test("结构损坏 → StoreError（tasks 非数组 / 任务缺字段 / marks 形状错 / run 字段坏）", async () => {
    const cases: unknown[] = [
      { version: 1, tasks: "nope", runs: [], marks: {} },
      { version: 1, tasks: [{ ...t1, id: 5 }], runs: [], marks: {} },
      { version: 1, tasks: [t1], runs: [runFixture({ outcome: "bogus" as never })], marks: {} },
      { version: 1, tasks: [t1], runs: [], marks: { t1: { lastDue: 7, resetKeys: [] } } },
      { version: 1, tasks: [t1], runs: [], marks: { t1: { lastDue: null, resetKeys: "k" } } },
      [1, 2, 3],
    ];
    for (const bad of cases) {
      const dir = await newDir();
      const raw = JSON.stringify(bad);
      await writeFile(join(dir, "state.json"), raw);
      await expect(openStore(dir)).rejects.toThrow(StoreError);
      expect(await readFile(join(dir, "state.json"), "utf8")).toBe(raw);
    }
  });

  test("runs 超过 50 条按任务截断（保留最近的尾部）", async () => {
    const dir = await newDir();
    const many: Run[] = Array.from({ length: 55 }, (_, i) => runFixture({ id: `r${i}` }));
    const t2 = { ...t1, id: "t2" };
    const raw = stateJson(
      [t1, t2],
      [...many, runFixture({ id: "x1", taskId: "t2" }), runFixture({ id: "x2", taskId: "t2" })],
      {},
    );
    await writeFile(join(dir, "state.json"), raw);

    const s = await openStore(dir);
    const mine = s.data.runs.filter((r) => r.taskId === "t1");
    expect(mine).toHaveLength(50);
    expect(mine[0].id).toBe("r5");
    expect(mine[49].id).toBe("r54");
    expect(s.data.runs.filter((r) => r.taskId === "t2")).toHaveLength(2);
  });

  test("每任务 resetKey 超过 20 个截断", async () => {
    const dir = await newDir();
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}`);
    await writeFile(join(dir, "state.json"), stateJson([t1], [], { t1: { lastDue: null, resetKeys: keys } }));

    const s = await openStore(dir);
    expect(s.data.marks["t1"].resetKeys).toHaveLength(20);
    expect(s.data.marks["t1"].resetKeys[0]).toBe("k5");
    expect(s.data.marks["t1"].resetKeys[19]).toBe("k24");
  });

  test("旧 state 的 run 没有 model 字段 → 照常加载为 null，保存后字段补齐", async () => {
    const dir = await newDir();
    const legacyRun = {
      id: "r1", taskId: "t1", source: "schedule", due: null,
      startedAt: "2026-10-30T06:00:00.000Z", endedAt: "2026-10-30T06:00:05.000Z",
      outcome: "ok", reason: "", effort: null, ms: 5, resetKey: null,
    };
    await writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, tasks: [t1], runs: [legacyRun], marks: {} }));

    const s = await openStore(dir);
    expect(s.data.runs[0].model).toBeNull();
    await s.save();
    const s2 = await openStore(dir);
    expect(s2.data.runs[0]).toEqual(runFixture());
  });

  test("run.model 类型坏 → StoreError", async () => {
    const dir = await newDir();
    const raw = stateJson([t1], [runFixture({ model: 5 as never })], {});
    await writeFile(join(dir, "state.json"), raw);
    await expect(openStore(dir)).rejects.toThrow(StoreError);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(raw);
  });
});

describe("migrateLegacyState", () => {
  function legacyEnv(xdg: string): Record<string, string | undefined> {
    return { XDG_CONFIG_HOME: xdg };
  }

  test("旧目录有 state.json 且新目录没有 → 复制过来；旧文件与锁都不动", async () => {
    const xdg = await newDir();
    const legacyDir = join(xdg, "magpie", "scheduled-messages");
    await mkdir(legacyDir, { recursive: true });
    const legacyState = stateJson([t1], [runFixture()], {});
    await writeFile(join(legacyDir, "state.json"), legacyState);
    await writeFile(join(legacyDir, "service.lock"), "999");
    const dir = await newDir();

    await migrateLegacyState(dir, legacyEnv(xdg));

    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(legacyState);
    expect(await readFile(join(legacyDir, "state.json"), "utf8")).toBe(legacyState); // 复制而非移动
    expect(await readdir(dir)).toEqual(["state.json"]); // 锁属于旧目录的进程语义，不跟过来
  });

  test("新目录已有 state.json → 不覆盖（哪怕是坏的，坏文件由 openStore 报给用户）", async () => {
    const xdg = await newDir();
    const legacyDir = join(xdg, "magpie", "scheduled-messages");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "state.json"), stateJson([t1], [], {}));
    const dir = await newDir();
    const own = "自己已有的内容";
    await writeFile(join(dir, "state.json"), own);

    await migrateLegacyState(dir, legacyEnv(xdg));

    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(own);
  });

  test("旧目录没有 state.json → 新目录保持空，不报错", async () => {
    const xdg = await newDir();
    const dir = await newDir();
    await migrateLegacyState(dir, legacyEnv(xdg));
    expect(await readdir(dir)).toEqual([]);
  });

  test("旧文件损坏也照搬（迁移只看存在性，结构校验交给 openStore）", async () => {
    const xdg = await newDir();
    const legacyDir = join(xdg, "magpie", "scheduled-messages");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "state.json"), "{坏了");
    const dir = await newDir();

    await migrateLegacyState(dir, legacyEnv(xdg));

    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("{坏了");
  });
});

describe("acquireLock", () => {
  test("无锁 → 原子拿到并写入自身 pid；release 后文件消失", async () => {
    const dir = await newDir();
    const lock = await acquireLock(dir);
    if (!lock.ok) throw new Error("应当拿到锁");
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe(String(process.pid));
    await lock.release();
    expect(await readFile(join(dir, "service.lock"), "utf8").catch(() => "gone")).toBe("gone");
  });

  test("锁里是存活 pid → ok:false 且不覆盖文件", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), String(process.pid));
    const lock = await acquireLock(dir);
    expect(lock.ok).toBe(false);
    if (!lock.ok) expect(lock.pid).toBe(process.pid);
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe(String(process.pid));
  });

  test("锁里是存活 pid 但确认不过（持有者并未在服务）→ 视为陈旧锁接管", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), String(process.pid));
    const lock = await acquireLock(dir, { confirmAlive: () => false });
    expect(lock.ok).toBe(true);
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe(String(process.pid));
    if (lock.ok) await lock.release();
  });

  test("锁里是存活 pid 且确认在服务 → ok:false 不覆盖文件", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), String(process.pid));
    const lock = await acquireLock(dir, { confirmAlive: () => true });
    expect(lock.ok).toBe(false);
    if (!lock.ok) expect(lock.pid).toBe(process.pid);
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe(String(process.pid));
  });

  test("pid 已死时不调用确认直接接管", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), String(2 ** 22 + 1));
    let calls = 0;
    const lock = await acquireLock(dir, {
      confirmAlive: () => {
        calls += 1;
        return true;
      },
    });
    expect(lock.ok).toBe(true);
    expect(calls).toBe(0);
    if (lock.ok) await lock.release();
  });

  test("锁里是不存在的 pid → 接管并写入自身 pid", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), String(2 ** 22 + 1));
    const lock = await acquireLock(dir);
    expect(lock.ok).toBe(true);
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe(String(process.pid));
    if (lock.ok) await lock.release();
  });

  test("release 只释放自己持有的锁", async () => {
    const dir = await newDir();
    const lock = await acquireLock(dir);
    if (!lock.ok) throw new Error("应当拿到锁");
    await writeFile(join(dir, "service.lock"), "999999");
    await lock.release();
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe("999999");
  });

  test("锁内容无法解析（活性不明）→ 不抢占", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock"), "看不懂的内容");
    const lock = await acquireLock(dir);
    expect(lock.ok).toBe(false);
    if (!lock.ok) expect(lock.pid).toBe(0);
    expect(await readFile(join(dir, "service.lock"), "utf8")).toBe("看不懂的内容");
  });

  test("入口顺带清理崩溃残留的锁 tmp 文件", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "service.lock.999.3f2b4c5d-6e7f-8a9b-0a1b-2c3d4e5f6a7b.tmp"), "999");
    const lock = await acquireLock(dir);
    expect(lock.ok).toBe(true);
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
    if (lock.ok) await lock.release();
  });
});

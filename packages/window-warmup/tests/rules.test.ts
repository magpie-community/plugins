import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lastDue, nextDaily, nextEvery, upcoming, validateTask, windowDue } from "../src/rules";
import type { Trigger } from "../src/types";

test("rules 只依赖 types：页面直接打包它，引入 node:* 或网关模块会让浏览器端构建失效", () => {
  for (const file of ["rules.ts", "types.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
    const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    expect(imports.filter((s) => s !== "./types")).toEqual([]);
  }
});

const SH = "Asia/Shanghai";
const NY = "America/New_York";

const ms = (iso: string) => new Date(iso).getTime();

describe("nextDaily", () => {
  test("上海：05:00 之后下一次 06:00 是当天", () => {
    expect(nextDaily({ time: "06:00", timeZone: SH }, new Date("2026-10-31T05:00:00+08:00")).getTime())
      .toBe(ms("2026-10-31T06:00:00+08:00"));
  });

  test("after 恰为 06:00 → 次日 06:00", () => {
    expect(nextDaily({ time: "06:00", timeZone: SH }, new Date("2026-10-31T06:00:00+08:00")).getTime())
      .toBe(ms("2026-11-01T06:00:00+08:00"));
  });

  test("纽约春令时：02:30 不存在 → 跳变后第一个有效时刻 03:00（EDT）", () => {
    expect(nextDaily({ time: "02:30", timeZone: NY }, new Date("2026-03-08T00:00:00-05:00")).getTime())
      .toBe(ms("2026-03-08T03:00:00-04:00"));
  });

  test("纽约秋令时：01:30 出现两次 → 取较早的 EDT 实例", () => {
    expect(nextDaily({ time: "01:30", timeZone: NY }, new Date("2026-11-01T00:00:00-04:00")).getTime())
      .toBe(ms("2026-11-01T01:30:00-04:00"));
  });

  test("纽约秋令时：EDT 实例已过 → 同日较晚的 EST 实例", () => {
    expect(nextDaily({ time: "01:30", timeZone: NY }, new Date("2026-11-01T01:45:00-04:00")).getTime())
      .toBe(ms("2026-11-01T01:30:00-05:00"));
  });

  test("纽约秋令时：02:30 当天不受跳变影响（EST）", () => {
    expect(nextDaily({ time: "02:30", timeZone: NY }, new Date("2026-11-01T00:00:00-04:00")).getTime())
      .toBe(ms("2026-11-01T02:30:00-05:00"));
  });

  test("春令时跳变：结果毫秒精确到跳变边界（二分提前停止会带 ≤999ms 误差）", () => {
    // 跳变瞬间是 07:00:00Z；02:01 与 02:04 的二分区间奇偶不同，修复前分别落在 .234Z / .058Z
    expect(nextDaily({ time: "02:01", timeZone: NY }, new Date("2026-03-08T00:00:00-05:00")).getTime())
      .toBe(ms("2026-03-08T03:00:00-04:00"));
    expect(nextDaily({ time: "02:04", timeZone: NY }, new Date("2026-03-08T00:00:00-05:00")).getTime())
      .toBe(ms("2026-03-08T03:00:00-04:00"));
  });
});

describe("nextEvery", () => {
  const t = { hours: 5, anchor: "2026-10-31T09:30:00+08:00" };

  test("anchor 09:30 起每 5 小时：14:29 → 14:30", () => {
    expect(nextEvery(t, new Date("2026-10-31T14:29:00+08:00")).getTime())
      .toBe(ms("2026-10-31T14:30:00+08:00"));
  });

  test("after 早于 anchor → anchor", () => {
    expect(nextEvery(t, new Date("2026-10-31T08:00:00+08:00")).getTime())
      .toBe(ms("2026-10-31T09:30:00+08:00"));
  });

  test("after 恰为到期点 → 下一个点（严格晚于）", () => {
    expect(nextEvery(t, new Date("2026-10-31T14:30:00+08:00")).getTime())
      .toBe(ms("2026-10-31T19:30:00+08:00"));
  });

  test("hours <= 0 → 抛错（正常路径有校验，这里防未校验来源除零）", () => {
    expect(() => nextEvery({ hours: 0, anchor: t.anchor }, new Date("2026-10-31T14:29:00+08:00")))
      .toThrow(/间隔/);
  });
});

describe("lastDue", () => {
  const daily: Trigger = { kind: "daily", time: "06:00", timeZone: SH };
  const every: Trigger = { kind: "every", hours: 5, anchor: "2026-10-31T09:30:00+08:00" };

  test("daily：07:00 之前最近的应到点是当天 06:00", () => {
    expect(lastDue(daily, new Date("2026-10-31T07:00:00+08:00"))?.getTime())
      .toBe(ms("2026-10-31T06:00:00+08:00"));
  });

  test("daily：05:00 之前最近的应到点是前一天 06:00", () => {
    expect(lastDue(daily, new Date("2026-10-31T05:00:00+08:00"))?.getTime())
      .toBe(ms("2026-10-30T06:00:00+08:00"));
  });

  test("every：14:29 之前最近的应到点是 anchor", () => {
    expect(lastDue(every, new Date("2026-10-31T14:29:00+08:00"))?.getTime())
      .toBe(ms("2026-10-31T09:30:00+08:00"));
  });

  test("every：19:00 之前最近的应到点是 14:30", () => {
    expect(lastDue(every, new Date("2026-10-31T19:00:00+08:00"))?.getTime())
      .toBe(ms("2026-10-31T14:30:00+08:00"));
  });

  test("every：before 早于 anchor → null", () => {
    expect(lastDue(every, new Date("2026-10-31T08:00:00+08:00"))).toBeNull();
  });

  test("window 触发没有几何上的应到点 → null", () => {
    expect(lastDue({ kind: "window", window: "5h" }, new Date())).toBeNull();
  });

  test("every：hours <= 0 → null（不产生几何点）", () => {
    expect(lastDue({ kind: "every", hours: 0, anchor: "2026-10-31T09:30:00+08:00" }, new Date()))
      .toBeNull();
  });
});

describe("windowDue", () => {
  test("resetsAt 在未来 → at = resetsAt + 30s，resetKey = resetsAt", () => {
    const r = windowDue(
      { name: "5h", used: 3, resetsAt: "2026-10-31T14:32:00+08:00" },
      new Date("2026-10-31T10:00:00+08:00"),
    );
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.at.getTime()).toBe(ms("2026-10-31T14:32:30+08:00"));
      expect(r.resetKey).toBe("2026-10-31T14:32:00+08:00");
    }
  });

  test("resetsAt 为 null（窗口空闲）：同一小时的两个快照共享 idle resetKey", () => {
    const a = windowDue({ name: "5h", used: 0, resetsAt: null }, new Date("2026-10-31T10:05:00+08:00"));
    const b = windowDue({ name: "5h", used: 0, resetsAt: null }, new Date("2026-10-31T10:55:00+08:00"));
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    if (!("error" in a) && !("error" in b)) {
      expect(a.resetKey).toBe(b.resetKey);
      expect(a.resetKey.startsWith("idle:")).toBe(true);
      expect(a.at.getTime()).toBe(ms("2026-10-31T10:05:00+08:00"));
      expect(b.at.getTime()).toBe(ms("2026-10-31T10:55:00+08:00"));
    }
  });

  test("resetsAt 已过 → 视为空闲，立即到期", () => {
    const r = windowDue(
      { name: "5h", used: 0, resetsAt: "2026-10-31T09:00:00+08:00" },
      new Date("2026-10-31T10:05:00+08:00"),
    );
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.at.getTime()).toBe(ms("2026-10-31T10:05:00+08:00"));
      expect(r.resetKey.startsWith("idle:")).toBe(true);
    }
  });

  test("账号的额度里没有这个窗口 → error", () => {
    const r = windowDue(undefined, new Date("2026-10-31T10:00:00+08:00"));
    expect("error" in r && r.error === "账号的额度里没有这个窗口").toBe(true);
  });

  test("resetsAt 无法解析（truthy 但非时间）→ 按空闲每小时限频", () => {
    const r = windowDue(
      { name: "5h", used: 0, resetsAt: "not-a-date" },
      new Date("2026-10-31T10:05:00+08:00"),
    );
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.resetKey.startsWith("idle:")).toBe(true);
      expect(r.at.getTime()).toBe(ms("2026-10-31T10:05:00+08:00"));
    }
  });
});

describe("upcoming", () => {
  test("daily：给出未来 3 个点", () => {
    const pts = upcoming({ kind: "daily", time: "06:00", timeZone: SH }, new Date("2026-10-31T07:00:00+08:00"), 3);
    expect(pts.map((p) => p.getTime())).toEqual([
      ms("2026-11-01T06:00:00+08:00"),
      ms("2026-11-02T06:00:00+08:00"),
      ms("2026-11-03T06:00:00+08:00"),
    ]);
  });

  test("every：给出未来 2 个点", () => {
    const pts = upcoming(
      { kind: "every", hours: 5, anchor: "2026-10-31T09:30:00+08:00" },
      new Date("2026-10-31T14:29:00+08:00"), 2,
    );
    expect(pts.map((p) => p.getTime())).toEqual([
      ms("2026-10-31T14:30:00+08:00"),
      ms("2026-10-31T19:30:00+08:00"),
    ]);
  });

  test("window 触发依赖额度快照，由调度层单独计算 → 空数组", () => {
    expect(upcoming({ kind: "window", window: "5h" }, new Date(), 3)).toEqual([]);
  });
});

describe("validateTask", () => {
  const now = new Date("2026-10-31T09:00:00+08:00");
  const base = {
    name: "早报",
    provider: "openai",
    account: "acc-1",
    model: "gpt-5",
    trigger: { kind: "daily", time: "06:00", timeZone: SH },
  };

  test("合法 daily 任务：缺省 message=hi、enabled=true", () => {
    const r = validateTask(base, now);
    expect("task" in r).toBe(true);
    if ("task" in r) {
      expect(r.task.message).toBe("hi");
      expect(r.task.enabled).toBe(true);
      expect(r.task.trigger).toEqual({ kind: "daily", time: "06:00", timeZone: SH });
    }
  });

  test("account 为空（账号必选，不分触发）→ field account", () => {
    const r = validateTask({ ...base, account: "" }, now);
    expect("error" in r && r.field === "account").toBe(true);
  });

  test("名称为空 → field name", () => {
    const checked = validateTask({ ...base, name: "   " }, now);
    expect("error" in checked && checked.field === "name").toBe(true);
  });

  test("名称超过 40 字 → field name；恰好 40 字 → 通过", () => {
    const long = validateTask({ ...base, name: "字".repeat(41) }, now);
    expect("error" in long && long.field === "name").toBe(true);
    const edge = validateTask({ ...base, name: "字".repeat(40) }, now);
    expect("task" in edge).toBe(true);
  });

  test("路由组模型（group/ 开头）不接受 → field model", () => {
    const r = validateTask({ ...base, model: "group/auto" }, now);
    expect("error" in r && r.field === "model").toBe(true);
  });

  test("model 为空串 → 通过，表示由供应商自动选模型", () => {
    const r = validateTask({ ...base, model: "" }, now);
    expect("task" in r).toBe(true);
    if ("task" in r) expect(r.task.model).toBe("");
    // 纯空白同样归一成自动
    const blank = validateTask({ ...base, model: "   " }, now);
    expect("task" in blank && blank.task.model === "").toBe(true);
  });

  test("非法时区 → field timeZone", () => {
    const r = validateTask({ ...base, trigger: { kind: "daily", time: "06:00", timeZone: "Mars/Olympus" } }, now);
    expect("error" in r && r.field === "timeZone").toBe(true);
  });

  test("time 非 HH:MM → field time", () => {
    for (const time of ["6:00", "25:00", "06:60"]) {
      const r = validateTask({ ...base, trigger: { kind: "daily", time, timeZone: SH } }, now);
      expect("error" in r && r.field === "time").toBe(true);
    }
  });

  test("hours 越界（0 与 200）→ field hours", () => {
    for (const hours of [0, 200]) {
      const r = validateTask({ ...base, trigger: { kind: "every", hours } }, now);
      expect("error" in r && r.field === "hours").toBe(true);
    }
  });

  test("every 缺省 anchor → 取创建时刻并取整到分钟", () => {
    const at = new Date("2026-10-31T09:30:47+08:00");
    const r = validateTask({ ...base, trigger: { kind: "every", hours: 5 } }, at);
    expect("task" in r).toBe(true);
    if ("task" in r) {
      expect(r.task.trigger).toEqual({ kind: "every", hours: 5, anchor: "2026-10-31T01:30:00.000Z" });
    }
  });

  test("every 提供非法 anchor → field anchor", () => {
    const r = validateTask({ ...base, trigger: { kind: "every", hours: 5, anchor: "not-a-date" } }, now);
    expect("error" in r && r.field === "anchor").toBe(true);
  });

  test("message 字段忽略，一律存 hi（旧长度校验不再存在）", () => {
    const long = validateTask({ ...base, message: "字".repeat(201) }, now);
    expect("task" in long).toBe(true);
    if ("task" in long) expect(long.task.message).toBe("hi");
    // 类型不对的字段同样忽略
    const weird = validateTask({ ...base, message: 42 }, now);
    expect("task" in weird).toBe(true);
    if ("task" in weird) expect(weird.task.message).toBe("hi");
  });
});

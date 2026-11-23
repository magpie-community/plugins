// 本文由AI自动生成
// pace 分值的展示用分解：只测「式子」与「合并」，不测排序策略本身
// （真实排序由 magpie 写进 routing 日志的 order[] 决定，面板照抄）。
import { test, expect } from "bun:test";
import { decompose, aggregate, humanHours } from "../lib/pace.mjs";

const H = 3_600_000;
const now = Date.parse("2026-03-01T00:00:00Z");
const later = (hours) => new Date(now + hours * H).toISOString();

test("pace = (100 − 已用%) ÷ 距到期小时", () => {
  const d = decompose(40, later(10), now);
  expect(d.divisorHours).toBeCloseTo(10, 9);
  expect(d.pace).toBeCloseTo(6, 9);
  expect(d.assumed).toBe(false);
});

test("距到期不足 1 小时按 1 小时算，不除零", () => {
  const d = decompose(95, later(0.1), now);
  expect(d.divisorHours).toBe(1);
  expect(d.pace).toBeCloseTo(5, 9);
  expect(d.overdue).toBe(true);
});

test("没有到期日时按 168 小时兜底", () => {
  const d = decompose(0, null, now);
  expect(d.assumed).toBe(true);
  expect(d.divisorHours).toBe(168);
  expect(d.pace).toBeCloseTo(100 / 168, 9);
});

test("已用超过 100% 时剩余百分比不出现负数", () => {
  expect(decompose(130, null, now).remainingPct).toBe(0);
});

test("同一账号的多条条目合并成一行，取最大 pace", () => {
  const rows = aggregate(
    [
      { id: "acct-a", provider: "p", used: 50, due: later(10), pace: 5 },
      { id: "acct-a", provider: "p", used: 10, due: later(5), pace: 18 },
      { id: "acct-b", provider: "p", used: 80, due: later(10), pace: 2 },
    ],
    now,
  );
  expect(rows.length).toBe(2);
  expect(rows[0].id).toBe("acct-a");
  expect(rows[0].pace).toBe(18);
  expect(rows[0].entries).toBe(2);
  expect(rows[1].id).toBe("acct-b");
  expect(rows.map((r) => r.shownRank)).toEqual([1, 2]);
});

test("冷却中的账号沉底，即使 pace 并列", () => {
  const rows = aggregate(
    [
      { id: "cool", used: 10, due: later(10), pace: 9, rest: { why: "rate limit" } },
      { id: "hot", used: 10, due: later(10), pace: 9 },
    ],
    now,
  );
  expect(rows[0].id).toBe("hot");
  expect(rows[1].id).toBe("cool");
  expect(rows[1].rest.why).toBe("rate limit");
});

test("magpie 给了 pace 就用它，没给才按式子复算", () => {
  const declared = aggregate([{ id: "x", used: 50, due: later(10), pace: 7.5 }], now);
  expect(declared[0].paceSource).toBe("magpie");
  expect(declared[0].pace).toBe(7.5);

  const computed = aggregate([{ id: "y", used: 50, due: later(10) }], now);
  expect(computed[0].paceSource).toBe("computed");
  expect(computed[0].pace).toBeCloseTo(5, 9);
});

test("小时数说人话", () => {
  expect(humanHours(null)).toBe("未知");
  expect(humanHours(0.5)).toBe("已到期");
  expect(humanHours(5)).toBe("5.0 小时");
  expect(humanHours(48)).toBe("2.0 天");
});

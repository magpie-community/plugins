// 本文由AI自动生成
// 到期账：官方 runsOut 优先，没有才估；「包过期」与「本期重置」必须分开。
import { test, expect } from "bun:test";
import { projectWindow } from "../lib/waste.mjs";

const DAY = 86_400_000;
const now = Date.now();
const inDays = (d) => new Date(now + d * DAY).toISOString();
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("官方给的 runsOut 直接用，标 official", () => {
  const r = projectWindow(
    { name: "Credits", unit: "credits", limit: 100, amount: 40, runsOut: 12.5, runsOutAt: inDays(5) },
    null,
    [],
    now,
  );
  expect(r.wasteSource).toBe("official");
  expect(r.waste).toBe(12.5);
  expect(r.verdict).toBe("waste");
  expect(r.kind).toBe("lapse");
});

test("官方 runsOut 为 0 判定为能烧完", () => {
  const r = projectWindow({ name: "x", runsOut: 0, runsOutAt: inDays(5) }, null, [], now);
  expect(r.verdict).toBe("burnable");
  expect(r.waste).toBe(0);
});

test("额度已经用尽，谈不上浪费", () => {
  const r = projectWindow({ name: "x", limit: 100, amount: 100, resetsAt: inDays(9) }, null, [], now);
  expect(r.verdict).toBe("spent");
  expect(r.kind).toBe("reset");
});

test("没有到期日就不会过期", () => {
  const r = projectWindow({ name: "x", limit: 100, amount: 20 }, null, [], now);
  expect(r.verdict).toBe("no-due");
});

test("没有历史消耗就明说推不出来，不给数字", () => {
  const r = projectWindow(
    { name: "x", unit: "credits", limit: 100, amount: 40, resetsAt: inDays(10) },
    null,
    [],
    now,
  );
  expect(r.verdict).toBe("thin");
  expect(r.waste).toBe(null);
});

test("有近 7 天日均消耗就按线性外推", () => {
  const days = {};
  for (let i = 1; i <= 3; i++) days[dayKey(new Date(now - i * DAY))] = 10;
  const r = projectWindow(
    { name: "x", unit: "credits", limit: 100, amount: 40, resetsAt: inDays(7) },
    { days },
    [],
    now,
  );
  // 剩 60，日均 30/7 ≈ 4.29，7 天烧 30，到期还剩 30
  expect(r.ratePerDay).toBeCloseTo(30 / 7, 6);
  expect(r.projectedLeft).toBeCloseTo(30, 6);
  expect(r.verdict).toBe("waste");
  expect(r.wasteSource).toBe("estimated");
});

test("烧得完就不报警", () => {
  const days = {};
  for (let i = 1; i <= 7; i++) days[dayKey(new Date(now - i * DAY))] = 10;
  const r = projectWindow(
    { name: "x", unit: "credits", limit: 100, amount: 10, resetsAt: inDays(2) },
    { days },
    [],
    now,
  );
  // 剩 90，日均 70/7 = 10，2 天烧 20，到期还剩 70
  expect(r.verdict).toBe("waste");
  expect(r.waste).toBeGreaterThan(0);

  const ok = projectWindow(
    { name: "y", unit: "credits", limit: 1000, amount: 950, resetsAt: inDays(2) },
    { days },
    [],
    now,
  );
  // 剩 50，日均 10，2 天烧 20，剩 30 —— 阈值 max(5, 0.01) = 5，仍算浪费
  expect(ok.projectedLeft).toBeCloseTo(30, 6);
});

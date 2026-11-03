import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRows, parseCSV, periodTrend } from "../lib/usage.mjs";

// 与 Magpie `usage --csv` 的真实列一致；按列名取值，测试跟着实现走。
const COLUMNS = [
  "time", "agent", "requested_model", "provider", "host", "model", "served_model",
  "swapped", "effort", "input_tokens", "output_tokens", "cache_write_tokens",
  "cache_read_tokens", "reasoning_tokens", "cost_usd", "duration_ms", "ttft_ms",
  "status", "error", "session", "caller_key_id", "caller_key_name",
];

function line(values = {}) {
  return COLUMNS.map((name) => {
    const value = values[name] ?? "";
    const text = String(value);
    return text.includes(",") || text.includes('"')
      ? '"' + text.replace(/"/g, '""') + '"'
      : text;
  }).join(",");
}

function csv(rows) {
  return [COLUMNS.join(","), ...rows.map(line)].join("\n");
}

test("tokens 口径与 Magpie 一致：只算 input + output，cache 单列", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", input_tokens: 100, output_tokens: 50, cache_read_tokens: 30000, cache_write_tokens: 10, caller_key_id: "k1", caller_key_name: "project:a" },
  ])).rows;
  const { totals, byKey } = aggregateRows(rows);
  assert.equal(totals.tokens, 150);
  assert.equal(byKey.k1.tokens, 150);
  assert.equal(totals.cacheRead, 30000);
  assert.equal(totals.cacheWrite, 10);
  assert.equal(totals.in, 100);
  assert.equal(totals.out, 50);
});

test("cacheHitRate is cache_read / (cache_read + cache_write)", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", input_tokens: 1, output_tokens: 1, cache_read_tokens: 75, cache_write_tokens: 25, caller_key_id: "k1" },
  ])).rows;
  const { byKey } = aggregateRows(rows);
  assert.equal(byKey.k1.cacheHitRate, 0.75);
});

test("cacheHitRate is null when no cache traffic", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", input_tokens: 1, output_tokens: 1, caller_key_id: "k1" },
  ])).rows;
  assert.equal(aggregateRows(rows).byKey.k1.cacheHitRate, null);
});

test("periodTrend：今天对比昨天", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-30T10:00:00+08:00", input_tokens: 100, output_tokens: 0, caller_key_id: "k1" },
    { time: "2026-10-31T10:00:00+08:00", input_tokens: 150, output_tokens: 0, caller_key_id: "k1" },
  ])).rows;
  assert.equal(periodTrend(rows, 1, "2026-10-31").get("k1"), 0.5);
});

test("periodTrend：7d 对比上一个 7 天窗口", () => {
  const rows = parseCSV(csv([
    // 上一窗口（10-18 ~ 10-24）
    { time: "2026-10-20T10:00:00+08:00", input_tokens: 200, output_tokens: 0, caller_key_id: "k1" },
    // 当前窗口（10-25 ~ 10-31）
    { time: "2026-10-28T10:00:00+08:00", input_tokens: 300, output_tokens: 0, caller_key_id: "k1" },
    // 只有当前窗口有数据的新钥匙 → +100%
    { time: "2026-10-29T10:00:00+08:00", input_tokens: 10, output_tokens: 0, caller_key_id: "k2" },
    // 只有上一窗口有数据的钥匙 → 不出条目
    { time: "2026-10-19T10:00:00+08:00", input_tokens: 10, output_tokens: 0, caller_key_id: "k3" },
  ])).rows;
  const trend = periodTrend(rows, 7, "2026-10-31");
  assert.equal(trend.get("k1"), 0.5);
  assert.equal(trend.get("k2"), 1);
  assert.equal(trend.has("k3"), false);
});

test("periodTrend：窗口外与无时间戳的行不参与", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", input_tokens: 10, caller_key_id: "k1" },
    { time: "", input_tokens: 999, caller_key_id: "k1" },
    { time: "2026-09-01T10:00:00+08:00", input_tokens: 999, caller_key_id: "k1" },
  ])).rows;
  assert.equal(periodTrend(rows, 1, "2026-10-31").get("k1"), 1);
});

test("sessions are unique per caller key", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", session: "a", caller_key_id: "k1" },
    { time: "2026-10-31T11:00:00+08:00", session: "a", caller_key_id: "k1" },
    { time: "2026-10-31T12:00:00+08:00", session: "b", caller_key_id: "k1" },
  ])).rows;
  assert.equal(aggregateRows(rows).byKey.k1.sessions, 2);
});

test("errors come from status >= 400 or error=true", () => {
  const rows = parseCSV(csv([
    { time: "2026-10-31T10:00:00+08:00", status: 200, caller_key_id: "k1" },
    { time: "2026-10-31T11:00:00+08:00", status: 500, caller_key_id: "k1" },
    { time: "2026-10-31T12:00:00+08:00", status: 200, error: true, caller_key_id: "k1" },
  ])).rows;
  assert.equal(aggregateRows(rows).byKey.k1.errors, 2);
});

test("parseCSV survives BOM, plugin-host log lines, and quoted commas", () => {
  const text = [
    "﻿" + COLUMNS.join(","),
    "2026/11/01 10:00:00 [page-project-keys] listening",
    line({ time: "2026-10-31T10:00:00+08:00", caller_key_id: "k,1", caller_key_name: 'project:"a"' }),
  ].join("\n");
  const { header, rows } = parseCSV(text);
  assert.equal(header[0], "time");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caller_key_id, "k,1");
  assert.equal(rows[0].caller_key_name, 'project:"a"');
});

test("parseCSV 保留引号内的换行（error_message 可能多行）", () => {
  const text = [
    "time,error_message,caller_key_id",
    '2026-10-31T10:00:00+08:00,"line one',
    'line two",k1',
    "2026-10-31T11:00:00+08:00,ok,k2",
  ].join("\n");
  const { rows } = parseCSV(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].error_message, "line one\nline two");
  assert.equal(rows[0].caller_key_id, "k1");
  assert.equal(rows[1].caller_key_id, "k2");
});

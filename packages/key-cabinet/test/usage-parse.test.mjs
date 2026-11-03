import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../lib/usage.mjs";

const HEADER =
  "time,agent,requested_model,provider,host,model,served_model,swapped,effort,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,reasoning_tokens,cost_usd,duration_ms,ttft_ms,status,error,session,kind,provider_key_id,provider_key_name,provider_account,route_id,request_id,endpoint,error_message,error_type,source,rejected,session_provider,session_account,session_official_login,caller_key_id,caller_key_name,response_id,upstream,cache_write_5m_tokens,cache_write_1h_tokens,tries,handed_on,tier_asked,tier_sent,tier_served,upstream_stop,credits";

test("CSV 列名映射到 row 字段（含 caller key 列）", () => {
  const values = {
    time: "2026-11-01T10:00:00+08:00",
    agent: "claude",
    input_tokens: "100",
    output_tokens: "4",
    cache_read_tokens: "33280",
    cost_usd: "0.000217",
    status: "200",
    session: "s1",
    caller_key_id: "k-1",
    caller_key_name: "project:dev",
  };
  const row = HEADER.split(",")
    .map((name) => values[name] ?? "")
    .join(",");
  const { header, rows } = parseCSV([HEADER, row].join("\n"));
  assert.equal(header[0], "time");
  assert.ok(header.includes("caller_key_id"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, "100");
  assert.equal(rows[0].output_tokens, "4");
  assert.equal(rows[0].cache_read_tokens, "33280");
  assert.equal(rows[0].caller_key_id, "k-1");
  assert.equal(rows[0].caller_key_name, "project:dev");
});

test("空输出返回空结果，不产生幽灵行", () => {
  assert.deepEqual(parseCSV(""), { header: [], rows: [] });
  assert.deepEqual(parseCSV("\n\n"), { header: [], rows: [] });
});

test("列数不足的行不会抛错", () => {
  const { rows } = parseCSV([HEADER, "2026-11-01T10:00:00+08:00,claude"].join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "claude");
  assert.equal(rows[0].caller_key_id, "");
});

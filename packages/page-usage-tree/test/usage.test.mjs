import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsageCSV, parseCSV, whoOf } from "../lib/usage.mjs";
import { cacheUsable } from "../lib/data.mjs";

const HEADER =
  "time,agent,requested_model,provider,host,model,served_model,swapped,effort,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,reasoning_tokens,cost_usd,duration_ms,ttft_ms,status,error,session,kind,provider_key_id,provider_key_name,provider_account,route_id,request_id,endpoint,error_message,error_type,source,rejected,session_provider,session_account,session_official_login,caller_key_id,caller_key_name,response_id,upstream,cache_write_5m_tokens,cache_write_1h_tokens,tries,handed_on,tier_asked,tier_sent,tier_served,upstream_stop,credits";

const CSV = [
  HEADER,
  "2026-10-31T10:00:00Z,codex,group/a,codex,chatgpt.com as alice@example.com,gpt-a,gpt-a,false,high,100,50,0,1000,5,1.5,10,10,200,false,s1,,,,alice@example.com,1,,,,,false,,,false,,,false,resp1,,0,0,,false,,,,",
  "2026-10-31T10:01:00Z,codex,group/b,codex,chatgpt.com as alice@example.com,gpt-b,gpt-b,false,high,200,80,10,2000,7,0.5,10,10,200,false,s2,,,,alice@example.com,2,,,,,false,,,false,,,false,resp2,,0,0,,false,,,,",
  "2026-10-31T10:02:00Z,codex,group/a,codex,chatgpt.com as bob@example.com,gpt-a,gpt-a,false,high,50,20,0,500,0,2,10,10,200,false,s3,,,,bob@example.com,3,,,,,false,,,false,,,false,resp3,,0,0,,false,,,,",
  "2026-10-31T10:03:00Z,codex,group/a,codex,chatgpt.com as alice@example.com,gpt-a,gpt-a,false,high,999,999,0,0,0,,10,10,500,true,s4,,,,alice@example.com,4,,,,,false,,,false,,,false,resp4,,0,0,,false,,,,",
  "2026-10-31T10:04:00Z,codex,,session-unknown,,group/free-or-cheap,,false,high,999,999,0,0,0,,10,10,200,false,s5,,,,,,,,,false,,,false,,,false,,,false,,,0,0,,false,,,,",
  "2026-10-31T10:05:00Z,codex,,codex,chatgpt.com,probe-model,probe-model,false,high,999,999,0,0,0,,10,10,200,false,s6,,,,,6,,,,,false,,,false,,,false,,,false,,,0,0,,false,,,,",
  "2026-10-31T10:06:00Z,codex,,codex,chatgpt.com as alice@example.com,gpt-c,,false,high,10,5,0,100,0,0.25,10,10,200,false,s7,,,,alice@example.com,7,,,,,false,,,false,,,false,,,false,,,0,0,,false,,,,",
  "2026-10-31T10:07:00Z,codex,,codex,chatgpt.com,gpt-a,gpt-a,false,high,10,5,0,100,0,0.25,10,10,200,false,s8,,,,alice@example.com,8,,,,,false,,,false,,,false,,,false,,,0,0,,false,,,,",
].join("\n");

test("parses quoted CSV fields", () => {
  assert.deepEqual(parseCSV('a,b,c\n1,"two, words","say ""hi"""\n'), [
    ["a", "b", "c"],
    ["1", "two, words", 'say "hi"'],
  ]);
});

test("reads the account a call went out as", () => {
  assert.equal(whoOf("chatgpt.com as alice@example.com"), "alice@example.com");
  assert.equal(whoOf("chatgpt.com"), "chatgpt.com");
});

test("groups accounts before models, the way magpie groups its own tables", () => {
  const data = aggregateUsageCSV(CSV, { period: "7d" });

  assert.equal(data.summary.accounts, 3);
  assert.equal(data.summary.calls, 7);
  assert.equal(data.summary.errors, 1);
  assert.equal(data.summary.input, 2368);
  assert.equal(data.summary.output, 2158);
  assert.equal(data.summary.tokens, 4526);
  assert.equal(data.summary.cache, 3710);
  assert.equal(data.summary.cost, 4.5);
  assert.equal(data.summary.unpriced, 2);

  const alice = data.accounts.find((account) => account.account === "alice@example.com");
  assert.equal(alice.calls, 5);
  assert.equal(alice.models.length, 3);
  assert.deepEqual(
    alice.models.map((model) => model.model).sort(),
    ["gpt-a", "gpt-b", "gpt-c"],
  );
  // One model stays one row, even when an old record named only the host.
  const gptA = alice.models.find((model) => model.model === "gpt-a");
  assert.equal(gptA.calls, 3);
  assert.deepEqual(gptA.hostNotes, [{ account: "chatgpt.com", calls: 1 }]);

  // A call whose host names no account is its own account.
  const probe = data.accounts.find((account) => account.account === "chatgpt.com");
  assert.ok(probe);
  assert.equal(probe.calls, 1);

  // The local session record is not a call of an account.
  assert.equal(
    data.accounts.some((account) => account.account.includes("未记录")),
    false,
  );
});

test("shows the name the user gave an account", () => {
  const data = aggregateUsageCSV(CSV, {
    period: "7d",
    accountNames: { codex: { "alice@example.com": "10月越南Plus" } },
  });
  const alice = data.accounts.find((account) => account.account === "alice@example.com");
  assert.equal(alice.alias, "10月越南Plus");
});

test("a read from before the three-level shape is not served as current", () => {
  // An older build wrote accounts and models but no providers. Serving that
  // as current made the page say there was no usage at all.
  assert.equal(cacheUsable({ summary: {}, accounts: [{ id: "a" }] }), false);
  assert.equal(cacheUsable({ summary: {}, providers: [], accounts: [] }), true);
  assert.equal(cacheUsable(null), false);
});

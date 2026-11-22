// The relay's OpenAI face: history flattening, thinking normalization,
// the turn's aggregation (text and reasoning split), the SSE shape, the
// per-turn metadata with the server's model fingerprint and wall-clock,
// and the errors (tools refused, usage_limit, auth).
import { expect, test } from "bun:test"
import { flatten, collectTurn, openaiChunk, usageMeta, userPayload } from "../lib/relay.mjs"
import { modelsOf, modeOf, effortOf, THINKING } from "../lib/models.mjs"
import { usageOf } from "../lib/usage.mjs"
import { parseCookie, parseAccounts, poolOf } from "../lib/session.mjs"

test("history flattens into one text, systems first, tool calls inlined", () => {
  const text = flatten([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "42" },
    { role: "user", content: [{ type: "text", text: "now what?" }] },
  ])
  expect(text).toContain("[System]\nbe brief")
  expect(text).toContain("hi")
  expect(text).toContain("[Tool call f] {}")
  expect(text).toContain("[Tool result for c1]\n42")
  expect(text).toContain("now what?")
  expect(text.indexOf("be brief")).toBeLessThan(text.indexOf("hi"))
})

test("thinking normalizes to the protocol's enum", () => {
  expect(effortOf(undefined)).toBe("off")
  expect(effortOf(false)).toBe("off")
  expect(effortOf(true)).toBe("high")
  expect(effortOf("HIGH")).toBe("high")
  expect(effortOf("max")).toBe("max")
  expect(effortOf("nope")).toBe(null)
  expect(THINKING).toEqual(["off", "low", "medium", "high", "max"])
})

test("the user payload carries the tier and the explicit thinking", () => {
  const p = userPayload({ text: "hi", model: "quick-smart", thinking: "high", threadId: "t1" })
  expect(p.agent_mode).toBe("smart")
  expect(p.thinking_effort).toBe("high")
  expect(p.thread_id).toBe("t1")
  expect(p.auto_routing).toBe(false)
  expect(modeOf("quick-fast")).toBe("fast")
  expect(modeOf("unknown-model")).toBe("balanced")
})

test("models are the three tiers with all thinking variants", () => {
  const m = modelsOf()
  expect(Object.keys(m)).toEqual(["quick-fast", "quick-balanced", "quick-smart"])
  for (const k of Object.keys(m)) {
    expect(Object.keys(m[k].variants)).toEqual(["off", "low", "medium", "high", "max"])
    expect(m[k].limit.context).toBe(1_000_000)
    expect(m[k].tool_call).toBe(false)
  }
})

test("a turn's events aggregate into text, reasoning and usage", () => {
  const { content, reasoning, usage } = collectTurn([
    { type: "message_start", role: "assistant" },
    { type: "text_delta", delta: "Hel" },
    { type: "thinking_delta", delta: "thinking…" },
    { type: "text_delta", delta: "lo" },
    {
      type: "turn_usage",
      input_tokens: 4,
      output_tokens: 16,
      total_tokens: 69352,
      model: "smart",
      resolved_model_id: "us.anthropic.claude-opus-5-5",
      served_model_id: "us.anthropic.claude-opus-5-5",
      cost_usd: 0.023,
      context_window: 1_000_000,
    },
    { type: "message_complete", text: "Hello" },
  ])
  expect(content).toBe("Hello")
  expect(reasoning).toBe("thinking…")
  expect(usage.resolved_model_id).toBe("us.anthropic.claude-opus-5-5")
})

test("usage metadata names the fingerprint and the wall-clock", () => {
  const meta = usageMeta({ model: "smart", resolved_model_id: "xu.x", served_model_id: "xu.x", cost_usd: 0.01, input_tokens: 4, output_tokens: 16 }, Date.now() - 5000)
  expect(meta["quick.resolved_model_id"]).toBe("xu.x")
  expect(meta["quick.cost_usd"]).toBe(0.01)
  expect(meta["quick.turn_seconds"]).toBeGreaterThan(4)
})

test("the account's pools read out of the usage reply", () => {
  const u = usageOf({ session: { used: 0, limit: 100 }, monthly: { used: 2, limit: 600 }, subscription: { name: "QUICK_LITE_FREE_TRIAL", expiresAt: "2026-12-22" } })
  expect(u.windows).toEqual([
    { name: "session", label: "session", used: 0, limit: 100, percent: 0 },
    { name: "monthly", label: "monthly", used: 2, limit: 600, percent: (2 / 600) * 100 },
  ])
  expect(u.subscription.expiresAt).toBe("2026-12-22")
  expect(u.note).toBe("600 minutes/month (agent hours)")
})

test("the live /profile/usage shape parses: epoch resets, trial expiry, resume wait", () => {
  // the exact fields the probe returned on 2026-11-21 (values from the recon)
  const u = usageOf({
    session: { used: 0, limit: 100, label: "Session usage", percent: 0, resets_at: null, resume_in_minutes: 0 },
    monthly: { used: 2, limit: 600, label: "Monthly usage", percent: 0, ceiling_percent: 0, resets_at: 1796083200, resume_in_minutes: null },
    overage_monthly: null,
    subscription: { subscription_type: "QUICK_LITE_FREE_TRIAL", free_trial_metadata: { status: "ACTIVE", expiry_date: 1797875568 } },
  })
  expect(u.subscription).toEqual({ name: "QUICK_LITE_FREE_TRIAL", status: "ACTIVE", expiresAt: new Date(1797875568 * 1000).toISOString() })
  expect(u.windows[1].resetsAt).toBe(new Date(1796083200 * 1000).toISOString())
  expect(u.windows[0]).not.toHaveProperty("resetsAt") // a null reset is dropped
  expect(u.windows[0]).not.toHaveProperty("resumeInMinutes") // 0 means no wait
  expect(u.windows[0].label).toBe("Session usage")
  expect(u.note).toBe("600 minutes/month (agent hours)")
})

test("a pasted Cookie header parses; a JSON account too", () => {
  const c = parseCookie("mbtc=abc; other=1\nGET /sn/account/12345/start/chat?mbtc=abc")
  expect(c.cookie).toBe("mbtc=abc; other=1")
  expect(c.accountId).toBe("12345")
  const j = parseCookie('{"cookie":"a=1","accountId":"42","mbtc":"m"}')
  expect(j).toEqual({ cookie: "a=1", accountId: "42", mbtc: "m" })
  expect(parseCookie("nonsense")).toBe(null)
})

test("a paste of several accounts parses into a pool", () => {
  expect(parseAccounts("mbtc=a; x=1 account/111\nmbtc=b; x=2 account/222").map((a) => a.accountId)).toEqual(["111", "222"])
  // one Cookie header followed by its URL stays ONE account (the URL names its id)
  const one = parseAccounts("mbtc=z; k=v\nhttps://quick.aws.com/sn/account/999/start/chat?mbtc=z")
  expect(one).toHaveLength(1)
  expect(one[0].accountId).toBe("999")
  expect(one[0].mbtc).toBe("z")
  // a JSON array of accounts; duplicate ids keep the first
  const arr = parseAccounts(JSON.stringify([
    { cookie: "a=1", accountId: "111", mbtc: "m1" },
    { cookie: "a=2", accountId: "111", mbtc: "m1" },
    { cookie: "a=3", accountId: "222", mbtc: "m2" },
  ]))
  expect(arr.map((a) => a.accountId)).toEqual(["111", "222"])
  // JSON Lines, one account per line
  const jl = parseAccounts('{"cookie":"a=1","accountId":"111","mbtc":"m1"}\n{"cookie":"a=2","accountId":"222","mbtc":"m2"}')
  expect(jl.map((a) => a.accountId)).toEqual(["111", "222"])
  expect(parseAccounts("")).toEqual([])
  expect(parseAccounts("nonsense")).toEqual([])
})

test("poolOf reads the pool back, falling back to the single account", () => {
  const single = { accountId: "999", access: "z", refresh: "c=1", metadata: { cookie: "c=1", mbtc: "z" } }
  expect(poolOf(single).map((a) => a.accountId)).toEqual(["999"])
  const pool = {
    accountId: "111",
    access: "m1",
    refresh: "a=1",
    metadata: {
      cookie: "a=1",
      mbtc: "m1",
      accounts: [
        { cookie: "a=1", accountId: "111", mbtc: "m1" },
        { cookie: "a=3", accountId: "222", mbtc: "m2" },
        { cookie: "bad" }, // dropped: no id/mbtc
      ],
    },
  }
  expect(poolOf(pool).map((a) => a.accountId)).toEqual(["111", "222"])
})

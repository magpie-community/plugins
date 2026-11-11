// Usage as the built-in read it (google_test.go's TestAntigravityQuota*):
// each model's window from fetchAvailableModels, and the pools a group
// of models shares from retrieveUserQuotaSummary.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { AntigravityAuthPlugin, _internal } from "./index.mjs"
import { auth, fake, real, reset } from "./fake.mjs"

beforeEach(reset)
afterEach(() => (globalThis.fetch = real))

async function read(models, summary) {
  _internal.lists.clear()
  fake({ fetchAvailableModels: models, retrieveUserQuotaSummary: summary ?? (() => new Response("no", { status: 500 })) })
  const p = await AntigravityAuthPlugin({})
  return p.auth.usage(async () => auth())
}
const of = (ws) => Object.fromEntries(ws.filter((w) => w.model).map((w) => [w.model, w.pool ?? ""]))
const poolWindows = (ws) => ws.filter((w) => !w.model).map((w) => `${w.pool}|${w.name}`)
const at = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z")
const H = 3600_000

test("each model's window, with its family", async () => {
  const u = await read(JSON.parse(`{"models":{
    "gemini-3.1-pro-high":{"displayName":"Gemini 3.1 Pro (High)","quotaInfo":{"remainingFraction":0.4,"resetTime":"2099-01-01T00:00:00Z"}},
    "gemini-3.1-pro-low":{"displayName":"Gemini 3.1 Pro (Low)","quotaInfo":{"remainingFraction":1}},
    "gemini-3.7-flash-medium":{"displayName":"Gemini 3.7 Flash (Medium)","quotaInfo":{}},
    "claude-opus-4-6-thinking":{"displayName":"Claude Opus 4.6 (Thinking)","quotaInfo":{"remainingFraction":0.75}},
    "claude-sonnet-4-6":{"quotaInfo":{"remainingFraction":0.9}},
    "gpt-oss-120b-medium":{"displayName":"GPT-OSS 120B (Medium)","quotaInfo":{"remainingFraction":1}},
    "tab_flash_lite_preview":{"quotaInfo":{"remainingFraction":1}}}}`))
  expect(u.signIn).toBe("kept")
  expect(u.windows.map((w) => `${w.model}|${w.name}|${w.family}|${Math.round(w.used)}`)).toEqual([
    "claude-opus-4-6-thinking|Claude Opus 4.6 (Thinking)|Claude|25",
    "claude-sonnet-4-6|claude-sonnet-4-6|Claude|10",
    "gemini-3.1-pro-high|Gemini 3.1 Pro (High)|Gemini|60",
    "gemini-3.1-pro-low|Gemini 3.1 Pro (Low)|Gemini|0",
    "gemini-3.7-flash-medium|Gemini 3.7 Flash (Medium)|Gemini|100",
    "gpt-oss-120b-medium|GPT-OSS 120B (Medium)|GPT-OSS|0",
  ])
  // a level's window names the model magpie offers too
  expect(u.windows[2].models).toEqual(["gemini-3.1-pro-high", "gemini-3.1-pro"])
  expect(u.windows[0].models).toEqual(["claude-opus-4-6-thinking"])
  expect(u.windows[2].resetsAt).toBe("2099-01-01T00:00:00Z")
  const { vendorOf } = _internal
  expect([vendorOf("gemini-3-flash"), vendorOf("claude-x", "Other"), vendorOf("kimi-k2", "Kimi K2"), vendorOf("glm-5")]).toEqual(["Gemini", "Claude", "Kimi", "glm"])
})

test("the pools a group shares, each model in its own", async () => {
  const models = JSON.parse(`{"models":{
    "gemini-3.1-pro-high":{"displayName":"Gemini 3.1 Pro (High)","quotaInfo":{"remainingFraction":0.9545545,"resetTime":"2099-01-01T05:00:00Z"}},
    "gemini-3-flash":{"displayName":"Gemini 3 Flash","quotaInfo":{"remainingFraction":0.9545545,"resetTime":"2099-01-01T05:00:00Z"}},
    "claude-opus-4-6-thinking":{"displayName":"Claude Opus 4.6 (Thinking)","quotaInfo":{"remainingFraction":0.7}},
    "gpt-oss-120b-medium":{"displayName":"GPT-OSS 120B (Medium)","quotaInfo":{"remainingFraction":0.7}}}}`)
  const u = await read(models, JSON.parse(`{"groups":[
    {"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
      {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.75,"resetTime":"2099-01-07T00:00:00Z","displayName":"Weekly Limit"},
      {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.9545545,"resetTime":"2099-01-01T05:00:00Z","displayName":"Five Hour Limit"}]},
    {"displayName":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[
      {"bucketId":"3p-weekly","window":"weekly","resetTime":"2099-01-06T00:00:00Z"},
      {"bucketId":"3p-5h","window":"5h","remainingFraction":0.7,"resetTime":"2099-01-01T03:00:00Z"},
      {"bucketId":"3p-x","window":"5h","remainingFraction":1,"disabled":true}]}]}`))
  expect(u.windows.map((w) => `${w.model ?? ""}|${w.name}|${w.family ?? ""}|${w.pool ?? ""}|${Math.round(w.used)}|${(w.resetsAt ?? "").slice(5, 13)}|${!!w.aside}`)).toEqual([
    "claude-opus-4-6-thinking|Claude Opus 4.6 (Thinking)|Claude|Claude & GPT|30||false",
    "gemini-3-flash|Gemini 3 Flash|Gemini|Gemini|5|01-01T05|false",
    "gemini-3.1-pro-high|Gemini 3.1 Pro (High)|Gemini|Gemini|5|01-01T05|false",
    "gpt-oss-120b-medium|GPT-OSS 120B (Medium)|GPT-OSS|Claude & GPT|30||false",
    "|7 days||Gemini|25|01-07T00|true",
    "|5 hours||Gemini|5|01-01T05|true",
    "|7 days||Claude & GPT|100|01-06T00|true", // none left: no fraction
    "|5 hours||Claude & GPT|30|01-01T03|true",
  ])
  expect(u.windows[4].span).toBe(7 * 24 * 3600)
  expect(u.windows[5].span).toBe(5 * 3600)

  // no summary: the models' windows alone
  const none = await read(models)
  expect(none.windows.length).toBe(4)
  expect(none.windows.every((w) => !w.pool)).toBe(true)

  // a group's week without its 5 hours: its models stay out of it
  const week = await read(models, JSON.parse(`{"groups":[
    {"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
      {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.75,"resetTime":"2099-01-07T00:00:00Z"},
      {"bucketId":"gemini-5h","window":"5h","remainingFraction":1,"disabled":true}]}]}`))
  expect(of(week.windows)).toEqual({ "claude-opus-4-6-thinking": "", "gemini-3-flash": "", "gemini-3.1-pro-high": "", "gpt-oss-120b-medium": "" })
  expect(poolWindows(week.windows)).toEqual(["Gemini|7 days"])
})

test("a model with a group of its own is in it, and that group takes no other", async () => {
  const argon = (five) =>
    `{"displayName":"Gemini 4 Argon","description":"For paid Pro plans, Argon quota is separate.","buckets":[{"bucketId":"gemini-argon-wtu-weekly","window":"weekly","remainingFraction":0.53,"resetTime":"2099-01-07T00:00:00Z","displayName":"Gemini 4 Argon Weekly Limit"}` +
    (five ? `,{"bucketId":"gemini-argon-5h","window":"5h","remainingFraction":0.8,"resetTime":"2099-01-01T04:00:00Z"}` : "") +
    `]}`
  const gemini = `{"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
    {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.99,"resetTime":"2099-01-07T00:00:00Z"},
    {"bucketId":"gemini-5h","window":"5h","remainingFraction":1,"resetTime":"2099-01-01T05:00:00Z"}]}`
  const claude = `{"displayName":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[
    {"bucketId":"3p-weekly","window":"weekly","remainingFraction":0.6,"resetTime":"2099-01-06T00:00:00Z"},
    {"bucketId":"3p-5h","window":"5h","remainingFraction":0.7,"resetTime":"2099-01-01T03:00:00Z"}]}`
  const models = JSON.parse(`{"models":{
    "gemini-3-flash":{"displayName":"Gemini 3 Flash","quotaInfo":{"remainingFraction":1,"resetTime":"2099-01-01T05:00:00Z"}},
    "gemini-4-argon":{"displayName":"Gemini 4 Argon","quotaInfo":{"remainingFraction":0.53,"resetTime":"2099-01-07T00:00:00Z"}},
    "claude-sonnet-4-6":{"displayName":"Claude Sonnet 4.6","quotaInfo":{"remainingFraction":0.7}}}}`)
  for (const [name, groups, pools] of [
    ["as agy has it", [gemini, claude, argon(false)], ["Gemini|7 days", "Gemini|5 hours", "Claude & GPT|7 days", "Claude & GPT|5 hours", "Gemini 4 Argon|7 days"]],
    ["Argon first", [argon(false), gemini, claude], ["Gemini 4 Argon|7 days", "Gemini|7 days", "Gemini|5 hours", "Claude & GPT|7 days", "Claude & GPT|5 hours"]],
    ["Argon first with 5 hours", [argon(true), gemini, claude], ["Gemini 4 Argon|7 days", "Gemini 4 Argon|5 hours", "Gemini|7 days", "Gemini|5 hours", "Claude & GPT|7 days", "Claude & GPT|5 hours"]],
  ]) {
    const u = await read(models, JSON.parse(`{"groups":[${groups.join(",")}]}`))
    expect([name, of(u.windows)]).toEqual([name, { "gemini-3-flash": "Gemini", "gemini-4-argon": "Gemini 4 Argon", "claude-sonnet-4-6": "Claude & GPT" }])
    expect([name, poolWindows(u.windows)]).toEqual([name, pools])
  }
})

test("a model read apart from its group is a pool of its own; one read alike folds", async () => {
  const five = at(3 * H)
  const week = at(6 * 24 * H)
  const gemini = `{"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
    {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.98,"resetTime":"${week}"},
    {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.92,"resetTime":"${five}"}]}`
  const claude = `{"displayName":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[
    {"bucketId":"3p-weekly","window":"weekly","resetTime":"${week}"},
    {"bucketId":"3p-5h","window":"5h","resetTime":"${five}"}]}`
  const argonGroup = `{"displayName":"Gemini 4 Argon","description":"For paid Pro plans, Argon quota is separate.","buckets":[
    {"bucketId":"gemini-argon-wtu-weekly","window":"weekly","remainingFraction":0.53,"resetTime":"${week}","displayName":"Gemini 4 Argon Weekly Limit"}]}`
  const models = (argon) =>
    JSON.parse(`{"models":{
    "gemini-3-flash":{"displayName":"Gemini 3 Flash","quotaInfo":{"remainingFraction":0.92,"resetTime":"${five}"}},
    "gemini-3.1-pro-high":{"displayName":"Gemini 3.1 Pro (High)","quotaInfo":{"remainingFraction":0.92,"resetTime":"${five}"}},
    "gemini-4-argon-high":{"displayName":"Gemini 4 Argon (High)","quotaInfo":${argon}},
    "gemini-4-argon-low":{"displayName":"Gemini 4 Argon (Low)","quotaInfo":${argon}},
    "claude-sonnet-4-6":{"displayName":"Claude Sonnet 4.6","quotaInfo":{"resetTime":"${five}"}}}}`)
  const apart = `{"remainingFraction":0.53,"resetTime":"${week}"}`
  const alike = `{"remainingFraction":0.92,"resetTime":"${five}"}`
  const argonPool = { "gemini-3-flash": "Gemini", "gemini-3.1-pro-high": "Gemini", "gemini-4-argon-high": "Gemini 4 Argon", "gemini-4-argon-low": "Gemini 4 Argon", "claude-sonnet-4-6": "Claude & GPT" }
  const folded = { ...argonPool, "gemini-4-argon-high": "Gemini", "gemini-4-argon-low": "Gemini" }
  const base = ["Gemini|7 days", "Gemini|5 hours", "Claude & GPT|7 days", "Claude & GPT|5 hours"]
  for (const [name, groups, argon, pools, windows] of [
    ["no Argon group, read apart (runking)", [gemini, claude], apart, argonPool, [...base, "Gemini 4 Argon|7 days"]],
    ["no Argon group, read alike", [gemini, claude], alike, folded, base],
    ["the Argon group", [gemini, claude, argonGroup], apart, argonPool, [...base, "Gemini 4 Argon|7 days"]],
  ]) {
    const u = await read(models(argon), JSON.parse(`{"groups":[${groups.join(",")}]}`))
    expect([name, of(u.windows)]).toEqual([name, pools])
    expect([name, poolWindows(u.windows)]).toEqual([name, windows])
    for (const w of u.windows) {
      if (w.pool === "Gemini 4 Argon" && !w.model) {
        expect(w.used).toBeGreaterThan(46)
        expect(w.used).toBeLessThan(48)
        expect(w.aside).toBe(true)
      }
    }
  }
})

test("models read as their group's week draw on the group", async () => {
  const five = at(5 * H)
  const week = at(5 * 24 * H)
  const wk = `{"remainingFraction":0.01,"resetTime":"${week}"}`
  const u = await read(
    JSON.parse(`{"models":{
    "gemini-3-flash":{"displayName":"Gemini 3 Flash","quotaInfo":${wk}},
    "gemini-3.1-pro-high":{"displayName":"Gemini 3.1 Pro (High)","quotaInfo":${wk}},
    "gemini-3.1-pro-low":{"displayName":"Gemini 3.1 Pro (Low)","quotaInfo":${wk}},
    "gemini-3.5-flash":{"displayName":"Gemini 3.5 Flash","quotaInfo":${wk}},
    "gemini-3.1-flash-lite":{"displayName":"Gemini 3.1 Flash Lite","quotaInfo":${wk}},
    "claude-sonnet-4-6":{"displayName":"Claude Sonnet 4.6","quotaInfo":{"resetTime":"${week}"}},
    "claude-opus-4-6-thinking":{"displayName":"Claude Opus 4.6 (Thinking)","quotaInfo":{"resetTime":"${week}"}}}}`),
    JSON.parse(`{"groups":[
    {"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
      {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.01,"resetTime":"${week}"},
      {"bucketId":"gemini-5h","window":"5h","remainingFraction":1,"resetTime":"${five}"}]},
    {"displayName":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[
      {"bucketId":"3p-weekly","window":"weekly","resetTime":"${week}"},
      {"bucketId":"3p-5h","window":"5h","resetTime":"${five}"}]}]}`),
  )
  for (const w of u.windows.filter((w) => w.model)) expect([w.model, w.pool]).toEqual([w.model, w.family === "Claude" ? "Claude & GPT" : "Gemini"])
  expect(poolWindows(u.windows)).toEqual(["Gemini|7 days", "Gemini|5 hours", "Claude & GPT|7 days", "Claude & GPT|5 hours"])
  // a model read as the week is a week's window
  expect(u.windows.find((w) => w.model === "gemini-3-flash").span).toBe(7 * 24 * 3600)
})

test("a refresh Google refuses is a sign-in to do again", async () => {
  fake({ token: () => new Response('{"error":"invalid_grant"}', { status: 400 }) })
  const p = await AntigravityAuthPlugin({})
  const u = await p.auth.usage(async () => ({ ...auth(), expires: 0 }))
  expect(u.signIn).toBe("expired")
})

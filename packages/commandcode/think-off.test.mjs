// CHENJIAMIAN (magpie-community/plugins#334): Command Code's Provider API
// turns a DeepSeek model's thinking off at reasoning_effort "off", its own
// word: "none" is refused ('Invalid option: expected one of
// "off"|"low"|"medium"|"high"|"xhigh"|"max"'), and so is "off" for a model
// that can't turn it off (deepseek/deepseek-v4-flash-fast, Kimi K3:
// 'does not support reasoning_effort "off"'), as measured on a GOAT key on
// 2026-10-23. So the five models that took it offer magpie's off level,
// none, and are sent "off" for it; any other is sent no level for it, and
// Go's /alpha/generate, not measured, is sent none either.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
})

const OFF = [
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-fast",
]
const ON = ["deepseek/deepseek-v4-flash-fast", "moonshotai/Kimi-K3"]

const LIST = readFileSync(join(import.meta.dir, "testdata", "models-2026-10-13.json"), "utf8")
const GOAT_SUB = readFileSync(join(import.meta.dir, "testdata", "subscriptions-goat.json"), "utf8")
const CREDITS = readFileSync(join(import.meta.dir, "testdata", "credits-goat.json"), "utf8")

// chat sends a chat completion for model at effort through a GOAT
// account's fetch, as the AI SDK hands it, and gives the body the
// Provider API was sent
async function chat(model, effort) {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname
    if (path.endsWith("/chat/completions")) {
      sent.push({ method: init.method, body: JSON.parse(init.body), auth: new Headers(init.headers).get("x-api-key") })
      return Response.json({ choices: [] })
    }
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan: "GOAT" } }))
  const body = { model, stream: false, messages: [{ role: "user", content: "1+1=?" }] }
  if (effort !== undefined) body.reasoning_effort = effort
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  expect(sent.length).toBe(1)
  expect(sent[0].method).toBe("POST")
  expect(sent[0].auth).toBe("k")
  expect(sent[0].body.messages).toEqual(body.messages)
  return sent[0].body
}

test("off (magpie's none, or a client's \"off\") goes to the Provider API as \"off\" for each model that takes it", async () => {
  for (const model of OFF) {
    expect((await chat(model, "none")).reasoning_effort).toBe("off")
    expect((await chat(model, "off")).reasoning_effort).toBe("off")
  }
})

test("off is sent as no level to a model that refuses \"off\"", async () => {
  for (const model of ON) {
    for (const e of ["none", "off"]) {
      const b = await chat(model, e)
      expect("reasoning_effort" in b).toBe(false)
    }
  }
})

test("any other level, or none asked, goes as it came", async () => {
  expect((await chat("deepseek/deepseek-v4.1-flash", "low")).reasoning_effort).toBe("low")
  expect((await chat("deepseek/deepseek-v4-flash-fast", "max")).reasoning_effort).toBe("max")
  expect("reasoning_effort" in (await chat("deepseek/deepseek-v4.1-flash"))).toBe(false)
})

test("the Provider API's list offers the off level for those models alone", async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return new Response(GOAT_SUB)
    if (path === "/alpha/billing/credits") return new Response(CREDITS)
    if (path === "/provider/v1/models") return new Response(LIST)
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const ms = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "goat", metadata: { plan: "GOAT" } } })
  for (const id of OFF) {
    expect(ms[id]).toBeDefined()
    expect(Object.keys(ms[id].variants)).toEqual(["none", "low", "high", "max"])
    expect(ms[id].variants.none).toEqual({ reasoningEffort: "none" })
    expect(ms[id].capabilities.reasoning).toBe(true)
  }
  for (const [id, m] of Object.entries(ms)) if (!OFF.includes(id)) expect(Object.keys(m.variants)).not.toContain("none")
  for (const id of ON) expect(ms[id]).toBeDefined()
})

test("the default list, standing in for the Provider API's, offers it too", async () => {
  const cfg = {}
  const hooks = await CommandCodePlugin()
  await hooks.config(cfg)
  const ms = cfg.provider["commandcode-plan"].models
  expect(Object.keys(ms["deepseek/deepseek-v4-pro"].variants)).toEqual(["none", "low", "high", "max"])
  expect(Object.keys(ms["deepseek/deepseek-v4-flash"].variants)).toEqual(["none", "low", "high", "max"])
  expect(ms["moonshotai/Kimi-K3"].variants).toBeUndefined()
})

test("Go's /alpha/generate, not known to take \"off\", is sent no level for off, and Go's levels have none", async () => {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname
    if (path === "/alpha/generate") {
      sent.push(JSON.parse(init.body).params)
      return new Response(JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } }) + "\n")
    }
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "go", metadata: { plan: "Go" } }))
  for (const e of ["none", "off", "high"]) {
    await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", stream: false, reasoning_effort: e, messages: [{ role: "user", content: "hi" }] }),
    })
  }
  expect(sent.map((p) => p.reasoning_effort)).toEqual([undefined, undefined, "high"])
  for (const m of _internal.GO_MODELS) expect(m.efforts ?? []).not.toContain("none")
})

// A Go account lists every model Command Code lets Go use, not ten, as
// magpie's built-in does (internal/provider/commandcode_plan.go, cmdGoFetch;
// commandcode_go_models_test.go, TestCommandCodeGoModels): the Provider
// API's list, asked without the key, less the models Go is refused; the
// CLI's table when the list can't be had. testdata/models.json is that list
// as api.commandcode.ai answered it (2026-10-01, 86 models), the built-in
// test's testdata/commandcode_models.json.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

// talking leaves out the decision model (Jev, jev.test.mjs), which every
// plan's list has beside the models it talks to
const talking = (ms) => {
  delete ms[_internal.JEV]
  return ms
}

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

const list = readFileSync(join(import.meta.dir, "testdata", "models.json"), "utf8")
const go = { type: "api", key: "go-key", metadata: { plan: "Go" } }

// models asks the provider.models hook for a Go account's list, the list
// answered with reply (a body, or a status)
async function models(reply) {
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    const h = new Headers(init.headers)
    if (path === "/alpha/billing/subscriptions") return Response.json({ success: true, data: { planId: "individual-go-monthly", status: "active" } })
    if (path === "/provider/v1/models") {
      asked.push({ auth: h.get("Authorization"), key: h.get("x-api-key") })
      return typeof reply === "number" ? new Response("", { status: reply }) : new Response(reply, { status: 200 })
    }
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const ms = talking(await hooks.provider.models({ models: {} }, { auth: go }))
  return { ms, asked }
}

test("Go lists Command Code's models less those Go is refused, asked without the key", async () => {
  const { ms, asked } = await models(list)
  expect(asked).toEqual([{ auth: null, key: null }])
  const got = Object.keys(ms)
  expect(got.length).toBe(56)
  for (const id of ["gpt-6-luna", "deepseek/deepseek-v4.1-flash", "moonshotai/Kimi-K2.6", "zai-org/GLM-5.2", "Qwen/Qwen3.7-Max", "stepfun/Step-5-Preview", "tencent/hy4-preview", "google/gemini-3.6-flash", "xai/grok-4.5"])
    expect(got).toContain(id)
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-sol", "gpt-5.6-sol", "xai/grok-4.7", "google/gemini-3.8-flash", "xiaomi/mimo-v2.6-pro-ultraspeed"])
    expect(got).not.toContain(id)
  // the list's order, and the table's names, reasoning levels and pictures
  expect(got[0]).toBe("gpt-6-luna")
  const k3 = ms["moonshotai/Kimi-K3"]
  expect(k3.name).toBe("Kimi K3")
  expect(Object.keys(k3.variants)).toEqual(["low", "high", "max"])
  expect(k3.capabilities.attachment).toBe(true)
  expect(k3.limit.context).toBe(1_000_000)
  expect(ms[Symbol.for("magpie.fellBack")]).toBeUndefined()
  // every Go model on chat completions, which the fetch sends to /alpha/generate
  expect(new Set(Object.values(ms).map((m) => m.api.npm))).toEqual(new Set(["@ai-sdk/openai-compatible"]))
})

test("the CLI's table stands in when the list can't be had, and offers nothing Go is refused", async () => {
  expect(_internal.GO_MODELS.length).toBe(57)
  for (const m of _internal.GO_MODELS) expect(_internal.GO_REFUSED.has(m.id)).toBe(false)
  for (const reply of [500, "not json", JSON.stringify({ data: [] }), JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "gpt-6-sol" }] })]) {
    const { ms } = await models(reply)
    expect(Object.keys(ms)).toEqual(_internal.GO_MODELS.map((m) => m.id))
    expect(ms[Symbol.for("magpie.fellBack")]).toBe(true)
  }
})

test("the list's failures read as the built-in's", async () => {
  const url = "https://api.commandcode.ai/provider/v1/models"
  const fail = async (res) => {
    globalThis.fetch = async () => res
    return (await _internal.goModels().then(() => null, (e) => e)).message
  }
  expect(await fail(new Response('{"error":{"message":"down"}}', { status: 503 }))).toBe(`${url}: 503 Service Unavailable (down)`)
  expect(await fail(new Response("", { status: 500 }))).toBe(`${url}: 500 Internal Server Error`)
  expect(await fail(new Response("<html>", { status: 200 }))).toBe(`${url}: not a model list`)
  expect(await fail(Response.json({ data: [] }))).toBe(`${url}: no models listed`)
  expect(await fail(Response.json({ data: [{ id: "claude-opus-5-5" }, { id: "gpt-6-sol" }] }))).toBe("Command Code listed no models for the Go plan")
})

// Command Code's list says nothing of pictures, and magpie's plugin host
// takes a model whose capabilities.input.image is a boolean as the plugin's
// answer, over models.dev's (internal/plugin/host.js, imageSaid): a false
// said for every model left each one of a moved plan without image input
// (ARNO on magpie 0.1.810). A model the plugin knows takes pictures says
// so; of one it doesn't know, nothing is said, and magpie answers from
// models.dev as the built-in does.
test("a model says it takes pictures when known, and nothing when not", async () => {
  const pro = { type: "api", key: "max-key", metadata: { plan: "Max" } }
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json({ success: true, data: { planId: "individual-max-monthly", status: "active" } })
    if (path === "/provider/v1/models") return new Response(list, { status: 200 })
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const ms = talking(await hooks.provider.models({ models: {} }, { auth: pro }))
  expect(Object.keys(ms).length).toBe(86)
  const said = (id) => ms[id].capabilities.input.image
  // Claude, the default list's and the CLI's table's
  for (const id of ["claude-opus-5-5", "claude-haiku-4-5-20251001", "gpt-6-sol", "gpt-6-luna", "moonshotai/Kimi-K3", "Qwen/Qwen3.8-Flash", "stealth/pixel-canary", "MiniMaxAI/MiniMax-M3"]) {
    expect(said(id)).toBe(true)
    expect(ms[id].capabilities.attachment).toBe(true)
  }
  // text alone, or not known: not said either way
  for (const id of ["deepseek/deepseek-v4-pro", "zai-org/GLM-5.3", "MiniMaxAI/MiniMax-M2.7", "tencent/hy4-preview"]) {
    expect(said(id)).toBeUndefined()
    expect("image" in ms[id].capabilities.input).toBe(false)
  }
  for (const m of Object.values(ms)) expect(said(m.id) === true || said(m.id) === undefined).toBe(true)

  // a list that says, is taken at its word
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json({ success: true, data: { planId: "individual-max-monthly", status: "active" } })
    return Response.json({ data: [{ id: "claude-opus-5-5", modalities: { input: ["text"] } }, { id: "x/seer", modalities: { input: ["text", "image"] } }] })
  }
  _internal.subsSeen.clear()
  const said2 = await (await CommandCodePlugin()).provider.models({ models: {} }, { auth: { ...pro, key: "max-key-2" } })
  expect(said2["claude-opus-5-5"].capabilities.input.image).toBe(false)
  expect(said2["x/seer"].capabilities.input.image).toBe(true)

  // Go: the table's pictures, nothing said of the rest
  const { ms: g } = await models(list)
  expect(g["moonshotai/Kimi-K3"].capabilities.input.image).toBe(true)
  expect(g["zai-org/GLM-5.2"].capabilities.input).not.toHaveProperty("image")
})

// An enterprise model and a Trae preset of one config_name (plugins#1605,
// shex816, a Trae CN enterprise seat): batch_get_detail_param lists
// kimi-k3.1-pro twice, as Trae's preset and as the tenant's own model on
// aliyuncs (config_source 2). Keyed by config_name alone, the preset's __dev
// entry won the tie and every ask went to the preset, which that seat's
// Trae answers 4222; aliyuncs//kimi-k3.1-pro, as the enterprise console
// writes it, was no id at all (4001). The entries' fields are the ones the
// reporter named (config_name, config_source 2, provider aliyuncs, the
// preset's __dev model); the rest is shaped as #1258's real enterprise
// entries are.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

const preset = { config_name: "kimi-k3.1-pro", usage: "chat_completion", config_source: 1, is_preset: true,
  display_config: { display_name: "Kimi-K3.1-Pro" }, model_detail_list: [{ model_name: "kimi-k3.1-pro__dev", max_tokens: 32768 }] }
const twin = { config_name: "kimi-k3.1-pro", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "kimi-k3.1-pro", is_custom_model: true },
  model_detail_list: [{ model_name: "kimi-k3.1-pro", provider: "aliyuncs", max_tokens: 16384 }] }
// the seat's other aliyuncs model, which no preset shares a name with
const qwen = { config_name: "qwen4-max", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "qwen4-max", is_custom_model: true },
  model_detail_list: [{ model_name: "qwen4-max", provider: "aliyuncs", max_tokens: 16384 }] }
// #1258's enterprise model, whose config_name names its provider already
const theirs = { config_name: "AI/deekseek-v4.1-flash", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "deekseek-v4.1-flash", is_custom_model: true },
  model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "AI", max_tokens: 8192 }] }

// Trae as the reporter met it: the preset is refused on that seat, the
// enterprise model is served when asked as Trae's client asks it (its bare
// config_name with config_source 2), and a name Trae doesn't know is 4001
const DEAD = "the preset is not available"
function trae(configs, order = configs) {
  f?.close()
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: order }] }))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    const b = r.json
    const known = configs.find((m) => m.config_name === b.config_name && (b.config_source === 2) === (m.config_source === 2))
    if (!known) return sse([["error", { code: 4001, message: "We're sorry, the param is invalid. Please try with a valid param." }]])
    if (known === preset) return sse([["error", { code: 4222, message: DEAD }]])
    return sse([["output", { response: "ok " + b.config_name }], ["done", {}]])
  })
}

const chats = () => f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").map((r) => r.json)
const ask = async (model) => {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const listed = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
  return { listed, res }
}

// either order of the two in Trae's list: the preset kept the bare id
// whichever came first, so neither order may give it to the twin
for (const order of [[preset, twin, qwen, theirs], [twin, preset, qwen, theirs]]) {
  const named = order[0] === preset ? "preset first" : "twin first"
  test(`an enterprise model a preset shares its config_name with is listed and asked as its own (${named})`, async () => {
    trae([preset, twin, qwen, theirs], order)
    const { listed, res } = await ask("aliyuncs//kimi-k3.1-pro")
    // both are listed: the preset under the bare id, the twin as the console writes it
    expect(Object.keys(listed).sort()).toEqual(["AI/deekseek-v4.1-flash", "aliyuncs//kimi-k3.1-pro", "kimi-k3.1-pro", "qwen4-max"])
    expect(listed["kimi-k3.1-pro"].limit.output).toBe(32768)
    expect(listed["aliyuncs//kimi-k3.1-pro"].limit.output).toBe(16384)
    expect(listed["aliyuncs//kimi-k3.1-pro"].id).toBe("aliyuncs//kimi-k3.1-pro")
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("ok kimi-k3.1-pro")
    // asked as Trae's client asks it: the bare config_name, config_source 2
    const [b] = chats()
    expect(b).toMatchObject({ config_name: "kimi-k3.1-pro", model: "kimi-k3.1-pro", model_name: "kimi-k3.1-pro", config_source: 2, is_custom_model: true, provider: "aliyuncs" })
    expect(JSON.stringify(b)).not.toContain("//")
  })
}

test("the bare id stays the preset's, and its refusal names the twin", async () => {
  trae([preset, twin, qwen, theirs])
  const { res } = await ask("kimi-k3.1-pro")
  const [b] = chats()
  expect(b.config_name).toBe("kimi-k3.1-pro")
  expect(b.model_name).toBe("kimi-k3.1-pro__dev")
  expect(b.config_source).toBeUndefined()
  expect(res.status).toBe(502)
  const msg = (await res.json()).error.message
  expect(msg).toContain(DEAD)
  expect(msg).toContain("listed as aliyuncs//kimi-k3.1-pro")
})

test("an enterprise model no preset shares a name with keeps its id, and answers to its provider's too", async () => {
  trae([preset, twin, qwen, theirs])
  for (const [model, config, provider] of [["qwen4-max", "qwen4-max", "aliyuncs"], ["aliyuncs//qwen4-max", "qwen4-max", "aliyuncs"], ["AI/deekseek-v4.1-flash", "AI/deekseek-v4.1-flash", "AI"]]) {
    const { res } = await ask(model)
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("ok " + config)
    expect(chats().at(-1)).toMatchObject({ config_name: config, model: config, config_source: 2, provider })
  }
})

test("a twin id asked before this plugin read the list reads it for the entry", async () => {
  trae([preset, twin])
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "aliyuncs//kimi-k3.1-pro", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  expect(chats()[0]).toMatchObject({ config_name: "kimi-k3.1-pro", config_source: 2, provider: "aliyuncs" })
})

test("twinId takes the provider from the config, else its detail", () => {
  expect(_internal.twinId(twin)).toBe("aliyuncs//kimi-k3.1-pro")
  expect(_internal.twinId({ ...twin, provider: "volcengine" })).toBe("volcengine//kimi-k3.1-pro")
  expect(_internal.twinId({ ...twin, model_detail_list: [{ model_name: "kimi-k3.1-pro" }] })).toBe("enterprise//kimi-k3.1-pro")
})

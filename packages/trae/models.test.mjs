// What magpie reads of a Trae model: capabilities.reasoning. magpie builds
// a provider's models from the plugin's config first (its host spreads the
// config's flat fields into capabilities, internal/plugin/host.js), then
// lets the provider.models hook replace the list. A hook that hands back a
// model without capabilities replaces a model that reasons with one magpie
// reads as one that doesn't: every model outside the site's fallback table
// came out 不支持推理, and a routing group with one of them in it lost
// reasoning for the whole group (magpie's groups take a member that thinks).
// So every model the hook returns carries capabilities.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())

// live serves the account's list (one chat function's entries) and hands
// back the models the provider.models hook built from it.
async function live(configs, provider = { models: {} }) {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: configs },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  return hooks.provider.models(provider, { auth: signedIn() })
}

// a model the account's list has and the fallback table doesn't (magpie's
// report: deepseek-v4-flash-0731-max was 不支持推理)
const offTable = { config_name: "deepseek-v4-flash-0731-max", usage: "chat_completion",
  display_config: { display_name: "DeepSeek V4 Flash 0731 Max" },
  context_window_tokens: { dev: 1_000_000 },
  model_detail_list: [{ model_name: "deepseek-v4-flash-0731-max__dev", max_tokens: 32000 }] }

test("a model the fallback table doesn't have is served with capabilities", async () => {
  const ms = await live([offTable])
  const m = ms["deepseek-v4-flash-0731-max"]
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.temperature).toBe(true)
  expect(m.capabilities.attachment).toBe(false)
  expect(m.capabilities.input).toEqual({ text: true, image: false, audio: false, video: false, pdf: false })
  expect(m.capabilities.output).toEqual({ text: true, image: false, audio: false, video: false, pdf: false })
  // Trae's request takes no effort or thinking level: no variants
  expect(m.variants).toEqual({})
})

test("the fallback table stays the authority where it has an entry", async () => {
  // what magpie's host hands the hook for a model of the config: the
  // fallback table's flat fields already spread into capabilities
  const was = { id: "minimax-m2", name: "MiniMax M2", reasoning: false, tool_call: false, temperature: false,
    capabilities: { reasoning: false, temperature: false, toolcall: false, attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false } } }
  const ms = await live([{ config_name: "minimax-m2", usage: "chat_completion", display_config: { display_name: "MiniMax M2" } }],
    { models: { "minimax-m2": was } })
  const m = ms["minimax-m2"]
  expect(m.capabilities.reasoning).toBe(false)
  expect(m.capabilities.toolcall).toBe(false)
  expect(m.capabilities.temperature).toBe(false)
})

test("every model of the account's list, the fallback ones included, carries capabilities", async () => {
  const ms = await live([offTable,
    { config_name: "glm-5.2", usage: "chat_completion", display_config: { display_name: "GLM-5.2" },
      context_window_tokens: { dev: 200000 }, model_detail_list: [{ model_name: "glm-5.2__dev", max_tokens: 32000 }] }])
  expect(Object.keys(ms)).toEqual(["deepseek-v4-flash-0731-max", "glm-5.2"])
  for (const m of Object.values(ms)) {
    expect(m.capabilities?.reasoning).toBe(true)
    expect(m.capabilities.input.text).toBe(true)
    expect(m.capabilities.output.text).toBe(true)
    expect(m.variants).toEqual({})
  }
  // the model of the fallback table keeps its own name and window
  expect(ms["glm-5.2"].name).toBe("GLM-5.2")
  expect(ms["glm-5.2"].limit.context).toBe(200000)
  // the off-table one is named and windowed from the list
  expect(ms["deepseek-v4-flash-0731-max"].name).toBe("DeepSeek V4 Flash 0731 Max")
  expect(ms["deepseek-v4-flash-0731-max"].limit.context).toBe(1_000_000)
})

test("a model's Max is a model of its own and reasons too", async () => {
  const max = { config_name: "deepseek-v4-flash-0731-max", usage: "chat_completion",
    display_config: { display_name: "DeepSeek V4 Flash 0731" },
    context_window_tokens: { dev: 200000, max: 1000000 },
    model_detail_list: [{ model_name: "deepseek-v4-flash-0731__dev", max_tokens: 32000 },
      { model_name: "deepseek-v4-flash-0731__max", max_tokens: 64000 }] }
  const ms = await live([max])
  expect(Object.keys(ms).sort()).toEqual(["deepseek-v4-flash-0731-max", "deepseek-v4-flash-0731-max-max"])
  expect(ms["deepseek-v4-flash-0731-max-max"].capabilities.reasoning).toBe(true)
  expect(ms["deepseek-v4-flash-0731-max-max"].name).toBe("DeepSeek V4 Flash 0731 (Max)")
  expect(ms["deepseek-v4-flash-0731-max-max"].limit.context).toBe(1_000_000)
})

// The two realms share the machinery, so the fix is one: Trae Global's
// models carry capabilities too.
test("Trae Global's models carry capabilities as well", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [{ config_name: "gemini-3.1-pro-paygo", usage: "chat_completion",
      display_config: { display_name: "Gemini 3.1 Pro" }, model_detail_list: [{ model_name: "gemini-3.1-pro-paygo__dev" }] }] },
  ] }))
  const { TraeGlobalAuthPlugin } = await import("./index.mjs")
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const ms = await hooks.provider.models({ models: { ..._internal.SITES["trae-global"].models } }, { auth: signedIn() })
  expect(ms["gemini-3.1-pro-paygo"].capabilities.reasoning).toBe(true)
})

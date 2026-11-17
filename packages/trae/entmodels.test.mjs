// An enterprise's own built-in models (Trae CN's client: config_source 2,
// "Enterprise-builtin" in its picker). They are not Trae's presets, so their
// entries say is_custom_model, and the list dropped them with the personal
// custom models a seat's IDE alone holds the key for. A seat that typed one
// in by hand got a bare 502 with nothing saying what was asked.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

// an enterprise built-in as the detail lists are expected to carry it: the
// fields Trae CN 3.4.20's client reads of one (not yet seen from a real seat)
const ent = { config_name: "custom_model_acme_qwen", usage: "chat_completion", config_source: 2, is_preset: false,
  is_custom_model: true, display_config: { display_name: "Acme Qwen", is_custom_model: true },
  custom_model_id: "cm-42", provider: "volcengine", status: true }
// a personal custom model: its provider key is in the user's IDE only
const own = { config_name: "custom_model_mine", usage: "chat_completion", config_source: 3, is_preset: false,
  is_custom_model: true, display_config: { display_name: "My GPT", is_custom_model: true }, custom_model_id: "cm-7" }
const preset = { config_name: "glm-5", usage: "chat_completion", config_source: 1, is_preset: true, display_config: { display_name: "GLM-5" } }

async function plugin(configs) {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: configs }] }))
  return TraeCNAuthPlugin({ client: {} })
}

test("an enterprise built-in model is listed; a personal custom one and a disabled one are not", async () => {
  const hooks = await plugin([preset, ent, own, { ...ent, config_name: "custom_model_off", status: false }])
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  expect(Object.keys(ms).sort()).toEqual(["custom_model_acme_qwen", "glm-5"])
  expect(ms.custom_model_acme_qwen.name).toBe("Acme Qwen")
})

test("chatModel keeps config_source 2 only", () => {
  expect(_internal.chatModel(ent)).toBe(true)
  expect(_internal.chatModel(own)).toBe(false)
  expect(_internal.chatModel({ ...ent, config_source: 3 })).toBe(false)
  expect(_internal.chatModel({ ...ent, usage: "summary" })).toBe(false)
  expect(_internal.chatModel(preset)).toBe(true)
})

test("a chat with an enterprise model carries its model info; a preset's doesn't", async () => {
  const hooks = await plugin([preset, ent])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const opts = await hooks.auth.loader(async () => signedIn())
  for (const model of ["custom_model_acme_qwen", "glm-5"]) {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(200)
  }
  const chats = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(chats[0].json.model).toBe("custom_model_acme_qwen")
  expect(chats[0].json.user_message_context.model_info).toEqual({ config_name: "custom_model_acme_qwen", config_source: 2, is_preset: false,
    use_remote_service: true, display_model_name: "Acme Qwen", custom_model_id: "cm-42", provider: "volcengine" })
  expect(chats[1].json.user_message_context).toBeUndefined()
})

test("a refused chat names the model, the functions tried and the host", async () => {
  const hooks = await plugin([preset, ent])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  f.route("POST /api/agent/v3/llm_utils_chat", () => json({ code: 5000, message: "model not found" }))
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = (model) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })

  let res = await ask("custom_model_acme_qwen")
  expect(res.status).toBe(502)
  let msg = (await res.json()).error.message
  expect(msg).toContain("model not found (code 5000)")
  expect(msg).toContain("enterprise built-in model custom_model_acme_qwen asked through chat_v3")
  expect(msg).toContain("127.0.0.1")
  expect(msg).not.toContain("doesn't have")

  // typed in by hand: a name the account's list doesn't have
  res = await ask("Acme-Qwen-72B")
  expect(res.status).toBe(502)
  msg = (await res.json()).error.message
  expect(msg).toContain("model Acme-Qwen-72B asked through chat_v3")
  expect(msg).toContain("this account's model list doesn't have Acme-Qwen-72B")
})

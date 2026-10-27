// Images (magpie's Discord: Trae CN's doubao said it can't read images
// through magpie, while it reads them in Trae). Trae's model lists mark
// each model multimodal true or false; a model marked true is told to
// magpie as one that takes images, and its images go to llm_utils_chat as
// OpenAI image_url parts, the shape TRAE's ai-agent sends
// (LLMRawMultiContent / LLMRawChatImageURL). A model marked false is still
// told there was an image it can't see.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

// the tools named natively in the body: past calls then go back as Trae's own turns
const TOOLS_ON = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]

let f
afterEach(() => f?.close())

// two entries of TRAE SOLO CN's list as Trae sends them (the fields a
// relay's capture of the solo_agent list kept, wangqi233/trae2api
// scripts/_solo-models-clean.json), with the __dev model the request needs
const seed = { config_name: "Doubao-Seed-2.1-Pro", display_name: "Seed-2.1-Pro", capability: "reasoning_model", multimodal: true, ctx_dev: 256000, is_default: false, is_custom_model: false, usage: "chat_completion", model_detail_list: [{ model_name: "Doubao-Seed-2.1-Pro__dev" }] }
const glm = { config_name: "glm-5.3", display_name: "GLM-5.3", capability: "reasoning_model", multimodal: false, ctx_dev: 200000, is_default: false, is_custom_model: false, usage: "chat_completion", model_detail_list: [{ model_name: "glm-5.3__dev" }] }

// a 1×1 PNG, as an agent attaches a screenshot
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const said = (text) => ({ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: PNG } }] })

async function plugin() {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: [seed, glm] }] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "a red dot" }], ["done", {}]]))
  return TraeCNAuthPlugin({ client: {} })
}

async function ask(hooks, body) {
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
  await res.text()
  return f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-1).json
}

test("a model Trae's list marks multimodal is one that takes images, and one marked otherwise isn't", async () => {
  const ms = await (await plugin()).provider.models({ models: {} }, { auth: signedIn() })
  expect(ms["Doubao-Seed-2.1-Pro"].capabilities.input.image).toBe(true)
  expect(ms["Doubao-Seed-2.1-Pro"].capabilities.attachment).toBe(true)
  expect(ms["Doubao-Seed-2.1-Pro"].modalities.input).toEqual(["text", "image"])
  expect(ms["glm-5.3"].capabilities.input.image).toBe(false)
  expect(ms["glm-5.3"].capabilities.attachment).toBe(false)
})

test("the list's word wins over a fallback entry's capabilities", async () => {
  const was = { capabilities: { reasoning: true, temperature: true, toolcall: true, attachment: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false } } }
  const ms = await (await plugin()).provider.models({ models: { "Doubao-Seed-2.1-Pro": was } }, { auth: signedIn() })
  expect(ms["Doubao-Seed-2.1-Pro"].capabilities.input).toEqual({ text: true, image: true, audio: false, video: false, pdf: false })
})

test("a multimodal model's image goes to Trae as an image_url part beside the text", async () => {
  const hooks = await plugin()
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const b = await ask(hooks, { model: "Doubao-Seed-2.1-Pro", stream: true, messages: [said("what is this?")] })
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: PNG } }] }])
  expect(JSON.stringify(b)).not.toContain("can't see")
})

test("a model Trae marks text-only is told of the image, not sent it", async () => {
  const hooks = await plugin()
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const b = await ask(hooks, { model: "glm-5.3", stream: true, messages: [said("what is this?")] })
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this?\n[an image, which this model can't see]" }] }])
})

test("an image alone, a tool's image and two user turns in a row keep every image in order", () => {
  const m = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] },
    { role: "user", content: [{ type: "text", text: "and this" }, { type: "image_url", image_url: "https://example.invalid/b.png" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "taken" }, { type: "image_url", image_url: { url: PNG } }] },
  ] }, true)
  // a tool result's image rides a user message after the run of results:
  // a tool turn's image reaches Kimi but not Doubao, and nothing may go
  // between the results of one turn (11148)
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "user"])
  expect(m[0].content).toEqual([{ type: "text", text: "and this" }, { type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: { url: "https://example.invalid/b.png" } }])
  expect(m[2].content).toEqual([{ type: "text", text: "taken" }])
  expect(m[3].content).toEqual([{ type: "image_url", image_url: { url: PNG } }])

  // the images of parallel results come out after every result, in order
  const p = _internal.traeMessages({ tools: TOOLS_ON, messages: [
    { role: "user", content: [{ type: "text", text: "two shots" }] },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "shot", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "shot", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: [{ type: "image_url", image_url: { url: PNG } }] },
    { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "second" }, { type: "image_url", image_url: { url: "https://example.invalid/b.png" } }] },
  ] }, true)
  expect(p.map((x) => x.role)).toEqual(["user", "assistant", "tool", "tool", "user"])
  expect(p[2].content).toEqual([{ type: "text", text: "(the result's image follows)" }])
  expect(p[3].content).toEqual([{ type: "text", text: "second" }])
  expect(p[4].content).toEqual([{ type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: { url: "https://example.invalid/b.png" } }])
})

test("a fallback model that Trae marks multimodal is sent its images before the list is read", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  expect((await ask(hooks, { model: "kimi-k2.6", stream: true, messages: [said("see")] })).messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: PNG } })
  expect((await ask(hooks, { model: "glm-5", stream: true, messages: [said("see")] })).messages[0].content).toEqual([{ type: "text", text: "see\n[an image, which this model can't see]" }])
})

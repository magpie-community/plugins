// What a model takes is what MiniMax Code's model config says (#985,
// LingYingNX): the platform's modalities.input, video included, not image
// alone. In magpie the gateway writes the Anthropic body and the plugin
// sends it on as it is, so a video block reaches MiniMax; in OpenCode,
// @ai-sdk/anthropic throws on a video file part, so there video is left
// out and OpenCode says the model can't read it.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 }
const magpie = { option: () => undefined, options: () => ({}) }

// the reporter's, from GET /mavis/api/v1/models?region=cn&buildEnv=prod
const flash = { "modalities": { "input": ["text", "image", "video"], "output": ["text"] }, "attachment": true }

const plugins = [
  ["minimax-code", MiniMaxCodeAuthPlugin, "MiniMax-M3.1-Flash"],
  ["minimax-code-global", MiniMaxCodeGlobalAuthPlugin, "MiniMax-M3.1-Flash-Preview"],
]

function list(id) {
  return json({
    providers: [{ providerId: "minimax", config: {
      model_order: [id, "MiniMax-M3", "MiniMax-M2.7"],
      models: {
        [id]: { name: id, ...flash },
        "MiniMax-M3": { name: "MiniMax-M3", modalities: { input: ["text", "image", "video"], output: ["text"] }, attachment: true },
        "MiniMax-M2.7": { name: "MiniMax-M2.7", modalities: { input: ["text"] } },
      },
    } }],
  })
}

async function given(hooks, id) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider[id]
  return { cfg: p, provider: { id, models: Object.fromEntries(Object.entries(p.models).map(([k, m]) => [k, { id: k, ...m }])) } }
}

for (const [id, Plugin, model] of plugins) {
  test(`${id}: in magpie, the live list's video reaches the model (#985)`, async () => {
    f = fakeMiniMax()
    f.route("GET /mavis/api/v1/models", () => list(model))
    const hooks = await Plugin({ client: {}, magpie })
    const { provider } = await given(hooks, id)
    const ms = await hooks.provider.models(provider, { auth })
    expect(ms[model].capabilities.input).toEqual({ text: true, image: true, audio: false, video: true, pdf: false })
    expect(ms[model].capabilities.attachment).toBe(true)
    expect(ms["MiniMax-M3"].capabilities.input.video).toBe(true)
    expect(ms["MiniMax-M2.7"].capabilities.input).toEqual({ text: true, image: false, audio: false, video: false, pdf: false })
    expect(ms["MiniMax-M2.7"].capabilities.attachment).toBe(false)
  })

  test(`${id}: in magpie, the built-in list says video too`, async () => {
    const hooks = await Plugin({ client: {}, magpie })
    const { cfg } = await given(hooks, id)
    expect(cfg.models["MiniMax-M3.1-Flash-Preview"].modalities.input).toEqual(["text", "image", "video"])
    expect(cfg.models["MiniMax-M3"].modalities.input).toEqual(["text", "image", "video"])
    expect(cfg.models["MiniMax-M2.7"].modalities.input).toEqual(["text"])
    expect(cfg.models["MiniMax-M2.7"].attachment).toBe(false)
  })

  test(`${id}: in OpenCode, whose Anthropic SDK can't send video, it is left out`, async () => {
    f = fakeMiniMax()
    f.route("GET /mavis/api/v1/models", () => list(model))
    const hooks = await Plugin({ client: {} })
    const { cfg, provider } = await given(hooks, id)
    expect(cfg.models["MiniMax-M3"].modalities.input).toEqual(["text", "image"])
    const ms = await hooks.provider.models(provider, { auth })
    expect(ms[model].capabilities.input).toEqual({ text: true, image: true, audio: false, video: false, pdf: false })
  })
}

test("every kind the config says is passed on, pdf and audio too; unknown ones are not", async () => {
  f = fakeMiniMax()
  f.route("GET /mavis/api/v1/models", () => json({
    providers: [{ providerId: "minimax", config: { models: {
      "X-All": { name: "X-All", modalities: { input: ["text", "image", "audio", "video", "pdf", "hologram"] } },
      // an attachment model with no list takes images, as before
      "X-Att": { name: "X-Att", attachment: true },
    } } }],
  }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {}, magpie })
  const { provider } = await given(hooks, "minimax-code")
  const ms = await hooks.provider.models(provider, { auth })
  expect(ms["X-All"].capabilities.input).toEqual({ text: true, image: true, audio: true, video: true, pdf: true })
  expect(ms["X-Att"].capabilities.input).toEqual({ text: true, image: true, audio: false, video: false, pdf: false })
  expect(ms["X-Att"].capabilities.attachment).toBe(true)
  // OpenCode's SDK sends a PDF as a document block, so pdf stays there
  const oc = await MiniMaxCodeAuthPlugin({ client: {} })
  const ms2 = await oc.provider.models((await given(oc, "minimax-code")).provider, { auth })
  expect(ms2["X-All"].capabilities.input).toEqual({ text: true, image: true, audio: false, video: false, pdf: true })
})

test("a chat's video block goes to MiniMax as it came", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({ type: "message", content: [] }))
  const body = JSON.stringify({
    model: "MiniMax-M3.1-Flash", max_tokens: 64,
    messages: [{ role: "user", content: [
      { type: "video", source: { type: "base64", media_type: "video/mp4", data: "AAAAIGZ0eXBpc29t" } },
      { type: "text", text: "描述这个视频" },
    ] }],
  })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {}, magpie })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch(opts.baseURL + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body })
  expect(res.status).toBe(200)
  expect(f.seen.at(-1).text).toBe(body)
})

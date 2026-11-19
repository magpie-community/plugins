// 豆包生图 (Doubao images) as an image provider: one request draws one
// picture in 豆包, and the answer is that picture — nothing else.
//
// It answers /v1/images/generations only. There is no chat here: an image
// request has no conversation, so nothing of one is kept, and the picture
// never enters a client's context as text. That is also the cheapest way to
// get the result: a chat reply would carry a signed CDN link in the
// history (about 149 tokens a turn, sent again every turn), while an image
// response carries it outside the context.
import { DoubaoError, DoubaoImage, MODE, choose } from "./doubao.mjs"
import { directPrompt, imagePrompt, imagePromptMany, ratioOf } from "./prompt.mjs"

const ID = "doubao-image"
const BASE = "https://doubao-image.invalid/v1"

const BUSY = (name) => `${name}正在运行。${name}同时只能开一个，插件要用自己的${name}窗口：请先退出${name}（⌘Q）再试。`

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// MODELS are the 工作任务 models this plugin offers. The id is the client's;
// label is the row's first line in Doubao's own menu.
export const MODELS = {
  "doubao-image": { name: "豆包 2.1 Lite 生图", label: "豆包 2.1 Lite" },
  "doubao-image-pro": { name: "豆包 2.1 Pro 生图", label: "豆包 2.1 Pro" },
}

// models says what each one makes: images, not text. magpie reads that from
// the output modalities.
function models() {
  const out = {}
  for (const [id, m] of Object.entries(MODELS))
    out[id] = {
      name: m.name,
      limit: { context: 256000, output: 32768 },
      attachment: false,
      tool_call: false,
      reasoning: false,
      modalities: { input: ["text"], output: ["image"] },
    }
  return out
}

// N is how many pictures one request asks for. Nothing caps it: the
// caller decides, and each picture is one request to Doubao.
const N = (v) => {
  const n = Math.trunc(Number(v))
  return n > 1 ? n : 1
}

// JOBS are drawings still going. magpie cuts a tool call off at 60
// seconds; a call waits 50 of them, and the next call waits on the same
// drawing, so a slow picture is never lost to the limit.
const jobs = new Map()
const WAIT_MS = 50000

function startJob(draw, args) {
  const id = "job_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
  const promise = draw({ ...args, n: 1, signal: AbortSignal.timeout(180000) })
    .then((images) => ({ ok: true, images }))
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
  jobs.set(id, promise)
  promise.then((r) => {
    if (!r.ok) jobs.delete(id)
    else setTimeout(() => jobs.delete(id), 10 * 60 * 1000)?.unref?.()
  })
  return { id, promise }
}

async function answer(id, promise) {
  let timer
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(null), WAIT_MS)
  })
  let r
  try {
    r = await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
  if (!r) return `图片还在画（${id}）。请调用 magpie-doubao-image_image_result，参数 job="${id}"，继续等结果。`
  if (!r.ok) throw new DoubaoError(`豆包生图失败：${r.error}`, "doubao_tool", { status: 502 })
  const images = r.images || []
  if (images.length === 1) {
    const im = images[0]
    return `已生成图片（${im.width || "?"}×${im.height || "?"}）：\n${im.url}`
  }
  return `已生成 ${images.length} 张图片：\n` + images.map((im, i) => `${i + 1}. ${im.width || "?"}×${im.height || "?"}\n${im.url}`).join("\n")
}

async function base64Of(url, signal) {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new DoubaoError(`图片下载失败：HTTP ${r.status}`, "doubao_fetch", { status: 502 })
  return Buffer.from(await r.arrayBuffer()).toString("base64")
}

export function createPlugin({ doubao = new DoubaoImage(), pick = choose } = {}) {
  const failed = (e) => {
    if (e?.signIn) throw e
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    const status = String(e?.code ?? "").startsWith("app_") ? 503 : e?.status ?? 502
    const why = e?.code === "app_busy" ? BUSY(pick().app.name) : String(e?.message ?? e)
    return json(status, why, e?.code ?? "doubao_error")
  }
  // empty says why Doubao gave no picture, with whatever it replied
  // instead (an exhausted allowance, for one).
  const empty = (final) => {
    const why = String(final?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200)
    return new DoubaoError(why ? `豆包没有画图：${why}` : "豆包没有返回图片。", "doubao_empty", { status: 502 })
  }
  // draw runs one request through Doubao and gives back the images it
  // brought. In 对话 the 图像生成 skill already draws, so the description
  // goes as it is and the ratio is a menu key; in 工作 the drawing rules
  // are needed, and the ratio goes in the words.
  const draw = async ({ prompt, prompts, size, style = "", user = "", model = "doubao-image", n = 1, signal }) => {
    const m = MODELS[model]
    if (!m) throw new DoubaoError(`没有模型 ${model}。豆包生图的模型有：${Object.keys(MODELS).join("、")}。`, "model_not_found", { status: 404 })
    const many = Array.isArray(prompts) ? prompts.map((x) => String(x ?? "").trim()).filter(Boolean) : []
    const chat = MODE() === "chat"
    const list = many.length ? many : [String(prompt ?? "").trim()]
    const text = chat
      ? directPrompt(list, String(style ?? "").trim(), ratioOf(size))
      : many.length > 1
        ? imagePromptMany(many, ratioOf(size), String(style ?? "").trim())
        : imagePrompt(list[0], ratioOf(size), String(style ?? "").trim())
    // 对话 keeps 比例 on 自动: the ratio goes in the words, which Seedream
    // follows as well as the menu
    const key = ""
    const sessionKey = user ? "user:" + String(user) : ""
    if (many.length > 1) {
      signal?.throwIfAborted()
      const final = await doubao.ask({ prompt: text, sessionKey, model: m.label, ratio: key, signal })
      const images = (final.images || []).filter((x) => x?.url)
      if (!images.length) throw empty(final)
      return images
    }
    const images = []
    for (let i = 0; i < n; i++) {
      signal?.throwIfAborted()
      const final = await doubao.ask({ prompt: text, sessionKey, model: m.label, ratio: key, signal })
      const image = (final.images || []).find((x) => x?.url)
      if (!image) throw empty(final)
      images.push(image)
    }
    return images
  }
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= { name: "豆包生图", npm: "@ai-sdk/openai-compatible", api: BASE }
      cfg.provider[ID].models = { ...models(), ...(cfg.provider[ID].models ?? {}) }
    },
    provider: { id: ID, models: async () => models() },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [
        {
          type: "oauth",
          label: "在豆包窗口中登录",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "将打开一个单独的豆包窗口（不影响你平时用的豆包）。请在其中登录，登录后回到这里。",
            callback: async () => {
              const { app, binary } = pick()
              if (!binary) return { type: "failed", error: "豆包生图只支持 macOS 和 Windows：豆包没有 Linux 版。" }
              let s
              try {
                s = await doubao.waitSignedIn()
              } catch (e) {
                if (e?.code === "app_missing") return { type: "failed", error: `没有找到${app.name}，请先安装豆包。` }
                if (e?.code === "app_busy") return { type: "failed", error: BUSY(app.name) }
                return { type: "failed", error: "打开豆包失败：" + String(e?.message ?? e) }
              }
              if (!s) return { type: "failed", error: "五分钟内没有在豆包窗口里登录，请再试一次。" }
              return { type: "success", access: "doubao-desktop", refresh: "", expires: 0, accountId: "豆包生图 · " + s.name, name: s.name }
            },
          }),
        },
      ],
      loader: async () => ({
        baseURL: BASE,
        apiKey: "doubao-desktop",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? new Request(input, init) : null
          const url = new URL(request ? request.url : String(input))
          const method = request ? request.method : init.method ?? "GET"
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/images/generations") || method !== "POST")
            return json(404, "豆包生图只提供 images/generations。", "not_found")
          const signal = request ? request.signal : init.signal
          let body
          try {
            body = JSON.parse(request ? await request.text() : typeof init.body === "string" ? init.body : await new Response(init.body).text())
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const model = String(body.model ?? "doubao-image").replace(/^doubao-image\//, "")
          const m = MODELS[model]
          if (!m) return json(404, `没有模型 ${model}。豆包生图的模型有：${Object.keys(MODELS).join("、")}。`, "model_not_found")
          const description = String(body.prompt ?? "").trim()
          const many = Array.isArray(body.prompts) ? body.prompts.map((x) => String(x ?? "").trim()).filter(Boolean) : []
          if (!description && !many.length) return json(400, "缺少 prompt。", "invalid_request_error")
          // 豆包 has no size parameter, so the ratio goes in the prompt. It
          // has no conversation either, unless the caller names one with
          // `user`, which keeps a series' style.
          const responseFormat = String(body.response_format ?? "url").toLowerCase()
          try {
            const images = await draw({
              prompt: description,
              prompts: many,
              size: body.size,
              style: body.doubao_style,
              user: body.user,
              model,
              n: N(body.n),
              signal,
            })
            const data = []
            for (const image of images)
              data.push(responseFormat === "b64_json" ? { b64_json: await base64Of(image.url, signal) } : { url: image.url })
            return Response.json({ created: Math.floor(Date.now() / 1000), data })
          } catch (e) {
            return failed(e)
          }
        },
      }),
    },
    // magpie gives these tools to every agent through its plugin tools MCP
    // server. A tool call is cut off at 60 seconds and a picture sometimes
    // takes longer: the drawing runs in the background, the call waits 50
    // seconds for it, and the next call waits on the same drawing — three
    // calls cover 180 seconds.
    tool: {
      generate_image: {
        description:
          "用豆包（Doubao）生成图片，返回图片地址。适合需要配图、插画、海报底图的场景。要画多张时把每张写进 prompts，豆包会在同一条消息里一次画完。通常需要 30～90 秒；超过 50 秒时会返回 job id，再调用 image_result 继续等。",
        args: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "画面描述，中文即可。写清主体、场景、风格、光线、构图。" },
            prompts: {
              type: "array",
              items: { type: "string" },
              description: "一次画多张时用：每项是一张图的描述。豆包收到一条消息，在里面连续画。传了它就不必再传 prompt。",
            },
            size: { type: "string", description: "画幅，如 1024x1792（9:16 竖版）、1536x1024（3:2 横版）、9:16、16:9。不填默认 3:2 横版。多张时每张同画幅。" },
            model: { type: "string", enum: Object.keys(MODELS), description: "默认 doubao-image（豆包 2.1 Lite）。doubao-image-pro 更慢更贵。" },
            user: { type: "string", description: "同一系列传同一个值，复用同一个豆包会话，风格更连贯。" },
          },
        },
        execute: async (args) => {
          const prompt = String(args?.prompt ?? "").trim()
          const prompts = Array.isArray(args?.prompts) ? args.prompts.map((x) => String(x ?? "").trim()).filter(Boolean) : []
          if (!prompt && !prompts.length) throw new DoubaoError("缺少 prompt。", "invalid_request", { status: 400 })
          const { id, promise } = startJob(draw, {
            prompt,
            prompts,
            size: args?.size,
            user: args?.user,
            model: String(args?.model ?? "doubao-image"),
          })
          return await answer(id, promise)
        },
      },
      image_result: {
        description: "取回 magpie-doubao-image_generate_image 开始画的那张图。job 是上一次返回的 job id。",
        args: {
          type: "object",
          properties: { job: { type: "string", description: "generate_image 返回的 job id" } },
          required: ["job"],
        },
        execute: async (args) => {
          const job = String(args?.job ?? "").trim()
          const promise = jobs.get(job)
          if (!promise) return `找不到 ${job}：它可能已经取走并清理了。请重新调用 magpie-doubao-image_generate_image。`
          return await answer(job, promise)
        },
      },
    },
  }
}

export default async function DoubaoImageProvider() {
  return createPlugin()
}

export const _internal = { createPlugin, models, BASE, ID, DoubaoError }

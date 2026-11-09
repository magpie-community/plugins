// 豆包工作 (Doubao Work) as a model provider. Doubao Work runs its agent
// loop in ByteDance's cloud and has no API, so this plugin uses the app
// the way a person does: it opens Doubao's desktop app from a profile of
// its own, starts a new 工作任务 per request on 云电脑, writes the whole
// request into the input, and reads the reply as Doubao renders it. The
// client's tools are asked for as <tool_call> text blocks and given back
// as OpenAI tool_calls. See README.md for what that costs.
import { Doubao, DoubaoError, MODELS, binary, usageOf } from "./doubao.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "doubao-work"
const BASE = "https://doubao-work.invalid/v1"

const BUSY = "豆包正在运行。豆包同时只能开一个，插件要用自己的豆包窗口：请先退出豆包（⌘Q）再试。"

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// models are named as Doubao's menu names them: magpie adds the
// provider's name. Each says it takes text only, or magpie would ask
// models.dev about another vendor's model of the same id ("auto").
function models() {
  const out = {}
  for (const [id, m] of Object.entries(MODELS))
    out[id] = {
      name: m.name,
      limit: { context: 256000, output: 32768 },
      tool_call: true,
      reasoning: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    }
  return out
}

export function createPlugin({ doubao = new Doubao(), newId, appBinary = binary } = {}) {
  const failed = (e) => {
    if (e?.signIn) throw e
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    const status = String(e?.code ?? "").startsWith("app_") ? 503 : e?.status ?? 502
    return json(status, e?.code === "app_busy" ? BUSY : String(e?.message ?? e), e?.code ?? "doubao_error")
  }
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= { name: "豆包工作", npm: "@ai-sdk/openai-compatible", api: BASE, models: models() }
    },
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
              if (!appBinary()) return { type: "failed", error: "豆包工作插件目前只支持 macOS 上的豆包桌面版。" }
              let s
              try {
                s = await doubao.waitSignedIn()
              } catch (e) {
                if (e?.code === "app_missing") return { type: "failed", error: "没有找到豆包桌面版，请先安装：https://www.doubao.com/download/desktop" }
                if (e?.code === "app_busy") return { type: "failed", error: BUSY }
                return { type: "failed", error: "打开豆包失败：" + String(e?.message ?? e) }
              }
              if (!s) return { type: "failed", error: "五分钟内没有在豆包窗口里登录，请再试一次。" }
              return { type: "success", access: "doubao-desktop", refresh: "", expires: 0, accountId: "豆包工作 · " + s.name, name: s.name }
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
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/chat/completions") || method !== "POST")
            return json(404, "豆包工作只提供 chat/completions。", "not_found")
          const signal = request ? request.signal : init.signal
          let body
          try {
            body = JSON.parse(request ? await request.text() : typeof init.body === "string" ? init.body : await new Response(init.body).text())
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const model = String(body.model ?? "auto").replace(/^doubao-work\//, "")
          if (!MODELS[model]) return json(404, `没有模型 ${model}。`, "model_not_found")
          const prompt = flatten(body)
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = (r) => usageOf(r?.usage) || Math.ceil(prompt.length / 3)
          try {
            if (body.stream)
              return await sse({ id, model, signal, newId, promptTokens, ask: (onUpdate, sig) => doubao.ask(prompt, { model, signal: sig, onUpdate }) })
            const final = await doubao.ask(prompt, { model, signal })
            return Response.json(completion({ id, model, final, promptTokens: promptTokens(final), newId }))
          } catch (e) {
            return failed(e)
          }
        },
      }),
    },
  }
}

export default async function DoubaoWorkProvider() {
  return createPlugin()
}

export const _internal = { createPlugin, models, BASE, ID, DoubaoError }

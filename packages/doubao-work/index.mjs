// 豆包工作 (Doubao Work) as a model provider. Doubao Work runs its agent
// loop in ByteDance's cloud and has no API, so this plugin uses the app
// the way a person does: it opens 豆包工作 (or 豆包) from a profile of
// its own, starts a new 工作任务 per request on 云电脑, writes the whole
// request into the input, and reads the reply as Doubao renders it. The
// client's tools are asked for as <tool_call> text blocks and given back
// as OpenAI tool_calls. See README.md for what that costs.
import { Doubao, DoubaoError, EFFORTS, MODELS, choose, lookup, quotaOf, usageOf } from "./doubao.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "doubao-work"
const BASE = "https://doubao-work.invalid/v1"

const BUSY = (name) => `${name}正在运行。${name}同时只能开一个，插件要用自己的${name}窗口：请先退出${name}（⌘Q）再试。`

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// variantsOf offers a model's 推理强度 levels as reasoning efforts
// (低 low, 中 medium, 高 high, 极高 xhigh, 最高 max).
function variantsOf(m) {
  const out = {}
  for (const name of m?.efforts ?? []) {
    const e = EFFORTS.find(([n]) => n === name)
    if (e) out[e[1]] = { reasoningEffort: e[1] }
  }
  return Object.keys(out).length ? out : null
}

// models are named as Doubao's menu names them: magpie adds the
// provider's name. Each says it takes text only, or magpie would ask
// models.dev about another vendor's model of the same id ("auto").
function models(table = MODELS) {
  const out = {}
  for (const [id, m] of Object.entries(table))
    out[id] = {
      name: m.name,
      limit: { context: 256000, output: 32768 },
      tool_call: true,
      reasoning: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      // the multiple of the plan's allowance a request costs, as the menu
      // writes it next to the model (none when it says none)
      ...(m.rate > 0 ? { rate: m.rate } : {}),
      ...(variantsOf(m) ? { variants: variantsOf(m) } : {}),
    }
  return out
}

// modelTable is the list the plugin offers: Doubao's menu as discover read
// it (never opening the app here), or the built-in fallback.
const modelTable = (doubao) => (typeof doubao?.modelList === "function" ? doubao.modelList() : MODELS)

// pick says which app the plugin drives (doubao.mjs choose): its name goes
// in the messages, and no binary at all means Linux.
export function createPlugin({ doubao = new Doubao(), newId, pick = choose } = {}) {
  const failed = (e) => {
    if (e?.signIn) throw e
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    const status = String(e?.code ?? "").startsWith("app_") ? 503 : e?.status ?? 502
    return json(status, e?.code === "app_busy" ? BUSY(pick().app.name) : String(e?.message ?? e), e?.code ?? "doubao_error")
  }
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // the list comes from Doubao's menu, so it is merged in on every load
      // instead of being frozen in the declaration; a model the user
      // declared themselves keeps their settings
      cfg.provider[ID] ??= { name: "豆包工作", npm: "@ai-sdk/openai-compatible", api: BASE }
      cfg.provider[ID].models = { ...models(modelTable(doubao)), ...(cfg.provider[ID].models ?? {}) }
    },
    // each account is offered the models its own menu shows (the cache
    // discover() writes; no app is opened from here)
    provider: {
      id: ID,
      async models() {
        // a list never read from the menu is read now, so an account that
        // signed in before the plugin read menus isn't left with three
        if (typeof doubao?.ensureList === "function") await doubao.ensureList({ signal: AbortSignal.timeout(25000) })
        return models(modelTable(doubao))
      },
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      // the plan's allowance, read through the app's own page
      usage: async () => {
        const fail = (error) => ({ plan: "", windows: [], error, signIn: "kept" })
        let read
        try {
          read = await doubao.quota({ signal: AbortSignal.timeout(25000) })
        } catch (e) {
          return fail(e?.code === "app_busy" ? BUSY(pick().app.name) : String(e?.message ?? e))
        }
        if (read?.error) return fail("读取豆包额度失败：" + read.error)
        if (read?.status === 401 || read?.status === 403) return fail("豆包登录已过期，请重新登录豆包工作窗口。")
        const u = quotaOf(read)
        if (!u) return fail("豆包额度回复里没有额度数据（HTTP " + (read?.status ?? "?") + "）")
        if (!u.windows.length) return fail("当前套餐没有额度限制数据")
        return u
      },
      methods: [
        {
          type: "oauth",
          label: "在豆包窗口中登录",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "将打开一个单独的豆包工作窗口（不影响你平时用的豆包工作或豆包）。请在其中登录，登录后回到这里。",
            callback: async () => {
              const { app, binary } = pick()
              if (!binary) return { type: "failed", error: "豆包工作插件只支持 macOS 和 Windows：豆包工作和豆包都没有 Linux 版。" }
              let s
              try {
                s = await doubao.waitSignedIn()
              } catch (e) {
                if (e?.code === "app_missing") return { type: "failed", error: `没有找到${app.name}，请先安装：${app.download}` }
                if (e?.code === "app_busy") return { type: "failed", error: BUSY(app.name) }
                return { type: "failed", error: "打开豆包失败：" + String(e?.message ?? e) }
              }
              if (!s) return { type: "failed", error: "五分钟内没有在豆包窗口里登录，请再试一次。" }
              // read the model menu now that the window is open and signed
              // in, so the models it shows are listed at once
              if (typeof doubao.discover === "function") {
                try { await doubao.discover({ signal: AbortSignal.timeout(20000) }) } catch {}
              }
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
          const known = lookup(modelTable(doubao), model) || (typeof doubao?.known === "function" && (await doubao.known(model, { signal })))
          if (!known) return json(404, `没有模型 ${model}。豆包工作的模型有：${Object.keys(modelTable(doubao)).join("、")}。`, "model_not_found")
          // the client's reasoning effort, as OpenAI's chat completions or
          // the Responses API write it
          const effort = String(body.reasoning_effort ?? body.reasoning?.effort ?? "")
          const prompt = flatten(body)
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = (r) => usageOf(r?.usage) || Math.ceil(prompt.length / 3)
          try {
            if (body.stream)
              return await sse({ id, model, signal, newId, promptTokens, ask: (onUpdate, sig) => doubao.ask(prompt, { model, effort, signal: sig, onUpdate }) })
            const final = await doubao.ask(prompt, { model, effort, signal })
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

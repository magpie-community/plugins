// The Gemini web app (gemini.google.com) as a model provider. Each request
// is one POST to the app's own StreamGenerate endpoint, read as it
// streams: no local server, no browser per request, no file upload. A
// Google account is signed in through a browser window of the plugin's
// own; without one the app still answers, with the model Google gives
// visitors. The client's tools are asked for as <tool_call> text blocks
// and given back as OpenAI tool_calls. See README.md.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { renew, profileRoot, signIn } from "./browser.mjs"
import { GeminiError, MODELS, Session } from "./gemini.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "gemini-web"
const BASE = "https://gemini-web.invalid/v1"
const ANONYMOUS = "anonymous"
const VISITOR = { "gemini-auto": MODELS["gemini-auto"] }

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// models are offered as text-only, or magpie would ask models.dev about
// Google's API models of similar ids
function models(table) {
  const out = {}
  for (const [id, m] of Object.entries(table))
    out[id] = {
      name: m.name,
      limit: { context: 128000, output: 32768 },
      tool_call: true,
      reasoning: false,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    }
  return out
}

// cookiesOf reads an account's stored sign-in; anonymous has none
export function cookiesOf(auth) {
  if (!auth?.access || auth.access === ANONYMOUS) return null
  try {
    const v = JSON.parse(auth.access)
    return v?.cookies && typeof v.cookies === "object" ? v.cookies : null
  } catch {
    return null
  }
}

export function createPlugin({ client, fetchImpl = globalThis.fetch, newId, browser = { signIn, renew, profileRoot } } = {}) {
  // one Session per account, kept across requests so the page's tokens
  // and the account's model list are read once, not per request
  const sessions = new Map()
  const tables = new Map()

  const sessionFor = (auth) => {
    const key = auth?.accountId || (cookiesOf(auth) ? auth.refresh : ANONYMOUS) || ANONYMOUS
    const cookies = cookiesOf(auth)
    let s = sessions.get(key)
    // a new sign-in of the same account replaces the one in memory
    if (s && s.storedAccess !== auth?.access && s.writtenAccess !== auth?.access) s = null
    if (!s) {
      s = new Session({
        cookies,
        fetchImpl,
        renew: cookies && auth?.refresh ? () => browser.renew(auth.refresh, { before: s.cookies ?? {} }) : null,
        onCookies: (c) => {
          const access = JSON.stringify({ cookies: c })
          s.writtenAccess = access
          client?.auth
            ?.set?.({ path: { id: ID }, body: { type: "oauth", access, refresh: auth?.refresh ?? "", expires: 0, accountId: auth?.accountId } })
            ?.catch?.(() => {})
        },
      })
      s.storedAccess = auth?.access
      sessions.set(key, s)
    }
    return { key, s }
  }

  const tableFor = (key, s) => (s.signedIn ? tables.get(key) ?? MODELS : VISITOR)

  const listFor = async (auth) => {
    const { key, s } = sessionFor(auth)
    if (!s.signedIn) return { table: VISITOR, read: true }
    try {
      const read = await s.models({ signal: AbortSignal.timeout(20000) })
      if (Object.keys(read).length) {
        tables.set(key, read)
        return { table: read, read: true }
      }
    } catch {}
    return { table: tables.get(key) ?? MODELS, read: tables.has(key) }
  }

  const failed = (e) => {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    if (e?.signIn) throw Object.assign(new Error(e.message), { signIn: "expired" })
    return json(e?.status ?? 502, String(e?.message ?? e), e?.code ?? "gemini_error")
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= { name: "Gemini 网页版", npm: "@ai-sdk/openai-compatible", api: BASE }
      cfg.provider[ID].models = { ...models(MODELS), ...(cfg.provider[ID].models ?? {}) }
    },
    // each account is offered what its own model picker shows
    provider: {
      id: ID,
      async models(_given, { auth } = {}) {
        const { table, read } = await listFor(auth)
        const out = models(table)
        if (!read) out[Symbol.for("magpie.fellBack")] = true
        return out
      },
    },
    auth: {
      provider: ID,
      maxConcurrency: 2,
      methods: [
        {
          type: "oauth",
          label: "在单独的浏览器窗口登录 Google 账号",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "将打开一个单独的 Chrome 窗口（独立的配置，不影响你平时的浏览器）。请在其中登录 Google 账号，打开 Gemini 后窗口会自动关闭。",
            callback: async () => {
              const profile = join(browser.profileRoot(), randomBytes(6).toString("hex"))
              let cookies
              try {
                cookies = await browser.signIn(profile)
              } catch (e) {
                return { type: "failed", error: "打开浏览器失败：" + String(e?.message ?? e) }
              }
              if (!cookies) return { type: "failed", error: "五分钟内没有在窗口里登录 Google 账号，请再试一次。" }
              let t
              try {
                t = await new Session({ cookies, fetchImpl }).tokens({ signal: AbortSignal.timeout(20000) })
              } catch (e) {
                return { type: "failed", error: "登录后打开 Gemini 失败：" + String(e?.message ?? e) }
              }
              if (!t?.at) return { type: "failed", error: "Gemini 没有把这个窗口当成已登录，请再试一次。" }
              const who = t.email || "Google 账号"
              return { type: "success", access: JSON.stringify({ cookies }), refresh: profile, expires: 0, accountId: who, name: who }
            },
          }),
        },
        {
          type: "oauth",
          label: "不登录使用",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "不登录时，Gemini 网页版只给访客的模型（目前是 3.5 Flash-Lite）。",
            callback: async () => ({ type: "success", access: ANONYMOUS, refresh: "", expires: 0, accountId: ANONYMOUS, name: "访客（未登录）" }),
          }),
        },
      ],
      loader: async (getAuth) => ({
        baseURL: BASE,
        apiKey: "gemini-web",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? new Request(input, init) : null
          const url = new URL(request ? request.url : String(input))
          const method = request ? request.method : init.method ?? "GET"
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/chat/completions") || method !== "POST")
            return json(404, "Gemini 网页版只提供 chat/completions。", "not_found")
          const signal = request ? request.signal : init.signal
          let body
          try {
            body = JSON.parse(request ? await request.text() : typeof init.body === "string" ? init.body : await new Response(init.body).text())
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const auth = await getAuth()
          const { key, s } = sessionFor(auth)
          const model = String(body.model ?? "gemini-auto").replace(/^gemini-web\//, "")
          let table = tableFor(key, s)
          if (!table[model] && s.signedIn && !tables.has(key)) table = (await listFor(auth)).table
          const m = table[model]
          if (!m) return json(404, `没有模型 ${model}。这个账号的 Gemini 网页版模型有：${Object.keys(table).join("、")}。`, "model_not_found")
          const prompt = flatten(body)
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => Math.ceil(prompt.length / 3)
          // a visitor is given what Google gives visitors: no picker header
          const pick = s.signedIn ? m : {}
          try {
            if (body.stream)
              return await sse({ id, model, signal, newId, promptTokens, ask: (onUpdate, sig) => s.ask(prompt, { model: pick, signal: sig, onUpdate }) })
            const final = await s.ask(prompt, { model: pick, signal })
            return Response.json(completion({ id, model, final, promptTokens: promptTokens(), newId }))
          } catch (e) {
            return failed(e)
          }
        },
      }),
    },
  }
}

export default async function GeminiWebProvider({ client } = {}) {
  return createPlugin({ client })
}

export const _internal = { createPlugin, models, BASE, ID, GeminiError }

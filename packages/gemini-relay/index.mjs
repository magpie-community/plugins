// The Gemini web app as a magpie provider, through a long-lived real
// browser relay. A bare Node client is /sorry-ed by Google on many
// networks; the same request sent from inside the app's own page (its
// cookies, its TLS) is served. The browser stays up across requests; one
// in-page fetch per chat request, read as it streams.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { RelayBrowser, findChrome, pageEmail, profileRoot, signIn } from "./browser.mjs"
import { GeminiError, MODELS, RelaySession, thinkingByte } from "./relay.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "gemini-relay"
const BASE = "https://gemini-relay.invalid/v1"
// the anonymous account: no cookies, the app serves what it serves visitors
const ANONYMOUS = "anonymous"
// visitors get the app's Auto only (the old gemini-web plugin's way)
const VISITOR = { "gemini-auto": MODELS["gemini-auto"] }

// the Gemini sparkle as a vector: crisp at any size (the favicon PNG got
// blurry on the provider card)
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZzEiIHgxPSI4IiB5MT0iNDAiIHgyPSI0MCIgeTI9IjgiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNDI4NUY0Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjMzIiBzdG9wLWNvbG9yPSIjOUI3MkNCIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjY2IiBzdG9wLWNvbG9yPSIjRDk2NTcwIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0YyQTYwQyIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPHBhdGggZmlsbD0idXJsKCNnMSkiIGQ9Ik0yNCA0YzEuMSA3LjkgNC4yIDEzLjYgOC40IDE3LjJDMzYgMjQuNSA0MSAyNi40IDQ0IDI2LjZ2LjhjLTMgLjItOCAyLjEtMTEuNiA1LjRDMjguMiAzNi40IDI1LjEgNDIuMSAyNCA1MGMtMS4xLTcuOS00LjItMTMuNi04LjQtMTcuMkMxMiAyOS41IDcgMjcuNiA0IDI3LjR2LS44YzMtLjIgOC0yLjEgMTEuNi01LjRDMTkuOCAxNy42IDIyLjkgMTEuOSAyNCA0eiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAtMykiLz4KPC9zdmc+Cg=="

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// accountName reads the account's Google email. It goes through the
// account's own relay browser (the one already running — a second Chrome
// on the same profile would lose the singleton lock and fail) and reads
// the accounts.google.com page, which no /sorry ever replaces. "" when
// the account is not reachable right now; the name is cosmetic, the
// cookies decide what is served.
async function accountName(profileDir) {
  if (!profileDir) return ""
  return pageEmail(browserFor(profileDir))
}

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

export function createPlugin({ profileDir, headless = true } = {}) {
  // one relay browser and session per account, kept across requests: the
  // anonymous account runs its own signed-out browser
  const browsers = new Map()
  const browserFor = (key) => {
    let b = browsers.get(key)
    if (!b) {
      b = new RelayBrowser({ profileDir: key === ANONYMOUS ? undefined : key, headless })
      browsers.set(key, b)
    }
    return b
  }
  // the account's profile dir from its stored sign-in; anonymous has none.
  // A corrupt record must not silently become the anonymous visitor: the
  // request would be served by the wrong identity at the wrong tier. It
  // surfaces as an error instead, telling the user to sign in again.
  const accountKey = (auth) => {
    if (!auth?.access || auth.access === ANONYMOUS) return ANONYMOUS
    try {
      const v = JSON.parse(auth.access)
      const dir = v?.profileDir || profileDir
      if (!dir) throw new Error("no profileDir")
      return dir
    } catch {
      throw new GeminiError("账号的登录记录已损坏，请移除后重新登录。", { code: "auth_corrupted", status: 401 })
    }
  }
  const sessionFor = (auth) => new RelaySession({ browser: browserFor(accountKey(auth)) })

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= { name: "Gemini 网页版 2.0", npm: "@ai-sdk/openai-compatible", api: BASE, icon: ICON }
      cfg.provider[ID].models = { ...models(MODELS), ...(cfg.provider[ID].models ?? {}) }
    },
    provider: {
      id: ID,
      // each account is offered what it can use: a visitor only Auto
      async models(given, { auth } = {}) {
        const key = accountKey(auth)
        return models(key === ANONYMOUS ? VISITOR : MODELS)
      },
      // the account's own info, read again on every magpie account-page
      // visit: a name left as a fallback becomes the account's email as
      // soon as it is readable — no re-sign-in needed
      async accountInfo(_given, { auth } = {}) {
        const key = accountKey(auth)
        if (key === ANONYMOUS) return { name: "访客（未登录）" }
        const email = await accountName(key)
        return email ? { name: email } : {}
      },
    },
    auth: {
      provider: ID,
      icon: ICON,
      maxConcurrency: 2,
      methods: [
        {
          // the plugin's own sign-in: a window of its own, the user signs in
          // there, the cookies are read over DevTools. The profile is kept
          // as the account's refresh, so the relay browser reuses the very
          // sign-in. This is the independent way — nothing of any other
          // plugin is touched.
          type: "oauth",
          icon: ICON,
          label: "在单独的浏览器窗口登录 Google 账号（推荐）",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "将打开一个单独的 Chrome 窗口（本插件自己的配置，不碰你平时的浏览器）。请在其中登录 Google 账号，打开 Gemini 后窗口会自动关闭。",
            callback: async () => {
              const profile = join(profileRoot(), randomBytes(6).toString("hex"))
              let cookies
              try {
                cookies = await signIn(profile)
              } catch (e) {
                return { type: "failed", error: "打开浏览器失败：" + String(e?.message ?? e) }
              }
              if (!cookies) return { type: "failed", error: "五分钟内没有在窗口里登录 Google 账号，请再试一次。" }
              // name the account by its Google email. The sign-in window
              // itself was on accounts.google.com, which never /sorry-s;
              // a second look through the just-signed profile names the
              // account. If that fails too, the profile's own suffix keeps
              // two accounts from rendering as one name.
              const who = (await accountName(profile)) || `Google 账号 (${profile.slice(-4)})`
              return { type: "success", access: JSON.stringify({ profileDir: profile }), refresh: profile, expires: 0, accountId: who, name: who }
            },
          }),
        },
        {
          // the old plugin's 不登录使用: the app answers visitors too
          // (today 3.5 Flash-Lite via Auto); its own browser, signed out
          type: "oauth",
          icon: ICON,
          label: "不登录使用（访客）",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions: "不登录时，Gemini 网页版只给访客的模型（目前经由 Auto，多半是较轻的模型）。",
            callback: async () => ({ type: "success", access: ANONYMOUS, refresh: "", expires: 0, accountId: ANONYMOUS, name: "访客（未登录）" }),
          }),
        },
      ],
      loader: async (getAuth) => {
        // the host may hand over the auth record or a (possibly async)
        // getter for it; await either
        const auth = await (typeof getAuth === "function" ? getAuth() : getAuth)
        const session = sessionFor(auth)
        return {
        baseURL: BASE,
        apiKey: "gemini-relay",
        async fetch(input, init = {}) {
          // the Request is always built: with a plain-string URL (what the
          // AI SDK sends) only init carries the caller's abort signal, and
          // new Request(input, init) merges it in
          const request = new Request(input, init)
          const url = new URL(request.url)
          const method = request.method
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/chat/completions") || method !== "POST")
            return json(404, "gemini-relay 只提供 chat/completions。", "not_found")
          let body
          try {
            body = JSON.parse(await request.text())
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const table = accountKey(auth) === ANONYMOUS ? VISITOR : MODELS
          const model = String(body.model ?? "gemini-auto").replace(/^gemini-relay\//, "")
          let m = table[model] ?? (accountKey(auth) === ANONYMOUS ? undefined : MODELS[model])
          if (!m) return json(404, `没有模型 ${model}。可用：${Object.keys(table).join("、")}。`, "model_not_found")
          // 4 Neon carries its thinking depth as the request's reasoning
          // effort (the app's own 低/中/高 selector); unset = the app default.
          // An invalid value is a 400 whatever the model; a valid one on a
          // model without depths is a 400 too — silently ignoring a client's
          // requested constraint would mislead it.
          if (body.reasoning_effort) {
            let b15
            try {
              b15 = thinkingByte(body.reasoning_effort)
            } catch (e) {
              return json(400, String(e?.message ?? e), "invalid_request_error")
            }
            if (m.b14 !== 3) return json(400, `模型 ${m.name} 没有思考深度选择，reasoning_effort 仅 4 Neon（gemini-3.1-pro）支持。`, "invalid_request_error")
            m = { ...m, b15 }
          }
          const prompt = flatten(body)
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => Math.ceil(prompt.length / 3)
          // strict by default: a silent tier downgrade (asked Neon, served
          // Hydrogen) must fail loudly rather than pass as if fine
          const strictModel = body.strict_model !== false
          try {
            if (body.stream)
              return await sse({ id, model, signal: request.signal, promptTokens, ask: (onUpdate, sig) => wrapAsk(session, prompt, m, onUpdate, sig, strictModel) })
            const final = await session.ask(prompt, { model: m, signal: request.signal, strictModel })
            return Response.json(completion({ id, model, final, promptTokens: promptTokens() }))
          } catch (e) {
            // a client abort travels as a real AbortError (or as the
            // relay's own cancelled error): rethrow so the SDK sees the
            // cancel — never answer it with a body, and never with an
            // invalid 499 status that the Response constructor rejects
            if (e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "aborted") throw new DOMException("已取消", "AbortError")
            return json(e?.status ?? 502, String(e?.message ?? e), e?.code ?? "gemini_error")
          }
        },
        }
      },
    },
    async dispose() {
      for (const b of browsers.values()) await b.stop().catch(() => {})
    },
  }
}

// ask with streaming updates: the relay reads the whole reply at once (the
// page's fetch is already streamed), so onUpdate fires once with the final
// text — enough for the SSE wrapper to emit it as one chunk set.
function wrapAsk(session, prompt, model, onUpdate, signal, strictModel = false) {
  return session.ask(prompt, { model, signal, strictModel }).then((final) => {
    onUpdate({ text: final.text, reasoning: final.reasoning })
    return final
  })
}

export default async function GeminiWebRelay({ client, options } = {}) {
  // the sign-in made through the plugin's window is the one source of an
  // account; options.profileDir is for selftest/manual runs only
  const dir = options?.profileDir || process.env.GEMINI_RELAY_PROFILE
  return createPlugin({ profileDir: dir, headless: options?.headless ?? true })
}

export const _internal = { createPlugin, MODELS, GeminiError, findChrome }

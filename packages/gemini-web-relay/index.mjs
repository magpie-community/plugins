// The Gemini web app as a magpie provider, through a long-lived real
// browser relay. A bare Node client is /sorry-ed by Google on many
// networks; the same request sent from inside the app's own page (its
// cookies, its TLS) is served. The browser stays up across requests; one
// in-page fetch per chat request, read as it streams.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { RelayBrowser, findChrome, profileRoot, signIn } from "./browser.mjs"
import { GeminiError, MODELS, RelaySession, thinkingByte } from "./relay.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "gemini-web-relay"
const BASE = "https://gemini-web-relay.invalid/v1"
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
  // the account's profile dir from its stored sign-in; anonymous has none
  const accountKey = (auth) => {
    if (!auth?.access || auth.access === ANONYMOUS) return ANONYMOUS
    try {
      const v = JSON.parse(auth.access)
      return v?.profileDir || profileDir || ANONYMOUS
    } catch {
      return ANONYMOUS
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
        return models(accountKey(auth) === ANONYMOUS ? VISITOR : MODELS)
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
              // check the sign-in really opens Gemini: the page must carry
              // its tokens, and its email names the account
              let who = "Google 账号"
              try {
                const check = new RelayBrowser({ profileDir: profile, headless: true })
                try {
                  const page = await check.ensure()
                  const t = await page.eval(`(() => {
                    const html = document.documentElement.innerHTML
                    return { at: (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || "", email: (html.match(/"oPEP7c":"([^"]+)"/) || [])[1] || "" }
                  })()`)
                  if (t?.email) who = t.email
                } finally {
                  await check.stop()
                }
              } catch {}
              return { type: "success", access: JSON.stringify({ profileDir: profile }), refresh: profile, expires: 0, accountId: who, name: who }
            },
          }),
        },
        {
          // compatibility: reuse a profile that already holds a Gemini
          // sign-in — by default one of THIS plugin's own windows; any
          // absolute profile dir is also accepted (e.g. one signed in
          // elsewhere). The relay browser opens it and the page's own
          // cookies serve every request.
          type: "oauth",
          icon: ICON,
          label: "复用已登录的浏览器配置（不重新登录）",
          prompts: [
            {
              key: "profileDir",
              message: "Chrome 配置目录（含 Gemini 登录态）；留空则用本插件目录下最近登录过的配置",
              required: false,
            },
          ],
          authorize: async (inputs) => {
            // magpie's host finishes every oauth sign-in through a callback,
            // so the reuse starts here and "finishes" at once
            return {
              url: "",
              method: "auto",
              instructions: "将直接复用已登录的浏览器配置，无需重新登录。",
              callback: async () => {
                const dir = String(inputs?.profileDir ?? "").trim() || latestProfile()
                if (!dir)
                  return { type: "failed", error: "没有找到已登录的浏览器配置。请先用窗口登录，或填一个配置目录。" }
                // name the account by its Google email — a profile dir
                // string means nothing to the user
                let who = ""
                try {
                  const check = new RelayBrowser({ profileDir: dir, headless: true })
                  try {
                    const page = await check.ensure()
                    const t = await page.eval(`(() => {
                      const html = document.documentElement.innerHTML
                      return (html.match(/"oPEP7c":"([^"]+)"/) || [])[1] || ""
                    })()`)
                    if (t) who = t
                  } finally {
                    await check.stop()
                  }
                } catch {}
                who = who || "Gemini 账号"
                return { type: "success", access: JSON.stringify({ profileDir: dir }), refresh: dir, expires: 0, accountId: who, name: who }
              },
            }
          },
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
        apiKey: "gemini-web-relay",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? new Request(input, init) : null
          const url = new URL(request ? request.url : String(input))
          const method = request ? request.method : init.method ?? "GET"
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/chat/completions") || method !== "POST")
            return json(404, "gemini-web-relay 只提供 chat/completions。", "not_found")
          let body
          try {
            body = JSON.parse(request ? await request.text() : String(init.body ?? "{}"))
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const table = accountKey(auth) === ANONYMOUS ? VISITOR : MODELS
          const model = String(body.model ?? "gemini-auto").replace(/^gemini-web-relay\//, "")
          let m = table[model] ?? (accountKey(auth) === ANONYMOUS ? undefined : MODELS[model])
          if (!m) return json(404, `没有模型 ${model}。可用：${Object.keys(table).join("、")}。`, "model_not_found")
          // 4 Neon carries its thinking depth as the request's reasoning
          // effort (the app's own 低/中/高 selector); unset = the app default
          if (body.reasoning_effort && m.b14 === 3) {
            try {
              m = { ...m, b15: thinkingByte(body.reasoning_effort) }
            } catch (e) {
              return json(400, String(e?.message ?? e), "invalid_request_error")
            }
          }
          const prompt = flatten(body)
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => Math.ceil(prompt.length / 3)
          // strict by default: a silent tier downgrade (asked Neon, served
          // Hydrogen) must fail loudly rather than pass as if fine
          const strictModel = body.strict_model !== false
          try {
            if (body.stream)
              return await sse({ id, model, signal: request?.signal, promptTokens, newId: () => "call_" + Math.random().toString(36).slice(2, 14), ask: (onUpdate, sig) => wrapAsk(session, prompt, m, onUpdate, sig, strictModel) })
            const final = await session.ask(prompt, { model: m, signal: request?.signal, strictModel })
            return Response.json(completion({ id, model, final, promptTokens: promptTokens(), newId: () => "call_" + Math.random().toString(36).slice(2, 14) }))
          } catch (e) {
            if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
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
  const dir = options?.profileDir || process.env.GEMINI_WEB_RELAY_PROFILE || latestProfile()
  return createPlugin({ profileDir: dir, headless: options?.headless ?? true })
}

import { readFileSync, readdirSync, statSync } from "node:fs"

// latestProfile picks the most recently used signed-in profile under THIS
// plugin's own browser root, so a sign-in made through the plugin's window
// can be reused without signing in again. A profile counts only when its
// cookie store holds a session (__Secure-1PSID), not merely analytics
// cookies. Nothing outside the plugin's root is ever read.
function latestProfile() {
  const root = profileRoot()
  if (!root || !exists(root)) return undefined
  let best = null
  let bestAt = 0
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      const at = statSync(p).mtimeMs
      if (at > bestAt && hasSessionCookie(p)) {
        best = p
        bestAt = at
      }
    } catch {}
  }
  return best ?? undefined
}

function hasSessionCookie(profile) {
  for (const f of [join(profile, "Default", "Network", "Cookies"), join(profile, "Cookies")]) {
    try {
      if (statSync(f).size <= 0) continue
      // the value is encrypted; the name in plain text is enough here
      const buf = readFileSync(f)
      return buf.includes("__Secure-1PSID")
    } catch {}
  }
  return false
}

function exists(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

export const _internal = { createPlugin, MODELS, GeminiError, findChrome }

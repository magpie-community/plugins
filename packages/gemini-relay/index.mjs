// The Gemini web app as a magpie provider, through a long-lived real
// browser relay. A bare Node client is /sorry-ed by Google on many
// networks; the same request sent from inside the app's own page (its
// cookies, its TLS) is served. The browser stays up across requests; one
// in-page fetch per chat request, read as it streams.
//
// Beyond the old temporary-chat relay this adds: server-side
// conversation continuation (the shared SessionPool — a follow-up sends
// only the new user text), the full model table with per-tier thinking
// depths, tool calls over the ```tool_call fence, image upload through
// the app's storage endpoint, and a background cookie rotator.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { ACCOUNTS_URL, RelayBrowser, findChrome, pageEmail, profileRoot, signIn } from "./browser.mjs"
import { GeminiError, MODELS, RelaySession, thinkingByte } from "./relay.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"
import { SessionPool } from "./session_pool.mjs"
import { uploadFile } from "./upload.mjs"
import { CookieRotator } from "./rotate.mjs"

const ID = "gemini-relay"
const BASE = "https://gemini-relay.invalid/v1"
// the anonymous account: no cookies, the app serves what it serves visitors
const ANONYMOUS = "anonymous"
// visitors get the app's Auto only (the old gemini-web plugin's way)
const VISITOR = { "gemini-auto": MODELS["gemini-auto"] }

// the icon magpie renders natively on provider cards (a base64 data-URL
// shows as a square box there — registry.json's gemini-color is the name)
const ICON = "gemini-color"

// a non-streamed turn must answer within magpie's first-token deadline
// (60 s) or the gateway reads "no answer": the hard cap sits below it so
// the caller gets a real error, not a gateway timeout
const NON_STREAM_BUDGET_MS = 55_000

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

function models(table) {
  const out = {}
  for (const [id, m] of Object.entries(table))
    out[id] = {
      name: m.name,
      limit: { context: 128000, output: 32768 },
      tool_call: true,
      reasoning: m.mode === 3 || m.mode === 8,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    }
  return out
}

export function createPlugin({ profileDir, headless = true, signInImpl = signIn, pageEmailImpl = pageEmail, accountNameImpl = null } = {}) {
  // signInImpl / pageEmailImpl / accountNameImpl exist so the auth callback
  // can be exercised offline: signIn() is the user's window, the other two
  // read the account's name afterwards.
  //
  // One relay browser and session per account, kept across requests: the
  // anonymous account runs its own signed-out browser.
  const browsers = new Map()
  const browserFor = (key) => {
    let b = browsers.get(key)
    if (!b) {
      b = new RelayBrowser({ profileDir: key === ANONYMOUS ? undefined : key, headless })
      // the cookie rotator rides the browser's own lifecycle: started with
      // the page, stopped with the browser, failures only logged
      b.rotatorFactory = (browser) =>
        new CookieRotator({
          page: () => browser._page,
          cookies: () => browser.cookies?.(),
          onError: (e) => console.warn("[gemini-relay] cookie 轮换失败：", String(e?.message ?? e)),
        })
      browsers.set(key, b)
    }
    return b
  }
  // the shared conversation pool: one server-side conversation per
  // message history, across all accounts (entries are bound to their
  // account/browser/model, so sharing the map is safe)
  const pool = new SessionPool()

  // accountName reads an account's Google email with a browser of its own
  // on the account's already-signed profile. It deliberately does NOT
  // borrow the account's long-lived relay browser: reading a name means
  // sitting on accounts.google.com, and the relay's chat runs inside the
  // app's own page (its cookies and session context decide the tier) —
  // a name read must never move that page. The profile is signed in, so a
  // quiet headless window started on the accounts page costs one short
  // load and answers the account; "" when Google's risk control hides it
  // right now, since the name is cosmetic and the cookies decide what is
  // served.
  const accountName = accountNameImpl ?? (async (profileDir) => {
    if (!profileDir) return ""
    const check = new RelayBrowser({ profileDir, headless: true, startUrl: ACCOUNTS_URL })
    try {
      return await pageEmailImpl(check)
    } catch {
      return ""
    } finally {
      await check.stop().catch(() => {})
    }
  })

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
  const sessionFor = (auth) => {
    const key = accountKey(auth)
    return new RelaySession({ browser: browserFor(key), pool, accountKey: key })
  }

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
                cookies = await signInImpl(profile)
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
          // thinking depth rides the request's reasoning effort (the app's
          // own 低/中/高 selector); unset = the app default. An invalid
          // value is a 400 whatever the model; a valid one on a model
          // without depths is a 400 too — silently ignoring a client's
          // requested constraint would mislead it.
          if (body.reasoning_effort) {
            let think
            try {
              think = thinkingByte(body.reasoning_effort)
            } catch (e) {
              return json(400, String(e?.message ?? e), "invalid_request_error")
            }
            if (!(m.mode === 3 || m.mode === 8)) return json(400, `模型 ${m.name} 没有思考深度选择，reasoning_effort 仅 4 Neon / 4 Carbon 支持。`, "invalid_request_error")
            m = { ...m, think }
          }
          // images ride the OpenAI content parts; they are uploaded
          // through the app's storage endpoint and carried in inner[0][3].
          // An upload failure is not fatal: the turn degrades to the same
          // text placeholder a non-carried image gets. The page is only
          // reached when there is something to upload.
          const files = []
          const messages = await extractImages(body.messages, async (data, mime) => {
            const page = await session.browser.ensure()
            const ref = await uploadFile(page, { data, filename: "image.png", mime })
            files.push(ref)
          })
          const prompt = flatten({ messages, tools: body.tools })
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => Math.ceil(prompt.length / 3)
          // strict by default: a silent tier downgrade (asked Neon, served
          // Hydrogen) must fail loudly rather than pass as if fine
          const strictModel = body.strict_model !== false
          // the inner[0][3] file references ride the ask's options
          const askOptions = {
            model: files.length ? { ...m, files } : m,
            signal: request.signal,
            strictModel,
            messages,
            continueConversation: body.continue_conversation !== false,
          }
          try {
            if (body.stream)
              return await sse({ id, model, signal: request.signal, promptTokens, ask: (onUpdate, sig) => wrapAsk(session, prompt, { ...askOptions, signal: sig }, onUpdate) })
            // non-streamed: the whole answer must land inside magpie's
            // first-token deadline (60 s), so the turn is cut at 55 s with
            // a real error — the gateway's own "no answer in 1m0s" reads
            // as a dead model, this reads as what happened
            const budget = new AbortController()
            const timer = setTimeout(() => budget.abort(new Error("回答超过 55 秒仍未完成（非流式上限，可改用 stream）。")), NON_STREAM_BUDGET_MS)
            const onAbort = () => budget.abort(request.signal?.reason)
            request.signal?.addEventListener("abort", onAbort, { once: true })
            try {
              const final = await session.ask(prompt, { ...askOptions, signal: budget.signal })
              return Response.json(completion({ id, model, final, promptTokens: promptTokens() }))
            } finally {
              clearTimeout(timer)
              request.signal?.removeEventListener("abort", onAbort)
            }
          } catch (e) {
            // a client abort travels as a real AbortError (or as the
            // relay's own cancelled error): rethrow so the SDK sees the
            // cancel — never answer it with a body, and never with an
            // invalid 499 status that the Response constructor rejects
            if (e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "aborted") {
              // the 55 s budget, not the client: say so, as a gateway
              // timeout the SDK can show
              if (request.signal && !request.signal.aborted) return json(504, "回答超过 55 秒仍未完成（非流式上限，可改用 stream）。", "timeout")
              throw new DOMException("已取消", "AbortError")
            }
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

// extractImages walks the messages' content arrays: every image_url part
// with a data: URL is decoded and uploaded, and its part is replaced by
// plain text (the flattened prompt carries text only). A failed upload
// degrades to the placeholder text instead of failing the turn.
async function extractImages(messages, upload) {
  const out = []
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) {
      out.push(m)
      continue
    }
    const parts = []
    for (const c of m.content) {
      const url = c?.image_url?.url ?? c?.image_url
      const isData = typeof url === "string" && url.startsWith("data:")
      if (c?.type === "image_url" && isData) {
        try {
          const [head, b64] = url.split(",", 2)
          const mime = (head.match(/data:([^;]+)/) ?? [])[1] || "image/png"
          await upload(Buffer.from(b64, "base64"), mime)
          parts.push({ type: "text", text: "[图片已上传，随本条消息发送]" })
          continue
        } catch {
          parts.push({ type: "text", text: "[此消息带有一张图片：图片上传失败]" })
          continue
        }
      }
      parts.push(c)
    }
    out.push({ ...m, content: parts })
  }
  return out
}

// ask with streaming updates: the relay reads the whole reply at once (the
// page's fetch is already streamed), so onUpdate fires once with the final
// text — enough for the SSE wrapper to emit it as one chunk set.
function wrapAsk(session, prompt, options, onUpdate) {
  return session.ask(prompt, options).then((final) => {
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

export const _internal = { createPlugin, MODELS, GeminiError, findChrome, SessionPool, CookieRotator, uploadFile }

// @magpie-community/opencode-catpaw-auth — the 妙手 (CatPaw, Meituan)
// provider plugin for OpenCode and magpie.
//
// Signs in with a browser web login or the CatPaw desktop client's saved
// credentials, then runs each chat completion through its conversation
// protocol: round → event(running) → turn(SSE). The SSE frames are
// cumulative, so each is diffed against the last to make OpenAI deltas.
// The request shapes are the desktop client's own, captured 2026-10-09
// (testdata/captured-*.json; the simplified chain was first verified in
// catpaw-proxy.mjs the same day); conversation reuse and tool continuation
// are phase 2.

const ID = "catpaw"
const NAME = "妙手 CatPaw"

const ORIGIN = "https://ai.catpaw.meituan.com"

// the credit balance endpoint. A different host *and* a different auth header
// from the conversation gateway: it takes `X-Auth-Token` and rejects
// `X-Passport-Token` / `Cookie` / `Authorization` with 401 code 4010 (see
// usage() — sending the cookie here marks the account signed out).
const balanceUrl = () => process.env.CATPAW_BALANCE_URL || "https://catx.nocode.cn/api/gateway/credit/balance"

// the passport domain the web sign-in runs on (login-config / poll-token /
// current-user, none of them authenticated; the vendor serves them from
// catx.nocode.cn while the conversation gateway is ai.catpaw.meituan.com)
const passportBase = () => process.env.CATPAW_PASSPORT_BASE || "https://catx.nocode.cn"

// how long a read of the desktop client's auth.json is trusted before being
// read again (the proxy's 5-minute cache)
const AUTH_TTL = 5 * 60_000

// ── the desktop client's model table (the proxy's MODEL_MAP, deduped) ──────

const MODELS = {
  "longcat-2.0": { name: "LongCat-2.0 (限时免费)", type: 77, image: true },
  "glm-5.3-flashx": { name: "GLM-5.3-FlashX", type: 98, image: true },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", type: 91, image: true },
  "glm-5.3": { name: "GLM-5.3", type: 89, image: false },
  "deepseek-v4-flash": { name: "DeepSeek-V4-Flash", type: 63, image: false },
  "deepseek-v4-pro": { name: "DeepSeek-V4-Pro", type: 64, image: false },
  "minimax-m3": { name: "MiniMax-M3", type: 70, image: true },
  "kimi-k3": { name: "Kimi-K3", type: 83, image: true },
  auto: { name: "Auto (自动选择)", type: 0, image: false },
}
const DEFAULT_MODEL_TYPE = 77
const modelTypeOf = (id) => MODELS[id]?.type ?? DEFAULT_MODEL_TYPE

// no modalities (the conversation prompt is text-only — see the 400s above)
// and no `limit` (the client publishes no per-model context or output
// window; an invented number would lie to the agent sizing its prompts)
const configModel = (id, m) => ({
  name: m.name,
})

// ── small helpers ──────────────────────────────────────────────────────────

const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

// ── credentials: the desktop client's file, read live ─────────────────────

const fs = await import("node:fs")
const os = await import("node:os")
const path = await import("node:path")

function authPath() {
  return process.env.CATPAW_AUTH_PATH || path.join(os.homedir(), ".meituan-catpaw", "auth.json")
}

// readAuth reads the desktop client's auth.json — every time, so a re-login
// in 妙手 is picked up without restarting magpie. mtime-checked to skip
// re-reading an unchanged file.
let cachedAuth = null
let cachedAt = 0
function readAuth() {
  const p = authPath()
  let mtime = 0
  try {
    mtime = fs.statSync(p).mtimeMs
  } catch {
    throw new SignedOut(`未找到妙手登录态文件 ${p}：请安装并登录妙手桌面端，或改用"手动粘贴 token"登录`)
  }
  if (cachedAuth && cachedAt === mtime) return cachedAuth
  const file = JSON.parse(fs.readFileSync(p, "utf8"))
  const token = file?.auth?.accessToken
  if (!token) throw new SignedOut(`妙手登录态文件里没有 accessToken（${p}）：请在妙手桌面端重新登录`)
  cachedAuth = { token, uid: String(file?.account?.uid ?? "") }
  cachedAt = mtime
  return cachedAuth
}

class SignedOut extends Error {}
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

// the auth.json account name, for the sign-in's display
function authAccount() {
  try {
    return JSON.parse(fs.readFileSync(authPath(), "utf8"))?.account?.name || "妙手桌面端账号"
  } catch {
    return "妙手桌面端账号"
  }
}

// ── the gateway ────────────────────────────────────────────────────────────

// gatewayHeaders is what every CatPaw request carries. Every value is what
// the official desktop client itself puts on the wire — captured 2026-10-09
// from the client talking to its own gateway (002…round.json / 004…turn.json
// in the capture set): the axios UA, m-debug: true, the m-appkey, the trace
// ids. The capture's m-host carried the client machine's LAN IP; that is not
// a value we can truthfully send from somewhere else, so the header is left
// off entirely rather than invented.
function gatewayHeaders(token, extra = {}) {
  const traceId = crypto.randomUUID().replace(/-/g, "")
  return {
    "Content-Type": "application/json",
    Cookie: `X-Passport-Token=${token}`,
    "User-Agent": "axios/1.19.0",
    "m-appkey": "com.sankuai.mcopilot.cli",
    "m-debug": "true",
    "m-traceid": traceId,
    "x-request-id": crypto.randomUUID(),
    "x-trace-id": traceId,
    "x-agent-version": "1.2.0-beta.6",
    ...extra,
  }
}

async function gatewayPost(pathname, body, token, extraHeaders, signal) {
  const res = await fetch(ORIGIN + pathname, {
    method: "POST",
    headers: gatewayHeaders(token, extraHeaders),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  return { status: res.status, text }
}

// buildPrompt flattens the messages into the one text the conversation
// protocol carries (the proxy's buildPrompt)
function buildPrompt(messages) {
  const parts = []
  for (const msg of messages) {
    const role = msg.role || "user"
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c) => c.text || "").join("")
          : ""
    if (role === "system") parts.push(`[System Instructions]\n${content}`)
    else if (role === "user") parts.push(`[User]\n${content}`)
    else if (role === "assistant") parts.push(`[Assistant]\n${content}`)
  }
  if (messages.length === 1 && messages[0].role === "user") {
    const m = messages[0]
    return typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c) => c.text || "").join("")
        : ""
  }
  return parts.join("\n\n")
}

// runConversation: round → event(running) → turn(SSE), yielding OpenAI-shaped
// deltas from the cumulative frames (the proxy's catpawComplete, as a stream)
async function* runConversation(token, chat, signal) {
  const modelType = modelTypeOf(chat.model)
  const convId = crypto.randomUUID()
  const msgId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const prompt = buildPrompt(chat.messages ?? [])

  // ① round: create the conversation
  const r1 = await gatewayPost(
    "/api/agent/conversation/round",
    {
      conversationId: convId,
      message: { type: "user", messageId: msgId, content: [{ type: "text", text: prompt }], finished: true },
      modelType,
      // the client's own round body (testdata/captured-round.json): CLI
      // identity end to end — these source/mode values ride the same
      // captured request as the CLI headers gatewayHeaders sends
      source: "CatPawCLI",
      mode: "CLI",
      // the client's own round/turn bodies carry this exact value (captured
      // 2026-10-09, both requests) — the client's default, not ours
      permissionMode: "unsafeBypassPermissions",
      toolVersion: "2.0.2",
      repositories: [],
    },
    token,
    { "m-spanid": "0.2", "m-spanname": "conversation.round" },
    signal,
  )
  const r1j = JSON.parse(r1.text || "{}")
  if (r1.status !== 200 || r1j.code !== 0)
    throw new Error(`妙手 round 失败：HTTP ${r1.status} code=${r1j.code ?? "?"} msg=${r1j.msg ?? r1j.message ?? ""}`)

  // ② event: mark the conversation as running
  const r2 = await gatewayPost(
    "/api/agent/conversation/event",
    { conversationId: convId, eventType: "conversation", data: { status: "running" } },
    token,
    { "m-spanid": "0.3", "m-spanname": "conversation.event" },
    signal,
  )
  if (r2.status !== 200) throw new Error(`妙手 event 失败：HTTP ${r2.status}`)

  // ③ turn: the SSE answer. Every frame's content is the whole text so far,
  // so each is diffed against the last; the reply is yielded as deltas.
  const turnBody = JSON.stringify({
    conversationId: convId,
    turnRequestId: turnId,
    message: { type: "user", messageId: msgId, content: [{ type: "text", text: prompt }], finished: true },
    modelType,
    // the client's own turn body (testdata/captured-turn.json): CLI identity
    source: "CatPawCLI",
    mode: "CLI",
    // the client's own round/turn bodies carry this exact value (captured
    // 2026-10-09, both requests) — the client's default, not ours
    permissionMode: "unsafeBypassPermissions",
    toolConfigs: [],
    toolVersion: "2.0.2",
  })
  const res = await fetch(ORIGIN + "/api/agent/conversation/turn", {
    method: "POST",
    headers: gatewayHeaders(token, {
      Accept: "text/event-stream",
      enableheartbeat: "true",
      "m-spanid": "0.4.1",
      "m-spanname": "conversation.turn",
    }),
    body: turnBody,
    // a total timeout over the whole response, as the reference's
    // SSE_TIMEOUT_MS = 15min: long tool-loop answers stream the whole time,
    // a shorter cap would cut them off mid-answer
    signal: signal ?? AbortSignal.timeout(15 * 60e3),
  })
  if (res.status !== 200) throw new Error(`妙手 turn 失败：HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 500)}`)
  if (!res.body) throw new Error("妙手 turn 返回了空流")

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffered = ""
  let prevText = ""
  let prevReasoning = ""
  let finalText = ""
  let finalReasoning = ""
  let frameCount = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") {
        yield { done: true, text: finalText, reasoning: finalReasoning }
        return
      }
      let frame
      try {
        frame = JSON.parse(data)
      } catch {
        continue
      }
      frameCount++
      if (frame.error) throw new Error(`妙手 SSE 错误：code=${frame.error.code} msg=${frame.error.message || ""}`)
      const msg = frame.message
      if (!msg || !Array.isArray(msg.content)) continue
      for (const c of msg.content) {
        if (c.type !== "text") continue
        const curText = c.text || ""
        if (curText.length > prevText.length) {
          yield { delta: curText.slice(prevText.length) }
          prevText = curText
        }
        finalText = curText
        const curReasoning = c.reasoningContent || ""
        if (curReasoning.length > prevReasoning.length) {
          yield { reasoningDelta: curReasoning.slice(prevReasoning.length) }
          prevReasoning = curReasoning
        }
        finalReasoning = curReasoning
      }
    }
  }
  // the stream ended without [DONE]
  if (finalText === "" && frameCount === 0) throw new Error("妙手 SSE 流结束但没有任何帧")
  yield { done: true, text: finalText, reasoning: finalReasoning }
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function CatPawAuthPlugin({ client } = {}) {
  return {
    auth: {
      provider: ID,
      // CatPaw has no refresh: the sign-in lives in the desktop client's
      // auth.json and is re-read before every request (mtime-checked), so
      // an "expiry" is just the next read finding a new file
      async loader(getAuth) {
        const a = await getAuth()
        return {
          baseURL: ORIGIN,
          apiKey: "catpaw",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return errorResponse(404, "only chat completions are served")
            const raw = await bodyText(input, init)
            let chat
            try {
              chat = JSON.parse(raw)
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            if (!Array.isArray(chat.messages) || chat.messages.length === 0)
              return errorResponse(400, "messages is required")
            if (!(chat.model in MODELS) && String(chat.model).trim() !== "")
              return errorResponse(400, `unknown model "${chat.model}" (known: ${Object.keys(MODELS).join(", ")})`)
            // the flattened one-text prompt the conversation protocol carries
            // has no room for tool schemas, tool results or image parts: a
            // request carrying any of them would get an answer that never
            // calls a tool and never sees the image, with nothing saying why
            // — refuse it instead (tool continuation is a later phase)
            if (Array.isArray(chat.tools) && chat.tools.length > 0)
              return errorResponse(400, "this provider cannot run tools: the conversation protocol takes one flattened text prompt, so tool definitions would be silently dropped (refused rather than answered wrongly)")
            if (chat.messages.some((m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_call" || c?.type === "tool_use" || c?.type === "tool_result"))))
              return errorResponse(400, "this provider cannot continue a tool call: the conversation protocol takes one flattened text prompt, so tool results would be silently dropped (refused rather than answered wrongly)")
            // image_url is what @ai-sdk/openai-compatible actually sends
            // ({"type":"image_url","image_url":{…}}); input_image is the
            // responses-API shape some clients carry over
            if (chat.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "image" || c?.type === "image_url" || c?.type === "input_image" || (typeof c?.text === "string" && c.text.startsWith("data:image/")))))
              return errorResponse(400, "this provider cannot take images through the text-only conversation prompt (refused rather than silently dropped)")

            // the token: only the desktop method's credentials live in the
            // client's auth.json — a web sign-in or a paste carries its own
            // token in the account record, and a request made in account A's
            // name must never be spent on whatever account the desktop app
            // happens to hold
            let token
            let accountName
            const a = await getAuth()
            if (a?.type === "oauth" && a.access && a.source !== "desktop") {
              token = a.access
              accountName = a.name || a.accountId || (a.source === "web" ? "妙手网页登录" : "手动粘贴")
            } else {
              try {
                const file = readAuth()
                token = file.token
                accountName = authAccount()
              } catch (e) {
                return errorResponse(e instanceof SignedOut ? 401 : 502, String(e?.message ?? e))
              }
            }
            if (!token) return errorResponse(401, "妙手登录态缺失：请登录妙手桌面端或手动粘贴 token")

            // the answer as an OpenAI Response, streaming or not
            const model = chat.model || "longcat-2.0"
            const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
            const created = Math.floor(Date.now() / 1000)

            if (chat.stream) {
              const encoder = new TextEncoder()
              const chunk = (delta, finish, reasoningDelta) => {
                const choices = [{ index: 0, delta: {}, finish_reason: finish ?? null }]
                if (delta) choices[0].delta.content = delta
                if (reasoningDelta) choices[0].delta.reasoning_content = reasoningDelta
                return encoder.encode(
                  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices })}\n\n`,
                )
              }
              const stream = new ReadableStream({
                async start(controller) {
                  controller.enqueue(chunk(null, null)) // the role frame
                  try {
                    for await (const ev of runConversation(token, chat, init.signal)) {
                      if (ev.delta) controller.enqueue(chunk(ev.delta, null))
                      if (ev.reasoningDelta) controller.enqueue(chunk(null, null, ev.reasoningDelta))
                      if (ev.done) {
                        controller.enqueue(chunk(null, "stop"))
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                      }
                    }
                  } catch (e) {
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e) } })}\n\n`),
                    )
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  }
                  controller.close()
                },
              })
              return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
            }

            let text = ""
            let reasoning = ""
            try {
              for await (const ev of runConversation(token, chat, init.signal)) {
                if (ev.done) {
                  text = ev.text
                  reasoning = ev.reasoning
                }
              }
            } catch (e) {
              return errorResponse(e?.message?.includes("401") ? 401 : 502, String(e?.message ?? e))
            }
            return new Response(
              JSON.stringify({
                id,
                object: "chat.completion",
                created,
                model,
                choices: [{ index: 0, message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop" }],
                // no usage block: the conversation protocol returns no token
                // counts, and zeros would read as real ones
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          },
        }
      },
      // the credit balance the desktop client's own gateway API serves.
      //
      // ⚠️ This endpoint's auth header is `X-Auth-Token`, **not** the
      // conversation gateway's `Cookie: X-Passport-Token` — the same
      // accessToken either way, but the cookie here answers 401 code 4010
      // ("Authentication token is required"). Getting that wrong is not a
      // cosmetic bug: a 401 from usage is how magpie learns an account's
      // sign-in is gone, so the wrong header marks a live account as signed
      // out on its card (`lapsed` in logins.json).
      async usage(getAuth) {
        const a = await getAuth()
        let token
        // same split as the loader: only the desktop method reads the
        // client's auth.json; every stored account spends its own token
        if (a?.type === "oauth" && a.access && a.source !== "desktop") token = a.access
        else {
          try {
            token = readAuth().token
          } catch (e) {
            return { error: String(e?.message ?? e), signIn: "kept" }
          }
        }
        let res
        try {
          res = await fetch(balanceUrl(), {
            headers: {
              Accept: "application/json",
              "X-Auth-Token": token,
              // the client's own marker; not required, but its real shape
              "gray-set": "new-agent-sdk",
            },
            signal: AbortSignal.timeout(20_000),
          })
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
        const payload = await res.json().catch(() => null)
        const code = typeof payload?.code === "number" ? payload.code : null
        // two credential paths: HTTP 401, and the body's 4010 (no token) /
        // 4011 (token refused)
        if (res.status === 401 || code === 4010 || code === 4011)
          return { error: "妙手登录态已过期，请在妙手桌面端重新登录", signIn: "expired" }
        if (!res.ok) return { error: `妙手余额查询返回 HTTP ${res.status}`, signIn: "kept" }
        if (!payload) return { error: "妙手余额响应无法解析", signIn: "kept" }
        if (code !== 0) return { error: `妙手余额查询返回异常 code=${code ?? "null"}`, signIn: "kept" }
        const data = payload.data
        if (!data || typeof data !== "object") return { error: "妙手余额响应缺少 data", signIn: "kept" }
        const credit = data.availableCredits ?? data.credit ?? data.balance ?? data.available
        const plan = data.userPlan ?? {}
        if (credit == null) return { error: `余额接口没有返回积分数额（${JSON.stringify(data).slice(0, 120)}）`, signIn: "kept" }
        // no `signIn` on a clean read: magpie reads that as "the sign-in is
        // fine" and takes the expired mark back off the account. Saying
        // "kept" here instead would leave a lapse — this read's or an
        // earlier transient 401's — on the card until a manual re-login.
        return {
          plan: plan.planName || (plan.pro ? "妙手 CatPaw Pro" : NAME),
          user: a?.type === "oauth" && a.source !== "desktop" ? a.name || a.accountId || "妙手网页登录" : authAccount(),
          windows: [{ name: "可用积分", used: 0, display: `${credit} credit`, aside: true }],
        }
      },
      // CatPaw has no check-in (confirmed: no such activity in its client)
      methods: [
        {
          type: "oauth",
          label: "网页登录（妙手官方授权页，Web sign-in）",
          authorize: async () => {
            // the vendor's own two-channel web login, the poll channel only:
            // login-config names the entry URL, the browser login claims the
            // sid, and GET poll-token?sid hands the token straight to us —
            // server-to-server, no loopback listener, immune to the browser's
            // private-network check that breaks the vendor's own POST channel
            // (agent2api login/catpaw.rs, the official client's Promise.race)
            const state = crypto.randomUUID().replace(/-/g, "")
            const sid = crypto.randomUUID().replace(/-/g, "")
            let entry
            try {
              const res = await fetch(`${passportBase()}/api/gateway/passport/login-config`, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(10_000),
              })
              const payload = await res.json().catch(() => null)
              entry = payload?.data?.loginEntryUrl
            } catch (e) {
              return { type: "failed", error: `无法连接妙手登录服务: ${e?.message ?? e}` }
            }
            if (!entry) return { type: "failed", error: "妙手登录服务未返回登录入口地址" }
            const url = new URL(entry)
            url.searchParams.set("state", state)
            url.searchParams.set("sid", sid)
            url.searchParams.set("redirect", `http://127.0.0.1:9/catpaw-callback`)
            return {
              url: url.href,
              instructions:
                "浏览器打开上面的妙手登录页并完成登录。登录成功后本插件会自动拿到登录态（约几秒），无需手动输入任何东西；若长时间停在完成页，请回到 magpie 重试一次。",
              method: "auto",
              callback: async () => {
                // poll-token every second until the browser login claims the
                // sid (data: null = not yet), 3 minutes overall like agent2api
                const deadline = Date.now() + 180_000
                let token
                while (Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 1000))
                  try {
                    const res = await fetch(`${passportBase()}/api/gateway/passport/poll-token?sid=${sid}`, {
                      headers: { Accept: "application/json" },
                      signal: AbortSignal.timeout(5_000),
                    })
                    const payload = await res.json().catch(() => null)
                    const t = typeof payload?.data === "string" ? payload.data.trim() : ""
                    if (t) {
                      token = t
                      break
                    }
                  } catch {
                    // a single failed poll is skipped, like the vendor's client
                  }
                }
                if (!token) return { type: "failed", error: "网页登录超时（3 分钟内未取到登录态），请重试" }
                // current-user fills uid/name; failing it does not fail the
                // sign-in (the token itself is already in hand)
                let accountId = "妙手网页登录"
                let uid = ""
                try {
                  const res = await fetch(`${passportBase()}/api/gateway/passport/current-user`, {
                    headers: { Accept: "application/json", "X-Auth-Token": token },
                    signal: AbortSignal.timeout(10_000),
                  })
                  const payload = await res.json().catch(() => null)
                  const data = payload?.data
                  if (data) {
                    uid = String(data.userId ?? "") === "null" ? "" : String(data.userId ?? "")
                    if (data.userName) accountId = data.userName
                  }
                } catch {}
                return { type: "success", refresh: "", access: token, expires: 0, accountId, ...(uid ? { uid } : {}), source: "web" }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "妙手桌面端登录态（CatPaw desktop sign-in）",
          authorize: () => ({
            url: "",
            instructions: "使用本机妙手桌面端已保存的登录态（每次请求前实时读取，重开妙手即自动刷新）。",
            method: "auto",
            callback: async () => {
              try {
                const auth = readAuth()
                // refresh is present-but-empty: magpie's host only keeps a
                // sign-in whose result has a refresh field, and CatPaw has
                // no refresh to give (the token lives in the desktop file)
                return { type: "success", refresh: "", access: auth.token, expires: 0, accountId: authAccount(), uid: auth.uid, source: "desktop" }
              } catch (e) {
                return { type: "failed", error: String(e?.message ?? e) }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 token（Paste token）",
          prompts: [{ type: "text", key: "token", message: "accessToken（X-Passport-Token 的值）", validate: (v) => (v && v.trim() ? undefined : "必填") }],
          // an oauth authorize() hands back {url, method, instructions,
          // callback} and the host finishes the sign-in by calling
          // callback() — returning the account directly leaves the host
          // waiting on a callback that doesn't exist
          authorize: async (inputs) => {
            const token = String(inputs?.token ?? "").trim()
            if (!token) return { type: "failed", error: "token 必填" }
            return {
              url: "",
              instructions: "已取到粘贴的 token，确认即完成登录。",
              method: "auto",
              callback: async () => ({ type: "success", refresh: "", access: token, expires: 0, accountId: "手动粘贴", source: "manual" }),
            }
          },
        },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: ORIGIN,
        ...was,
        models: { ...Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, configModel(id, m)])), ...(was.models ?? {}) },
      }
    },
  }
}

// for tests
export const _internal = { ID, NAME, MODELS, modelTypeOf, buildPrompt, gatewayHeaders, gatewayHeadersForTest: gatewayHeaders, readAuth, authPath, configModel }

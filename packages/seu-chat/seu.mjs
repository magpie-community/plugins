// ChatSEU 网页接口的客户端，按 ChatSEU 网页自己的方式调用：
//   GET  /api/cas/userInfo            当前登录的用户
//   POST /api/chat/streamchat         发一条消息（新对话），response 是 messageId
//   GET  /api/chat/streamchat?messageId=…    该消息的 SSE 回复
//   POST /api/chat/del-conversation   删掉用完即弃的对话
// 整个插件的会话凭据是 chatseu.seu.edu.cn 的 cookie（整包保存，不做白名单）。
import { readSSE, Assembler } from "./sse.mjs"
import { SeuError } from "./errors.mjs"

export { SeuError }

export const ORIGIN = "https://chatseu.seu.edu.cn"
export const CHAT_URL = ORIGIN + "/chat"
export const LOGIN_URL =
  "https://auth.seu.edu.cn/dist/#/dist/main/login?service=" + encodeURIComponent(ORIGIN + "/api/cas/call-back?url=L2NoYXQ*")
// 网页端的上下文比真正的 API 小得多，超了直接不发送。实测站点能
// 处理约 90 万字符（28 万 token），95 万字符回空回复；取 85 万，
// 留 5% 余量。
export const MAX_PROMPT = 850_000

// 模型表：id → { name, code }。code 是网页发给后端的数字型号
// （从前端 bundle 逆出：4 = GLM5.3-Flash，3 = Qwen3.8-Flash-Next），
// package.json 的 magpie.options.models 可以覆盖或追加。
export const MODELS = {
  "glm-5.3-flash": { name: "GLM5.3-Flash", code: 4 },
  "qwen3.8-flash-next": { name: "Qwen3.8-Flash-Next", code: 3 },
}

export function modelsOf(options = {}) {
  const out = { ...MODELS }
  for (const m of Array.isArray(options.models) ? options.models : []) {
    if (m && typeof m.id === "string" && m.id && Number.isInteger(m.code)) out[m.id] = { name: String(m.name ?? m.id), code: m.code }
  }
  return out
}

// SeuError 定义在 errors.mjs（sse.mjs 也要抛它，避免循环 import）；上面 re-export。

// what Chrome sends；请求应该长得像这些 cookie 所来自的那个浏览器
export function userAgent(platform = process.platform) {
  const os =
    platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36`
}

export const cookieHeader = (cookies) =>
  Object.entries(cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")

// "Cookie: a=1; b=2" 或 "a=1; b=2" → {a:"1", b:"2"}；没有 "=" 的段丢弃
export function parseCookieHeader(str) {
  const out = {}
  for (const part of String(str ?? "").replace(/^Cookie:\s*/i, "").split(";")) {
    const at = part.indexOf("=")
    if (at <= 0) continue
    const k = part.slice(0, at).trim()
    if (k) out[k] = part.slice(at + 1).trim()
  }
  return out
}

// 把 res 的 set-cookie 合并进 cookies 的副本；值为空或 "delete" 的键删除；
// 没有可合并的就返回原对象。
export function mergeSetCookie(cookies, res) {
  const setCookies = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers?.get("set-cookie") ?? ""].flat()
  let out = null
  for (const line of setCookies.flat()) {
    if (!line) continue
    const pair = line.split(";")[0]
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const k = pair.slice(0, at).trim()
    const v = pair.slice(at + 1).trim()
    if (!k) continue
    out ??= { ...cookies }
    if (v === "" || v.toLowerCase() === "delete") delete out[k]
    else out[k] = v
  }
  return out ?? cookies
}

export class SeuClient {
  constructor({ cookies, fetchImpl = globalThis.fetch, onCookies, renew, platform = process.platform, timeouts = {} } = {}) {
    this.cookies = cookies ?? {}
    this.fetchImpl = fetchImpl
    this.onCookies = onCookies
    // 登录被拒时由调用方（index.mjs）用的无窗口续期；SeuClient 自己不用它
    this.renew = renew
    this.platform = platform
    this.timeouts = { connect: 30_000, stream: 600_000, idle: 120_000, ...timeouts }
  }

  // deadline 在 ms 内跑完 run；timeout 时以带 retryAfter 的 SeuError 中止
  // 传给 run 的 signal。外部 signal 先中止（客户端取消）则原样抛出。
  async deadline(run, signal, ms, label) {
    const ctl = new AbortController()
    let timedOut = false
    const err = new SeuError(`ChatSEU ${label}超时（${Math.round(ms / 1000)} 秒没有回音），请稍后重试。`, {
      code: "seu_timeout",
      status: 504,
      retryAfter: 0,
    })
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort(err)
    }, ms)
    timer.unref?.()
    const combined = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal
    try {
      return await run(combined)
    } catch (e) {
      if (timedOut) throw err
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  headers(extra = {}) {
    const h = {
      "user-agent": userAgent(this.platform),
      referer: CHAT_URL,
      origin: ORIGIN,
      accept: "application/json",
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    }
    if (Object.keys(this.cookies).length) h.cookie = cookieHeader(this.cookies)
    return h
  }

  // unwrap 把 ChatSEU 的应答（信封 {code, response} 或错误页）变成
  // response 或抛出带原因的 SeuError；每个应答的 set-cookie 合并存回。
  async unwrap(res) {
    // 只有站点真的续了 cookie 才写回账号（每次响应都写会让 magpie 反复重列账号）
    const merged = mergeSetCookie(this.cookies, res)
    if (merged !== this.cookies) {
      this.cookies = merged
      this.onCookies?.(merged)
    }
    if (res.status === 429)
      throw new SeuError("ChatSEU 说请求太多（HTTP 429），过一会儿再试。", { code: "rate_limited", status: 429, retryAfter: 60 })
    if (res.status === 302 || res.status === 401)
      throw new SeuError("ChatSEU 的登录已失效，请在 magpie 里重新登录。", { code: "seu_signed_out", status: 401, signIn: true })
    // aTrust（奇安信零信任网关）拦在 ChatSEU 前面：隧道在线但这个会话没过
    // 应用认证时，它回 307 + 自己的页面（title aTrust 2.0）。这不是 ChatSEU
    // 的错也不是登录失效 —— 是校园零信任客户端掉线/未认证（或请求被代理
    // 劫到校外出口），请求根本没到 ChatSEU。报出原因，别当成可重试的 502。
    if (res.status === 307) {
      const peek = (await res.text()).slice(0, 2000)
      if (/aTrust/i.test(peek))
        throw new SeuError("校园零信任网关 aTrust 把请求拦下了（HTTP 307）：请求没到 ChatSEU。请检查：① aTrust 客户端已连接并通过认证；② 代理/Clash 对 *.seu.edu.cn 走直连。", {
          code: "seu_atrust",
          status: 502,
        })
      throw new SeuError(`ChatSEU 回复 HTTP 307：${peek.slice(0, 200)}`, { status: 502 })
    }
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      if (!res.ok) throw new SeuError(`ChatSEU 回复 HTTP ${res.status}：${text.slice(0, 200)}`, { status: 502 })
      throw new SeuError(`ChatSEU 的回复不是 JSON：${text.slice(0, 200)}`, { status: 502 })
    }
    if (json?.code === 40301) throw new SeuError("ChatSEU 账号已被封禁，无法继续使用。", { code: "seu_blocked", status: 403 })
    if (json?.code === 401)
      throw new SeuError("ChatSEU 的登录已失效，请在 magpie 里重新登录。", { code: "seu_signed_out", status: 401, signIn: true })
    if (json?.code !== 0)
      throw new SeuError("ChatSEU：" + (json?.message ?? json?.msg ?? json?.error ?? "code " + json?.code), { status: 502 })
    return json.response
  }

  // → { name, uid, isadmin, apiKeyEndpoints }
  async userInfo({ signal } = {}) {
    const res = await this.fetchImpl(ORIGIN + "/api/cas/userInfo", { headers: this.headers(), redirect: "manual", signal })
    return await this.unwrap(res)
  }

  // 发一条消息并流式读回：→ { text, reasoning, conversationId }。
  // 无状态：conversationID 为空串新开对话，读完删掉。
  async ask(prompt, { modelCode, signal, onUpdate, onEvent } = {}) {
    if (String(prompt ?? "").length > MAX_PROMPT)
      throw new SeuError(`请求太长（${String(prompt).length} 字符），ChatSEU 插件最多 ${MAX_PROMPT}。`, {
        code: "context_length_exceeded",
        status: 413,
      })
    if (!Number.isInteger(modelCode)) throw new SeuError("没有这个模型。", { code: "model_not_found", status: 404 })
    const res = await this.deadline(
      (sig) =>
        this.fetchImpl(ORIGIN + "/api/chat/streamchat", {
          method: "POST",
          headers: this.headers({ "content-type": "application/json; charset=utf-8" }),
          body: JSON.stringify({ conversationID: "", modelCode, content: prompt, typeCode: 0, fileIds: [], enableSearch: false }),
          redirect: "manual",
          signal: sig,
        }),
      signal,
      this.timeouts.connect,
      "没有收到响应",
    )
    let messageId = await this.unwrap(res)
    if (typeof messageId !== "string" && messageId && typeof messageId === "object") messageId = messageId.messageId ?? messageId.id
    if (!messageId || typeof messageId !== "string")
      throw new SeuError("ChatSEU 没有返回 messageId。", { status: 502 })

    const stream = await this.deadline(
      (sig) =>
        this.fetchImpl(ORIGIN + "/api/chat/streamchat?messageId=" + encodeURIComponent(messageId), {
          headers: this.headers({ accept: "text/event-stream" }),
          redirect: "manual",
          signal: sig,
        }),
      signal,
      this.timeouts.connect,
      "流没有开始",
    )
    const ct = String(stream.headers?.get("content-type") ?? "")
    if (!stream.ok || !ct.includes("event-stream")) await this.unwrap(stream)
    else {
      const merged = mergeSetCookie(this.cookies, stream)
      if (merged !== this.cookies) {
        this.cookies = merged
        this.onCookies?.(merged)
      }
    }

    const a = new Assembler()
    let conversationId = ""
    try {
      await this.deadline(
        (sig) =>
          readSSE(
            stream,
            (ev) => {
              onEvent?.(ev)
              if (ev.event === "metadata") {
                conversationId ||= ev.id
                return
              }
              if (ev.event) return
              if (ev.data === "[DONE]") return false
              const d = a.push(ev.data)
              if (d.reasoning || d.content) onUpdate?.(d)
            },
            { signal: sig, idleMs: this.timeouts.idle },
          ),
        signal,
        this.timeouts.stream,
        "的回复流",
      )
      const last = a.flush()
      // 只有真有新内容才算一次更新：空更新会让流式层以为回复已开始，
      // 把本该是 HTTP 错误的情况变成 200 + 空流
      if (last.reasoning || last.content) onUpdate?.(last)
    } finally {
      // 客户端断开（signal 已中止）也要尽力删掉这条对话
      if (conversationId) {
        try {
          await this.deleteConversation(conversationId, { signal: AbortSignal.timeout(5000) })
        } catch {}
      }
    }
    return { text: a.text, reasoning: a.reasoning, conversationId }
  }

  async deleteConversation(conversationId, { signal } = {}) {
    const res = await this.fetchImpl(ORIGIN + "/api/chat/del-conversation", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ conversationID: conversationId }),
      redirect: "manual",
      signal,
    })
    return await this.unwrap(res)
  }
}

// ChatSEU (chatseu.seu.edu.cn) 网页版作为模型供应商。每个请求是整段
// OpenAI 请求压成的一条消息，发到网页自己的 streamchat 接口，SSE 回复
// 边读边翻成 OpenAI chat completion（SSE 或整段）：没有本地服务器，
// 没有每次请求的浏览器。登录在插件专属的浏览器窗口里由用户自己完成；
// cookie 过期由 magpie 的 auth.refresh 续期（见下方 KEEP_ALIVE_MS 的
// 注释），续不上才请用户重新登录。See README.md.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { renew, profileRoot, signIn } from "./browser.mjs"
import {
  CHAT_URL,
  MAX_PROMPT,
  MODELS,
  ORIGIN,
  SeuClient,
  SeuError,
  modelsOf,
  parseCookieHeader,
} from "./seu.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

export const ID = "seu-chat"
export const BASE = "https://seu-chat.invalid/v1"

// estimateTokens 估算提示词 token：CJK 每字约 1 token，其余每 4 字符约
// 1 token。旧的 length/3 把中文 4000 字报成 1334 token，agent 按这个
// 预算会塞进远超上下文的内容。
export function estimateTokens(s) {
  const text = String(s ?? "")
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/gu) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}
// ChatSEU 的会话按空闲超时作废（Spring Boot 默认 30 分钟；实测下午的登录
// 2 小时后已死，cookie 本身却还有 24 小时）。所以登录时写一个 25 分钟
// 后的 expires，并提供 auth.refresh：magpie 的网关会在它到期前（最多每
// 5 分钟看一次）后台调用 refresh，拿存的 cookie 碰一下 userInfo，把 expires
// 再续 25 分钟——magpie 开着，登录就不过期。CAS 的票据关窗即清，所以
// 不能靠重开浏览器续。
export const KEEP_ALIVE_MS = 25 * 60_000

const json = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "Content-Type": "application/json" } })

// models 把 {name, code} 行变成供应商目录的一行（OpenCode 形状，OpenCode
// 1.x/2.x 读它）：网页只出文本，工具以文本协议回（tool_call: true），
// models.dev 里没有这两个 id，不标注会被 magpie 拿同名 API 模型来猜
function models(table) {
  const out = {}
  for (const [id, m] of Object.entries(table))
    out[id] = {
      name: m.name,
      limit: { context: 200000, output: 8192 },
      tool_call: true,
      reasoning: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    }
  return out
}

// magpieModels 是 magpie 自己读的那份模型表（magpie 形状）：magpie 只认
// context/output/inputs/image/imageSaid 这些字段，给了 OpenCode 的
// limit/modalities 它读不到，就会回退到 catalog 按 id 猜——猜出这两个模型
// 「能收图片」（实测报的是 ["text","image","video","pdf"]），而图片其实
// 到不了站点（prompt.mjs 把它换成占位符），于是 agent 发图会被静默丢掉。
// 所以在这里明确说：只收文本。
export function magpieModels(table) {
  const out = {}
  for (const [id, m] of Object.entries(table))
    out[id] = {
      id,
      name: m.name,
      context: 200000,
      output: 8192,
      inputs: ["text"],
      outputs: ["text"],
      image: false,
      imageSaid: true,
      inputsSaid: true,
      outputsSaid: true,
      reasoning: true,
    }
  return out
}

// cookiesOf 读账号里存的登录态：oauth 存在 access，api 存在 key，
// 都是 JSON.stringify({ cookies })。
export function cookiesOf(auth) {
  const raw = auth?.type === "oauth" ? auth?.access : auth?.type === "api" ? auth?.key : undefined
  if (typeof raw !== "string") return null
  try {
    const v = JSON.parse(raw)
    return v?.cookies && typeof v.cookies === "object" ? v.cookies : null
  } catch {
    return null
  }
}

export function createPlugin({ client, fetchImpl = globalThis.fetch, newId, browser = { signIn, renew, profileRoot }, options = {} } = {}) {
  // 一个账号一个 SeuClient，跨请求留着（cookie 会被回复续上）
  const sessions = new Map()

  const verify = (cookies) => new SeuClient({ cookies, fetchImpl }).userInfo({ signal: AbortSignal.timeout(15000) })

  const sessionFor = (auth) => {
    const cookies = cookiesOf(auth)
    const key = auth?.accountId || auth?.metadata?.accountId || (cookies ? "cookies" : "none")
    let s = sessions.get(key)
    // 重新登录（或 cookie 被换）后重建
    const stored = auth?.type === "oauth" ? auth?.access : auth?.key
    if (s && s.storedCredential !== stored) s = null
    if (!s) {
      s = new SeuClient({
        cookies,
        fetchImpl,
        renew: null,
        onCookies: (c) => {
          const stored2 = JSON.stringify({ cookies: c })
          s.writtenCredential = stored2
          client?.auth
            ?.set?.({
              path: { id: ID },
              body:
                auth?.type === "api"
                  ? { type: "api", key: stored2, metadata: auth?.metadata }
                  // 不带 expires：magpie 把它存的值合并进来（all[key] = {...was, ...fields}），
                  // 带着建会话时的旧快照写回会把 magpie 刚续好的到期时间改回去，
                  // 甚至写成 0（= 永不到期）而让保活停下来。
                  : { type: "oauth", access: stored2, refresh: auth?.refresh ?? "", accountId: auth?.accountId, ...(auth?.name ? { name: auth.name } : {}) },
            })
            ?.catch?.(() => {})
        },
      })
      s.storedCredential = stored
      sessions.set(key, s)
    }
    return { key, s }
  }

  // askWithRenew 在登录被拒时把账号标记给 magpie（signIn: "expired"），
  // magpie 随后调 auth.refresh 续期；续不上就请用户重新登录。
  // 实测（2026-11-27）：CAS 票据关窗即清，无窗口重开浏览器自动续期
  // 不可行，所以这里不再试那条路。
  // 另一实测：请求超过站点上限（约 90 万字符 / 28 万 token，
  // 两个模型一致）时，站点不报错，回一个空回复。把它改回 413，magpie
  // 才会告诉 agent 「prompt is too long」去压缩对话，而不是拿到空回答。
  const askWithRenew = async (s, prompt, opts) => {
    const run = () =>
      s.ask(prompt, opts).then((r) => {
        if (r && !String(r.text ?? "").trim()) {
          const thought = String(r.reasoning ?? "").trim()
          throw new SeuError(
            thought
              ? "ChatSEU 的模型只输出了思考过程，没有给出回答，请重试。"
              : "ChatSEU 返回了空回复：请求可能超过它能处理的长度（prompt is too long），请压缩对话后重试。",
            { code: thought ? "seu_empty_reply" : "context_length_exceeded", status: thought ? 502 : 413 },
          )
        }
        return r
      })
    try {
      return await run()
    } catch (e) {
      if (e?.signIn) throw Object.assign(new Error(e.message), { signIn: "expired" })
      throw e
    }
  }

  const failed = (e) => {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    if (e?.signIn) throw Object.assign(new Error(e.message), { signIn: "expired" })
    return json(e?.status ?? 502, String(e?.message ?? e), e?.code ?? "seu_error")
  }

  const table = () => models(modelsOf(options))

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= { name: "东大 ChatSEU", npm: "@ai-sdk/openai-compatible", api: BASE }
      cfg.provider[ID].models = { ...table(), ...(cfg.provider[ID].models ?? {}) }
    },
    provider: {
      id: ID,
      async models() {
        return magpieModels(modelsOf(options))
      },
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [
        {
          type: "oauth",
          label: "在单独的浏览器窗口登录东南大学统一认证",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions:
              "将打开一个单独的 Chrome/Edge 窗口（插件专用配置，不影响你平时的浏览器）。请在其中用学工号完成统一认证，登录成功后窗口会自动关闭。",
            callback: async () => {
              const profile = join(browser.profileRoot(), randomBytes(6).toString("hex"))
              let cookies
              let progress = ""
              try {
                cookies = await browser.signIn(profile, { verify, onProgress: (m) => { progress = m } })
              } catch (e) {
                return { type: "failed", error: "打开浏览器失败：" + String(e?.message ?? e) }
              }
              if (!cookies)
                return {
                  type: "failed",
                  error: progress ? progress + "，请检查网络或代理后重试。" : "五分钟内没有在窗口里完成东南大学登录，请再试一次。",
                }
              let who
              try {
                who = await verify(cookies)
              } catch {
                return { type: "failed", error: "ChatSEU 没有把这个窗口当成已登录，请再试一次。" }
              }
              return {
                type: "success",
                access: JSON.stringify({ cookies }),
                refresh: profile,
                expires: Date.now() + KEEP_ALIVE_MS,
                accountId: who.uid,
                name: who.name,
              }
            },
          }),
        },
        // 粘贴 Cookie：也是 oauth 形状的账号（存 access），这样同样能被
        // magpie 的保活续期；没有 profile（refresh 为空），掉线只能重贴
        {
          type: "oauth",
          label: "粘贴浏览器里的 Cookie（登录窗口不可用时）",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: "Cookie",
              placeholder: "在 chatseu.seu.edu.cn 页面的任意请求头里复制整行 Cookie",
              validate: (v) => (v && v.trim() ? undefined : "Cookie required"),
            },
          ],
          authorize: async (inputs) => ({
            url: "",
            method: "auto",
            instructions: "",
            callback: async () => {
              const cookies = parseCookieHeader(String(inputs?.cookie ?? ""))
              if (!Object.keys(cookies).length) return { type: "failed", error: "Cookie 里没有 chatseu.seu.edu.cn 的会话。" }
              let who
              try {
                who = await verify(cookies)
              } catch {
                return { type: "failed", error: "这个 Cookie 未登录或已过期。" }
              }
              return {
                type: "success",
                access: JSON.stringify({ cookies }),
                refresh: "",
                expires: Date.now() + KEEP_ALIVE_MS,
                accountId: who.uid,
                name: who.name,
              }
            },
          }),
        },
      ],
      // magpie 在 expires 减 refreshLead（默认 5 分钟）到期时调用：拿存的
      // cookie 碰一下 userInfo，站点续了 cookie 就存回，expires 再续一轮。
      // 站点已不认（302）→ 抛 signIn "expired"，magpie 把账号标记为要重新
      // 登录；其它失败（网络）→ 普通抛出，magpie 按退避重试、不标记账号。
      refresh: async (auth) => {
        const cookies = cookiesOf(auth)
        const c = new SeuClient({ cookies, fetchImpl })
        await c.userInfo({ signal: AbortSignal.timeout(15000) })
        return { access: JSON.stringify({ cookies: c.cookies }), expires: Date.now() + KEEP_ALIVE_MS }
      },
      loader: async (getAuth) => ({
        baseURL: BASE,
        apiKey: ID,
        async fetch(input, init = {}) {
          const request = input instanceof Request ? new Request(input, init) : null
          const url = new URL(request ? request.url : String(input))
          const method = request ? request.method : init.method ?? "GET"
          if (url.origin !== new URL(BASE).origin || !url.pathname.endsWith("/chat/completions") || method !== "POST")
            return json(404, "ChatSEU 只提供 chat/completions。", "not_found")
          const signal = request ? request.signal : init.signal
          let body
          try {
            body = JSON.parse(request ? await request.text() : typeof init.body === "string" ? init.body : await new Response(init.body).text())
          } catch {
            return json(400, "请求不是 JSON。", "invalid_request_error")
          }
          const auth = await getAuth()
          const { s } = sessionFor(auth)
          const model = String(body.model ?? "").replace(/^seu-chat\//, "")
          const m = modelsOf(options)[model]
          if (!m) return json(404, `没有模型 ${model}。ChatSEU 有：${Object.keys(modelsOf(options)).join("、")}。`, "model_not_found")
          const prompt = flatten(body)
          // 声明了工具才让解析器把裸 JSON（{"name","arguments"}）读成调用；
          // 连 schema 一起给，空工具名的调用可以按参数键唯一匹配补名
          const toolNames = (Array.isArray(body.tools) ? body.tools : [])
            .map((t) => (t?.function ?? t))
            .filter((f) => f && typeof f.name === "string" && f.name)
            .map((f) => ({ name: f.name, parameters: f.parameters }))
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => estimateTokens(prompt)
          const ask = (onUpdate, sig) => askWithRenew(s, prompt, { modelCode: m.code, signal: sig, onUpdate })
          try {
            if (body.stream) return await sse({ id, model, signal, newId, promptTokens, toolNames, ask })
            const final = await ask(null, signal)
            return Response.json(completion({ id, model, final, promptTokens: promptTokens(), newId, toolNames }))
          } catch (e) {
            return failed(e)
          }
        },
      }),
    },
  }
}

export default async function SeuChatProvider(input, options = {}) {
  return createPlugin({ client: input?.client, options })
}

export const _internal = { createPlugin, models, BASE, ID, cookiesOf, SeuError, estimateTokens, MODELS, ORIGIN, CHAT_URL, MAX_PROMPT }

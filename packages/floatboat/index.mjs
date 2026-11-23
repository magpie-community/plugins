// index.mjs —— magpie 插件入口：只做装配，实现全在 src/
//
// ═══════════════════════════════════════════════════════════════════════
// Floatboat 是什么
// ═══════════════════════════════════════════════════════════════════════
// 一个 Electron 桌面 Agent 客户端（aoe 出品）。它自己不做模型，背后是
// **New API 网关** `https://newapi.aoe.chat`：
//   · 业务后端 floatboat.ai 管账号、积分、发 sk- key；
//   · 网关按 OpenAI / Anthropic 双协议转发模型；
//   · 用户看到的是「积分 × 倍率」，不是美元。
//
// 所以插件只干两件事：
//   1. 用和桌面端一模一样的登录换到 floatboat 的 access/refresh token；
//   2. 拿 token 换网关的 sk- key，然后把宿主的 /chat/completions 原样转过去。
// 不注入任何官方系统提示词 —— 网关只做模型转发，system 是宿主自己写的那一份。
//
// ═══════════════════════════════════════════════════════════════════════
// 钩子清单（7 个实现 + 1 个故意不实现）
// ═══════════════════════════════════════════════════════════════════════
//   ① config         声明 provider 与静态模型表
//   ② auth.methods   浏览器登录 / 粘贴回调 / 粘贴 token
//   ③ auth.refresh   refresh_token 续期
//   ④ auth.loader    请求接管（转发到网关）
//   ⑤ auth.usage     积分余额
//   ⑥ auth.checkin   领取新手积分（首日 200 / 次日 300）
//   ⑦ provider.models 每账号的模型目录
//   （⑧ chat.headers 不实现：没有头要加，声明了只会让宿主每请求多跑一遍 infoOf）

import { PROVIDER, PROVIDER_NAME, ICON, SDK, GATEWAY_BASE } from "./src/config.mjs"
import { staticModelTable, resolveModelId } from "./src/models.mjs"
import { forwardChat, modelsResponse, ensureNewApiKey } from "./src/gateway.mjs"
import { fetchUser, refreshTokens } from "./src/desktop-api.mjs"
import { buildUsage, usageError } from "./src/usage.mjs"
import { claimSignupCredits } from "./src/checkin.mjs"
import { accountLabelOf, buildSignInUrl, loginWithCode, newState, tokenOf } from "./src/auth.mjs"
import { chromiumDeepLinkLogin, findBrowser, parseCallback } from "./src/browser-login.mjs"
import { errorResponse } from "./src/http.mjs"

/** uid 兜底（没有账号 id 时用 token 尾巴区分账号） */
function uidOf(auth) {
  const uid = String(auth?.uid || "").trim()
  if (uid) return uid
  const token = tokenOf(auth)
  return token ? `tok_${token.slice(-8)}` : "default"
}

/**
 * @param {object} _ctx magpie 的插件上下文（本插件用不到）
 * @param {object} [options] `magpie plugin options` 传进来的插件开关
 */
export const FloatboatPlugin = async (_ctx = {}, options = {}) => {
  const signInTimeoutMs = Number.isFinite(options?.signInTimeoutMs)
    ? Math.max(30_000, Number(options.signInTimeoutMs))
    : 5 * 60_000
  const maxConcurrency = Number.isFinite(options?.maxConcurrency) ? Number(options.maxConcurrency) : 4

  return {
    // ═══ ① 声明 provider 与静态模型表 ══════════════════════════════
    //
    // ⚠ 不能「cfg.provider[PROVIDER] 已有就 return」。
    // 宿主在跑 config 钩子前会先用**用户自己的** config.provider[<id>] 覆盖这个槽位
    // （或整个删掉）—— 也就是说这里看到的「已有」几乎总是用户手里的那一份，
    // 它可能只有 {models:{}} 甚至只有 name。早期写法一 return，provider 就永远
    // 少 npm / api / 模型表，界面上是一条空白卡片，而且不报错。
    // 正确做法：逐字段 ??= 补齐，models 取并集（用户写的优先，可以 disabled:true 关掉某条）。
    config: async (cfg) => {
      cfg.provider ??= {}
      const own = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        ...own,
        name: own.name ?? PROVIDER_NAME,
        npm: own.npm ?? SDK,
        api: own.api ?? GATEWAY_BASE,
        // 未登录时也必须有内容，否则界面显示 0 models
        models: { ...staticModelTable(), ...(own.models ?? {}) },
        // 联网检索是客户端自己的工具，不是网关的 OpenAI tools 通道
        searches: own.searches ?? false,
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency,
      // access token 大约 1~2 小时，提前 5 分钟续
      refreshLead: 5 * 60_000,

      // ═══ ② 登录方式 ══════════════════════════════════════════════
      methods: [
        // ── 浏览器登录（推荐）────────────────────────────────────
        // 和桌面端完全同一条路：打开 /desktop-sign-in?state=…，
        // 登录后网页回跳 aoe://…?code=&state=，插件从受控浏览器里把 code 截下来。
        {
          type: "oauth",
          label: "浏览器登录（推荐）",
          // 宿主支持 labels 多语言（一次最多 16 种，每种 ≤ 300 字）；label 本身仍是兜底
          labels: { en: "Sign in with a browser (recommended)" },
          async authorize() {
            const browser = findBrowser()
            if (!browser) {
              // 契约：start 不了可以返回 {type:"failed", error} 而不是抛（宿主原话：
              // "a plugin that can't start the sign-in may say why … rather than throw"），
              // 这样界面上是干净的失败原因，不是一段堆栈。
              return {
                type: "failed",
                error:
                  "没有找到 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 等）。" +
                  "装一个再试，也可以改用「粘贴回调链接 / 授权码」或「粘贴 accessToken」。",
              }
            }

            const state = newState()
            const url = buildSignInUrl(state)
            const controller = new AbortController()
            const pending = chromiumDeepLinkLogin({
              browser,
              url,
              timeoutMs: signInTimeoutMs,
              signal: controller.signal,
            })
            pending.catch(() => {})

            return {
              url,
              method: "auto",
              // 插件自己已经把浏览器开起来了，宿主不要再开一个
              opened: true,
              instructions:
                `已用 ${browser.name} 打开 Floatboat 登录页：` +
                "用你的 Floatboat 账号登录（手机号/邮箱/第三方都行），成功后会自动回到这里，不需要复制任何内容。",
              close: () => controller.abort(),
              async callback(_value, { signal } = {}) {
                const onAbort = () => controller.abort()
                signal?.addEventListener?.("abort", onAbort, { once: true })
                try {
                  const hit = await pending
                  if (hit.state && hit.state !== state) {
                    return {
                      type: "failed",
                      error: "回调里的 state 对不上（可能贴了别的窗口的链接），请重试一次",
                    }
                  }
                  return await loginWithCode({ code: hit.code, state: hit.state || state })
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e) }
                } finally {
                  signal?.removeEventListener?.("abort", onAbort)
                  controller.abort()
                }
              },
            }
          },
        },

        // ── 粘贴回调链接 / 授权码 ────────────────────────────────
        // 受控浏览器被策略挡住、或用户已经在别的浏览器登过：把地址栏那条
        // aoe://…?code=…&state=… 整条贴进来即可（只贴 code 也行）。
        {
          type: "oauth",
          label: "粘贴回调链接 / 授权码",
          labels: { en: "Paste the callback link / code" },
          async authorize() {
            return {
              url: "",
              opened: true,
              method: "code",
              instructions:
                "先在本机浏览器打开 https://floatboat.ai/desktop-sign-in 完成登录；" +
                "登录结束时地址栏会出现一条 aoe://…?code=…&state=… 的链接，" +
                "把整条链接贴到下面的输入框（只贴 code 也可以）。",
              async callback(value) {
                const parsed = parseCallback(value)
                if (!parsed?.code) {
                  return { type: "failed", error: "这段内容里没有 code，请确认贴的是 aoe:// 回调链接" }
                }
                try {
                  return await loginWithCode({ code: parsed.code, state: parsed.state })
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e) }
                }
              },
            }
          },
        },

        // ── 粘贴 accessToken ──────────────────────────────────────
        // 给「自己抓过包」的人留的后门。access token 会过期且没有续期凭据，
        // 过期后要重新贴一次 —— 所以只作为兜底，不推荐。
        {
          type: "api",
          label: "Floatboat accessToken（粘贴，兜底）",
          labels: { en: "Floatboat accessToken (paste, fallback)" },
          // placeholder 只对 api 类型有效（oauth 类型宿主会丢掉）
          placeholder: "从客户端 / 抓包里拿到的 access token（JWT 或不透明串）",
        },
      ],

      // ═══ ③ 续期 ══════════════════════════════════════════════════
      // 契约：refresh(auth, provider)，返回要覆盖到旧账号上的字段
      async refresh(auth, _provider) {
        const refreshToken = String(auth?.refresh || "").trim()
        if (!refreshToken) return undefined // api 类型登录没有续期凭据

        try {
          const tokens = await refreshTokens({ refreshToken })
          const user = await fetchUser(tokens.accessToken).catch(() => null)

          let newapiKey = ""
          try {
            newapiKey = await ensureNewApiKey(
              { access: tokens.accessToken, uid: uidOf(auth) },
              { force: true },
            )
          } catch {
            newapiKey = ""
          }

          return {
            access: tokens.accessToken,
            refresh: tokens.refreshToken,
            expires: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : 0,
            accountId: user ? accountLabelOf(user) : auth?.accountId,
            uid: user?.id || uidOf(auth),
            metadata: {
              ...(auth?.metadata || {}),
              ...(newapiKey ? { newapiKey } : {}),
            },
          }
        } catch {
          // 续期失败：保持现状，让下一次请求的 401 去触发重新登录
          return undefined
        }
      },

      // ═══ ④ 请求接管 ══════════════════════════════════════════════
      // 契约：loader(getAuth, provider) —— 每个账号只跑一次，结果被缓存到下次登录
      async loader(getAuth, _provider) {
        return {
          baseURL: GATEWAY_BASE,
          // 不走 Bearer 的静态 key：sk- key 每次现取（可能被轮换）
          apiKey: "",
          headers: { "user-agent": "Floatboat/0.6.7" },

          async fetch(input, init) {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url ?? ""
            const req = input instanceof Request ? input : null
            const method = String(init?.method ?? req?.method ?? "GET").toUpperCase()

            let path = url
            try {
              path = new URL(url).pathname
            } catch {
              /* 不是完整 URL：按原样匹配 */
            }
            // baseURL 已经带 /v1，宿主可能再拼一次；统一收敛到 /chat/completions
            const tail = path.replace(/^.*?\/v1(?=\/)/, "")

            if (method === "GET" && /\/models\/?$/.test(tail)) {
              return modelsResponse(staticModelTable())
            }

            if (!(method === "POST" && /\/chat\/completions\/?$/.test(tail))) {
              return errorResponse(
                501,
                `该端点没有实现：${method} ${url}。本插件只提供 /chat/completions 与 /models。`,
                "invalid_request_error",
                "not_implemented",
              )
            }

            let body = init?.body ?? (req ? await req.text() : undefined)
            if (body instanceof Uint8Array) body = new TextDecoder().decode(body)
            if (body && typeof body === "object" && !(body instanceof String)) {
              body = JSON.stringify(body)
            }

            let parsed = null
            if (typeof body === "string" && body.trim()) {
              try {
                parsed = JSON.parse(body)
              } catch {
                return errorResponse(400, "请求体不是合法 JSON", "invalid_request_error", "invalid_json")
              }
            }

            if (parsed) {
              const model = resolveModelId(parsed.model)
              // 只有真的改了 model 才重新序列化；没改就保留宿主原始 body
              if (parsed.model !== model) {
                parsed.model = model
                body = JSON.stringify(parsed)
              }
            }

            const auth = await getAuth()
            const headers = new Headers(init?.headers ?? req?.headers ?? {})

            try {
              return await forwardChat({
                path: "/chat/completions",
                method: "POST",
                body,
                headers,
                auth,
                getAuth,
                signal: init?.signal ?? req?.signal,
              })
            } catch (e) {
              const status = e?.status || 502
              return errorResponse(
                status,
                String(e?.message ?? e),
                status === 401 ? "authentication_error" : "upstream_error",
                e?.code || "upstream_error",
                status === 401 ? { "x-magpie-sign-in": "expired" } : {},
              )
            }
          },
        }
      },

      // ═══ ⑤ 额度 ══════════════════════════════════════════════════
      // 契约：usage(getAuth, provider, {signal})；第三个参数只在宿主给了 signal 时才传
      async usage(getAuth, _provider, opts = {}) {
        const auth = await getAuth()
        const token = tokenOf(auth)
        if (!token) return usageError("Floatboat 未登录")

        try {
          const user = await fetchUser(token, { signal: opts?.signal })
          return buildUsage(user, { accountId: auth?.accountId })
        } catch (e) {
          if (e?.status === 401) {
            return usageError("Floatboat 登录已过期，请重新登录一次", { signIn: "expired" })
          }
          return usageError(String(e?.message ?? e))
        }
      },

      // ═══ ⑥ 积分（新手首日/次日奖励）══════════════════════════════
      //
      // 契约只读 {outcome, credit, streak, message, until}；outcome 必须是
      // claimed / done / ineligible / inactive / captcha / failed 之一，
      // 别的字符串会被宿主改写成 failed。所以 outcome 由 src/checkin.mjs 直接产出，
      // 这里只负责把内部调试字段（raw）挡在返回值外面。
      async checkin(getAuth, _provider) {
        const auth = await getAuth()
        const token = tokenOf(auth)
        if (!token) return { outcome: "failed", message: "Floatboat 未登录" }
        try {
          const { raw: _raw, ...out } = await claimSignupCredits(token, {
            refreshToken: auth?.refresh,
            uid: uidOf(auth),
            log: (m) => console.log(m),
          })
          return out
        } catch (e) {
          return { outcome: "failed", message: String(e?.message ?? e) }
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,

      // 契约：models(providerInfo, { auth, signal })
      // 返回的是 **OpenCode 的 Model 形状**（宿主原样用，只补 id / providerID），
      // 所以 src/models.mjs 的条目同时带 capabilities 那一套。
      async models(_given, _ctx = {}) {
        // 网关关掉了 /v1/models（实测 404 feature_not_supported），
        // 目录只在插件里；永远不要返回空表。
        return staticModelTable()
      },
    },

    // ⑧ chat.headers —— **故意不实现**。
    // 只要 hooks 里有这个函数，宿主每个请求都会先 infoOf(provider) 再调一遍；
    // 而网关不认 magpie 的会话头，我们没有任何头要加，实现了就是纯白跑。
  }
}

// src/gateway.mjs —— 模型网关（New API）侧的转发与 sk- key 管理
//
// 网关是标准 New API：OpenAI 协议 /v1/chat/completions + Anthropic 协议 /v1/messages。
// 鉴权用 /api/desktop/newapi/key 发的 sk- key（不是 floatboat 的 accessToken）。
//
// 这个模块只做两件事：
//   1. sk- key 的取用与失效重取（内存缓存 + auth.metadata 双份，换进程也不至于打空）；
//   2. 把宿主的请求原样转给网关，SSE 直接透传，401 时换一次 key 再重试一次。

import { CHAT_TIMEOUT_MS, GATEWAY_BASE, KEY_TTL_MS, USER_AGENT } from "./config.mjs"
import { fetchNewApiKey } from "./desktop-api.mjs"
import { tokenOf } from "./auth.mjs"
import { errorResponse, jsonResponse } from "./http.mjs"

/** uid → { key, at } */
const keyCache = new Map()

/** 缓存键：uid 优先，其次 accountId（和 invalidateKey 的入参保持一致） */
function cacheKeyOf(auth) {
  return String(auth?.uid || auth?.accountId || "default")
}

/** 从 auth 里取已有 key（登录时抓到的存在 metadata 里） */
export function keyFromAuth(auth) {
  const k = auth?.metadata?.newapiKey
  return typeof k === "string" && k.trim() ? k.trim() : ""
}

export function invalidateKey(uid) {
  if (uid) keyCache.delete(String(uid))
}

/**
 * 拿到可用的 sk- key：metadata → 内存缓存 → 向业务后端现取。
 * @returns {Promise<string>}
 */
export async function ensureNewApiKey(auth, { force = false } = {}) {
  const uid = cacheKeyOf(auth)
  const token = tokenOf(auth)

  if (!force) {
    const fromAuth = keyFromAuth(auth)
    if (fromAuth) return fromAuth

    const hit = keyCache.get(uid)
    if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key
  }

  if (!token) {
    throw Object.assign(new Error("Floatboat 未登录：拿不到模型网关的 key"), {
      status: 401,
      code: "sign_in_required",
    })
  }

  const key = await fetchNewApiKey(token)
  keyCache.set(uid, { key, at: Date.now() })
  return key
}

/**
 * 转发一次聊天请求。
 *
 * @param {object} o
 * @param {string} o.path 形如 /chat/completions
 * @param {string} o.method
 * @param {string} o.body 已改好 model 的 JSON 字符串
 * @param {Headers} o.headers 宿主给的（Accept / 其它头，透传给上游）
 * @param {object} o.auth
 * @param {() => Promise<object>} [o.getAuth] 401 时用它拿最新账号
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Response>}
 */
export async function forwardChat({ path, method, body, headers, auth, getAuth, signal }) {
  const target = `${GATEWAY_BASE}${path}`
  const signals = [AbortSignal.timeout(CHAT_TIMEOUT_MS)]
  if (signal) signals.push(signal)
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

  const send = async (key) => {
    const h = new Headers()
    // 透传能透的：accept（决定 SSE / JSON）、anthropic 版本头等
    for (const name of ["accept", "content-type", "anthropic-version", "anthropic-beta"]) {
      const v = headers?.get?.(name)
      if (v) h.set(name, v)
    }
    h.set("accept", h.get("accept") || "text/event-stream")
    h.set("content-type", "application/json")
    h.set("authorization", `Bearer ${key}`)
    h.set("user-agent", USER_AGENT)
    return fetch(target, { method, headers: h, body, signal: combined })
  }

  let key = await ensureNewApiKey(auth)
  let res = await send(key)

  if (res.status === 401 || res.status === 403) {
    // key 被换掉 / 过期：换一次账号快照，重取 key，再试一次
    const fresh = getAuth ? await getAuth().catch(() => null) : null
    const effective = fresh ?? auth
    invalidateKey(effective?.uid || effective?.accountId || auth?.uid || auth?.accountId)
    try {
      key = await ensureNewApiKey({ ...effective, metadata: { ...(effective?.metadata || {}), newapiKey: "" } }, { force: true })
      res = await send(key)
    } catch (e) {
      return errorResponse(
        401,
        `模型网关鉴权失败，且无法重取 key：${String(e?.message ?? e)}`,
        "authentication_error",
        "sign_in_required",
      )
    }
  }

  if (res.status === 401) {
    const text = await res.text().catch(() => "")
    return errorResponse(
      401,
      `模型网关拒绝了这个 key：${text.slice(0, 200)}`,
      "authentication_error",
      "sign_in_required",
      { "x-magpie-sign-in": "expired" },
    )
  }

  // 其余状态原样透传：网关的错误体本身就是标准 OpenAI 形状，改它只会丢信息
  return res
}

/** 给 GET /models 用（宿主偶尔会探） */
export function modelsResponse(table) {
  const data = Object.values(table).map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "floatboat",
    name: m.name,
  }))
  return jsonResponse({ object: "list", data }, 200, { "content-type": "application/json; charset=utf-8" })
}

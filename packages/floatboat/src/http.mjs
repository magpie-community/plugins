// src/http.mjs —— 业务接口（floatboat.ai）的薄封装：超时、重试、错误归一。
//
// 只做三件事：
//   1. 给每个请求套上超时 + 可选 abort；
//   2. 把上游的 {code, message, data} / {error:{...}} 归一成 ApiError；
//   3. 网络层抖动（ECONNRESET / ETIMEDOUT）重试两次，4xx 不重试。

import { API_TIMEOUT_MS, USER_AGENT } from "./config.mjs"

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.body = body
  }
}

/** 上游错误体可能是三种形状，全部兼容 */
function messageOfBody(body, fallback) {
  if (!body) return fallback
  if (typeof body === "string") return body.slice(0, 300) || fallback
  const candidates = [
    body.message,
    body.error_description,
    body.error?.message,
    body.data?.message,
    body.data?.error,
    body.msg,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim()
  }
  return fallback
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 上游有的字段是数字、有的是字符串；统一成 number | null */
export function numberOrNull(v) {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/** 一行 JSON Response（宿主 / 网关错误体共用） */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** OpenAI 形状的错误 Response：{error:{message,type,code}} */
export function errorResponse(status, message, type, code, headers = {}) {
  return jsonResponse({ error: { message, type, code } }, status, headers)
}

/**
 * @param {string} url
 * @param {object} [o]
 * @param {string} [o.method]
 * @param {object} [o.json] 请求体（会被 JSON.stringify）
 * @param {Record<string,string>} [o.headers]
 * @param {string} [o.token] Bearer token
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.retries] 网络层重试次数，默认 2
 */
export async function apiFetch(url, o = {}) {
  const {
    method = "GET",
    json,
    headers: extra = {},
    token,
    signal,
    timeoutMs = API_TIMEOUT_MS,
    retries = 2,
  } = o

  const headers = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...(json !== undefined ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      })

      const text = await res.text()
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }

      if (!res.ok) {
        // 5xx 重试，4xx 直接抛
        if (res.status >= 500 && attempt < retries) {
          lastErr = new ApiError(res.status, "upstream_error", messageOfBody(body, `上游 ${res.status}`), body)
          await sleep(300 * (attempt + 1))
          continue
        }
        throw new ApiError(
          res.status,
          typeof body === "object" && body ? body.code ?? body.error?.code ?? "upstream_error" : "upstream_error",
          messageOfBody(body, `上游 ${res.status}`),
          body,
        )
      }

      // 业务层错误：{"code":-1,"message":"no auth"} —— HTTP 200 但其实是失败
      if (body && typeof body === "object" && typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
        throw new ApiError(401, String(body.code), messageOfBody(body, "上游返回业务错误"), body)
      }

      return body
    } catch (e) {
      if (e instanceof ApiError) throw e
      lastErr = e
      const code = e?.cause?.code || e?.code || ""
      const retryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR/.test(String(code))
      if (attempt < retries && retryable) {
        await sleep(300 * (attempt + 1))
        continue
      }
      throw new ApiError(0, "network_error", `网络错误：${String(e?.message ?? e)}`, null)
    }
  }
  throw lastErr ?? new ApiError(0, "network_error", "网络错误", null)
}

/** 从任意嵌套结构里找出第一个叫 name 的字段（上游响应包裹层不统一） */
export function deepFind(root, name, depth = 4) {
  if (!root || typeof root !== "object" || depth < 0) return undefined
  if (name in root) return root[name]
  for (const v of Object.values(root)) {
    if (v && typeof v === "object") {
      const hit = deepFind(v, name, depth - 1)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

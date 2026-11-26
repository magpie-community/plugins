export function normalizeReasoningBody(body) {
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
  else return body

  let request
  try {
    request = JSON.parse(text)
  } catch {
    return body
  }
  if (request?.model !== "deepseek-v41-flash" || !["none", "low", "high", "max"].includes(request.reasoning_effort)) return body

  const enabled = request.reasoning_effort !== "none"
  if (enabled && request.reasoning_effort === "low") request.reasoning_effort = "high"
  if (!enabled) delete request.reasoning_effort
  request.thinking = { ...request.thinking, type: enabled ? "enabled" : "disabled" }
  request.enable_thinking = enabled
  return JSON.stringify(request)
}

export class GatewayError extends Error {
  constructor({ status, message, type, code, payload }) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.type = type || (status === 401 ? "authentication_error" : "api_error")
    this.code = code
    this.payload = payload
  }
}

function errorFromResponse(response, payload) {
  const error = payload?.error ?? payload ?? {}
  const message = String(error.message ?? payload?.message ?? `DuMate gateway HTTP ${response.status}`)
  const status = response.status === 401 || response.status === 403 ? 401 : response.status
  return new GatewayError({
    status,
    message,
    type: error.type,
    code: error.code,
    payload,
  })
}

export class GatewayClient {
  constructor(config, auth, { fetchImpl = fetch } = {}) {
    this.config = config
    this.auth = auth
    this.fetchImpl = fetchImpl
  }

  async chat(body, { signal } = {}) {
    const text = normalizeReasoningBody(typeof body === "string" ? body : JSON.stringify(body))
    const cookieHeader = await this.auth.cookieHeader()
    let token
    try {
      token = await this.auth.gatewayToken(cookieHeader)
    } catch (error) {
      if (error?.status === 401) this.auth.invalidate()
      throw error
    }

    const response = await this.fetchImpl(`${this.config.gatewayBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": this.config.userAgent,
      },
      body: text,
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
    })

    if ((response.status >= 300 && response.status < 400) || response.status === 401) {
      this.auth.invalidate()
      throw new GatewayError({
        status: 401,
        message: "DuMate gateway token 已失效，缓存已清除，请重试",
        type: "authentication_error",
        code: "token_expired",
      })
    }
    if (!response.ok) {
      const raw = await response.text()
      let payload
      try { payload = JSON.parse(raw) } catch { payload = { error: { message: raw.slice(0, 500) } } }
      throw errorFromResponse(response, payload)
    }
    return response
  }

  async chatJson(body, options) {
    const response = await this.chat(body, options)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new GatewayError({ status: 502, message: "DuMate gateway 返回非 JSON 响应", code: "invalid_gateway_response" })
    }
  }
}

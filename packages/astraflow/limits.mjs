// Read-only APIKey fields from ucloud/ucloud-sdk-go, services/uai_modelverse.
// Amounts follow the account's channel; only channel 126 is documented USD.
const text = (v) => typeof v === "string" ? v.trim() : ""
const finite = (v) => {
  if (!["string", "number"].includes(typeof v) || String(v).trim() === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
const boolean = (v) => [true, 1, "true", "1"].includes(v) ? true : [false, 0, "false", "0"].includes(v) ? false : undefined

export function keyDetails(row) {
  if (!row || !text(row.KeyId)) return undefined
  const result = { id: row.KeyId }
  if (text(row.Name)) result.name = text(row.Name)
  for (const [field, name] of [["DailyLimitAmount", "dailyLimit"], ["DailyUsedAmount", "dailyUsed"],
    ["MonthlyLimitAmount", "monthlyLimit"], ["MonthlyUsedAmount", "monthlyUsed"], ["Status", "status"], ["ModelverseDisabled", "modelverseDisabled"]]) {
    const n = finite(row[field])
    if (n !== undefined) result[name] = n
  }
  const expires = finite(row.ExpireTime)
  if (expires > 0 && expires * 1000 <= 8.64e15) result.expiresAt = new Date(expires * 1000).toISOString()
  const all = boolean(row.GrantAllModels)
  if (all !== undefined) result.grantAllModels = all
  // Do not turn an omitted/malformed grant list into a known empty list.
  if (Array.isArray(row.GrantedModels) && row.GrantedModels.every((v) => typeof v === "string")) {
    result.grantedModels = [...new Set(row.GrantedModels.map(text).filter(Boolean))]
  }
  if (typeof row.IPWhitelist === "string") result.ipWhitelist = [...new Set(row.IPWhitelist.split(/\r?\n/).map(text).filter(Boolean))]
  if (Number(row.ChannelId) === 126) result.currency = "USD"
  return result
}

export async function readKeyDetails(auth, control) {
  if (auth?.type !== "oauth" || !text(auth.access) || !text(auth.projectId) || !text(auth.keyId)) return undefined
  try {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const data = await control(auth, "ListUMInferAPIKey", { ProjectId: auth.projectId, Offset: offset, Limit: 100 })
      if (data?.RetCode !== 0 || !data.Data || typeof data.Data !== "object") return undefined
      const page = Array.isArray(data.Data) ? data.Data : Object.values(data.Data)
      const row = page.find((r) => r?.KeyId === auth.keyId)
      if (row) return keyDetails(row)
      if (page.length < 100) return undefined
    }
  } catch {
    // Experimental key controls and restricted OAuth accounts may not expose
    // these fields. This optional read must not block inference or balance.
  }
  return undefined
}

export function allowedModels(details) {
  if (details?.grantAllModels !== false || !Array.isArray(details.grantedModels) || details.grantedModels.includes("all")) return null
  return new Set(details.grantedModels)
}

export function summarizeKey(details) {
  const out = { label: "", windows: [] }
  if (!details) return out
  const unit = details.currency || "account currency"
  const labels = []
  for (const [period, cap, amount] of [["Daily", details.dailyLimit, details.dailyUsed], ["Monthly", details.monthlyLimit, details.monthlyUsed]]) {
    if (!(cap > 0)) continue
    labels.push(`${period.toLowerCase()} key cap ${cap} (${unit})`)
    if (amount === undefined) continue
    // The API supplies settled consumption, not real-time spend. Neither
    // the reset timezone nor the next reset instant is supplied here.
    out.windows.push({ name: `${period} key budget`, used: Math.min(100, Math.max(0, amount / cap * 100)),
      amount, limit: cap, unit, display: `${amount} / ${cap} ${unit} (settled; billing may be delayed)` })
  }
  const models = allowedModels(details)
  if (models) labels.push(`${models.size} authorized models`)
  if (details.ipWhitelist?.length) labels.push(`IP allowlist: ${details.ipWhitelist.length} entries`)
  if ((details.status !== undefined && details.status !== 1) || details.modelverseDisabled === 1) labels.push("key disabled")
  if (details.expiresAt) labels.push(`key expires ${details.expiresAt}`)
  out.label = labels.join("; ")
  return out
}

export function classifyError(status, body) {
  const error = body?.error ?? body
  const message = text(error?.message)
  const code = text(error?.code).toLowerCase()
  if (status === 401) return "auth"
  if (status >= 400 && /api key quota exceeded/i.test(message)) return "quota"
  if (status >= 400 && /api key ip not in whitelist/i.test(message)) return "ip_allowlist"
  if (status >= 400 && (/no permission to use the model|apikey .* not support model/i.test(message) ||
    code === "model_error" && /permission|not support model/i.test(message))) return "model_access"
  if (status === 429) return "rate_limit"
  return "unknown"
}

function redact(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) if (typeof secret === "string" && secret) value = value.split(secret).join("[redacted]")
    return value
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redact(v, secrets)]))
  return value
}

export async function normalizeErrorResponse(response, secrets = []) {
  // Never clone, read or replace a successful response or an SSE stream.
  if (response.status < 400 || !/^(?:application\/json|application\/[\w.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") || "")) return response
  if (Number(response.headers.get("content-length")) > 65_536) return response
  let reader, timer, body
  try {
    reader = response.clone().body?.getReader()
    if (!reader) return response
    const read = async () => {
      let length = 0
      const chunks = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 65_536) throw new Error("error body too large")
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    }
    body = await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("error body incomplete")), 1000) })])
  } catch {
    void reader?.cancel().catch(() => {})
    return response
  } finally { clearTimeout(timer) }
  const kind = classifyError(response.status, body)
  const safe = redact(body, secrets)
  const changed = JSON.stringify(safe) !== JSON.stringify(body)
  if (kind === "unknown" && !changed) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("etag")
  headers.set("X-Magpie-Sign-In", kind === "auth" ? "expired" : "kept")
  // The documented quota refusal is a rejected (unbilled) request. Expose
  // only this precise 403 as 429 so Magpie may route to another account;
  // keep model/IP restrictions as their original status and error payload.
  return new Response(JSON.stringify(safe), { status: kind === "quota" && response.status === 403 ? 429 : response.status,
    statusText: kind === "quota" && response.status === 403 ? "Too Many Requests" : response.statusText, headers })
}

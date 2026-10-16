import { expect, test } from "bun:test"
import { keyDetails, readKeyDetails, allowedModels, summarizeKey, classifyError, normalizeErrorResponse } from "./limits.mjs"

const auth = { type: "oauth", access: "oauth-secret", inferenceKey: "inference-secret", refresh: "refresh-secret", projectId: "p", keyId: "selected" }
const quota = { error: { message: "Access forbidden: api key quota exceeded, key_id=selected, daily_limit_amount=100 , monthly_limit_amount=1000",
  type: "permission_error", code: "forbidden", param: "request-id" } }
const modelError = { error: { message: "No permission to use the model: apikey [selected] not support model [gpt-5.4]", type: "invalid_request_error", code: "model_error" } }
const ipError = { error: { message: "Access forbidden: api key ip not in whitelist, key_id=selected, ip=127.0.0.1", type: "permission_error", code: "forbidden" } }

test("key metadata retains verified monetary fields but never the credential or arbitrary control-plane data", () => {
  const d = keyDetails({ KeyId: "selected", Key: "inference-secret", Name: "Private key", DailyLimitAmount: "100", DailyUsedAmount: "25.5",
    MonthlyLimitAmount: "1000", MonthlyUsedAmount: "250", GrantAllModels: false, GrantedModels: ["a", "b", "a"],
    IPWhitelist: "192.168.1.1\r\n192.168.1.0/24\n", Status: 1, ModelverseDisabled: 0, ExpireTime: -1, AccessToken: "oauth-secret" })
  expect(d).toEqual({ id: "selected", name: "Private key", dailyLimit: 100, dailyUsed: 25.5, monthlyLimit: 1000, monthlyUsed: 250,
    grantAllModels: false, grantedModels: ["a", "b"], ipWhitelist: ["192.168.1.1", "192.168.1.0/24"], status: 1, modelverseDisabled: 0 })
  expect(JSON.stringify(d)).not.toContain("secret")
  expect(keyDetails({})).toBeUndefined()
})

test("missing, blank, invalid or negative consumption is never converted to zero and only documented USD channels are labeled", () => {
  for (const value of [undefined, null, "", " ", true, false, "NaN", "Infinity", -1, {}]) {
    const d = keyDetails({ KeyId: "selected", DailyLimitAmount: "100", DailyUsedAmount: value, MonthlyUsedAmount: value })
    expect(d.dailyUsed).toBeUndefined()
    expect(summarizeKey(d).windows).toEqual([])
  }
  expect(keyDetails({ KeyId: "selected", DailyUsedAmount: "0", ChannelId: 126 }).currency).toBe("USD")
  expect(keyDetails({ KeyId: "selected", ChannelId: 1 }).currency).toBeUndefined()
  expect(keyDetails({ KeyId: "selected", ExpireTime: 2_000_000_000 }).expiresAt).toBe("2033-05-18T03:33:20.000Z")
  expect(keyDetails({ KeyId: "selected", ExpireTime: Infinity }).expiresAt).toBeUndefined()
})

test("read-only key lookup paginates raw rows and selects exactly the account's key", async () => {
  const calls = []
  const d = await readKeyDetails(auth, async (a, action, params) => {
    expect(a).toBe(auth)
    expect(action).toBe("ListUMInferAPIKey")
    calls.push(params)
    return { RetCode: 0, Data: params.Offset === 0 ? Array.from({ length: 100 }, (_, n) => ({ KeyId: `other-${n}`, Key: "other-secret", Status: 0 })) : [
      { KeyId: "selected", Key: "inference-secret", DailyLimitAmount: "50", DailyUsedAmount: "12" }] }
  })
  expect(calls).toEqual([{ ProjectId: "p", Offset: 0, Limit: 100 }, { ProjectId: "p", Offset: 100, Limit: 100 }])
  expect(d).toEqual({ id: "selected", dailyLimit: 50, dailyUsed: 12 })
})

test("direct API keys and incomplete OAuth accounts never trigger control-plane requests", async () => {
  for (const a of [{ type: "api", key: "k" }, { ...auth, keyId: "" }, { ...auth, projectId: "" }, { ...auth, access: "" }]) {
    expect(await readKeyDetails(a, () => { throw new Error("must not call") })).toBeUndefined()
  }
})

test("restricted experimental controls, missing keys and malformed replies downgrade the optional read", async () => {
  for (const body of [{}, { RetCode: 1, Message: "no permission" }, { RetCode: 0, Data: [] }, { RetCode: 0, Data: "invalid" },
    { RetCode: 0, Data: [{ KeyId: "another", Key: "other-secret" }] }]) {
    expect(await readKeyDetails(auth, async () => body)).toBeUndefined()
  }
  expect(await readKeyDetails(auth, async () => { throw new Error("expired oauth-secret") })).toBeUndefined()
})

test("unknown grants stay unknown; explicit grants intersect only when the all-model switch is known false", () => {
  expect(allowedModels(undefined)).toBeNull()
  expect(allowedModels(keyDetails({ KeyId: "selected", GrantedModels: ["a"] }))).toBeNull()
  expect(allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: true, GrantedModels: ["a"] }))).toBeNull()
  expect(allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: false }))).toBeNull()
  expect(allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: false, GrantedModels: [null] }))).toBeNull()
  expect(allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: false, GrantedModels: ["all"] }))).toBeNull()
  expect([...allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: false, GrantedModels: ["a", "b"] }))]).toEqual(["a", "b"])
  expect([...allowedModels(keyDetails({ KeyId: "selected", GrantAllModels: false, GrantedModels: [] }))]).toEqual([])
})

test("quota windows use real settled consumption, clamp only percentage and do not invent resets or currency", () => {
  const summary = summarizeKey({ dailyLimit: 100, dailyUsed: 120, monthlyLimit: 1000, monthlyUsed: 0 })
  expect(summary.windows).toEqual([
    { name: "Daily key budget", used: 100, amount: 120, limit: 100, unit: "account currency", display: "120 / 100 account currency (settled; billing may be delayed)" },
    { name: "Monthly key budget", used: 0, amount: 0, limit: 1000, unit: "account currency", display: "0 / 1000 account currency (settled; billing may be delayed)" },
  ])
  expect(summarizeKey({ dailyLimit: 100, dailyUsed: 25, currency: "USD" }).windows[0].used).toBe(25)
  expect(summarizeKey({ dailyLimit: 0, dailyUsed: 0, monthlyLimit: -1, monthlyUsed: 10 }).windows).toEqual([])
  expect(summarizeKey(undefined)).toEqual({ label: "", windows: [] })
})

test("key restrictions remain readable without inventing quota consumption or displaying IP addresses", () => {
  const summary = summarizeKey({ dailyLimit: 100, monthlyLimit: 1000, grantAllModels: false, grantedModels: ["a", "b"],
    ipWhitelist: ["192.168.1.0/24"], status: 0, expiresAt: "2033-05-18T03:33:20.000Z" })
  expect(summary.label).toBe("daily key cap 100 (account currency); monthly key cap 1000 (account currency); 2 authorized models; IP allowlist: 1 entries; key disabled; key expires 2033-05-18T03:33:20.000Z")
  expect(summary.windows).toEqual([])
  expect(summary.label).not.toContain("192.168.")
})

test("documented Key errors classify separately from revoked login, generic permissions and rate limits", () => {
  expect(classifyError(401, {})).toBe("auth")
  expect(classifyError(403, quota)).toBe("quota")
  expect(classifyError(403, modelError)).toBe("model_access")
  expect(classifyError(403, ipError)).toBe("ip_allowlist")
  expect(classifyError(429, { error: { message: "too many requests" } })).toBe("rate_limit")
  expect(classifyError(403, { error: { message: "Access forbidden" } })).toBe("unknown")
  expect(classifyError(400, { error: { message: "context quota exceeded" } })).toBe("unknown")
  expect(classifyError(404, { error: { code: "model_error", message: "model does not exist" } })).toBe("unknown")
  expect(classifyError(200, quota)).toBe("unknown")
})

test("only explicit rejected Key-quota 403 maps to 429; error content and rate headers survive", async () => {
  const input = Response.json(quota, { status: 403, headers: { "retry-after": "60", "x-request-id": "request-id", "content-length": "999", etag: "old" } })
  const output = await normalizeErrorResponse(input)
  expect(output.status).toBe(429)
  expect(output.headers.get("retry-after")).toBe("60")
  expect(output.headers.get("x-request-id")).toBe("request-id")
  expect(output.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(output.headers.get("content-length")).toBeNull()
  expect(output.headers.get("etag")).toBeNull()
  expect(await output.json()).toEqual(quota)
  expect(await input.json()).toEqual(quota)
  for (const body of [modelError, ipError]) {
    const output = await normalizeErrorResponse(Response.json(body, { status: 403 }))
    expect(output.status).toBe(403)
    expect(output.headers.get("x-magpie-sign-in")).toBe("kept")
    expect(await output.json()).toEqual(body)
  }
})

test("401 marks sign-in expired and errors redact all credential strings while preserving structure", async () => {
  const output = await normalizeErrorResponse(Response.json({ error: { message: "denied inference-secret oauth-secret refresh-secret",
    code: "invalid_key", nested: ["oauth-secret", { detail: "refresh-secret" }] } }, { status: 401 }), [auth.inferenceKey, auth.access, auth.refresh])
  expect(output.status).toBe(401)
  expect(output.headers.get("x-magpie-sign-in")).toBe("expired")
  expect(await output.json()).toEqual({ error: { message: "denied [redacted] [redacted] [redacted]", code: "invalid_key", nested: ["[redacted]", { detail: "[redacted]" }] } })
  const other = await normalizeErrorResponse(Response.json({ error: { message: "bad inference-secret" } }, { status: 400 }), [auth.inferenceKey])
  expect(other.status).toBe(400)
  expect(await other.text()).not.toContain("inference-secret")
  const keyed = await normalizeErrorResponse(Response.json({ error: { [auth.inferenceKey]: { [auth.access]: auth.refresh } } }, { status: 400 }),
    [auth.inferenceKey, auth.access, auth.refresh])
  expect(await keyed.json()).toEqual({ error: { "[redacted]": { "[redacted]": "[redacted]" } } })
})

test("successful and SSE responses retain identity, do not clone, and remain readable as streams", async () => {
  for (const input of [new Response("data: delta\n\n", { headers: { "content-type": "text/event-stream" } }),
    new Response("data: error\n\n", { status: 403, headers: { "content-type": "text/event-stream" } }), Response.json({ data: "ok" })]) {
    input.clone = () => { throw new Error("must not clone stream") }
    expect(await normalizeErrorResponse(input)).toBe(input)
    expect(input.bodyUsed).toBe(false)
    expect(await input.text()).toBeTruthy()
  }
})

test("unknown, non-JSON, malformed and oversized errors pass through with their body intact", async () => {
  for (const input of [Response.json({ error: { message: "unspecified restriction" } }, { status: 403 }), new Response("bad", { status: 502 }),
    new Response("{broken", { status: 401, headers: { "content-type": "application/json" } }),
    Response.json({ error: { message: "x".repeat(66_000) } }, { status: 403 }),
    Response.json(quota, { status: 403, headers: { "content-length": "66000" } })]) {
    expect(await normalizeErrorResponse(input)).toBe(input)
    expect(input.bodyUsed).toBe(false)
    expect(await input.text()).toBeTruthy()
  }
})

test("an incomplete JSON error cannot hold the request indefinitely or consume the caller's response", async () => {
  let controller
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"error":')) } })
  const input = new Response(stream, { status: 403, headers: { "content-type": "application/json" } })
  expect(await normalizeErrorResponse(input)).toBe(input)
  expect(input.bodyUsed).toBe(false)
  controller.enqueue(new TextEncoder().encode('{"message":"unfinished quota"}}'))
  controller.close()
  expect(await input.json()).toEqual({ error: { message: "unfinished quota" } })
})

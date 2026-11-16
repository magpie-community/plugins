// QianWen AI's individual Token Plan: reuse the official CLI's local sign-in
// and show its monthly allowance, reset and subscription expiry in Magpie.
// This is read-only quota support; it does not replace model routing.
import { CredentialError, decryptCredential, findCli, findApiRoutes } from "./credential.mjs"
import { QuotaError, readAllowance } from "./quota.mjs"

const ID = "qwen-token-plan"
const BASE = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1"
const ISSUER = "https://cli.qianwenai.com/data/v2/api.json"
const GATEWAY = "https://cs-data.qianwenai.com/cli/api.json"
const COMMODITY = "sfm_tokenplansolo_public_cn"
const REQUEST_TIMEOUT_MS = 15_000

class NetworkError extends Error {}

function failed(error) {
  if (error instanceof CredentialError || error instanceof QuotaError) return error.message
  return error instanceof NetworkError ? "QianWen quota could not be reached; check network or CLI sign-in" : "QianWen quota is unavailable"
}

async function request(url, options, deadline, fetchImpl = globalThis.fetch) {
  let response
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
  } catch (error) {
    throw new NetworkError(error?.message || "request failed")
  }
  if (response.status === 401 || response.status === 403) throw new QuotaError("QianWen sign-in expired; run qianwen auth login")
  if (!response.ok) throw new QuotaError(`QianWen quota HTTP ${response.status}`)
  try { return await response.json() } catch { throw new QuotaError("QianWen quota returned an invalid response") }
}

async function cliToken(access, deadline, fetchImpl) {
  const body = await request(ISSUER, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}`, "User-Agent": "qianwen-cli/1.10.0" },
    body: JSON.stringify({ product: "ModelStudioRegional", action: "GenerateCLIAccessToken", version: "2026-02-10", region: "cn-beijing", params: {} }),
  }, deadline, fetchImpl)
  if (body?.successResponse !== true || (String(body?.code) !== "200" && String(body?.httpStatusCode) !== "200")) {
    throw new QuotaError("QianWen CLI sign-in is not accepted; run qianwen auth login")
  }
  if (typeof body?.data?.cliAccessToken !== "string" || !body.data.cliAccessToken) throw new QuotaError("QianWen CLI returned no quota access token")
  return body.data.cliAccessToken
}

async function callQuota(api, token, deadline, fetchImpl, data) {
  const url = new URL(GATEWAY)
  url.search = new URLSearchParams({ action: "BroadScopeAspnGateway", product: "sfm_bailian", api }).toString()
  const params = {
    Api: api,
    V: "1.0",
    Data: { ...(data || {}), cornerstoneParam: { protocol: "V2", console: "ONE_CONSOLE", productCode: "p_efm", switchUserType: 3, consoleSite: "QIANWENAI" } },
  }
  const body = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}`, "User-Agent": "qianwen-cli/1.10.0" },
    body: new URLSearchParams({ params: JSON.stringify(params), region: "cn-beijing" }).toString(),
  }, deadline, fetchImpl)
  const gateway = body?.data
  const business = gateway?.DataV2?.data
  if (body?.code !== "200" || body?.successResponse !== true || gateway?.success !== true || business?.code !== "SUCCESS" || business?.success !== true || !business?.data || typeof business.data !== "object") {
    throw new QuotaError("QianWen quota request was rejected")
  }
  return business.data
}

export async function readUsage({ fetchImpl = globalThis.fetch, now = Date.now(), signal } = {}) {
  const { access, bundle } = findCli()
  const routes = findApiRoutes(bundle)
  const deadline = now + REQUEST_TIMEOUT_MS
  const token = await cliToken(access, deadline, fetchImpl)
  const subscription = await callQuota(routes.subscription, token, deadline, fetchImpl, { commodityCode: COMMODITY })
  const config = await callQuota(routes["quota-config"], token, deadline, fetchImpl)
  const usage = await callQuota(routes.usage, token, deadline, fetchImpl)
  return readAllowance(subscription, config, usage, now)
}

export const QwenTokenPlanPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[ID] ??= { name: "Qwen Token Plan", models: {} }
  },
  auth: {
    provider: ID,
    single: true,
    methods: [{ type: "api", label: "QianWen Token Plan API key" }],
    loader: async (getAuth) => {
      const auth = await getAuth()
      if (!auth?.key) return { baseURL: BASE, apiKey: "" }
      return { baseURL: BASE, apiKey: auth.key }
    },
    usage: async () => {
      try { return await readUsage() } catch (error) { return { error: failed(error), windows: [] } }
    },
  },
})

export default { id: ID, server: QwenTokenPlanPlugin }

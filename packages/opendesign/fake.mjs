// A fake of Open Design's two hosts for the tests: one local server standing
// in for the control plane (amr-api) and the model plane (amr-link), which
// the plugin's HOSTS are pointed at. route(key, h) answers "METHOD /path";
// seen lists what came.
import { _internal } from "./index.mjs"

export function fakeOpenDesign() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, headers: req.headers, text }
      if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const was = { ..._internal.HOSTS }
  Object.assign(_internal.HOSTS, { api: origin, link: origin + "/v1" })
  return {
    origin,
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      Object.assign(_internal.HOSTS, was)
    },
  }
}

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

// Fixtures in the shapes Open Design's own source reads (nexu-io/open-design
// apps/daemon/src/integrations/vela-wallet.ts, vela-billing.ts and
// packages/contracts/src/api/collab.ts WorkspaceBillingPreflight)
export const WALLET = { balanceUsd: "12.3456", updatedAt: "2026-10-14T08:00:00.000Z" }
export const SUMMARY = {
  membershipTier: "pro",
  subscriptionStatus: "active",
  balanceUsd: "12.3456",
  creditsPerUsd: 1000,
  availableActions: ["recharge", "upgrade"],
  balances: { totalAvailableCredits: "54000", subscriptionCredits: "42000", rechargeCredits: "12000" },
  subscriptionCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
  subscriptionCurrentPeriodEnd: "2026-11-01T00:00:00.000Z",
  subscriptionCancelAtPeriodEnd: false,
}
export const PREFLIGHT = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  workspaceMemberId: "wm_1",
  modelId: null,
  generatedAt: "2026-10-14T08:00:00.000Z",
  balanceUsd: "12.3456",
  modelCovered: null,
  funding: "coding_plan",
  codingPlan: {
    workspaceId: "ws_1",
    generatedAt: "2026-10-14T08:00:00.000Z",
    eligible: true,
    tier: "pro",
    windows: [
      { policyId: "p_week", durationSeconds: 604800, resetMode: "anchored_recurring", usedCredits: "250000000000000000000", limitCredits: "1000000000000000000000", remainingCredits: "750000000000000000000", windowStart: "2026-10-12T00:00:00.000Z", resetsAt: "2026-10-19T00:00:00.000Z" },
      { policyId: "p_5h", durationSeconds: 18000, resetMode: "activity_triggered", usedCredits: "1500", limitCredits: "6000", remainingCredits: "4500", windowStart: "2026-10-14T06:00:00.000Z", resetsAt: "2026-10-14T11:00:00.000Z" },
    ],
  },
}
// /models as dbydd/opencode-opendesign-auth's seed records it from a real
// account (metadata.context_budget, output_budget, context_limit, cost,
// capability; architecture.input_modalities)
export const MODELS = {
  object: "list",
  data: [
    { id: "deepseek-v4-flash", object: "model", created: 1760000000, owned_by: "amr", metadata: { context_budget: 232000, output_budget: 32000, context_limit: 1048000, cost: "low", capability: "standard" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "claude-sonnet-4.6", object: "model", created: 1760000000, owned_by: "amr", metadata: { context_budget: 200000, cost: "high", capability: "advanced" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  ],
}

// A fake of the MOSS console (portal-api) and API for the tests: one local
// server standing in for platform.mosi.cn and api.mosi.cn, which the plugin's
// ENDPOINTS are pointed at. route(method, path) answers a request; seen
// lists what came.
import { _internal } from "./index.mjs"

export function fakeMoss() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        text,
        url: url.pathname + url.search,
      }
      if (text) {
        try {
          r.json = JSON.parse(text)
        } catch {}
      }
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const was = { ..._internal.ENDPOINTS }
  // The real bases carry their own path prefix (/v1, /portal-api), so the
  // fake's route keys are the real-world paths ("GET /v1/models",
  // "GET /portal-api/me"), like the inkstone fake's are.
  Object.assign(_internal.ENDPOINTS, {
    console: origin,
    api: origin + "/v1",
  })
  return {
    origin,
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      Object.assign(_internal.ENDPOINTS, was)
    },
  }
}

export const json = (v, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

/** The OpenAI-compatible model list MOSS answers GET /v1/models with. */
export const modelsBody = (ids = ["nex-n2.6", "nex-n2.6-2026-11-05", "moss-vl-1.0"]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 1767225600, owned_by: "MOSS" })),
})

/** The console's /portal-api/me row (fields the SPA's u0() reads). */
export const meBody = () => ({
  ID: 42,
  Username: "张三",
  email: "user@example.com",
  phone_number: "12345678901",
  avatar_url: "",
  has_password: true,
})

/** The console's /portal-api/maas/credits/usage-summary row. */
export const usageSummaryBody = () => ({
  display_total_remaining_points: "1,234.56",
  display_available_points: "1,200.00",
  display_frozen_points: "34.56",
  frozen_points: 34.56,
  estimated_available_days: 12.4,
})

/** The console's /portal-api/api_keys list. */
export const keysBody = (items = []) => ({ items, total: items.length })

export const keyRow = (over = {}) => ({
  id: over.id ?? "1",
  name: over.name ?? "moss-key",
  api_key: over.api_key ?? "sk-****abcd",
  status: over.status ?? "active",
  created_at: over.created_at ?? new Date().toISOString(),
  expired_at: null,
})

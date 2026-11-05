// A fake of the InkStone console and API for the tests: one local server
// standing in for the console, its credit APIs and the OpenAI-compatible
// catalogue, which the plugin's ENDPOINTS are pointed at. route(method, path)
// answers a request; seen lists what came.
import { _internal } from "./index.mjs"

export function fakeInkStone() {
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
      if ((req.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")) {
        r.form = Object.fromEntries(new URLSearchParams(text))
      } else if (text) {
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

/** A console success envelope. */
export const ok = (data) => json({ code: 0, msg: "success", data })

/** A console failure envelope: HTTP 200 with a negative code, as the site sends. */
export const fail = (code, msg) => json({ code, msg, data: null })

/** A JWT with the given claims (the console's uaa-token is treated as one). */
export const jwtOf = (claims) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

export function poolUsageFixture() {
  return {
    available_credits: 10,
    active_package_count: 2,
    rpm_limit: 50,
    decision_rpm_limit: 200,
    tpm_limit: 2_000_000,
    usage_windows: {
      "5h": { enabled: true, limit_credits: 10, remaining_credits: 6.5, next_recover_at: "2026-11-05T08:00:00Z" },
      "7d": { enabled: true, limit_credits: 50, remaining_credits: 41.2, next_recover_at: "2026-11-10T08:00:00Z" },
    },
  }
}

export function packagesFixture() {
  return {
    total: 2,
    packages: [
      {
        pkg_id: "pkg-1",
        status: "available",
        remaining_credits: 6.5,
        total_credits: 10,
        current_cycle: { start_at: "2026-11-01T00:00:00Z", end_at: "2026-11-28T12:00:00Z" },
        remark: "每月免费基础包",
      },
      {
        pkg_id: "pkg-2",
        status: "unused",
        remaining_credits: 50,
        total_credits: 50,
        current_cycle: { start_at: "2026-11-01T00:00:00Z", end_at: "2026-12-28T00:00:00Z" },
        remark: "扩容包",
      },
    ],
  }
}

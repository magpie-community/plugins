// A fake of Trae for the tests: one local server standing in for the
// realm's authorization page host and its other hosts, which the plugin's
// HOSTS are pointed at. route(method, path) answers a request; seen lists
// what came. The CN realm is the default, so a test written before the two
// realms shared a package is unchanged; pass "trae-global" for the
// international one, whose hosts and usage page differ.
import { _internal } from "./index.mjs"

const HOST_KEYS = ["web", "auth", "api", "us", "pay", "usPay"]

export function fakeTrae(siteId = "trae-cn") {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, text }
      if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const hosts = _internal.SITES[siteId].hosts
  const was = { ...hosts }
  Object.assign(hosts, { web: origin, auth: origin, api: origin, us: origin, pay: origin, usPay: origin })
  return {
    origin,
    site: _internal.SITES[siteId],
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      for (const k of HOST_KEYS) if (was[k] === undefined) delete hosts[k]
      Object.assign(hosts, was)
    },
  }
}

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

// sse is an answer in Trae's events: [event, data] pairs
export const sse = (events, status = 200) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""), { status, headers: { "content-type": "text/event-stream" } })

export const jwtOf = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

export const signedIn = (over = {}) => ({
  type: "oauth", access: "jwt-1", refresh: "r-1", expires: Date.now() + 3600_000, accountId: "Ann", uid: "u-1",
  clientId: "ono9krqynydwx5", deviceId: "1234567890123456789", machineId: "ab".repeat(16), ...over,
})

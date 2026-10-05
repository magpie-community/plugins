// A fake of Trae Global for the tests: one local server standing in for
// trae.ai's authorization page host, the SG auth host and the model host,
// which the plugin's HOSTS are pointed at. route(method, path) answers a
// request; seen lists what came.
import { _internal } from "./index.mjs"

export function fakeTrae() {
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
  const was = { ..._internal.HOSTS }
  Object.assign(_internal.HOSTS, { web: origin, auth: origin, api: origin, us: origin, usPay: origin, pay: origin })
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

// sse is an answer in Trae's events: [event, data] pairs
export const sse = (events, status = 200) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""), { status, headers: { "content-type": "text/event-stream" } })

export const jwtOf = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

export const signedIn = (over = {}) => ({
  type: "oauth", access: "jwt-1", refresh: "r-1", expires: Date.now() + 3600_000, accountId: "Ann", uid: "u-1",
  clientId: "ono9krqynydwx5", deviceId: "1234567890123456789", machineId: "ab".repeat(16), ...over,
})

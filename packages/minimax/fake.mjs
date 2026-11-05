// A fake of MiniMax's hosts for the tests: one local server standing in
// for the account, agent and platform hosts of both sites, which the
// plugin's SITES are pointed at. route(method, path) answers a request;
// seen lists what came.
import { _internal } from "./index.mjs"

export function fakeMiniMax() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, text, url: url.pathname + url.search }
      if ((req.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")) r.form = Object.fromEntries(new URLSearchParams(text))
      else if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const was = {}
  for (const [id, s] of Object.entries(_internal.SITES)) {
    was[id] = { ...s }
    Object.assign(s, { account: origin, llm: origin, agent: origin, platform: origin, ...(s.agentFallback ? { agentFallback: origin } : {}) })
  }
  _internal.renewing.clear()
  _internal.renewed.clear()
  return {
    origin,
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      for (const [id, s] of Object.entries(was)) Object.assign(_internal.SITES[id], s)
    },
  }
}

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

// a JWT as MiniMax's tokens are, with the claims given
export const jwtOf = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

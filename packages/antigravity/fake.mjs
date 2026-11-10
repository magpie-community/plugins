// A fake Google for the tests: OAuth's token endpoint, the update
// manifest and Code Assist's methods, each answered from `replies`.
import { _internal } from "./index.mjs"

export const real = globalThis.fetch

export function reset() {
  for (const m of [_internal.tokens, _internal.projects, _internal.lists, _internal.refused]) m.clear()
  _internal.ver.v = "3.1.4"
  _internal.ver.at = Date.now()
  _internal.onboardPoll = 1
}

export function fake(replies = {}) {
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const body = typeof init.body === "string" ? init.body : ""
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const m = /\/v1internal:([a-zA-Z]+)/.exec(url)
    const name = m ? m[1] : url.startsWith("https://oauth2.googleapis.com/token") ? "token" : url.includes("userinfo") ? "who" : url
    seen.push({ name, url, body, headers, json: (() => { try { return JSON.parse(body) } catch { return undefined } })() })
    let r = replies[name]
    if (typeof r === "function") r = r(seen[seen.length - 1], seen)
    if (r === undefined) {
      if (name === "token") r = { access_token: "tok-new", expires_in: 3600 }
      else if (name === "loadCodeAssist") r = { cloudaicompanionProject: "ag-proj", currentTier: { id: "free-tier", name: "Antigravity" } }
      else if (name === "fetchAvailableModels") r = { models: {} }
      else if (name === "retrieveUserQuotaSummary") r = { groups: [] }
      else return new Response("not found", { status: 404 })
    }
    if (r instanceof Response) return r
    return new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } })
  }
  return seen
}

export const auth = (project = "ag-proj") => ({
  type: "oauth",
  access: "tok",
  refresh: "rt-ag|" + project,
  expires: Date.now() + 3600_000,
  accountId: "ag@example.com",
})

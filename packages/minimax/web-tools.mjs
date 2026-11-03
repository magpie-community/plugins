// MiniMax's native search is separate from the Connector catalog. Page
// retrieval follows the desktop client: local HTTP, bounded text, no login.
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })
const string = { type: "string", minLength: 1 }
const sites = ["minimax-code", "minimax-code-global"]
const freshness = ["noLimit", "day", "week", "month", "year"]
const searchTypes = ["search", "videos", "places", "news", "shopping"]
function args(value, allowed) {
  if (!object(value)) throw new Error("arguments must be an object")
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("unknown argument: " + key)
  return value
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " must be a non-empty string")
  return value
}
const MAX_BYTES = 2 * 1024 * 1024
async function fetchPage(value, ctx = {}) {
  const a = args(value, ["url", "method"])
  let url
  try { url = new URL(text(a.url, "url")) } catch { throw new Error("url must be an absolute HTTP(S) URL") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url must be an HTTP(S) URL with no embedded credentials")
  const method = a.method ?? "GET"
  if (!["GET", "HEAD"].includes(method)) throw new Error("method must be GET or HEAD")
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(ctx.abort ? [ctx.abort] : [])])
  signal.throwIfAborted()
  const res = await fetch(url, { method, signal, redirect: "follow", headers: { "User-Agent": "MiniMaxAgent" } })
  const contentType = res.headers.get("content-type") ?? ""
  const metadata = { url: url.href, finalUrl: res.url, status: res.status, statusText: res.statusText, contentType, ...(res.headers.has("retry-after") ? { retryAfter: res.headers.get("retry-after") } : {}) }
  if (method === "HEAD") return { ...metadata, bytes: 0, content: "", truncated: false }
  const mime = contentType.split(";", 1)[0].trim().toLowerCase()
  if (!(mime.startsWith("text/") || /^application\/(json|xml|javascript|x-www-form-urlencoded)$/.test(mime) || /\+(json|xml)$/.test(mime))) {
    await res.body?.cancel()
    return { ...metadata, bytes: 0, content: "", truncated: false, retrievalOutcome: "non_text" }
  }
  const reader = res.body?.getReader()
  if (!reader) return { ...metadata, bytes: 0, content: "", truncated: false }
  const decoder = new TextDecoder()
  let content = "", bytes = 0, truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const length = Math.min(value.byteLength, MAX_BYTES - bytes)
      content += decoder.decode(value.subarray(0, length), { stream: true })
      bytes += length
      if (length < value.byteLength) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    content += decoder.decode()
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e
  } finally { reader.releaseLock() }
  signal.throwIfAborted()
  // MCP responses should stay usable by an agent even for large HTML pages.
  if (content.length > 64000) { content = content.slice(0, 48000) + "\n[content truncated]\n" + content.slice(-16000); truncated = true }
  return { ...metadata, bytes, content, truncated, retrievalOutcome: res.ok ? "usable_content" : "http_error" }
}

export function createWebTools(request) {
  return {
    web_search: {
      description: "Search the live web through MiniMax Code for facts, news, videos, places and shopping. Return the upstream sources and search metadata. Cite result URLs; use web_fetch to read a source page.",
      args: schema({
        query: { ...string, description: "Search query" },
        count: { type: "integer", minimum: 1, description: "Maximum results (server default 10)" },
        freshness: { type: "string", enum: freshness },
        search_type: { type: "string", enum: searchTypes },
        site: { type: "string", enum: sites, default: "minimax-code" },
        account: { ...string, description: "Full Magpie account key for the selected site, such as minimax-code#xxxxxx. Defaults to its primary account." },
      }, ["query"]),
      async execute(value, ctx = {}) {
        const { site = "minimax-code", account, ...input } = args(value, ["query", "count", "freshness", "search_type", "site", "account"])
        text(input.query, "query")
        if (!sites.includes(site)) throw new Error("unknown MiniMax Code site")
        if (account !== undefined) text(account, "account")
        if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1)) throw new Error("count must be a positive integer")
        if (input.freshness !== undefined && !freshness.includes(input.freshness)) throw new Error("invalid freshness")
        if (input.search_type !== undefined && !searchTypes.includes(input.search_type)) throw new Error("invalid search_type")
        ctx.abort?.throwIfAborted()
        const { base_resp, ...payload } = await request(site, "/mavis/api/v1/mcp/web_search", input, { account, signal: ctx.abort, timeoutMs: 120000 })
        return payload
      },
    },
    web_fetch: {
      description: "Retrieve raw text or metadata from an absolute HTTP(S) URL. Follows redirects, supports GET/HEAD, reads at most 2 MiB and bounds the returned text. This is direct HTTP retrieval; JavaScript pages may require a browser.",
      args: schema({ url: { ...string, description: "Absolute HTTP(S) URL" }, method: { type: "string", enum: ["GET", "HEAD"], default: "GET" } }, ["url"]),
      execute: fetchPage,
    },
  }
}

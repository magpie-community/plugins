// MiniMax's native search is separate from the Connector catalog.
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

export function createWebTools(request) {
  return {
    web_search: {
      description: "Search the live web through MiniMax Code for facts, news, videos, places and shopping. Return the upstream sources and search metadata. Cite result URLs; use an available webpage-reading tool to read a source page.",
      args: schema({
        query: { ...string, description: "Search query" },
        count: { type: "integer", minimum: 1, description: "Maximum results (server default 10)" },
        freshness: { type: "string", enum: freshness },
        search_type: { type: "string", enum: searchTypes },
        site: { type: "string", enum: sites, default: "minimax-code" },
        account: { ...string, description: "Full stored account key for the selected site, such as minimax-code#xxxxxx. Defaults to that site's first stored account." },
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
  }
}

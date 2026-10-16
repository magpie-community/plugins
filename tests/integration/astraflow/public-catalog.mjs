// Read-only live listing acceptance. No real or fixture key is sent to UCloud.
import assert from "node:assert/strict"
import { AstraFlowPlugin } from "../../../packages/astraflow/index.mjs"

const catalogs = []
for (const protocol of ["chat", "gemini"]) {
  const endpoint = `https://api.modelverse.cn/${protocol === "gemini" ? "v1beta" : "v1"}/models`
  const pages = new Map()
  const rows = []
  const seen = new Set()
  let url = endpoint
  while (url) {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" })
    assert.equal(upstream.status, 200)
    const body = await upstream.json()
    const page = protocol === "gemini" ? body.models : body.data
    assert.ok(Array.isArray(page))
    pages.set(url, body)
    rows.push(...page)
    const next = protocol === "gemini" ? body.nextPageToken : undefined
    if (!next) break
    assert.equal(typeof next, "string")
    assert.ok(!seen.has(next) && seen.size < 100)
    seen.add(next)
    const following = new URL(endpoint)
    following.searchParams.set("pageToken", next)
    url = following.href
  }
  assert.ok(rows.length)
  catalogs.push({ protocol, endpoint, pages, rows })
}
const original = globalThis.fetch
try {
  const plugin = await AstraFlowPlugin()
  for (const { protocol, endpoint, pages, rows } of catalogs) {
    // Feed the anonymous live response through the actual discovery hook.
    globalThis.fetch = async (url, init) => {
      assert.ok(pages.has(url))
      assert.equal(init.headers.Authorization, "Bearer fixture-catalog-key")
      if (protocol === "gemini") assert.equal(init.headers["x-goog-api-key"], "fixture-catalog-key")
      return Response.json(pages.get(url))
    }
    const models = await plugin.provider.models({}, { auth: { type: "api", key: "fixture-catalog-key", metadata: { protocol } } })
    const ids = Object.keys(models)
    assert.ok(ids.length && ids.length < rows.length)
    for (const id of ids) {
      assert.ok(rows.some((m) => (m.id ?? m.baseModelId ?? m.name?.replace(/^models\//, "")) === models[id].api.id))
      assert.ok(!/image|nano-banana/.test(id))
      assert.equal(models[id].api.url, endpoint.replace(/\/models$/, ""))
      assert.equal(models[id].cost.input, 0)
      assert.equal(models[id].cost.output, 0)
    }
    console.log(JSON.stringify({ endpoint, listed: rows.length, conversational: ids.length,
      excluded: rows.length - ids.length, paidRequests: 0, authenticatedUpstreamRequests: 0 }))
  }
} finally {
  globalThis.fetch = original
}

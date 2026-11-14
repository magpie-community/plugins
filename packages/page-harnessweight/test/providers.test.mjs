import { test } from "node:test"
import assert from "node:assert/strict"
import { parseUsageLine } from "../lib/usage.mjs"
import { summarizeProviders } from "../lib/providers.mjs"
import { errorReason } from "../lib/errors.mjs"
import { providerView } from "../app/providers.js"
import { translate } from "../app/i18n.mjs"

const row = (values = {}) => parseUsageLine(JSON.stringify({ t: 100, agent: "claude", model: "m1", provider: "alpha", status: 200, ...values }))
const summarize = (rows, options = {}) => summarizeProviders(rows, { since: 50, now: 200, ...options })

test("supplier/harness rates use all requests and separate cancellations, including failures with HTTP 200", () => {
  const rows = [row(), row({ status: 429 }), row({ status: 499, err: "cancelled" }), row({ status: 200, err: "stream failed" }), row({ agent: "codex" }), row({ provider: "beta", status: 502 })]
  const { providers } = summarize(rows)
  const p = providers.find(p => p.provider === "alpha")
  assert.deepEqual([p.calls, p.failed, p.cancelled, p.errorRate], [5, 2, 1, 2 / 5])
  const claude = p.harnesses.find(a => a.agent === "claude")
  assert.deepEqual([claude.calls, claude.failed, claude.cancelled, claude.errorRate], [4, 2, 1, .5])
  assert.equal(p.reasons.reduce((n, r) => n + r.count, 0), p.failed)
  assert.equal(p.reasons.find(r => r.reason === "rateLimit").status, 429)
  assert.equal(providers.find(p => p.provider === "beta").errorRate, 1)
})

test("period, client and exact model filters preserve discovery and distinguish unknown providers", () => {
  const rows = [row(), row({ model: "m2" }), row({ agent: "curl" }), row({ t: 49 }), row({ t: 201 }), row({ provider: undefined, model: "legacy" })]
  const all = summarize(rows)
  assert.equal(all.providers.reduce((n, p) => n + p.calls, 0), 3)
  assert.deepEqual(all.models, ["legacy", "m1", "m2"])
  assert.equal(all.providers.find(p => p.provider === "unknown").calls, 1)
  assert.equal(summarize(rows, { showClients: true }).providers[0].calls, 3)
  const filtered = summarize(rows, { model: "m2" })
  assert.equal(filtered.providers[0].calls, 1)
  assert.deepEqual(filtered.models, all.models)
  assert.deepEqual(filtered.providerOptions, all.providerOptions)
  assert.deepEqual(summarize(rows, { model: "missing" }).providers, [])
  assert.deepEqual(summarize([]).models, [])
})

test("classifies common failure reasons without retaining private upstream payloads", () => {
  for (const [status, type, message, expected] of [
    [400, "context_length_exceeded", "", "context"], [429, "insufficient_quota", "", "quota"],
    [429, "", "", "rateLimit"], [401, "", "", "auth"], [403, "", "", "auth"],
    [404, "", "The requested model is not supported", "model"], [504, "", "", "timeout"],
    [0, "", "socket ECONNRESET", "network"],
    [200, "", "WorkBuddy: ECONNRESET: The socket connection was closed", "stream"], [502, "", "", "server"],
    [400, "invalid_request_error", "", "request"], [0, "", "", "unknown"],
    [200, "", "Codex: connection lost mid-reply (unexpected EOF)", "stream"],
    [200, "", "the model answered nothing", "emptyReply"],
    [200, "reply_loop", "magpie ended this reply", "replyLoop"],
    [200, "", "Internal server error. Please retry", "server"],
  ]) assert.equal(errorReason(status, type, message), expected)
  // Built at runtime so the file holds no credential-shaped literal.
  const privateText = ["CUSTOM_PRIVATE_ACCOUNT", "sk", "example", "private", "value"].join("-")
  const r = row({ status: 500, err: privateText, host: "private.example", providerAccount: privateText })
  assert.equal(r.errorReason, "server")
  assert.ok(!JSON.stringify(r).includes(privateText))
  assert.ok(!JSON.stringify(summarize([r])).includes(privateText))
  assert.ok(!JSON.stringify(summarize([r])).includes("private.example"))
})

test("authenticated summary exposes model-filtered supplier reports without changing agent totals", async () => {
  const { createServer } = await import("node:http")
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createHandler, TOKEN_HEADER } = await import("../service.mjs")
  const dir = await mkdtemp(join(tmpdir(), "hw-providers-"))
  const server = createServer()
  try {
    const rows = [
      { agent: "claude", provider: "alpha", model: "m1", status: 200 },
      { agent: "codex", provider: "alpha", model: "m2", status: 429, err: "PRIVATE_PAYLOAD" },
      { agent: "codex", provider: "alpha", model: "m2", status: 499 },
    ].map(r => JSON.stringify({ t: Date.now() - 100, ...r }))
    await writeFile(join(dir, "usage.jsonl"), rows.join("\n") + "\n")
    await new Promise(r => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    server.on("request", createHandler({ port, token: "test-token", dataDir: dir, usageLog: join(dir, "usage.jsonl"), gatewayUrl: "http://127.0.0.1:9" }))
    const response = await fetch(`http://127.0.0.1:${port}/api/summary?providerModel=m2`, { headers: { [TOKEN_HEADER]: "test-token" } })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.totals.calls, 3)
    const p = result.providerView.providers[0]
    assert.deepEqual([p.calls, p.failed, p.cancelled, p.errorRate], [2, 1, 1, .5])
    assert.deepEqual(p.harnesses.map(h => h.agent), ["codex"])
    assert.deepEqual(result.providerView.models, ["m1", "m2"])
    assert.equal(JSON.stringify(result.providerView).includes("PRIVATE_PAYLOAD"), false)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})


test("provider UI isolates missing service data, clears stale reports and recovers on the next summary", t => {
  const ids = ["providerPicker", "providerGallery", "providerExpand", "providerHarnesses", "providerUnavailable", "providerReport", "providerModel", "providerShare", "providerReportTitle", "providerReportMark", "providerScope", "providerKpis", "providerTable", "providerReasons", "providersBlock", "clients"]
  const nodes = Object.fromEntries(ids.map(id => {
    const node = new EventTarget()
    Object.assign(node, { innerHTML: "", textContent: "", value: "", disabled: false, hidden: false, checked: false })
    const attributes = new Map()
    node.setAttribute = (key, value) => attributes.set(key, value)
    node.getAttribute = key => attributes.get(key)
    return [id, node]
  }))
  const original = globalThis.document
  const classes = new Set()
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: id => nodes[id] || null,
    body: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
  })
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original })
  const renderedMarks = []
  const ui = providerView({ T: key => translate("en", key), esc: String, int: String, pct: String, locale: "en", mark: info => { renderedMarks.push(info); return '<span class="mark"></span>' }, onModelChange() {} })
  const summary = { since: 50, generatedAt: 200, agents: [{ agent: "claude", name: "Claude Code" }], totals: { calls: 1 } }
  const originalSummary = structuredClone(summary)
  const healthy = { ...summary, providerView: summarize([row()]) }

  for (const missing of [undefined, null, {}, { providers: [], models: [] }, { providerOptions: [], providers: [], models: null }]) {
    ui.paint({ ...summary, providerView: missing })
    assert.equal(nodes.providerUnavailable.hidden, false)
    assert.equal(nodes.providerPicker.hidden, true)
    assert.equal(nodes.providerReport.hidden, true)
    for (const id of ["providerModel", "providerShare"]) assert.equal(nodes[id].disabled, true, id)
    nodes.providerShare.dispatchEvent(new Event("click"))
    assert.equal(ui.isSharing(), false)
  }
  ui.paint(healthy)
  assert.equal(nodes.providerUnavailable.hidden, true)
  assert.equal(nodes.providerReport.hidden, false)
  for (const id of ["providerModel", "providerShare"]) assert.equal(nodes[id].disabled, false, id)
  assert.match(nodes.providerTable.innerHTML, /Claude Code/)
  assert.match(nodes.providerGallery.innerHTML, /data-provider="alpha" aria-pressed="true"/)
  assert.match(nodes.providerHarnesses.innerHTML, /Claude Code/)
  assert.match(nodes.providerKpis.innerHTML, /Observed Harnesses/)
  assert.equal(nodes.providerPicker.hidden, false)

  const customIcon = "data:image/svg+xml;base64,PHN2Zy8+"
  const branded = summarize([row({ provider: "codex" })])
  branded.brands = { codex: { name: "My provider label", icon: customIcon } }
  renderedMarks.length = 0
  ui.paint({ ...summary, providerView: branded })
  assert.equal(nodes.providerReportTitle.textContent, "My provider label")
  assert.ok(renderedMarks.some(info => info.agent === "codex" && info.icon === customIcon), "host icon must override the bundled provider mark")
  assert.match(nodes.providerGallery.innerHTML, /My provider label/)
  ui.paint(healthy)
  assert.equal(nodes.providerReportTitle.textContent, "alpha", "older summaries without brands retain fallback labels")

  ui.paint(summary)
  for (const id of ["providerGallery", "providerHarnesses", "providerModel", "providerReportTitle", "providerReportMark", "providerScope", "providerKpis", "providerTable", "providerReasons"]) assert.equal(nodes[id].innerHTML, "", id)
  assert.deepEqual(summary, originalSummary)
  ui.paint(healthy)
  assert.match(nodes.providerTable.innerHTML, /Claude Code/)
  assert.equal(nodes.providerShare.disabled, false)

  const many = { ...summary, providerView: summarize([
    ...Array.from({ length: 9 }, (_, i) => row({ provider: `supplier-${i}` })),
    row({ provider: "supplier-7" }), row({ provider: "supplier-7" }),
  ]) }
  ui.paint(many)
  const galleryOrder = [...nodes.providerGallery.innerHTML.matchAll(/data-provider="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(galleryOrder, ["supplier-7", "supplier-0", "supplier-1", "supplier-2", "supplier-3", "supplier-4"])
  assert.equal((nodes.providerGallery.innerHTML.match(/data-provider=/g) || []).length, 6)
  assert.equal(nodes.providerExpand.hidden, false)
  nodes.providerExpand.dispatchEvent(new Event("click"))
  assert.equal((nodes.providerGallery.innerHTML.match(/data-provider=/g) || []).length, 9)
  assert.equal(nodes.providerExpand.getAttribute("aria-expanded"), "true")
  nodes.providerGallery.closest = () => ({ dataset: { provider: "supplier-8" } })
  nodes.providerGallery.dispatchEvent(new Event("click"))
  assert.equal(nodes.providerReportTitle.textContent, "supplier-8")
  nodes.providerExpand.dispatchEvent(new Event("click"))
  assert.equal((nodes.providerGallery.innerHTML.match(/data-provider=/g) || []).length, 6)
  assert.match(nodes.providerGallery.innerHTML, /data-provider="supplier-8" aria-pressed="true"/)
  assert.equal(nodes.providerExpand.getAttribute("aria-expanded"), "false")

  ui.paint({ ...summary, providerView: summarize([
    row(), row({ status: 500 }), row(), row({ agent: "codex" }),
  ]) })
  assert.match(nodes.providerKpis.innerHTML, /25\.00%/)
  assert.match(nodes.providerHarnesses.innerHTML, /33\.33%/)
  assert.match(nodes.providerHarnesses.innerHTML, /0\.00%/)
  assert.doesNotMatch(nodes.providerHarnesses.innerHTML, /metric-(best|worst)|Best|Worst/)
  assert.match(nodes.providerTable.innerHTML, /extreme-label/)

  assert.throws(() => ui.paint({
    ...healthy,
    providerView: { ...healthy.providerView, providers: [{ ...healthy.providerView.providers[0], harnesses: null }] },
  }), TypeError, "malformed provider records must not be treated as unavailable service data")
  assert.equal(nodes.providerUnavailable.hidden, true)

  ui.paint({ ...summary, providerView: summarize([]) })
  assert.equal(nodes.providerUnavailable.hidden, true)
  assert.equal(nodes.providerReport.hidden, false)
  assert.match(nodes.providerReasons.innerHTML, /No requests match/)
  assert.equal(nodes.providerShare.disabled, true)
  assert.equal(nodes.providerModel.disabled, false)
})

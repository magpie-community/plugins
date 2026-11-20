import assert from "node:assert/strict"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../dist/index.mjs"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-provider-runtime-"))
process.env.XDG_CACHE_HOME = home
process.env.XDG_CONFIG_HOME = home
process.env.TMPDIR = home
process.env.MAGPIE_ADDR = "invalid-local-address-must-not-be-used"
const requests = []
let rows = [{ id: "cursor/gpt-5.5", owned_by: "cursor", display_name: "GPT", context_window: 200000, max_output_tokens: 16000 }]
let fail = false
const server = createServer((req, res) => {
  requests.push({ path: req.url, headers: req.headers })
  res.setHeader("Content-Type", "application/json")
  if (req.url.startsWith("/redirect/")) {
    res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/leaked` })
    return res.end()
  }
  if (req.url.endsWith("/models")) {
    if (fail) { res.statusCode = 503; return res.end("{}") }
    return res.end(JSON.stringify({ data: req.headers["x-magpie-drawers"] ? [{ id: "test/image", kind: "image" }] : rows }))
  }
  if (req.url.endsWith("/images/generations")) return res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }))
  res.end("{}")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/proxy/v1`
const token = "test-only-gateway-key"
const remote = { baseURL, token }
const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realWarn = console.warn
let catalogDownloads = 0
const catalogRequests = []
const intervals = new Set()
globalThis.fetch = async (input, init) => {
  if (String(input) === "https://models.dev/api.json") {
    catalogDownloads++
    const request = new Request(input, init)
    catalogRequests.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.text(), redirect: request.redirect })
    return Response.json({ openai: { models: { "gpt-5.5": { cost: { input: 1, output: 2 } } } } })
  }
  return realFetch(input, init)
}
globalThis.setInterval = (tick, ms) => {
  assert.equal(ms, 30000)
  const timer = { tick, unref() {} }
  intervals.add(timer)
  return timer
}
globalThis.clearInterval = timer => intervals.delete(timer)
const waitFor = async fn => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for provider refresh")
}
function context(options) {
  const hooks = new Map(), tools = new Map(), registrations = []
  const state = { catalog: [], reloads: 0, disposed: [], hooks, tools }
  let transform
  const register = name => {
    registrations.push(name)
    return { dispose: async () => { state.disposed.push(name) } }
  }
  return Object.assign(state, {
    registrations,
    ctx: {
      options,
      provider: {
        transform: async fn => { transform = fn; return register("provider") },
        reload: async () => { const catalog = []; transform({ add: entry => catalog.push(entry) }); state.catalog = catalog; state.reloads++ },
      },
      session: { hook: async (name, fn) => { hooks.set(name, fn); return register(name) } },
      tool: { transform: async fn => { fn({ namespace() {}, add: tool => tools.set(tool.name, tool) }); return register("tools") } },
      skill: { transform: async fn => { fn({ add(skill) { assert.equal(typeof skill.content, "string") } }); return register("skill") } },
    },
  })
}
let cleanup
try {
  assert.equal(plugin.id, "magpie.providers")
  for (const agentID of ["", "UPPER", "with space", "bad\nheader", "a".repeat(65), 12]) {
    await assert.rejects(plugin.setup(context({ agentID, remote }).ctx), /agentID/)
  }
  for (const bad of [
    { baseURL: "file:///secret", token }, { baseURL: baseURL + "?key=secret", token },
    { baseURL, token: "bad\r\nheader" }, { baseURL, token: "contains space" },
  ]) await assert.rejects(plugin.setup(context({ remote: bad }).ctx), /remote/)
  assert.equal(requests.length, 0)

  const offline = context({ remote })
  const stopOffline = await plugin.setup(offline.ctx)
  assert.equal(catalogDownloads, 0)
  await stopOffline()
  requests.length = 0

  const state = context({ agentID: "yuri", remote, modelsDev: true })
  cleanup = await plugin.setup(state.ctx)
  assert.equal(state.catalog[0].info.id, "magpie-cursor")
  assert.equal(state.catalog[0].info.headers["X-Magpie-Agent"], "yuri")
  assert.equal(new Headers(state.catalog[0].info.headers).has("User-Agent"), false)
  assert.equal(requests[0].headers.authorization, `Bearer ${token}`)
  assert.equal(requests[0].headers["x-magpie-agent"], "yuri")
  assert.equal(state.catalog[0].models[0].settings.apiKey, token)
  const hook = state.hooks.get("http.request")
  for (const suffix of ["/chat/completions", "/responses", "/messages"]) {
    const request = new Request(baseURL + suffix, { headers: { "User-Agent": "opencode/test/real-host" } })
    await hook({ request, sessionID: "test-yuri-session" })
    assert.equal(request.headers.get("X-Magpie-Agent"), "yuri")
    assert.equal(request.headers.get("User-Agent"), "opencode/test/real-host")
    assert.equal(request.headers.get("X-Magpie-Session"), "test-yuri-session")
  }
  for (const url of ["https://other.test/proxy/v1/chat/completions", baseURL + "-other/chat", `http://127.0.0.1:${server.address().port}/not-api`]) {
    const request = new Request(url)
    await hook({ request, sessionID: "private-session" })
    assert.equal(request.headers.has("X-Magpie-Agent"), false)
    assert.equal(request.headers.has("X-Magpie-Session"), false)
    assert.equal(request.headers.has("Authorization"), false)
  }
  const signal = new AbortController().signal
  await state.tools.get("image_list").execute({}, { signal })
  const image = await state.tools.get("image_gen").execute({ prompt: "test" }, { signal })
  assert.ok(image.content.includes("![image]"))
  // The fixture owns only this generated image, never other users' temp images.
  const imagePath = image.content.match(/!\[image\]\((.*?)\)/)?.[1]?.replace(/^<|>$/g, "")
  assert.ok(imagePath && path.dirname(imagePath) === path.join(os.tmpdir(), "magpie-images"))
  await fs.unlink(imagePath)
  assert.ok(requests.filter(req => req.path.startsWith("/proxy/")).every(req => req.headers["x-magpie-agent"] === "yuri"))
  assert.ok(requests.every(req => !String(req.headers["user-agent"]).includes("yuri")))

  rows = [{ ...rows[0], id: "workbuddy/gpt-5.5", owned_by: "workbuddy" }]
  ;[...intervals][0].tick()
  await waitFor(() => state.catalog[0].info.id === "magpie-workbuddy")
  assert.equal(state.catalog[0].info.headers["X-Magpie-Agent"], "yuri")
  assert.equal(requests.at(-1).headers["x-magpie-agent"], "yuri")
  fail = true
  let warnings = 0
  console.warn = () => warnings++
  ;[...intervals][0].tick()
  await waitFor(() => warnings > 0)
  assert.equal(state.catalog[0].info.id, "magpie-workbuddy")
  fail = false
  await cleanup()
  cleanup = undefined
  assert.equal(intervals.size, 0)
  assert.deepEqual(state.disposed, [...state.registrations].reverse())
  await waitFor(() => catalogDownloads > 0)
  await waitFor(() => fs.access(path.join(home, "opencode-magpie-plugin/models.json")).then(() => true, () => false))
  for (const request of catalogRequests) {
    assert.equal(Object.hasOwn(request.headers, "authorization"), false)
    assert.equal(Object.hasOwn(request.headers, "x-magpie-agent"), false)
    assert.equal(JSON.stringify(request).includes(token), false)
    assert.equal(request.redirect, "error")
  }

  const tokenFile = path.join(home, "connection.json")
  await fs.writeFile(tokenFile, JSON.stringify({ baseURL, gatewayKey: token }))
  const assigned = context({ agentID: "yuri", remote: { baseURL, tokenFile } })
  const stopAssigned = await plugin.setup(assigned.ctx)
  await fs.writeFile(tokenFile, JSON.stringify({ baseURL, gatewayKey: "rotated-test-key" }))
  const assignedRequest = new Request(baseURL + "/chat/completions", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "opencode/test/real-host" } })
  await assigned.hooks.get("http.request")({ request: assignedRequest, sessionID: "assigned-session" })
  assert.equal(assignedRequest.headers.get("Authorization"), "Bearer rotated-test-key")
  assert.equal(assignedRequest.headers.get("User-Agent"), "opencode/test/real-host")
  await assigned.tools.get("image_list").execute({}, { signal })
  assert.equal(requests.at(-1).headers.authorization, "Bearer rotated-test-key")
  await fs.unlink(tokenFile)
  await assert.rejects(assigned.hooks.get("http.request")({ request: assignedRequest, sessionID: "assigned-session" }), /tokenFile/)
  await stopAssigned()

  const legacy = context({ remote })
  const stopLegacy = await plugin.setup(legacy.ctx)
  assert.equal(requests.at(-1).headers["x-magpie-agent"], "opencode")
  await stopLegacy()
  await assert.rejects(plugin.setup(context({ remote: { baseURL: baseURL.replace("/proxy/", "/redirect/"), token } }).ctx))
  assert.equal(requests.some(req => req.path === "/leaked"), false)

  const broken = context({ agentID: "yuri", remote })
  broken.ctx.provider.reload = async () => { throw new Error("reload failed") }
  await assert.rejects(plugin.setup(broken.ctx), /reload failed/)
  assert.deepEqual(broken.disposed, [...broken.registrations].reverse())
  assert.equal(intervals.size, 0)
} finally {
  await cleanup?.()
  globalThis.fetch = realFetch
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  console.warn = realWarn
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await fs.rm(home, { recursive: true, force: true })
}

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { StrataPlugin } from "./index.mjs"
import { authHost } from "./auth-fixture.mjs"

const dirs = []
const temporaryRoot = resolve(process.env.TEMP ?? tmpdir())
afterEach(() => {
  for (const d of dirs.splice(0)) {
    if (!resolve(d).startsWith(join(temporaryRoot, "strata-hooks-"))) throw new Error("Unexpected temporary directory")
    rmSync(d, { recursive: true, force: true })
  }
})
function host() {
  const directory = mkdtempSync(join(temporaryRoot, "strata-hooks-"))
  dirs.push(directory)
  return { directory, ...authHost(directory) }
}
test("A01/A05: configuration saves the target and defaults to stopping, without starting a service", async () => {
  const h = host()
  const hooks = await StrataPlugin(h)
  const empty = {}
  await hooks.config(empty)
  expect(Object.keys(empty.provider.strata.models)).toEqual(["configure-strata"])
  const inputs = { root: process.cwd(), python: process.execPath, config: import.meta.filename,
    model: "my-local-model", baseURL: "http://127.0.0.1:49199/v1", environment: "{}" }
  expect(hooks.auth.methods[0].type).toBe("oauth")
  expect(hooks.auth.methods[0].prompts.length).toBe(8)
  const authorization = await hooks.auth.methods[0].authorize(inputs)
  expect(authorization).toMatchObject({ url: "", method: "auto" })
  const result = await authorization.callback()
  expect(result.type).toBe("success")
  expect(result.metadata.gatewayPort).toBe(3425)
  expect(typeof result.metadata.gatewayRevision).toBe("string")
  expect(existsSync(join(h.directory, "plugin-auth.json"))).toBe(false)
  await h.login(hooks, inputs)
  expect((await h.getAuth()).metadata.autoStop).toBe(true)
  const cfg = {}
  await hooks.config(cfg)
  expect(Object.keys(cfg.provider.strata.models)).toEqual(["my-local-model"])
  const models = await hooks.provider.models({ id: "strata", models: {} }, { auth: await h.getAuth() })
  expect(Object.keys(models)).toEqual(["my-local-model"])
  const loader = await hooks.auth.loader(h.getAuth)
  expect(loader.baseURL).toBe(inputs.baseURL)
})


test("A04/A16/A19: a healthy unloaded service receives the original request and returns untouched SSE", async () => {
  const h = host()
  const seen = []
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/health") return Response.json({ service: "strata", status: "ok", loaded: false })
    seen.push({ method: request.method, body: await request.text(), header: request.headers.get("x-test") })
    return new Response("data: {\"delta\":\"hello\"}\n\ndata: [DONE]\n\n", {
      status: 201, headers: { "content-type": "text/event-stream", "x-upstream": "untouched" },
    })
  } })
  try {
    const hooks = await StrataPlugin(h)
    await h.login(hooks, { root: process.cwd(), python: process.execPath,
      config: import.meta.filename, model: "local", baseURL: s.url + "v1" })
    const loader = await hooks.auth.loader(h.getAuth)
    const response = await loader.fetch(s.url + "v1/chat/completions?test=1", {
      method: "POST", headers: { "x-test": "kept" }, body: '{"model":"local","stream":true}',
    })
    expect(response.status).toBe(201)
    expect(response.headers.get("x-upstream")).toBe("untouched")
    expect(await response.text()).toBe('data: {"delta":"hello"}\n\ndata: [DONE]\n\n')
    expect(seen).toEqual([{ method: "POST", body: '{"model":"local","stream":true}', header: "kept" }])
  } finally { s.stop(true) }
})
test("A15/A16: a foreign listener and an already cancelled request cause no generation", async () => {
  const h = host()
  let posts = 0
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST") posts++
    return Response.json({ status: "ok", service: "another-service" })
  } })
  try {
    const hooks = await StrataPlugin(h)
    await h.login(hooks, { root: process.cwd(), python: process.execPath,
      config: import.meta.filename, model: "local", baseURL: s.url + "v1" })
    const loader = await hooks.auth.loader(h.getAuth)
    await expect(loader.fetch(s.url + "v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow("healthy Strata")
    const c = new AbortController()
    c.abort(new Error("cancelled"))
    await expect(loader.fetch(s.url + "v1/chat/completions", { signal: c.signal })).rejects.toThrow("cancelled")
    expect(posts).toBe(0)
  } finally { s.stop(true) }
})


test("A01: reusing the config object after saving removes the unconfigured placeholder", async () => {
  const h = host()
  const hooks = await StrataPlugin(h)
  const cfg = {}
  await hooks.config(cfg)
  await h.login(hooks, { root: process.cwd(), python: process.execPath,
    config: import.meta.filename, model: "chosen", baseURL: "http://127.0.0.1:49198/v1" })
  await hooks.config(cfg)
  expect(Object.keys(cfg.provider.strata.models)).toEqual(["chosen"])
})
test("A01: unusable discovered model entries preserve the configured target and existing declaration", async () => {
  const h = host()
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ data: [{ id: 3 }] }) } })
  try {
    const hooks = await StrataPlugin(h)
    await h.login(hooks, { root: process.cwd(), python: process.execPath,
      config: import.meta.filename, model: "chosen", baseURL: s.url + "v1" })
    const cached = { id: "chosen", name: "known", limit: { context: 32768, output: 1024 } }
    const models = await hooks.provider.models({ id: "strata", models: { chosen: cached } }, { auth: await h.getAuth() })
    expect(models.chosen).toEqual(cached)
  } finally { s.stop(true) }
})


test("A16: cancelling after response headers cancels the original stream and does not replay", async () => {
  const h = host()
  let posts = 0
  let timer
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/health")
      return Response.json({ service: "strata", status: "ok", loaded: false })
    posts++
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: partial\n\n"))
        timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: done\n\n")); controller.close() }, 10000)
      },
      cancel() { clearTimeout(timer) },
    }), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const hooks = await StrataPlugin(h)
    await h.login(hooks, { root: process.cwd(), python: process.execPath,
      config: import.meta.filename, model: "local", baseURL: s.url + "v1" })
    const loader = await hooks.auth.loader(h.getAuth)
    const controller = new AbortController()
    const response = await loader.fetch(new Request(s.url + "v1/chat/completions", {
      method: "POST", body: "unaltered", signal: controller.signal,
    }))
    const reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: partial\n\n")
    const pending = reader.read()
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(posts).toBe(1)
  } finally { clearTimeout(timer); s.stop(true) }
})


test("A05: host saving preserves a stable target identity across changed keys, and a failed save has no effect", async () => {
  const h = host()
  const hooks = await StrataPlugin(h)
  const inputs = { root: process.cwd(), python: process.execPath, config: import.meta.filename,
    model: "local", baseURL: "http://localhost:49197/v1" }
  await h.login(hooks, { ...inputs, apiKey: "first-key" })
  await h.login(hooks, { ...inputs, baseURL: "http://127.0.0.1:49197/v1", apiKey: "changed-key", autoStop: "no" })
  const file = join(h.directory, "plugin-auth.json")
  const saved = readFileSync(file, "utf8")
  expect(Object.keys(JSON.parse(saved))).toEqual(["strata"])
  expect(JSON.parse(saved).strata).toMatchObject({ type: "api", key: "changed-key",
    metadata: { email: "strata:http://127.0.0.1:49197/v1", autoStop: false } })
  await expect(h.login(hooks, { ...inputs, autoStop: "yes" }, true)).rejects.toThrow("save denied")
  await hooks.auth.loader(async () => ({ ...await h.getAuth(), metadata: { ...inputs, autoStop: true } }))
  expect(readFileSync(file, "utf8")).toBe(saved)
  expect(existsSync(join(h.directory, "strata"))).toBe(false)
})


test("A04: stopped/error ownership records cannot block or take over a later healthy manual service, even without pythonw", async () => {
  const h = host()
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/health") return Response.json({ service: "strata", status: "ok" })
    requests++
    return Response.json({ answer: "manual" })
  } })
  try {
    const hooks = await StrataPlugin(h)
    await h.login(hooks, { root: process.cwd(), python: process.execPath, config: import.meta.filename,
      model: "local", baseURL: server.url + "v1" })
    const loader = await hooks.auth.loader(h.getAuth)
    const dir = join(h.directory, "strata", "127.0.0.1-" + server.port)
    mkdirSync(dir, { recursive: true })
    for (const status of ["stopped", "error"]) {
      const saved = JSON.stringify({ status, service: { pid: 1, created: "stale", image: "stale" } })
      writeFileSync(join(dir, "state.json"), saved)
      expect((await (await loader.fetch(server.url + "v1/chat/completions", { method: "POST", body: "{}" })).json()).answer).toBe("manual")
      expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(saved)
      expect(existsSync(join(dir, "request.json"))).toBe(false)
    }
    expect(requests).toBe(2)
  } finally { server.stop(true) }
})


test("A01: a successful native placeholder cache cannot override the configured offline target", async () => {
  const h = host()
  const hooks = await StrataPlugin(h)
  const cfg = {}
  await hooks.config(cfg)
  const file = join(h.directory, "plugin-providers.json")
  const cached = JSON.stringify([{ id: "strata", api: "http://127.0.0.1:49196/v1",
    models: [{ id: "configure-strata" }], accounts: [], fellBack: false }])
  writeFileSync(file, cached)
  await h.login(hooks, { root: process.cwd(), python: process.execPath, config: import.meta.filename,
    model: "chosen", baseURL: "http://127.0.0.1:49196/v1" })
  await hooks.config(cfg)
  const models = await hooks.provider.models({ id: "strata", models: {} }, { auth: await h.getAuth() })
  expect(Object.keys(models)).toEqual(["chosen"])
  expect(models[Symbol.for("magpie.fellBack")]).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe(cached)
  expect(existsSync(join(h.directory, "strata"))).toBe(false)
})

test("A01: only a successful native cache for the same address containing the target can replace the offline declaration", async () => {
  const h = host()
  const hooks = await StrataPlugin(h)
  const baseURL = "http://127.0.0.1:49195/v1"
  await h.login(hooks, { root: process.cwd(), python: process.execPath, config: import.meta.filename,
    model: "chosen", baseURL })
  const file = join(h.directory, "plugin-providers.json")
  const valid = { id: "strata", api: baseURL, models: [{ id: "chosen", context: 32768 }, { id: "other" }] }
  for (const [entry, expected] of [[valid, true], [{ ...valid, api: "http://127.0.0.1:1/v1" }, undefined],
      [{ ...valid, models: [{ id: "previous-target" }] }, undefined], [{ ...valid, fellBack: true }, undefined],
      [{ ...valid, models: [...valid.models, { id: "configure-strata" }] }, undefined]]) {
    const saved = JSON.stringify([entry])
    writeFileSync(file, saved)
    const models = await hooks.provider.models({ id: "strata", models: {} }, { auth: await h.getAuth() })
    expect(models[Symbol.for("magpie.fellBack")]).toBe(expected)
    expect(models.chosen.id).toBe("chosen")
    expect(readFileSync(file, "utf8")).toBe(saved)
  }
  writeFileSync(file, "{")
  const models = await hooks.provider.models({ id: "strata", models: {} }, { auth: await h.getAuth() })
  expect(models[Symbol.for("magpie.fellBack")]).toBeUndefined()
  expect(models.chosen.id).toBe("chosen")
  expect(readFileSync(file, "utf8")).toBe("{")
})

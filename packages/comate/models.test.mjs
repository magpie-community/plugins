import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { _internal } from "./index.mjs"

// Synthetic accounts only. These test routing and metadata, not real Comate
// model availability, context windows or client tool-call compliance.
function harness(t) {
  const home = mkdtempSync(join(tmpdir(), "comate-models-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const catalogs = new Map()
  const requests = []
  const factory = _internal.createPlugin({
    discoveryOptions: { home, env: {} },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (String(url).endsWith("/list-model")) {
        const data = catalogs.get(`${new URL(url).port}/${body.license}`)
        if (data instanceof Error) throw data
        return Response.json({ code: 0, data: data ?? [] })
      }
      requests.push(body)
      return new Response('data: {"kind":"text-delta","delta":"ok"}\n\ndata: {"type":"task_done","status":"completed"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const account = (key, port = 8627) => ({ type: "api", key, port })
  const catalog = (auth, id, type = "shared-type", name = "Shared Name") => {
    catalogs.set(`${auth.port}/${auth.key}`, [{ modelId: id, modelType: type, displayName: name }])
  }
  const list = (plugin, auth) => plugin.provider.models({ id: "comate", models: {} }, { auth })
  const request = async (loader, model) => {
    const response = await loader.fetch("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(response.status, 200)
    await response.text()
    return requests.at(-1).modelId
  }
  return { factory, account, catalog, catalogs, list, request }
}

test("config has no account-derived seeds and preserves explicit user models", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const config = {}
  await plugin.config(config)
  assert.deepEqual(config.provider.comate.models, {})
  const models = { "user-model": { name: "User model", limit: { context: 4096, output: 512 } } }
  config.provider.comate.models = models
  await plugin.config(config)
  assert.deepEqual(config.provider.comate.models, models)
  const auth = h.account("synthetic-offline")
  assert.deepEqual(await h.list(plugin, auth), {}, "unavailable discovery must not invent model IDs")
})

test("two accounts in one instance resolve identical aliases to their own model IDs", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const a = h.account("synthetic-a"), b = h.account("synthetic-b")
  h.catalog(a, "model-account-a")
  h.catalog(b, "model-account-b")
  await Promise.all([h.list(plugin, a), h.list(plugin, b)])
  const aLoader = await plugin.auth.loader(async () => a)
  const bLoader = await plugin.auth.loader(async () => b)
  for (const alias of ["shared-type", "Shared Name", "comate/shared name"]) {
    assert.equal(await h.request(aLoader, alias), "model-account-a")
    assert.equal(await h.request(bLoader, alias), "model-account-b")
  }
  assert.equal(await h.request(aLoader, "literal-model-id"), "literal-model-id")
})

test("instances created by the same factory do not share aliases even for the same credential", async (t) => {
  const h = harness(t)
  const a = await h.factory(), b = await h.factory()
  const auth = h.account("synthetic-account")
  h.catalog(auth, "model-instance-a")
  await h.list(a, auth)
  h.catalog(auth, "model-instance-b")
  await h.list(b, auth)
  assert.equal(await h.request(await a.auth.loader(async () => auth), "shared-type"), "model-instance-a")
  assert.equal(await h.request(await b.auth.loader(async () => auth), "shared-type"), "model-instance-b")
})

test("an existing loader resolves aliases with its current credential after an account switch", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const a = h.account("synthetic-a"), b = h.account("synthetic-b")
  h.catalog(a, "model-account-a")
  h.catalog(b, "model-account-b")
  await h.list(plugin, a)
  await h.list(plugin, b)
  let current = a
  const loader = await plugin.auth.loader(async () => current)
  assert.equal(await h.request(loader, "shared-type"), "model-account-a")
  current = b
  assert.equal(await h.request(loader, "shared-type"), "model-account-b")
})

test("the same credential on different local endpoints has separate aliases", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const a = h.account("synthetic-account", 8627), b = h.account("synthetic-account", 8628)
  h.catalog(a, "model-endpoint-a")
  h.catalog(b, "model-endpoint-b")
  await h.list(plugin, a)
  await h.list(plugin, b)
  assert.equal(await h.request(await plugin.auth.loader(async () => a), "shared-type"), "model-endpoint-a")
  assert.equal(await h.request(await plugin.auth.loader(async () => b), "shared-type"), "model-endpoint-b")
})

test("refresh replaces removed aliases and failed discovery clears that credential's aliases", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const a = h.account("synthetic-a"), b = h.account("synthetic-b")
  h.catalog(a, "old-model", "old-type", "Old Name")
  h.catalog(b, "other-model")
  await h.list(plugin, a)
  await h.list(plugin, b)
  const loader = await plugin.auth.loader(async () => a)
  assert.equal(await h.request(loader, "Old Name"), "old-model")
  h.catalog(a, "new-model")
  await h.list(plugin, a)
  assert.equal(await h.request(loader, "Old Name"), "Old Name")
  assert.equal(await h.request(loader, "shared-type"), "new-model")
  h.catalogs.set(`${a.port}/${a.key}`, new Error("synthetic discovery failure"))
  assert.deepEqual(await h.list(plugin, a), {})
  assert.equal(await h.request(loader, "shared-type"), "shared-type")
  assert.equal(await h.request(await plugin.auth.loader(async () => b), "shared-type"), "other-model")
})

test("an exact live model ID cannot be shadowed by another model's alias", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const auth = h.account("synthetic-account")
  h.catalogs.set(`${auth.port}/${auth.key}`, [
    { modelId: "literal-id", modelType: "first" },
    { modelId: "other-id", modelType: "literal-id" },
  ])
  await h.list(plugin, auth)
  assert.equal(await h.request(await plugin.auth.loader(async () => auth), "literal-id"), "literal-id")
})

test("explicit numeric live limits survive discovery; unknown limits are never guessed", async (t) => {
  const h = harness(t)
  const plugin = await h.factory()
  const auth = h.account("synthetic-account")
  h.catalogs.set(`${auth.port}/${auth.key}`, [
    { modelId: "fixture-with-limits", limit: { context: 8192, input: 6144, output: 2048 } },
    { modelId: "fixture-128k-without-limits" },
    { modelId: "fixture-invalid-limits", limit: { context: -1, input: "1000", output: 1.5 } },
  ])
  const models = await h.list(plugin, auth)
  assert.deepEqual(models["fixture-with-limits"].limit, { context: 8192, input: 6144, output: 2048 })
  assert.deepEqual(models["fixture-128k-without-limits"].limit, { context: 0, output: 0 })
  assert.deepEqual(models["fixture-invalid-limits"].limit, { context: 0, output: 0 })
})

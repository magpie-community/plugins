// grok-4.7 offers the built-in's reasoning levels before Grok lists any:
// magpie keeps the configured model when the models hook fails, and a
// model with no variants lost the levels the built-in had (low…xhigh).
import { noRealGrok } from "./nocli.mjs"
import { expect, test } from "bun:test"
import { GrokAuthPlugin, _internal } from "./index.mjs"

noRealGrok()

test("the configured grok-4.7 carries the built-in's levels", async () => {
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = {}
  await hooks.config(cfg)
  const m = cfg.provider.grok.models["grok-4.7"]
  expect(m.reasoning).toBe(true)
  expect(Object.keys(m.variants)).toEqual(["low", "medium", "high", "xhigh"])
  expect(m.variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
})

// Grok lists two windows. context_window is the default and keeps the
// plain id; each other size in context_windows is offered beside it, and
// a request for that id asks Grok for that window.
test("a model with two windows is offered at each, the plain id at the default", () => {
  const [base, wide] = _internal.windowsOf({
    id: "grok-4.7",
    name: "Grok 4.7",
    context_window: 256000,
    context_windows: [256000, 500000],
  }, ["low", "high"])
  expect(base).toMatchObject({ id: "grok-4.7", apiId: "grok-4.7", name: "Grok 4.7", context: 256000, window: 256000 })
  expect(wide).toMatchObject({ id: "grok-4.7@500k", apiId: "grok-4.7", name: "Grok 4.7 @ 500k", context: 500000, window: 500000 })
  expect(base.efforts).toEqual(["low", "high"])
  expect(wide.efforts).toEqual(["low", "high"])
})

test("one window, or none, stays one model", () => {
  expect(_internal.windowsOf({ id: "grok-4.5", context_window: 256000, context_windows: [256000] }, []).map((m) => m.id)).toEqual(["grok-4.5"])
  expect(_internal.windowsOf({ id: "grok-4.5", name: "Grok 4.5", context_window: 256000 }, [])).toEqual([
    { id: "grok-4.5", apiId: "grok-4.5", name: "Grok 4.5", context: 256000, window: 256000, efforts: [] },
  ])
  expect(_internal.windowsOf({ id: "grok-4.5", context_windows: [500000, 256000, 500000] }, []).map((m) => [m.id, m.context])).toEqual([
    ["grok-4.5", 500000],
    ["grok-4.5@256k", 256000],
  ])
})

test("an offered window asks Grok for that model and that many tokens", () => {
  expect(_internal.modelOf("grok-4.7")).toEqual({ model: "grok-4.7", window: 0 })
  expect(_internal.modelOf("grok-4.7@500k")).toEqual({ model: "grok-4.7", window: 500000 })
  expect(_internal.modelOf("grok-4.7@256k")).toEqual({ model: "grok-4.7", window: 256000 })
  expect(_internal.modelOf("grok-4.7-build-fast@500k")).toEqual({ model: "grok-4.7-build-fast", window: 500000 })
  expect(_internal.modelOf(undefined)).toEqual({ model: undefined, window: 0 })
})

// labelOf writes a window no multiple of 1000 as its digits (magpie
// yetone/magpie#1679): modelOf reads that id back as the same window, not
// as a model of its own sent to Grok as it is.
test("a window offered without a k asks Grok for that model and that many tokens", () => {
  const [, odd] = _internal.windowsOf({ id: "grok-4.7", context_window: 256000, context_windows: [256000, 131072] }, [])
  expect(odd.id).toBe("grok-4.7@131072")
  expect(_internal.modelOf(odd.id)).toEqual({ model: "grok-4.7", window: 131072 })
  expect(_internal.modelOf("grok-4.7@0")).toEqual({ model: "grok-4.7@0", window: 0 })
  expect(_internal.modelOf("@500k")).toEqual({ model: "@500k", window: 0 })
})

// A token Grok refuses before its time says the sign-in is gone, as one
// past its time does, so magpie's move takes the account along untried;
// "Grok models: 401 …" stopped every Grok account's move.
// with no Grok Build to renew it, a refused token says so, not that the
// sign-in has expired (renew.test.mjs has the CLI renewing it)
test("a refused token with no Grok Build to renew it says so", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = mkdtempSync(join(tmpdir(), "grok-models-"))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "revoked", expires_at: "2099-01-01T00:00:00Z", email: "a@x.ai" } }))
  const [path, h, fetch0] = [process.env.PATH, process.env.HOME, globalThis.fetch]
  process.env.PATH = ""
  process.env.HOME = home
  globalThis.fetch = async () => new Response('{"error":"Invalid or expired credentials"}', { status: 401 })
  try {
    const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
    const err = await hooks.provider.models({ id: "grok", models: {} }, { auth: { type: "oauth", refresh: home } }).catch((e) => e)
    expect(err?.message).toContain("there is no Grok Build here to renew it")
    expect(err?.message).not.toMatch(/sign-in has expired/)
  } finally {
    ;[process.env.PATH, process.env.HOME, globalThis.fetch] = [path, h, fetch0]
  }
})

// magpie (and OpenCode's AI SDK) put a model's api.id in the request body,
// not its key, so the window has to survive there for the plugin's fetch
// to see it: grok-4.7@500k reaches Grok as grok-4.7 with
// x-grok-context-window: 500000, and plain grok-4.7 with no such header.
test("a window the models hook offers reaches Grok as that window", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = mkdtempSync(join(tmpdir(), "grok-window-"))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "tok", expires_at: "2099-01-01T00:00:00Z", email: "a@x.ai" } }))
  const [path, fetch0] = [process.env.PATH, globalThis.fetch]
  process.env.PATH = ""
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "grok-4.7", name: "Grok 4.7", api_backend: "responses", context_window: 256000, context_windows: [256000, 500000] }] })
    }
    sent.push({ window: init.headers.get("x-grok-context-window"), override: init.headers.get("x-grok-model-override"), model: JSON.parse(init.body).model })
    return new Response("{}")
  }
  try {
    const auth = { type: "oauth", refresh: home, access: "tok", expires: Date.parse("2099-01-01T00:00:00Z"), accountId: "a@x.ai" }
    const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
    const models = await hooks.provider.models({ id: "grok", models: {} }, { auth })
    expect(Object.keys(models)).toEqual(["grok-4.7", "grok-4.7@500k"])
    expect(models["grok-4.7@500k"].limit.context).toBe(500000)
    const opts = await hooks.auth.loader(async () => auth)
    for (const id of ["grok-4.7", "grok-4.7@500k"]) {
      await opts.fetch(`${opts.baseURL}/responses`, { method: "POST", body: JSON.stringify({ model: models[id].api.id, input: "hi" }) })
    }
    expect(sent).toEqual([
      { window: null, override: "grok-4.7", model: "grok-4.7" },
      { window: "500000", override: "grok-4.7", model: "grok-4.7" },
    ])
  } finally {
    ;[process.env.PATH, globalThis.fetch] = [path, fetch0]
  }
})

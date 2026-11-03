// OpenCode 2.x loads a package's exports["."] and wants a default
// {id, setup(ctx)} (plugins#657, nbczw8750: trae 0.2.26 on OpenCode 2.2.5,
// "Plugin must export a default definition with an id and an effect or
// setup function"). These load packages the way 2.x does and run the
// adapter, scripts/opencode2.mjs, against a fake of 2.x's plugin context:
// no OpenCode, no network, no account.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const packages = new URL("../packages/", import.meta.url).pathname
// no request leaves these tests; fetch is put back after them, since a
// root `bun test` runs every package's files in this one process
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = async (input) => {
    throw new Error("a test asked " + (input?.url ?? input) + " with no fake in place")
  }
})
afterAll(() => {
  globalThis.fetch = realFetch
})

// entryOf is the file 2.x imports for a package: exports["."], a bare
// string exports, else main
function entryOf(name) {
  const pkg = JSON.parse(readFileSync(join(packages, name, "package.json"), "utf8"))
  const e = pkg.exports
  const entry = typeof e === "string" ? e : e && typeof e === "object" ? (e["."]?.import ?? e["."]?.default ?? e["."]) : (pkg.main ?? "index.mjs")
  return join(packages, name, entry)
}

// fakeContext is the part of 2.x's promise plugin context the adapter uses
function fakeContext() {
  const methods = []
  const providerTransforms = []
  const integrationTransforms = []
  const hooks = []
  const storage = new Map()
  const conns = new Map()
  const events = []
  let wake = null
  const reloads = { provider: 0, model: 0 }
  const ctx = {
    location: { directory: "/nowhere" },
    integration: {
      transform: async (fn) => {
        integrationTransforms.push(fn)
        fn({ method: { update: (m) => methods.push(m) } })
      },
      connection: {
        active: async (id) => conns.get(id)?.connection,
        resolve: async (c) => [...conns.values()].find((x) => x.connection === c)?.value,
      },
    },
    provider: {
      transform: async (fn) => providerTransforms.push(fn),
      reload: async () => void reloads.provider++,
    },
    model: { reload: async () => void reloads.model++ },
    aisdk: { hook: async (name, fn, filter) => hooks.push({ name, fn, filter }) },
    storage: { get: async (k) => storage.get(k), set: async (k, v) => void storage.set(k, v) },
    event: {
      async *subscribe() {
        for (;;) {
          while (events.length) yield events.shift()
          await new Promise((r) => (wake = r))
        }
      },
    },
  }
  const providers = () => {
    const out = []
    for (const fn of providerTransforms) fn({ add: (p) => out.push(p) })
    return out
  }
  const emit = (e) => {
    events.push(e)
    wake?.()
  }
  // 2.x runs every integration transform again, on a fresh editor, each
  // time it rebuilds the list
  const rebuild = () => {
    const out = []
    for (const fn of integrationTransforms) fn({ method: { update: (m) => out.push(m) } })
    return out
  }
  return { ctx, methods, providers, rebuild, hooks, storage, conns, emit, reloads }
}

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}

test("trae loads on OpenCode 2.x: a default {id, setup} (plugins#657)", async () => {
  const mod = await import(entryOf("trae"))
  expect(typeof mod.default?.id).toBe("string")
  expect(mod.default.id).toBe("@magpie-community/opencode-trae-auth")
  expect(typeof mod.default.setup).toBe("function")
  // and 2.x gets both of its providers with their sign-ins, before any
  // account is signed in, without a request
  const f = fakeContext()
  await mod.default.setup(f.ctx)
  const ids = f.providers().map((p) => p.info.id)
  expect(ids).toEqual(expect.arrayContaining(["trae-cn", "trae-global"]))
  for (const p of f.providers()) {
    expect(p.info.integrationID).toBe(p.info.id)
    expect(p.models.length).toBeGreaterThan(0)
    for (const m of p.models) {
      expect(Number.isInteger(m.limit.context) && Number.isInteger(m.limit.output)).toBe(true)
      expect(m.providerID).toBe(p.info.id)
    }
  }
  const signIns = new Set(f.methods.map((m) => m.integrationID))
  expect([...signIns].sort()).toEqual(["trae-cn", "trae-global"])
  expect(f.methods.every((m) => m.method.type === "key" || typeof m.authorize === "function")).toBe(true)
})

test("trae's main is what OpenCode 1.x and magpie's host take: plugins only", async () => {
  const pkg = JSON.parse(readFileSync(join(packages, "trae", "package.json"), "utf8"))
  const mod = await import(join(packages, "trae", pkg.main))
  const entries = Object.entries(mod)
  expect(entries.length).toBeGreaterThan(0)
  for (const [, v] of entries) expect(typeof v).toBe("function")
  for (const f of ["index.mjs", "opencode.mjs", "opencode2.mjs"]) expect(pkg.files).toContain(f)
})

test("every package's opencode2.mjs is scripts/opencode2.mjs", async () => {
  const { readdirSync, existsSync } = await import("node:fs")
  const canon = readFileSync(new URL("./opencode2.mjs", import.meta.url), "utf8")
  let n = 0
  for (const name of readdirSync(packages)) {
    const f = join(packages, name, "opencode2.mjs")
    if (!existsSync(f)) continue
    n++
    expect([name, readFileSync(f, "utf8") === canon]).toEqual([name, true])
  }
  expect(n).toBeGreaterThan(20)
})

// a 1.x plugin as the packages write them: an OAuth sign-in and a key, a
// config provider with a model, its own list and a loader with its own
// base URL, key, header and fetch
function acme(sent) {
  return {
    AcmePlugin: async ({ client }) => ({
      auth: {
        provider: "acme",
        methods: [
          {
            type: "oauth",
            label: "Sign in with Acme",
            prompts: [{ type: "text", key: "region", message: "Region" }],
            authorize: async (inputs) => ({
              url: "https://acme.invalid/login",
              instructions: "Finish in the browser",
              method: "auto",
              callback: async () => ({ type: "success", access: "tok-" + inputs.region, refresh: "r1", expires: 1234.5, email: "a@acme.invalid" }),
            }),
          },
          { type: "api", label: "Acme key" },
        ],
        async loader(getAuth) {
          const a = await getAuth()
          return {
            baseURL: "http://127.0.0.1:9/real/v1",
            apiKey: a.access ?? a.key,
            headers: { "x-acme": "1" },
            async fetch(url, init) {
              const h = Object.fromEntries(new Headers(init.headers))
              sent.push({ url: String(url), headers: h, body: init.body })
              if (a.access === "tok-eu") await client.auth.set({ path: { id: "acme" }, body: { type: "oauth", access: "tok-eu2", refresh: "r2", expires: 99 } })
              return new Response("{}")
            },
          }
        },
      },
      config: async (cfg) => {
        cfg.provider.acme = { npm: "@ai-sdk/openai-compatible", name: "Acme", models: { m1: { name: "M1", limit: { context: 1000, output: 100 }, variants: { high: { reasoningEffort: "high" } } } } }
        // sign-in only: no package, no models
        cfg.provider["acme-usage"] = { models: {} }
      },
      provider: { id: "acme", models: async (p, { auth }) => ({ m2: { ...p.models.m1, id: "m2", name: "M2 for " + auth.email } }) },
    }),
  }
}

test("a 1.x plugin's sign-in, models and requests on 2.x", async () => {
  const { setup } = await import(join(packages, "trae", "opencode2.mjs"))
  const sent = []
  const f = fakeContext()
  const stop = await setup(f.ctx, acme(sent))

  // the provider, its package pinned so 2.x's sdk hook runs, and its model
  const provs = f.providers()
  expect(provs.map((p) => p.info.id)).toEqual(["acme"])
  const p = provs[0]
  expect(p.info).toMatchObject({ id: "acme", integrationID: "acme", activation: "auto", package: "aisdk:@ai-sdk/openai-compatible@2.0.41" })
  expect(p.models.map((m) => [m.id, m.name, m.limit])).toEqual([["m1", "M1", { context: 1000, output: 100 }]])
  expect(p.models[0].variants).toEqual([{ id: "high", settings: { reasoningEffort: "high" } }])

  // the sign-ins: OAuth with its form, then the key
  expect(f.methods.map((m) => m.method.type)).toEqual(["oauth", "key"])
  // and again each time 2.x rebuilds the list: a key sign-in missing from
  // the second build left `opencode auth login` with no key method
  expect(f.rebuild().map((m) => m.method.type)).toEqual(["oauth", "key"])
  expect(f.rebuild().map((m) => m.method.type)).toEqual(["oauth", "key"])
  const oauth = f.methods[0]
  expect(oauth.method.form).toEqual([{ key: "region", type: "string", title: "Region", required: true }])
  const started = await oauth.authorize({ region: "eu" })
  expect(started).toMatchObject({ url: "https://acme.invalid/login", mode: "auto" })
  const cred = await started.callback
  expect(cred).toMatchObject({ type: "oauth", methodID: oauth.method.id, access: "tok-eu", refresh: "r1", expires: 1234 })
  expect(cred.metadata.v1).toMatchObject({ type: "oauth", access: "tok-eu", email: "a@acme.invalid" })
  expect(oauth.label(cred)).toBe("a@acme.invalid")

  // signed in: the account's own list replaces the config's
  const connection = { type: "credential", id: "cred_1" }
  f.conns.set("acme", { connection, value: cred })
  f.emit({ type: "credential.updated", data: {} })
  await until(() => f.reloads.model > 0)
  expect(f.providers()[0].models.map((m) => m.name)).toEqual(["M2 for a@acme.invalid"])
  expect(f.providers()[0].sourceConnection).toBe(connection)

  // a request: the SDK is made with the configured base URL and a stand-in
  // key; what goes out has the loader's URL, the account's key, the
  // loader's header, through the loader's fetch
  const hook = f.hooks.find((h) => h.filter.providerID === "acme")
  expect(hook.name).toBe("sdk")
  const options = { baseURL: p.info.settings.baseURL ?? "http://127.0.0.1:9/configured" }
  await hook.fn({ model: {}, package: p.info.package, options })
  expect(options.apiKey).not.toContain("tok")
  await options.fetch(options.baseURL + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${options.apiKey}` }, body: "{}" })
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("http://127.0.0.1:9/real/v1/chat/completions")
  expect(sent[0].headers).toMatchObject({ authorization: "Bearer tok-eu", "x-acme": "1" })

  // the loader renewed the token: the next request uses it, and it is kept
  // for this credential
  expect([...f.storage.values()].map((e) => e.auth.access)).toEqual(["tok-eu2"])
  await options.fetch(options.baseURL + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${options.apiKey}` }, body: "{}" })
  expect(sent[1].headers.authorization).toBe("Bearer tok-eu2")

  // a switch to a key account reads its own key
  f.conns.set("acme", { connection: { type: "credential", id: "cred_2" }, value: { type: "key", key: "sk-2" } })
  f.emit({ type: "credential.switched", data: { integrationID: "acme", credentialID: "cred_2" } })
  await until(() => f.reloads.model > 1)
  await options.fetch(options.baseURL + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${options.apiKey}` }, body: "{}" })
  expect(sent[2].headers.authorization).toBe("Bearer sk-2")
  stop()
})

test("a 1.x code sign-in is a 2.x code sign-in", async () => {
  const { setup } = await import(join(packages, "trae", "opencode2.mjs"))
  const f = fakeContext()
  await setup(f.ctx, {
    P: async () => ({
      auth: {
        provider: "acme",
        methods: [{ type: "oauth", label: "Paste a code", authorize: async () => ({ url: "https://acme.invalid", instructions: "Paste it", method: "code", callback: async (code) => (code === "ok" ? { type: "success", access: "a", refresh: "r", expires: 1 } : { type: "failed" }) }) }],
        loader: async () => ({}),
      },
      config: async (cfg) => (cfg.provider.acme = { npm: "@ai-sdk/anthropic", models: { m: {} } }),
    }),
  })
  expect(f.providers()[0].info.package).toBe("aisdk:@ai-sdk/anthropic@ai-v6")
  const r = await f.methods[0].authorize({})
  expect(r.mode).toBe("code")
  expect((await r.callback("ok")).access).toBe("a")
  const again = await f.methods[0].authorize({})
  await expect(again.callback("bad")).rejects.toThrow()
})

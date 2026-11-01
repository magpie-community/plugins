// plugins#430 (kongbai01203): "Free models only" is a hard stop on credits.
// With it on, the list holds only the models WorkBuddy serves at no cost,
// and a request for any other is answered here and never reaches WorkBuddy;
// so is one whose price can't be read. Every fetch here is a fake; nothing
// reaches the network.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const KEY = "ck_test0000000000abcdefgh"
const CONFIG = {
  code: 0,
  data: {
    agents: [{ name: "cli", models: ["hy3", "glm-5.3", "hy4-preview", "auto", "claude-sonnet-5"] }],
    models: [
      { id: "hy3", credits: "x0.00" },
      { id: "glm-5.3", credits: "x0.79" },
      // free only at night: paid here (#121)
      { id: "hy4-preview", credits: "x0.29" },
      // no price said: not free
      { id: "auto" },
      { id: "claude-sonnet-5", credits: "x1.00" },
    ],
    modelPromotions: [
      { discount: { discountedCredits: "0.00x", factor: 0 }, enabled: true, kind: "discount", modelIds: ["hy4-preview"], schedule: { daily: [{ start: "23:00", end: "23:59" }] } },
    ],
  },
}

// serve answers /v3/config with config (or fails it) and a chat with OK,
// and keeps every URL asked
function serve(config = () => Response.json(CONFIG)) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    sent.push({ url: u, body: unz(init?.body) })
    if (u.endsWith("/v3/config")) return config()
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  return sent
}

const chat = (opts, url, model) =>
  opts.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }) })

const magpieWith = (on) => ({ option: (provider, key) => on[provider]?.[key] === true })

for (const [plugin, site, url] of [
  [WorkBuddyAuthPlugin, "workbuddy", "https://copilot.tencent.com/v2/chat/completions"],
  [WorkBuddyAIAuthPlugin, "workbuddy-ai", "https://www.workbuddy.ai/v2/chat/completions"],
]) {
  test(`${site}: declares the switch, off by default`, async () => {
    const h = await plugin({ client: {} })
    const o = h.auth.options.find((x) => x.key === _internal.FREE_ONLY)
    expect(o.label).toBe("Free models only")
    expect(o.default).toBeUndefined()
  })

  // plugins#590 (anewuser6937): the switch read in English in magpie's
  // Chinese window, and a one-model list looked broken. Its words come in
  // each of magpie's languages, within magpie's caps (60 and 300), and it
  // says the list leaves models out while it is on.
  test(`${site}: says its words in magpie's languages, and that it filters the list`, async () => {
    const h = await plugin({ client: {} })
    const o = h.auth.options.find((x) => x.key === _internal.FREE_ONLY)
    expect(o.filtersModels).toBe(true)
    for (const lang of ["zh", "zh-TW", "ja", "de"]) {
      expect(o.labels[lang].length).toBeGreaterThan(0)
      expect(o.labels[lang].length).toBeLessThanOrEqual(60)
      expect(o.descriptions[lang]).toContain(site === "workbuddy" ? "WorkBuddy" : "WorkBuddy AI")
      expect(o.descriptions[lang].length).toBeLessThanOrEqual(300)
    }
    expect(o.labels.zh).toBe("仅免费模型")
  })

  test(`${site}: on, the list holds only the free models; off, all of them`, async () => {
    serve()
    const auth = { type: "api", key: KEY }
    const on = await plugin({ client: {}, magpie: magpieWith({ [site]: { free_only: true } }) })
    const cfg = { provider: {} }
    await on.config(cfg)
    expect(Object.keys(await on.provider.models(cfg.provider[site], { auth }))).toEqual(["hy3"])
    const off = await plugin({ client: {}, magpie: magpieWith({}) })
    expect(Object.keys(await off.provider.models(cfg.provider[site], { auth }))).toEqual(["hy3", "glm-5.3", "hy4-preview", "auto", "claude-sonnet-5"])
    // the other site's switch is its own
    const other = site === "workbuddy" ? "workbuddy-ai" : "workbuddy"
    const theirs = await plugin({ client: {}, magpie: magpieWith({ [other]: { free_only: true } }) })
    expect(Object.keys(await theirs.provider.models(cfg.provider[site], { auth }))).toHaveLength(5)
  })

  test(`${site}: on, a list that can't be read is a failure, not the built-in list`, async () => {
    serve(() => new Response("down", { status: 502 }))
    const h = await plugin({ client: {}, magpie: magpieWith({ [site]: { free_only: true } }) })
    const cfg = { provider: {} }
    await h.config(cfg)
    await expect(h.provider.models(cfg.provider[site], { auth: { type: "api", key: KEY } })).rejects.toThrow()
    // a key WorkBuddy lists no prices for, too
    await expect(h.provider.models(cfg.provider[site], { auth: { type: "api", key: "sk-other" } })).rejects.toThrow(/Free models only/)
    // off, the built-in list as before
    const off = await plugin({ client: {} })
    expect(Object.keys(await off.provider.models(cfg.provider[site], { auth: { type: "api", key: KEY } })).length).toBeGreaterThan(0)
  })

  test(`${site}: on, a paid or unpriced model's request never reaches WorkBuddy`, async () => {
    const sent = serve()
    const h = await plugin({ client: {}, magpie: magpieWith({ [site]: { free_only: true } }) })
    const opts = await h.auth.loader(async () => ({ type: "api", key: KEY }))
    for (const model of ["glm-5.3", "hy4-preview", "auto", "claude-sonnet-5", "not-listed", undefined]) {
      const res = await chat(opts, url, model)
      expect(res.status).toBe(404)
      const e = (await res.json()).error
      expect(e.code).toBe("model_not_found")
      expect(e.message).toContain("Free models only")
      // magpie's gateway rests the model, not the account, for these words
      expect(e.message).toMatch(/model.{0,80}not available/i)
      expect(e.message).not.toMatch(/quota|insufficient|balance|credit|billing|exceeded|limit/i)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    }
    expect(sent.filter((s) => !s.url.endsWith("/v3/config"))).toHaveLength(0)
    // the free one goes, and the list was read once for all of them
    const res = await chat(opts, url, "hy3")
    expect(res.status).toBe(200)
    expect(sent.filter((s) => s.url === url)).toHaveLength(1)
    expect(sent.filter((s) => s.url.endsWith("/v3/config"))).toHaveLength(1)
  })

  test(`${site}: on, a price that can't be read sends nothing`, async () => {
    const sent = serve(() => new Response("down", { status: 502 }))
    const h = await plugin({ client: {}, magpie: magpieWith({ [site]: { free_only: true } }) })
    const opts = await h.auth.loader(async () => ({ type: "api", key: KEY }))
    const res = await chat(opts, url, "hy3")
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain("is unknown")
    expect(sent.filter((s) => s.url === url)).toHaveLength(0)
  })

  test(`${site}: off, a paid model's request goes as before, the list not read for its price`, async () => {
    const sent = serve()
    const h = await plugin({ client: {}, magpie: magpieWith({}) })
    const opts = await h.auth.loader(async () => ({ type: "api", key: KEY }))
    // the effort named: nothing to read the list for (withDefaultEffort)
    const res = await opts.fetch(url, { method: "POST", body: JSON.stringify({ model: "glm-5.3", reasoning_effort: "low", stream: true, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(200)
    expect(sent.map((s) => s.url)).toEqual([url])
  })
}

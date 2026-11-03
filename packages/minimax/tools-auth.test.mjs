import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { MiniMaxCodeAuthPlugin, _internal } from "./index.mjs"
import { MiniMaxCodeToolsPlugin } from "./magpie.mjs"
import * as openCode from "./opencode.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

const dirs = []
let f
afterEach(async () => {
  f?.close()
  f = undefined
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})
const auth = (access = "tool-token") => ({ type: "oauth", access, refresh: "tool-refresh", expires: Date.now() + 3600_000 })
async function fixture(store = { "minimax-code": auth() }) {
  const directory = resolve(".sandbox", "minimax-tools-" + randomUUID())
  dirs.push(directory)
  await mkdir(directory, { recursive: true })
  const saveStore = () => writeFile(join(directory, "plugin-auth.json"), JSON.stringify(store), "utf8")
  await saveStore()
  const saves = []
  const client = { auth: { set: async ({ path, body }) => {
    saves.push({ id: path.id, body })
    store[path.id] = body
    await saveStore()
  } } }
  return { request: _internal.createToolRequest({ directory, client }), store, saves, client, saveStore }
}
const path = "/minimax-cloud/api/v1/connectors/tools/call"

test("default selection is magpie's own (bare id, else first by name) and refresh saves its exact key", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ access_token: "default-new", refresh_token: "default-refresh-new", expires_in: 3600 }))
  f.route("POST " + path, () => json({}))
  for (const site of ["minimax-code", "minimax-code-global"]) {
    const key = site + "#first"
    // the file's order puts the bare id last, as a sign-in made again after
    // a removal leaves it; magpie still takes the bare id first
    const t = await fixture({
      [site + "-other#unrelated"]: auth("unrelated"),
      [site + "#zzz"]: auth("later-by-name"),
      [key]: { ...auth("default-old"), refresh: "default-refresh-" + site, expires: Date.now() - 1 },
      [site]: auth("bare"),
    })
    await t.request(site, path, {})
    expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer bare")
    expect(t.saves).toHaveLength(0)
    delete t.store[site]
    await t.saveStore()
    await t.request(site, path, {})
    expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer default-new")
    expect(t.saves.map(s => s.id)).toEqual([key])
    delete t.store[site + "#zzz"]
    delete t.store[key]
    t.store[site + "#next"] = auth("next-default")
    await t.saveStore()
    await t.request(site, path, {})
    expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer next-default")
  }
})

test("an account removed during a 401 retry does not switch to another account", async () => {
  f = fakeMiniMax()
  const key = "minimax-code#first"
  const t = await fixture({ [key]: auth(), "minimax-code#second": auth("second") })
  f.route("POST " + path, async () => {
    delete t.store[key]
    await t.saveStore()
    return json({}, 401)
  })
  await expect(t.request("minimax-code", path, {})).rejects.toThrow("isn't signed in")
  expect(f.seen).toHaveLength(1)
  expect(t.saves).toHaveLength(0)
})

test("tool redirects to another host stop before a 401 or token rotation", async () => {
  f = fakeMiniMax()
  let targetCalls = 0
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { targetCalls++; return json({ error: "invalid access token" }, 401) } })
  try {
    const endpoints = ["/mavis/api/v1/mcp/web_search", "/minimax-cloud/api/v1/connectors/connected-tools/list", path]
    const t = await fixture({ "minimax-code": auth(), "minimax-code-global": auth("global") })
    for (const status of [307, 308]) {
      for (const endpoint of endpoints) {
        f.route("POST " + endpoint, () => new Response(null, { status, headers: { location: target.url.href + "refused" } }))
        for (const site of ["minimax-code", "minimax-code-global"]) {
          for (let call = 0; call < 3; call++) {
            const e = await t.request(site, endpoint, {}).catch(e => e)
            expect(e.status).toBe(status)
            expect(e.message).toContain("sent the request on to")
            expect(e.message).toContain("proxy")
            if (site === "minimax-code-global") expect(e.message).toContain("outside mainland China")
          }
        }
      }
    }
    expect(targetCalls).toBe(0)
    expect(t.saves).toHaveLength(0)
    expect(f.seen.filter(r => r.path === "/oauth2/token")).toHaveLength(0)
    expect(f.seen).toHaveLength(36)
  } finally { target.stop(true) }
})

test("same-host tool redirects preserve POST body and authorization", async () => {
  f = fakeMiniMax()
  const t = await fixture()
  f.route("POST /tool-destination", () => json({ result_json: "{}" }))
  for (const status of [307, 308]) {
    f.route("POST " + path, () => new Response(null, { status, headers: { location: "/tool-destination" } }))
    expect(await t.request("minimax-code", path, { arguments_json: "{}" })).toEqual({ result_json: "{}" })
    expect(f.seen.at(-1).path).toBe("/tool-destination")
    expect(f.seen.at(-1).method).toBe("POST")
    expect(f.seen.at(-1).json).toEqual({ arguments_json: "{}" })
    expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer tool-token")
  }
  expect(t.saves).toHaveLength(0)
})

test("tools use their Magpie account and the verified Connector host", async () => {
  f = fakeMiniMax()
  f.route("POST " + path, () => json({ result_json: "{}" }))
  const t = await fixture()
  expect(await t.request("minimax-code", path, { arguments_json: "{}" })).toEqual({ result_json: "{}" })
  const r = f.seen[0]
  expect(r.headers.get("authorization")).toBe("Bearer tool-token")
  expect(r.json).toEqual({ arguments_json: "{}" })
  expect(r.query.size).toBe(0)
})

test("tools can select a second account and refresh saves that exact key", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ access_token: "second-new", refresh_token: "second-refresh-new", expires_in: 3600 }))
  f.route("POST " + path, () => json({}))
  const key = "minimax-code#second"
  const primary = auth()
  const t = await fixture({ "minimax-code": primary, [key]: { ...auth("second-old"), expires: Date.now() - 1 } })
  await t.request("minimax-code", path, {}, { account: key })
  expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer second-new")
  expect(t.saves.map(s => s.id)).toEqual([key])
  expect(t.store["minimax-code"]).toEqual(primary)
})

test("an explicitly missing account stays missing and accounts stay within their site", async () => {
  const t = await fixture({ "minimax-code#second": auth(), "minimax-code-global": auth("global") })
  await expect(t.request("minimax-code", path, {}, { account: "minimax-code" })).rejects.toThrow("isn't signed in")
  await expect(t.request("minimax-code", path, {}, { account: "minimax-code#missing" })).rejects.toThrow("isn't signed in")
  const otherSite = await fixture({ "minimax-code-global": auth("global") })
  await expect(otherSite.request("minimax-code", path, {})).rejects.toThrow("isn't signed in")
  await expect(t.request("minimax-code", path, {}, { account: "minimax-code-global" })).rejects.toThrow("selected MiniMax Code site")
  await expect(t.request("not-a-site", path, {})).rejects.toThrow("unknown")
})

test("tools read login changes each time and support the global site", async () => {
  f = fakeMiniMax()
  f.route("POST " + path, () => json({}))
  const t = await fixture({ "minimax-code-global": auth("global-old") })
  await t.request("minimax-code-global", path, {})
  t.store["minimax-code-global"] = auth("global-new")
  await t.saveStore()
  await t.request("minimax-code-global", path, {})
  expect(f.seen.map(r => r.headers.get("authorization"))).toEqual(["Bearer global-old", "Bearer global-new"])
})

test("a 401 refreshes once; other statuses never replay a generation", async () => {
  f = fakeMiniMax()
  let calls = 0
  f.route("POST " + path, () => { calls++; return calls === 1 ? json({}, 401) : json({ result_json: "{}" }) })
  f.route("POST /oauth2/token", () => json({ access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 3600 }))
  const t = await fixture()
  await t.request("minimax-code", path, {})
  expect(calls).toBe(2)
  expect(t.saves.length).toBe(1)
  f.route("POST " + path, () => { calls++; return json({}, 500) })
  await expect(t.request("minimax-code", path, {})).rejects.toThrow("HTTP 500")
  expect(calls).toBe(3)
})

test("chat and tools share the same in-flight OAuth refresh", async () => {
  f = fakeMiniMax()
  let refreshes = 0
  f.route("POST /oauth2/token", async () => {
    refreshes++
    await Bun.sleep(30)
    return json({ access_token: "shared-new", refresh_token: "shared-r2", expires_in: 3600 })
  })
  f.route("POST " + path, () => json({}))
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({}))
  const t = await fixture({ "minimax-code": { ...auth(), expires: Date.now() - 1 } })
  const hooks = await MiniMaxCodeAuthPlugin({ client: t.client })
  const loader = await hooks.auth.loader(async () => t.store["minimax-code"])
  await Promise.all([
    t.request("minimax-code", path, {}),
    loader.fetch(loader.baseURL + "/messages", { method: "POST", body: "{}" }),
  ])
  expect(refreshes).toBe(1)
  for (const r of f.seen.filter(r => r.path !== "/oauth2/token")) expect(r.headers.get("authorization")).toBe("Bearer shared-new")
})

test("business errors and malformed JSON are errors with credentials redacted", async () => {
  f = fakeMiniMax()
  const t = await fixture()
  f.route("POST " + path, () => json({ base_resp: { status_code: "1000", status_msg: "tool-token tool-refresh" } }))
  const e = await t.request("minimax-code", path, {}).catch(e => e)
  expect(e.message).toContain("<redacted>")
  expect(e.message).not.toContain("tool-token")
  expect(e.message).not.toContain("tool-refresh")
  f.route("POST " + path, () => new Response("broken-json tool-token"))
  await expect(t.request("minimax-code", path, {})).rejects.toThrow("invalid JSON")
  f.route("POST " + path, () => json([]))
  await expect(t.request("minimax-code", path, {})).rejects.toThrow("JSON object")
})

test("cancelled calls never start, and a slow response can be cancelled", async () => {
  f = fakeMiniMax()
  f.route("POST " + path, async () => { await Bun.sleep(100); return json({}) })
  const t = await fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(t.request("minimax-code", path, {}, { signal: controller.signal })).rejects.toThrow()
  expect(f.seen.length).toBe(0)
  await expect(t.request("minimax-code", path, {}, { timeoutMs: 20 })).rejects.toThrow()
})

test("the OpenCode entry retains only its two supported chat plugins", () => {
  expect(Object.keys(openCode).sort()).toEqual(["MiniMaxCodeAuthPlugin", "MiniMaxCodeGlobalAuthPlugin"])
})

test("the actual plugin exports all 20 tools flat and performs a complete generation call", async () => {
  f = fakeMiniMax()
  f.route("POST /minimax-cloud/api/v1/connectors/connected-tools/list", () => json({
    tools: [{ provider: "matrix", provider_tool_name: "matrix_generate_image", runtime_tool_name: "connector__matrix__generate_image", input_schema_json: JSON.stringify({ type: "object" }) }], partial: false, provider_failures: [],
  }))
  f.route("POST " + path, () => json({ result_json: JSON.stringify({ code: 0, success_items: [{ node_id: "fake-node", file_name: "fake.png" }] }) }))
  const t = await fixture()
  const { tool } = await MiniMaxCodeToolsPlugin({ directory: dirs.at(-1), client: t.client })
  expect(Object.keys(tool)).toHaveLength(20)
  expect(tool.web_fetch).toBeUndefined()
  for (const def of Object.values(tool)) expect(JSON.stringify({ description: def.description, args: def.args })).not.toMatch(/magpie/i)
  for (const name of ["generate_image", "submit_video_generation", "query_video_generation", "get_asset_url", "web_search"]) {
    expect(typeof tool[name]?.execute).toBe("function")
    expect(tool[name].args.type).toBe("object")
  }
  const result = await tool.generate_image.execute({ requests: [{ prompt: "fixture only" }] })
  expect(result.success_items[0].node_id).toBe("fake-node")
  expect(f.seen.at(-1).json).toMatchObject({ provider: "matrix", provider_tool_name: "matrix_generate_image", arguments_json: JSON.stringify({ requests: [{ prompt: "fixture only" }] }) })
})

test("cancelling during token rotation returns promptly while the shared refresh is saved", async () => {
  f = fakeMiniMax()
  let started, release
  const arrived = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.route("POST /oauth2/token", async () => {
    started()
    await gate
    return json({ access_token: "after-cancel", refresh_token: "rotated-after-cancel", expires_in: 3600 })
  })
  const t = await fixture({ "minimax-code": { ...auth(), expires: Date.now() - 1 } })
  const controller = new AbortController()
  const pending = t.request("minimax-code", path, {}, { signal: controller.signal }).catch(e => e.name)
  await arrived
  const rotating = [..._internal.renewing.values()][0]
  try {
    controller.abort()
    expect(await Promise.race([pending, Bun.sleep(1000).then(() => "still waiting")])).toBe("AbortError")
    expect(f.seen.some(r => r.path === path)).toBe(false)
  } finally {
    release()
    await rotating
  }
  expect(t.saves[0].body.access).toBe("after-cancel")
})

test("native search normalizes both Matrix response envelopes and business errors", async () => {
  f = fakeMiniMax()
  const endpoint = "/mavis/api/v1/mcp/web_search"
  const t = await fixture()
  const { tool } = await MiniMaxCodeToolsPlugin({ directory: dirs.at(-1), client: t.client })
  f.route("POST " + endpoint, () => json({ code: 0, message: "ok", organic: [{ title: "fixture", url: "https://example.com" }] }))
  expect(await tool.web_search.execute({ query: "fixture", search_type: "news" })).toEqual({ organic: [{ title: "fixture", url: "https://example.com" }] })
  expect(f.seen.at(-1).json).toEqual({ query: "fixture", search_type: "news" })
  expect(f.seen.at(-1).headers.get("user-agent")).toBe("MiniMaxAgent")
  for (const code of [402, "402"]) {
    for (const envelope of [{ code, message: "insufficient credits" }, { code, message: "insufficient credits", base_resp: { status_code: 0, status_msg: "success" } }]) {
      f.route("POST " + endpoint, () => json(envelope))
      await expect(tool.web_search.execute({ query: "fixture" })).rejects.toThrow("insufficient credits")
    }
  }
  f.route("POST " + endpoint, () => json({ code: "0", organic: [] }))
  expect(await tool.web_search.execute({ query: "fixture" })).toEqual({ organic: [] })
})

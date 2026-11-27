// Qoder CN Teams (qoder-team) against a local stand-in for its hosts: the
// sign-in page is qoder.com.cn's, every account call goes to
// openapi.qoder.com.cn and every model call to gateway.qoder.com.cn, and a
// team account is named for the organization its user info carries.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { QoderCNAuthPlugin, QoderTeamAuthPlugin, _internal } from "./index.mjs"
import * as opencode from "./opencode.mjs"

const CN_CLIENT = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb"
const OPENAPI = "openapi.qoder.com.cn"
const GATEWAY = "gateway.qoder.com.cn"

let server
let route = () => new Response("", { status: 404 })
let seen = []
const real = globalThis.fetch

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const host = req.headers.get("x-qoder-host")
      const body = req.method === "GET" ? "" : await req.text()
      seen.push({ host, path: u.pathname, query: u.searchParams, method: req.method, headers: req.headers, body })
      return route(host + u.pathname, { req, url: u, body })
    },
  })
})
afterAll(() => server.stop(true))

const toServer = () => {
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    headers.set("x-qoder-host", u.host)
    return real(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, { ...init, headers })
  }
}
afterEach(() => {
  globalThis.fetch = real
  route = () => new Response("", { status: 404 })
  seen = []
})

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

function store(initial) {
  let auth = initial
  const saved = []
  return {
    client: { auth: { set: async ({ path, body }) => (saved.push(path.id), (auth = body)) } },
    get: async () => auth,
    auth: () => auth,
    saved,
  }
}

const hostsOf = () => [...new Set(seen.map((s) => s.host))]

const TEAM = { id: "u-team", email: "dev@acme.cn", name: "Dev", organization_id: "org-1", organization_name: "Acme" }

test("the package exports the Teams plugin beside the others", () => {
  expect(typeof QoderTeamAuthPlugin).toBe("function")
  expect(opencode.QoderTeamAuthPlugin).toBe(QoderTeamAuthPlugin)
  expect(opencode.QoderCNAuthPlugin).toBe(QoderCNAuthPlugin)
})

test("the sign-in page is qoder.com.cn's, with Qoder CN's CLI client id and no redirect", async () => {
  const hooks = await QoderTeamAuthPlugin({ client: store().client })
  expect(hooks.auth.provider).toBe("qoder-team")
  expect(hooks.auth.methods[0].label).toBe("Sign in with Qoder Teams")
  const flow = await hooks.auth.methods[0].authorize()
  const u = new URL(flow.url)
  expect(u.origin + u.pathname).toBe("https://qoder.com.cn/device/selectAccounts")
  expect(u.searchParams.get("client_id")).toBe(CN_CLIENT)
  expect(u.searchParams.get("challenge_method")).toBe("S256")
  expect(u.searchParams.has("redirect_uri")).toBe(false)
  for (const k of ["challenge", "nonce", "machine_id"]) expect(u.searchParams.get(k)).toBeTruthy()
})

test("a team sign-in keeps the organization and names the account for it", async () => {
  toServer()
  route = (at, { body }) => {
    if (at === OPENAPI + "/api/v1/deviceToken/poll") return json({ token: "dt-t", refresh_token: "drt-t", user_id: "u-team" })
    if (at === OPENAPI + "/api/v1/me/jobToken") {
      expect(JSON.parse(body)).toEqual({ clientId: CN_CLIENT })
      return json({ token: "jt-t", refresh_token: "jrt-t", expires_in: 3_600_000 })
    }
    if (at === OPENAPI + "/api/v1/userinfo") return json(TEAM)
    return new Response("", { status: 404 })
  }
  const flow = await (await QoderTeamAuthPlugin({ client: store().client })).auth.methods[0].authorize()
  const cred = await flow.callback()
  expect(cred).toMatchObject({
    type: "success",
    access: "jt-t",
    refresh: "jrt-t",
    uid: "u-team",
    email: "dev@acme.cn",
    accountId: "dev@acme.cn (Acme)",
    cardName: "dev@acme.cn · Acme",
    orgId: "org-1",
    orgName: "Acme",
  })
  // all account calls are Qoder CN's hosts; none goes to qoder.cn or qoder.com
  expect(hostsOf()).toEqual([OPENAPI])
  expect(seen.some((s) => s.host === "qoder.cn" || s.host === "qoder.com")).toBe(false)
})

test("a personal account on the Teams site is named as before", async () => {
  toServer()
  route = (at) => {
    if (at === OPENAPI + "/api/v1/deviceToken/poll") return json({ token: "dt-p", refresh_token: "drt-p", user_id: "u-p" })
    if (at === OPENAPI + "/api/v1/me/jobToken") return json({ token: "jt-p", refresh_token: "jrt-p", expires_in: 3_600_000 })
    if (at === OPENAPI + "/api/v1/userinfo") return json({ id: "u-p", email: "personal@x.cn", name: "P" })
    return new Response("", { status: 404 })
  }
  const flow = await (await QoderTeamAuthPlugin({ client: store().client })).auth.methods[0].authorize()
  const cred = await flow.callback()
  expect(cred.accountId).toBe("personal@x.cn")
  expect(cred.cardName).toBe("personal@x.cn")
  expect(cred.orgId).toBeUndefined()
  expect(cred.orgName).toBeUndefined()
})

test("qoder-cn's own sign-in is unchanged: no organization is added to its account", async () => {
  toServer()
  route = (at) => {
    if (at === OPENAPI + "/api/v1/deviceToken/poll") return json({ token: "dt-c", refresh_token: "drt-c", user_id: "u-c" })
    if (at === OPENAPI + "/api/v1/me/jobToken") return json({ token: "jt-c", refresh_token: "jrt-c", expires_in: 3_600_000 })
    // even when the same account is in a team, qoder-cn keeps its old name
    if (at === OPENAPI + "/api/v1/userinfo") return json({ ...TEAM, id: "u-c", email: "dev@acme.cn" })
    return new Response("", { status: 404 })
  }
  const flow = await (await QoderCNAuthPlugin({ client: store().client })).auth.methods[0].authorize()
  expect(new URL(flow.url).origin).toBe("https://qoder.cn")
  const cred = await flow.callback()
  expect(cred.accountId).toBe("dev@acme.cn")
  expect(cred.orgName).toBeUndefined()
})

test("the Teams PAT sign-in keeps the organization too", async () => {
  toServer()
  route = (at) => {
    if (at === OPENAPI + "/api/v1/jobToken/exchange") return json({ token: "jt-pt", refresh_token: "jrt-pt", expires_in: 3_600_000 })
    if (at === OPENAPI + "/api/v1/userinfo") return json(TEAM)
    return new Response("", { status: 404 })
  }
  const hooks = await QoderTeamAuthPlugin({ client: store().client })
  const pat = hooks.auth.methods.find((m) => m.label === "Sign in with Qoder Teams PAT")
  expect(pat).toBeTruthy()
  const flow = await pat.authorize({ pat: "pt-abc" })
  const cred = await flow.callback()
  expect(cred).toMatchObject({
    accountId: "dev@acme.cn (Acme)",
    cardName: "dev@acme.cn · Acme",
    orgId: "org-1",
    orgName: "Acme",
    patAuth: true,
    pat: "pt-abc",
  })
})

test("models and chats are served from gateway.qoder.com.cn", async () => {
  toServer()
  const signedIn = {
    type: "oauth",
    access: "jt-t",
    refresh: "jrt-t",
    expires: Date.now() + 3_600_000,
    accountId: "dev@acme.cn (Acme)",
    uid: "u-team",
    email: "dev@acme.cn",
    machineId: "m-t",
    deviceToken: "dt-t",
    deviceRefresh: "drt-t",
    orgId: "org-1",
    orgName: "Acme",
  }
  route = (at) => {
    if (at === GATEWAY + "/algo/api/v2/model/list") return json({ chat: [{ key: "performance", display_name: "Performance", enable: true, source: "system", max_input_tokens: 200_000 }] })
    return new Response("", { status: 404 })
  }
  const s = store(signedIn)
  const hooks = await QoderTeamAuthPlugin({ client: s.client })
  const opts = await hooks.auth.loader(s.get)
  expect(opts.baseURL).toBe("https://gateway.qoder.com.cn")
  const models = await hooks.provider.models({ models: {} }, { auth: signedIn })
  expect(Object.keys(models)).toContain("performance")
  expect(hostsOf()).toEqual([GATEWAY])
  expect(s.saved).toEqual([])
})

test("a renewal names the card for the organization, without renaming the account", async () => {
  expect(_internal.cardNameOf({ orgLabel: true }, TEAM, TEAM.email, TEAM.name)).toBe("dev@acme.cn · Acme")
  expect(_internal.cardNameOf({ orgLabel: true }, { email: "x@y" }, "x@y", "")).toBe("x@y")
  expect(_internal.teamOf({}, TEAM)).toEqual({})
  expect(_internal.orgOf({ organization: { id: "o", name: "N" } })).toEqual({ orgId: "o", orgName: "N" })
})

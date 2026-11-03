// Qoder CN enterprise dedicated domains (企业版专属域), such as Milktea's
// <corp>.rdc.aliyuncs.com, against a local stand-in for the domain's hosts.
// Nothing here comes from a real dedicated account: the rules are read from
// Qoder IDE 1.38.0's workbench (config.general.dedicatedUrl):
// - its probe GETs <domain>/algo/api/v1/version; 404 is a Lingma 1.0
//   dedicated domain (lingma.test.mjs), any other status Qoder CN 2.0;
// - a 2.0 domain signs in at <origin>/device/selectAccounts with the IDE's
//   client id and no redirect_uri, and polls and reads the user on the host
//   named with "-openapi" after its first label ("-gateway" for its gateway);
//   an IP or a host with no dot keeps its origin.
// The account shapes are the VPC ones (vpc.test.mjs): the same protocol.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const IDE_CLIENT = "f5a7f67c-11a8-491e-8b8e-a07f2d0df4b7"
const WEB = "corp.rdc.aliyuncs.com"
const OPENAPI = "corp-openapi.rdc.aliyuncs.com"
const GATEWAY = "corp-gateway.rdc.aliyuncs.com"
const PUBLIC = ["qoder.cn", "openapi.qoder.com.cn", "gateway.qoder.com.cn", "openapi.qoder.sh", "api3.qoder.sh"]

let server
let route = () => new Response("", { status: 404 })
let seen = []
let unreachable = new Set()
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
    if (unreachable.has(u.host)) throw new TypeError(`getaddrinfo ENOTFOUND ${u.hostname}`)
    const headers = new Headers(init.headers)
    headers.set("x-qoder-host", u.host)
    return real(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, { ...init, headers })
  }
}
afterEach(() => {
  globalThis.fetch = real
  route = () => new Response("", { status: 404 })
  seen = []
  unreachable = new Set()
})

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

function store(initial) {
  let auth = initial
  return {
    client: { auth: { set: async ({ body }) => (auth = body) } },
    get: async () => auth,
    auth: () => auth,
  }
}

const hostsOf = () => [...new Set(seen.map((s) => s.host))]
const noPublic = () => expect(hostsOf().filter((h) => PUBLIC.includes(h))).toEqual([])
const dedicatedMethod = (hooks) => hooks.auth.methods.find((m) => m.prompts?.some((p) => p.key === "dedicated"))

test("a dedicated domain is read as the IDE reads config.general.dedicatedUrl: a host or https address, path dropped", () => {
  for (const v of ["corp.rdc.aliyuncs.com", " corp.rdc.aliyuncs.com/ ", "https://corp.rdc.aliyuncs.com", "https://corp.rdc.aliyuncs.com/", "https://corp.rdc.aliyuncs.com/some/path?x=1", "HTTPS://CORP.rdc.aliyuncs.com"])
    expect([v, _internal.dedicatedOrigin(v)]).toEqual([v, "https://" + WEB])
  expect(_internal.dedicatedOrigin("https://corp.example.com:8443")).toBe("https://corp.example.com:8443")
  for (const v of ["", "  ", "http://corp.rdc.aliyuncs.com", "https://u:p@corp.rdc.aliyuncs.com", "ftp://corp.rdc.aliyuncs.com", "https://"])
    expect([v, _internal.dedicatedOrigin(v)]).toEqual([v, undefined])
})

test("its openapi and gateway hosts are the IDE's: the suffix after the first label, an IP or dotless host kept", () => {
  const h = _internal.dedicatedHost
  expect(h("https://" + WEB, "-openapi")).toBe("https://" + OPENAPI)
  expect(h("https://" + WEB, "-gateway")).toBe("https://" + GATEWAY)
  expect(h("https://acme.vpc.qoder.com.cn", "-openapi")).toBe("https://acme-openapi.vpc.qoder.com.cn")
  expect(h("https://corp.example.com:8443", "-gateway")).toBe("https://corp-gateway.example.com:8443")
  for (const o of ["https://10.0.0.5", "https://10.0.0.5:8443", "https://[::1]", "https://intranet"]) expect([o, h(o, "-openapi")]).toEqual([o, o])
  expect(_internal.dedicatedSite(_internal.SITES["qoder-cn"], WEB)).toMatchObject({
    id: "qoder-cn",
    web: "https://" + WEB,
    openapi: "https://" + OPENAPI,
    api: "https://" + GATEWAY,
    clientId: IDE_CLIENT,
    redirect: "",
    vpc: WEB,
    dedicated: WEB,
  })
})

test("only Qoder CN has the dedicated method, after the ones it had", async () => {
  const hooks = await QoderCNAuthPlugin({ client: store().client })
  expect(hooks.auth.methods[0].label).toBe("Sign in with Qoder CN")
  const m = dedicatedMethod(hooks)
  expect(hooks.auth.methods.at(-1)).toBe(m)
  expect(m.label).toBe("Sign in with Qoder CN Enterprise dedicated domain (企业版专属域)")
  expect(m.prompts[0].validate("corp.rdc.aliyuncs.com")).toBeUndefined()
  expect(m.prompts[0].validate("http://corp.rdc.aliyuncs.com")).toContain("Not a dedicated domain")
  expect(dedicatedMethod(await QoderAuthPlugin({ client: store().client }))).toBeUndefined()
})

test("a Qoder CN 2.0 dedicated sign-in probes, opens the domain's page and polls and reads the user on its openapi host", async () => {
  toServer()
  let polls = 0
  route = (at, { url, body, req }) => {
    // the IDE counts any status but 404 as 2.0
    if (at === WEB + "/algo/api/v1/version") return new Response("<html></html>", { status: 200 })
    if (at === GATEWAY + "/algo/api/v1/version") return new Response("", { status: 401 })
    if (at === OPENAPI + "/api/v1/deviceToken/poll") {
      expect(url.searchParams.get("challenge_method")).toBe("S256")
      return ++polls < 2 ? new Response("", { status: 404 }) : json({ token: "dt-ded", refresh_token: "drt-ded", user_id: "u-ded" })
    }
    if (at === OPENAPI + "/api/v1/me/jobToken") {
      expect(JSON.parse(body)).toEqual({ clientId: IDE_CLIENT })
      return json({ message: "client not allowed" }, 403)
    }
    if (at === OPENAPI + "/api/v1/userinfo") {
      expect(req.headers.get("authorization")).toBe("Bearer dt-ded")
      return json({ id: "u-ded", name: "Milk", email: "milk@corp.example" })
    }
    return new Response("", { status: 404 })
  }
  const flow = await dedicatedMethod(await QoderCNAuthPlugin({ client: store().client })).authorize({ dedicated: "https://corp.rdc.aliyuncs.com/" })
  const u = new URL(flow.url)
  expect(u.origin + u.pathname).toBe("https://" + WEB + "/device/selectAccounts")
  expect(u.searchParams.get("client_id")).toBe(IDE_CLIENT)
  expect(u.searchParams.has("redirect_uri")).toBe(false)
  const cred = await flow.callback()
  expect(cred).toMatchObject({
    type: "success",
    access: "dt-ded",
    deviceChat: true,
    uid: "u-ded",
    accountId: `milk@corp.example (${WEB})`,
    vpc: WEB,
    dedicated: WEB,
  })
  expect(cred.dedicatedApi).toBeUndefined()
  expect(hostsOf()).toEqual([WEB, GATEWAY, OPENAPI])
}, 10_000)

// a domain that answers 404 at the probe is Lingma 1.0: lingma.test.mjs

test("a domain that doesn't answer is refused, never read as either kind", async () => {
  toServer()
  unreachable.add(WEB)
  const m = dedicatedMethod(await QoderCNAuthPlugin({ client: store().client }))
  await expect(m.authorize({ dedicated: WEB })).rejects.toThrow("didn't answer")
})

const MODEL = { key: "performance", display_name: "Performance", enable: true, is_reasoning: true, max_input_tokens: 180000, format: "openai", source: "system", tags: [] }
const sse = (...chunks) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(c) })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
const signedIn = (over = {}) => ({
  type: "oauth",
  access: "dt-ded",
  refresh: "drt-ded",
  expires: Date.now() + 3_600_000,
  deviceChat: true,
  accountId: `milk@corp.example (${WEB})`,
  uid: "u-ded",
  machineId: "m-ded",
  deviceToken: "dt-ded",
  deviceRefresh: "drt-ded",
  vpc: WEB,
  dedicated: WEB,
  ...over,
})
const chat = { model: "performance", messages: [{ role: "user", content: "hi" }] }
const served = (host) => (at) => {
  if (at === host + "/algo/api/v2/model/list") return json({ chat: [MODEL] })
  if (at === host + "/algo/api/v2/service/pro/sse/agent_chat_generation") return sse({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })
  return new Response("", { status: 404 })
}

test("a dedicated account's chat and list go to its gateway host, never the public ones", async () => {
  toServer()
  route = served(GATEWAY)
  const s = store(signedIn())
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  expect(opts.baseURL).toBe("https://" + GATEWAY)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(chat) })
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("OK")
  expect(hostsOf()).toEqual([GATEWAY])
  noPublic()
})

test("when the gateway host doesn't answer at sign-in, the account chats on the domain's own origin", async () => {
  toServer()
  unreachable.add(GATEWAY)
  route = (at) => {
    if (at === WEB + "/algo/api/v1/version") return json({ version: "x" })
    if (at === OPENAPI + "/api/v1/deviceToken/poll") return json({ token: "dt-ded", refresh_token: "drt-ded", user_id: "u-ded" })
    if (at === OPENAPI + "/api/v1/me/jobToken") return json({}, 403)
    if (at === OPENAPI + "/api/v1/userinfo") return json({ id: "u-ded", email: "milk@corp.example" })
    return new Response("", { status: 404 })
  }
  const flow = await dedicatedMethod(await QoderCNAuthPlugin({ client: store().client })).authorize({ dedicated: WEB })
  const cred = await flow.callback()
  expect(cred.dedicatedApi).toBe("https://" + WEB)
  seen = []
  route = served(WEB)
  const s = store({ ...signedIn(), ...cred, type: "oauth" })
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  expect(opts.baseURL).toBe("https://" + WEB)
  expect((await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(chat) })).status).toBe(200)
  expect(hostsOf()).toEqual([WEB])
}, 10_000)

test("a dedicated device token is renewed on its openapi host", async () => {
  toServer()
  route = (at) => {
    if (at === OPENAPI + "/api/v1/deviceToken/refresh")
      return json({ device_token: "dt-ded-2", refresh_token: "drt-ded-2", expires_at: new Date(Date.now() + 7_200_000).toISOString() })
    return served(GATEWAY)(at)
  }
  const s = store(signedIn({ expires: Date.now() + 60_000 }))
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(chat) })
  expect(res.status).toBe(200)
  expect(s.auth()).toMatchObject({ access: "dt-ded-2", deviceToken: "dt-ded-2", dedicated: WEB })
  expect(seen[0].host + seen[0].path).toBe(OPENAPI + "/api/v1/deviceToken/refresh")
  noPublic()
})

test("an account whose dedicated domain on record isn't one is not sent to the public hosts", async () => {
  toServer()
  route = served("gateway.qoder.com.cn")
  const s = store(signedIn({ dedicated: "http://nope" }))
  const hooks = await QoderCNAuthPlugin({ client: s.client })
  const ms = await hooks.provider.models({ models: {} }, { auth: s.auth() }).catch(() => ({}))
  expect(Object.keys(ms)).toEqual([])
  noPublic()
})

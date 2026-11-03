// Qoder CN Lingma 1.0 (通义灵码) dedicated domains: a domain that answers 404
// at /algo/api/v1/version, as Qoder IDE 1.38.0's probe tells one apart, and
// whose sign-in is the session Qoder CN IDE's worker holds. The shapes are
// Milktea's (plugins Discord 2026-11-03, the redacted gist that was tested on
// a real dedicated host):
// - <cosyHome>/cache/id is the machine id (or <cosyHome>/id), cache/user is
//   base64(AES-128-CBC(JSON)) under key = IV = the id's first 16 chars, and
//   the JSON is { uid, yx_uid, organization_id, organization_name, name,
//   email, security_oauth_token, refresh_token, expire_time, user_type };
// - each SSE event is {"headers":…,"body":"<chunk>","statusCodeValue":…};
// - "Model not exist" (model_not_found) and 105 "Login timeout" are said
//   inside the stream.
// Nothing here reaches the network: fetch is answered in-process.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { createCipheriv } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QoderCNAuthPlugin, _internal } from "./index.mjs"

const HOST = "corp.rdc.aliyuncs.com"
const ORIGIN = "https://" + HOST
const CHAT = "/algo/api/v2/service/pro/sse/agent_chat_generation"
const MACHINE = "3f2b9c1e-7a4d-4e8f-9b21-6c0d5e4a1f37"

const real = globalThis.fetch
const saved = {}
let sandbox, cosy, seen, route

beforeAll(() => {
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "QODERCN_COSY_HOME"]) saved[k] = process.env[k]
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
})
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "qoder-lingma-"))
  // every layout the reader knows sits under the sandbox: none of this
  // machine's own is read
  process.env.HOME = process.env.USERPROFILE = sandbox
  process.env.APPDATA = join(sandbox, "AppData", "Roaming")
  process.env.XDG_CONFIG_HOME = join(sandbox, ".config")
  cosy = join(sandbox, "cosy")
  process.env.QODERCN_COSY_HOME = cosy
  seen = []
  route = () => new Response("", { status: 404 })
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const body = typeof init.body === "string" ? init.body : ""
    seen.push({ host: u.host, path: u.pathname, search: u.search, headers: new Headers(init.headers), body })
    return route(u.host + u.pathname, { body, headers: new Headers(init.headers) })
  }
})
afterEach(() => {
  globalThis.fetch = real
  rmSync(sandbox, { recursive: true, force: true })
})

// ideCache writes the account the IDE's worker caches, as the gist read it
function ideCache(root, account, { idAtRoot = false, id = MACHINE } = {}) {
  mkdirSync(join(root, "cache"), { recursive: true })
  writeFileSync(join(root, ...(idAtRoot ? ["id"] : ["cache", "id"])), id + "\n")
  const key = Buffer.from(id.slice(0, 16), "utf8")
  const c = createCipheriv("aes-128-cbc", key, key)
  writeFileSync(join(root, "cache", "user"), Buffer.concat([c.update(JSON.stringify(account), "utf8"), c.final()]).toString("base64"))
}
const ACCOUNT = (over = {}) => ({
  uid: "1234567890123456",
  yx_uid: "1234567890123456",
  organization_id: "65f0c1d2e3a4b5c6d7e8f901",
  organization_name: "Corp",
  name: "陈",
  email: "milk@corp.example",
  security_oauth_token: "pt-AbCdEfGhIjKlMnOpQrStUvW",
  refresh_token: "rt-ZyXwVuTsRqPoNmLkJiHgFeD",
  expire_time: Date.now() + 6 * 3600_000,
  user_type: "enterprise_professional",
  ...over,
})

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const frame = (inner, status = 200) => "data:" + JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(inner), statusCodeValue: status }) + "\n\n"
const sse = (...frames) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } })
const OK = frame({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }], model: "qmodel_latest" })
const NOT_HERE = frame({ error: { message: "Model not exist.", code: "model_not_found" } }, 400)
const LAPSED = frame({ code: "105", message: "Login timeout" }, 403)

function store(initial) {
  let auth = initial
  return { client: { auth: { set: async ({ body }) => (auth = body) } }, get: async () => auth, auth: () => auth }
}
const lingmaMethod = (hooks) => hooks.auth.methods.find((m) => m.prompts?.some((p) => p.key === "dedicated"))
const signedIn = (over = {}) => ({
  type: "oauth",
  access: "pt-AbCdEfGhIjKlMnOpQrStUvW",
  refresh: "",
  expires: Date.now() + 3_600_000,
  accountId: `milk@corp.example (${HOST})`,
  uid: "1234567890123456",
  email: "milk@corp.example",
  name: "陈",
  machineId: MACHINE,
  deviceToken: "",
  deviceRefresh: "",
  dedicated: HOST,
  lingma: true,
  ...over,
})
const ask = { model: "qmodel_latest", messages: [{ role: "user", content: "hi" }] }
const chats = () => seen.filter((s) => s.path === CHAT)
const sentModel = (s) => JSON.parse(_internal.decodeBody(s.body)).model_config.key

test("the IDE's cache is looked for where Qoder CN IDE keeps it on each system, the override first", () => {
  const home = "/h"
  expect(_internal.lingmaRoots({ QODERCN_COSY_HOME: "/o" }, "darwin", home).slice(0, 2)).toEqual(["/o", join(home, "Library", "Application Support", "QoderCN", "SharedClientCache")])
  expect(_internal.lingmaRoots({ APPDATA: "C:/Users/m/AppData/Roaming" }, "win32", home)[0]).toBe(join("C:/Users/m/AppData/Roaming", "QoderCN", "SharedClientCache"))
  expect(_internal.lingmaRoots({}, "win32", home)[0]).toBe(join(home, "AppData", "Roaming", "QoderCN", "SharedClientCache"))
  expect(_internal.lingmaRoots({ XDG_CONFIG_HOME: "/x" }, "linux", home)[0]).toBe(join("/x", "QoderCN", "SharedClientCache"))
  const linux = _internal.lingmaRoots({}, "linux", home)
  expect(linux).toEqual([join(home, ".config", "QoderCN", "SharedClientCache"), join(home, ".config", "Qoder CN", "SharedClientCache"), join(home, ".lingma")])
})

test("the worker's cache/user opens under its machine id, beside it or at the root", async () => {
  ideCache(join(sandbox, "a"), ACCOUNT())
  ideCache(join(sandbox, "b"), ACCOUNT({ uid: "u-b" }), { idAtRoot: true })
  const a = await _internal.lingmaDecode(join(sandbox, "a"))
  expect(a).toMatchObject({ machineId: MACHINE, uid: "1234567890123456", access: "pt-AbCdEfGhIjKlMnOpQrStUvW", orgId: "65f0c1d2e3a4b5c6d7e8f901", email: "milk@corp.example" })
  expect((await _internal.lingmaDecode(join(sandbox, "b"))).uid).toBe("u-b")
  // another machine's id doesn't open it
  ideCache(join(sandbox, "c"), ACCOUNT())
  writeFileSync(join(sandbox, "c", "cache", "id"), "00000000-0000-0000-0000-000000000000")
  expect((await _internal.lingmaDecode(join(sandbox, "c"))).reason).toContain("doesn't open")
  expect((await _internal.lingmaDecode(join(sandbox, "none"))).reason).toContain("no cache/id")
})

test("a domain that answers 404 at the probe signs in with the account Qoder CN IDE holds, asking the domain nothing else", async () => {
  const end = Date.now() + 6 * 3600_000
  ideCache(cosy, ACCOUNT({ expire_time: end }))
  const m = lingmaMethod(await QoderCNAuthPlugin({ client: store().client }))
  const flow = await m.authorize({ dedicated: `https://${HOST}/` })
  expect(flow.method).toBe("auto")
  expect(flow.instructions).toContain("milk@corp.example")
  const cred = await flow.callback()
  expect(cred).toMatchObject({
    type: "success",
    access: "pt-AbCdEfGhIjKlMnOpQrStUvW",
    refresh: "",
    expires: end,
    uid: "1234567890123456",
    orgId: "65f0c1d2e3a4b5c6d7e8f901",
    machineId: MACHINE,
    accountId: `milk@corp.example (${HOST})`,
    dedicated: HOST,
    lingma: true,
  })
  expect(seen.map((s) => s.host + s.path)).toEqual([HOST + "/algo/api/v1/version"])
})

test("the IDE's own folder is found with no override", async () => {
  delete process.env.QODERCN_COSY_HOME
  const own =
    process.platform === "darwin"
      ? join(sandbox, "Library", "Application Support", "QoderCN", "SharedClientCache")
      : process.platform === "win32"
        ? join(process.env.APPDATA, "QoderCN", "SharedClientCache")
        : join(process.env.XDG_CONFIG_HOME, "QoderCN", "SharedClientCache")
  ideCache(own, ACCOUNT())
  const flow = await lingmaMethod(await QoderCNAuthPlugin({ client: store().client })).authorize({ dedicated: HOST })
  expect((await flow.callback()).machineId).toBe(MACHINE)
})

test("with no IDE sign-in, or a lapsed one, the sign-in says so and where it looked", async () => {
  const m = lingmaMethod(await QoderCNAuthPlugin({ client: store().client }))
  const none = await m.authorize({ dedicated: HOST }).catch((e) => e)
  expect(none.message).toContain("no Qoder CN IDE sign-in found")
  expect(none.message).toContain(cosy)
  ideCache(cosy, ACCOUNT({ expire_time: Date.now() - 1000 }))
  await expect(m.authorize({ dedicated: HOST })).rejects.toThrow("ended")
})

test("a Lingma account chats on the domain's origin, signed and written as the IDE's worker sends it", async () => {
  route = (at) => (at === HOST + CHAT ? sse(OK) : new Response("", { status: 404 }))
  const s = store(signedIn())
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  expect(opts.baseURL).toBe(ORIGIN)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(ask) })
  expect(res.status).toBe(200)
  const out = await res.json()
  expect(out.choices[0].message.content).toBe("OK")
  expect(out.model).toBe("qmodel_latest")
  expect(seen.map((x) => x.host)).toEqual([HOST])
  const [c] = chats()
  expect(c.search).toBe("?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1")
  const h = c.headers
  expect(h.get("cosy-clienttype")).toBe("0")
  expect(h.get("cosy-version")).toBe("2.5.18")
  expect(h.get("cosy-machineid")).toBe(MACHINE)
  expect(h.get("cosy-user")).toBe("1234567890123456")
  for (const gone of ["cosy-scene", "cosy-business-product", "cosy-business-type"]) expect([gone, h.get(gone)]).toEqual([gone, null])
  expect(h.get("accept")).toBe("text/event-stream")
  expect(h.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
  const body = JSON.parse(_internal.decodeBody(c.body))
  expect(body.session_type).toBe("assistant")
  expect(body.business.version).toBe("2.5.18")
  expect(body.model_config).toMatchObject({ key: "qmodel_latest", format: "dashscope", source: "system" })
})

test("a model the domain refuses inside the stream is followed by the next the IDE knows", async () => {
  for (const refusal of [NOT_HERE, frame({ error: { message: "Model not exist.", code: "model_not_found" } })]) {
    seen = []
    route = (at, { body }) => {
      if (at !== HOST + CHAT) return new Response("", { status: 404 })
      return sse(JSON.parse(_internal.decodeBody(body)).model_config.key === "qmodel_latest" ? refusal : OK)
    }
    const s = store(signedIn())
    const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ ...ask, stream: false }) })
    expect(res.status).toBe(200)
    expect((await res.json()).model).toBe("dashscope_qmodel")
    expect(chats().map(sentModel)).toEqual(["qmodel_latest", "dashscope_qmodel"])
  }
})

test("a 105 said in the stream is asked again with the token the IDE renewed, and saved", async () => {
  ideCache(cosy, ACCOUNT({ security_oauth_token: "pt-Renewed00000000000000000" }))
  route = (at, { headers }) => {
    if (at !== HOST + CHAT) return new Response("", { status: 404 })
    return sse(seen.filter((x) => x.path === CHAT).length === 1 ? LAPSED : OK)
  }
  const s = store(signedIn())
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(ask) })
  expect(res.status).toBe(200)
  expect(chats().length).toBe(2)
  expect(s.auth().access).toBe("pt-Renewed00000000000000000")
})

test("a 105 with no newer IDE token is a 401 that marks the sign-in expired", async () => {
  ideCache(cosy, ACCOUNT())
  route = (at) => (at === HOST + CHAT ? sse(LAPSED) : new Response("", { status: 404 }))
  const s = store(signedIn())
  const opts = await (await QoderCNAuthPlugin({ client: s.client })).auth.loader(s.get)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(ask) })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  expect((await res.json()).error.message).toContain("Qoder CN IDE")
  expect(chats().length).toBe(1)
})

test("a token near its end is renewed from the IDE's cache, never by a refresh call", async () => {
  ideCache(cosy, ACCOUNT({ security_oauth_token: "pt-Renewed00000000000000000" }))
  route = (at) => (at === HOST + CHAT ? sse(OK) : new Response("", { status: 404 }))
  const s = store(signedIn({ expires: Date.now() + 60_000 }))
  const hooks = await QoderCNAuthPlugin({ client: s.client })
  const opts = await hooks.auth.loader(s.get)
  expect((await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(ask) })).status).toBe(200)
  expect(s.auth().access).toBe("pt-Renewed00000000000000000")
  expect(seen.map((x) => x.path)).toEqual([CHAT])
  // magpie's own renewal takes the same, and nothing while the IDE has none newer
  expect(await hooks.auth.refresh(signedIn())).toMatchObject({ access: "pt-Renewed00000000000000000" })
  expect(await hooks.auth.refresh(signedIn({ access: "pt-Renewed00000000000000000" }))).toBeUndefined()
  expect(seen.map((x) => x.path)).toEqual([CHAT])
})

test("its models are the IDE's, and usage and check-in ask the domain nothing", async () => {
  const s = store(signedIn())
  const hooks = await QoderCNAuthPlugin({ client: s.client })
  const ms = await hooks.provider.models({ models: {} }, { auth: s.auth() })
  expect(Object.keys(ms)).toEqual(["qmodel_latest", "dashscope_qmodel", "q36fmodel"])
  expect(ms.qmodel_latest.api.url).toBe(ORIGIN)
  expect(await hooks.auth.usage(s.get)).toMatchObject({ windows: [], signIn: "kept" })
  expect((await hooks.auth.checkin(s.get)).outcome).toBe("inactive")
  expect(seen).toEqual([])
})

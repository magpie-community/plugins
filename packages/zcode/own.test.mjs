// "ZCode app's sign-in" reads what ZCode keeps, as magpie's built-in did
// (internal/provider/zcode.go zcodeOwn, zcode_team.go zcodeOwnTeam), and
// follows it: a request made after ZCode switched to a team's plan, or
// signed in anew, uses what ZCode has now.
import { test, expect, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})

const dir = () => join(homedir(), ".zcode", "v2")
function enc(text) {
  const key = createHash("sha256").update("test-seed").digest()
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
function zcodeHas(store, setting = {}) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(join(dir(), "credentials.json"), JSON.stringify(Object.fromEntries(Object.entries(store).map(([k, v]) => [k, enc(v)]))))
  writeFileSync(join(dir(), "setting.json"), JSON.stringify(setting))
}
const KEY = "account-provider:coding-plan:account:zai-individual-coding-plan:account:u1:api-key"

test("the sign-in takes ZCode's account and key, and follows ZCode after", async () => {
  zcodeHas({ [KEY]: "id1.secret1", zcodejwttoken: "Bearer j1", "oauth:zai:user_info": JSON.stringify({ email: "ada@phone.local" }) })
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  expect(got.accountId).toBe("ada")
  expect(got.access).toBe("id1.secret1")
  expect(JSON.parse(got.refresh).source).toBe("zcode")
  const auth = { ...got, type: "oauth" }
  expect(_internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1", base: "https://api.z.ai/api/anthropic" })

  // ZCode signs in again with a new key
  const ada = JSON.stringify({ email: "ada@phone.local" })
  zcodeHas({ [KEY]: "id2.secret2", zcodejwttoken: "j2", "oauth:zai:user_info": ada })
  expect(_internal.stateOf(auth)).toMatchObject({ key: "id2.secret2", jwt: "j2" })

  // and switches to a team's plan
  zcodeHas(
    { [KEY]: "id2.secret2", zcodejwttoken: "j2", "oauth:zai:access_token": "tok-team", "oauth:zai:user_info": ada },
    { providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org1", projectId: "p1" } } },
  )
  expect(_internal.stateOf(auth)).toMatchObject({ key: "", token: "tok-team", org: "org1", project: "p1", jwt: "j2" })
})

test("with ZCode signed out, the sign-in says so", async () => {
  zcodeHas({})
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("ZCode isn't signed in")
})

test("a sign-in not ZCode's keeps its own key", () => {
  zcodeHas({ [KEY]: "id9.secret9" })
  const s = _internal.stateOf({ type: "oauth", access: "mine.k", refresh: JSON.stringify({ site: "zai", key: "mine.k" }) })
  expect(s.key).toBe("mine.k")
})

// LingYi_Stu on X: the app's sign-in added for A, then again after ZCode
// switched to B, is two accounts. A's entry follows ZCode only while ZCode
// is signed in to A; with ZCode on B it is what A's sign-in saved, never B's.
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const expiredJWT = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"

async function appSignIn() {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  return { ...got, type: "oauth" }
}

test("an app sign-in for A doesn't send with B's key once ZCode is signed in to B", async () => {
  zcodeHas({ [KEY]: "idA.secretA", zcodejwttoken: "Bearer jA", "oauth:zai:user_info": JSON.stringify({ email: "alice@x.local" }) })
  const a = await appSignIn()
  zcodeHas({ [KEY]: "idB.secretB", zcodejwttoken: "Bearer jB", "oauth:zai:user_info": JSON.stringify({ email: "bob@x.local" }) })
  const b = await appSignIn()
  expect([a.accountId, b.accountId]).toEqual(["alice@x.local", "bob@x.local"])

  expect(_internal.stateOf(a)).toMatchObject({ key: "idA.secretA", jwt: "jA" })
  expect(_internal.stateOf(b)).toMatchObject({ key: "idB.secretB", jwt: "jB" })

  _internal.routes?.clear?.()
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sent.push({ path: url.pathname, headers: Object.fromEntries(new Headers(init.headers ?? {})) })
    if (url.pathname === "/api/biz/subscription/list") return new Response(JSON.stringify({ code: 0, data: [{ productName: "GLM Coding Pro", status: "VALID" }] }))
    if (url.pathname === "/api/monitor/usage/quota/limit") return new Response(JSON.stringify({ code: 0, data: { limits: [] } }))
    return new Response(JSON.stringify({ type: "message", content: [] }), { headers: { "content-type": "application/json" } })
  }
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => a, { id: "zcode" })
  const res = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "zcode" },
    body: JSON.stringify({ model: "glm-5.1", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(200)
  await hooks.auth.usage?.(async () => a, { id: "zcode" }).catch(() => {})
  const msg = sent.find((c) => c.path === "/api/anthropic/v1/messages")
  expect(msg.headers["x-api-key"]).toBe("idA.secretA")
  const all = JSON.stringify(sent)
  expect(all).not.toContain("secretB")
  expect(all).not.toContain("jB")
})

test("an app sign-in for A whose saved session has lapsed, with ZCode on B, says sign in again", async () => {
  zcodeHas({ zcodejwttoken: "Bearer " + expiredJWT, "oauth:zai:user_info": JSON.stringify({ email: "alice@x.local" }) })
  const a = await appSignIn()
  zcodeHas({ zcodejwttoken: "Bearer jB-live", "oauth:zai:user_info": JSON.stringify({ email: "bob@x.local" }) })
  expect(_internal.stateOf(a).jwt).toBe(expiredJWT)

  _internal.routes?.clear?.()
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    sent.push(JSON.stringify(Object.fromEntries(new Headers(init.headers ?? {}))))
    return new Response("{}", { status: 500 })
  }
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => a, { id: "zcode" })
  const err = await opts
    .fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5.1", messages: [] }) })
    .then(() => null, (e) => e)
  expect(err?.message).toContain("sign in")
  expect(sent.join("")).not.toContain("jB-live")
})

// ZCode 3.15 keeps no coding plan key in its credentials: a BigModel GLM
// Coding Pro's key sits in config.json, the built-in coding plan
// provider's options.apiKey (yetone/magpie#2130)
test("ZCode 3.15's plan key is read from its config.json", async () => {
  const bm = JSON.stringify({ email: "bm@example.com" })
  zcodeHas({ zcodejwttoken: "Bearer j1", "oauth:bigmodel:user_info": bm, "oauth:bigmodel:access_token": "tok" })
  const config = (provider) => writeFileSync(join(dir(), "config.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", provider }))
  config({
    "builtin:bigmodel-coding-plan": { name: "GLM Coding Plan", options: { apiKey: "bm.secret", baseURL: "https://open.bigmodel.cn/api/anthropic" }, models: {} },
    "builtin:zai-coding-plan": { options: { apiKey: "" } },
  })
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("bm.secret")
  const auth = { ...got, type: "oauth" }
  expect(_internal.stateOf(auth)).toMatchObject({ key: "bm.secret", jwt: "j1", base: "https://open.bigmodel.cn/api/anthropic", site: "bigmodel" })

  // one written encrypted reads too; one that isn't a key doesn't
  config({ "builtin:zai-coding-plan": { options: { apiKey: "{env:ZAI_KEY}" } }, "builtin:bigmodel-coding-plan": { options: { apiKey: enc("bm.secret2") } } })
  expect(_internal.stateOf(auth)).toMatchObject({ key: "bm.secret2", base: "https://open.bigmodel.cn/api/anthropic" })

  // a key in credentials.json still comes first
  zcodeHas({ [KEY]: "id1.secret1", zcodejwttoken: "j1", "oauth:bigmodel:user_info": bm })
  expect(_internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", base: "https://api.z.ai/api/anthropic" })
  config({})
})

// wakkana on Discord (WorkBuddy's, the same here): two accounts of one
// name are two accounts. The sign-in keeps ZCode's user id beside the name,
// for magpie to tell them apart by, and an entry follows ZCode only while
// ZCode is signed in to that same user id, not another of its name.
test("the app's sign-in keeps the user id, and follows ZCode by it", async () => {
  const as = (id) => JSON.stringify({ name: "Ada", user_id: id })
  zcodeHas({ [KEY]: "id1.secret1", zcodejwttoken: "j1", "oauth:zai:user_info": as("u1") })
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.accountId).toBe("Ada")
  expect(got.uid).toBe("u1")
  expect(JSON.parse(got.refresh).uid).toBeUndefined()
  const auth = { ...got, type: "oauth" }

  zcodeHas({ [KEY]: "id2.secret2", zcodejwttoken: "j2", "oauth:zai:user_info": as("u1") })
  expect(_internal.stateOf(auth)).toMatchObject({ key: "id2.secret2", jwt: "j2" })
  expect(_internal.stateOf(auth).uid).toBeUndefined()

  // another account named Ada: A's entry keeps what it saved
  zcodeHas({ [KEY]: "id3.secret3", zcodejwttoken: "j3", "oauth:zai:user_info": as("u2") })
  expect(_internal.stateOf(auth)).toMatchObject({ key: "id1.secret1" })
})

// meraki7304 (#410): ZCode 3.16.3 on a Mac keeps no plan key at all, in
// credentials.json or config.json, only where the key is: a
// project-key-location:v1 record. The sign-in reads that key, as ZCode lists
// it, and the BigModel GLM Coding Plan is found, not only the gift.
test("ZCode 3.16's key location gives the coding plan its key", async () => {
  const loc = (fam, account) =>
    "project-key-location:v1:" + encodeURIComponent(JSON.stringify(["https://bigmodel.cn", fam, account, null, 1, "non-team"]))
  zcodeHas(
    {
      zcodejwttoken: "Bearer j1",
      "oauth:bigmodel:access_token": "tok-bm",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "u7", email: "q@example.com" }),
      [loc("bigmodel", "u7")]: JSON.stringify({ organizationId: "org7", projectId: "proj7", apiKeyId: "k7" }),
      // another account's location is left alone
      [loc("bigmodel", "u8")]: JSON.stringify({ organizationId: "org8", projectId: "proj8", apiKeyId: "k8" }),
    },
    { providerFamilyDomain: "bigmodel" },
  )
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    sent.push([init.method ?? "GET", url, new Headers(init.headers ?? {}).get("authorization")])
    if (url.includes("/api_keys/copy/k7")) return Response.json({ code: 200, data: { secretKey: "sec7" } })
    if (url.includes("/api/biz/subscription/list")) return Response.json({ code: 200, data: [{ productName: "GLM Coding Pro", status: "VALID" }] })
    if (url.includes("/zcode-plan/billing/balance")) return Response.json({ code: 0, data: { plans: [] } })
    return new Response("{}", { status: 404 })
  }
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  const auth = { ...got, type: "oauth" }
  const s = await _internal.located(_internal.stateOf(auth))
  expect(s).toMatchObject({ key: "k7.sec7", site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic" })
  expect(sent[0]).toEqual(["GET", "https://bigmodel.cn/api/biz/v1/organization/org7/projects/proj7/api_keys/copy/k7", "tok-bm"])
  // nothing is made
  expect(sent.every(([method]) => method === "GET")).toBe(true)
  _internal.routes.clear()
  expect((await _internal.plansOf(s)).start).toBe(false)
  expect(sent.map(([, u]) => u).join(" ")).not.toContain("k8")

  // a location whose key is gone leaves the sign-in as it was
  zcodeHas(
    {
      zcodejwttoken: "Bearer j1",
      "oauth:zai:access_token": "tok-z",
      "oauth:zai:user_info": JSON.stringify({ id: "u9", email: "z@example.com" }),
      ["project-key-location:v1:" + encodeURIComponent(JSON.stringify(["https://evil.example", "zai", "u9", null, 1, "non-team"]))]: JSON.stringify({ organizationId: "o", projectId: "p", apiKeyId: "gone" }),
    },
  )
  sent.length = 0
  const z = await (await m.authorize()).callback()
  const zs = await _internal.located(_internal.stateOf({ ...z, type: "oauth" }))
  expect(zs.key).toBe("")
  // asked at the site's own API, never the record's foreign origin, as a Bearer
  expect(sent[0]).toEqual(["GET", "https://api.z.ai/api/biz/v1/organization/o/projects/p/api_keys/copy/gone", "Bearer tok-z"])
})

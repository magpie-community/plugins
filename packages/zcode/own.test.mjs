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

// "ZCode app's sign-in" reads what ZCode keeps, as magpie's built-in did
// (internal/provider/zcode.go zcodeOwn, zcode_team.go zcodeOwnTeam), and
// follows it: a request made after ZCode switched to a team's plan, or
// signed in anew, uses what ZCode has now.
import { test, expect, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let ZCodeAuthPlugin, _internal, secret
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
  ;({ secret } = _internal)
})

// the keychain is one object, and the tests stand in for it: nothing here
// spawns security(1), so these tests say the same on any CI platform. The
// baseline answers "nothing there"; a test that reads sets its own answer.
const noKey = async () => ({ miss: true })
const noAttrs = async () => "unknown"
// starting a read is what clears the denial flag (v2Key sets it before
// asking), so one injected miss is what a fresh run's first read leaves
// behind; then the next test starts with an empty vault, as a fresh run does
afterEach(async () => {
  _internal.keychain.read = noKey
  _internal.keychain.attrs = noAttrs
  delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  await _internal.v2Key("reset")
  _internal.vault.clear()
  _internal.vaultInFlight.clear()
})

const dir = () => join(homedir(), ".zcode", "v2")
function enc(text) {
  const key = createHash("sha256").update("test-seed").digest()
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}

// ZCode 3.18's vault form: the key stands in for the OS keychain, named by
// ZCODE_CREDENTIAL_V2_SECRET or read from the keychain, and the fingerprint
// is sha256(key) as 24 hex
const fpOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24)
function vaultEnc(key, text) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return `enc:v2:os:${fpOf(key)}:` + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
const V2_KEY = randomBytes(32)
const V2_FP = fpOf(V2_KEY)
const encV2 = (text) => vaultEnc(V2_KEY, text)
function zcodeHas2(store, setting = {}) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(join(dir(), "credentials.json"), JSON.stringify(store))
  writeFileSync(join(dir(), "setting.json"), JSON.stringify(setting))
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
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1", base: "https://api.z.ai/api/anthropic" })

  // ZCode signs in again with a new key
  const ada = JSON.stringify({ email: "ada@phone.local" })
  zcodeHas({ [KEY]: "id2.secret2", zcodejwttoken: "j2", "oauth:zai:user_info": ada })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id2.secret2", jwt: "j2" })

  // and switches to a team's plan
  zcodeHas(
    { [KEY]: "id2.secret2", zcodejwttoken: "j2", "oauth:zai:access_token": "tok-team", "oauth:zai:user_info": ada },
    { providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org1", projectId: "p1" } } },
  )
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "", token: "tok-team", org: "org1", project: "p1", jwt: "j2" })
})

test("with ZCode signed out, the sign-in says so", async () => {
  zcodeHas({})
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("ZCode isn't signed in")
})

test("a sign-in not ZCode's keeps its own key", async () => {
  zcodeHas({ [KEY]: "id9.secret9" })
  const s = await _internal.stateOf({ type: "oauth", access: "mine.k", refresh: JSON.stringify({ site: "zai", key: "mine.k" }) })
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

  expect(await _internal.stateOf(a)).toMatchObject({ key: "idA.secretA", jwt: "jA" })
  expect(await _internal.stateOf(b)).toMatchObject({ key: "idB.secretB", jwt: "jB" })

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
  expect((await _internal.stateOf(a)).jwt).toBe(expiredJWT)

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
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "bm.secret", jwt: "j1", base: "https://open.bigmodel.cn/api/anthropic", site: "bigmodel" })

  // one written encrypted reads too; one that isn't a key doesn't
  config({ "builtin:zai-coding-plan": { options: { apiKey: "{env:ZAI_KEY}" } }, "builtin:bigmodel-coding-plan": { options: { apiKey: enc("bm.secret2") } } })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "bm.secret2", base: "https://open.bigmodel.cn/api/anthropic" })

  // a key in credentials.json still comes first
  zcodeHas({ [KEY]: "id1.secret1", zcodejwttoken: "j1", "oauth:bigmodel:user_info": bm })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", base: "https://api.z.ai/api/anthropic" })
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
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id2.secret2", jwt: "j2" })
  expect(await _internal.stateOf(auth).uid).toBeUndefined()

  // another account named Ada: A's entry keeps what it saved
  zcodeHas({ [KEY]: "id3.secret3", zcodejwttoken: "j3", "oauth:zai:user_info": as("u2") })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1" })
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
  const s = await _internal.located(await _internal.stateOf(auth))
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
  const zs = await _internal.located(await _internal.stateOf({ ...z, type: "oauth" }))
  expect(zs.key).toBe("")
  // asked at the site's own API, never the record's foreign origin, as a Bearer
  expect(sent[0]).toEqual(["GET", "https://api.z.ai/api/biz/v1/organization/o/projects/p/api_keys/copy/gone", "Bearer tok-z"])
})

// dinghao-8 (#439): the same ZCode 3.16 sign-in's model list. models() read
// the sign-in without its key, so plansOf took it for a Start Plan one and
// listed that plan's models: GLM-5.3, which ZCode's config gives
// account:bigmodel-individual-coding-plan, was left out and delisted.
test("ZCode 3.16's key location lists the coding plan's models", async () => {
  const at = "project-key-location:v1:" + encodeURIComponent(JSON.stringify(["https://bigmodel.cn", "bigmodel", "u7", null, 1, "non-team"]))
  zcodeHas(
    {
      zcodejwttoken: "Bearer j1",
      "oauth:bigmodel:access_token": "tok-bm",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "u7", email: "q@example.com" }),
      [at]: JSON.stringify({ organizationId: "org7", projectId: "proj7", apiKeyId: "k7" }),
    },
    { providerFamilyDomain: "bigmodel" },
  )
  const rule = (providerId, builtinModelIds) => ({ providerId, builtinModelIds })
  const cfg = {
    revision: 9_999_999,
    config: {
      providerConfigRules: {
        providerRules: [
          rule("account:bigmodel-individual-coding-plan", ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]),
          rule("account:zai-start-plan", ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]),
        ],
      },
    },
  }
  let keyFails = false
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes("/api_keys/copy/k7")) return keyFails ? new Response("{}", { status: 500 }) : Response.json({ code: 200, data: { secretKey: "sec7" } })
    if (url.includes("/api/biz/subscription/list")) return Response.json({ code: 200, data: [{ productName: "GLM Coding Pro", status: "VALID" }] })
    if (url.includes("/zcode-plan/billing/balance")) return Response.json({ code: 0, data: { plans: [] } })
    if (url.includes("/api/v1/client/configs")) return Response.json({ code: 0, data: { configs: { builtin_provider_config_json: "https://cdn.example/zcode-builtin.json" } } })
    if (url === "https://cdn.example/zcode-builtin.json") return Response.json(cfg)
    return new Response("{}", { status: 404 })
  }
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  const auth = { ...got, type: "oauth" }
  expect(JSON.parse(got.refresh).source).toBe("zcode")
  _internal.routes.clear()
  const ms = await hooks.provider.models({ models: {} }, { auth })
  expect(Object.keys(ms)).toContain("GLM-5.3")
  expect(ms["GLM-5.3"].api.url).toBe("https://open.bigmodel.cn/api/anthropic/v1")

  // a key that can't be read throws, so magpie keeps the list it had
  // rather than being told the Start Plan's
  keyFails = true
  const z = await (await m.authorize()).callback()
  zcodeHas(
    {
      zcodejwttoken: "Bearer j1",
      "oauth:bigmodel:access_token": "tok-other",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "u7", email: "q@example.com" }),
      [at]: JSON.stringify({ organizationId: "org7", projectId: "proj7", apiKeyId: "k7" }),
    },
    { providerFamilyDomain: "bigmodel" },
  )
  _internal.routes.clear()
  await expect(hooks.provider.models({ models: {} }, { auth: { ...z, type: "oauth" } })).rejects.toThrow("coding plan key")
})

// ZCode 3.18's China sign-in keeps its identity under zai_cn. Losing it
// makes every gift-only account "ZCode" and lets it follow a different
// account's session when the app switches users.
test("the app's China sign-in keeps its identity and follows only that user", async () => {
  const as = (id) => JSON.stringify({ email: "ada@phone.local", user_id: id })
  zcodeHas({
    zcodejwttoken: "Bearer china-a",
    "oauth:active_provider": "zai_cn",
    "oauth:zai_cn:user_info": as("china-user-a"),
  })
  const auth = await appSignIn()
  expect(auth.accountId).toBe("ada")
  expect(auth.uid).toBe("china-user-a")

  zcodeHas({
    zcodejwttoken: "Bearer china-renewed",
    "oauth:active_provider": "zai_cn",
    "oauth:zai_cn:user_info": as("china-user-a"),
  })
  expect((await _internal.stateOf(auth)).jwt).toBe("china-renewed")

  // Two accounts may share the same display name; the uid guards them.
  zcodeHas({
    zcodejwttoken: "Bearer china-b",
    "oauth:active_provider": "zai_cn",
    "oauth:zai_cn:user_info": as("china-user-b"),
  })
  expect((await _internal.stateOf(auth)).jwt).toBe("china-a")
})

test.each(["zai_cn", "zai", "bigmodel"])("the app's active %s identity wins over another provider's cached profile", async (active) => {
  const store = { zcodejwttoken: "Bearer active-session", "oauth:active_provider": active }
  for (const family of ["zai", "zai_cn", "bigmodel"])
    store[`oauth:${family}:user_info`] = JSON.stringify({ email: `${family}@example.com`, user_id: `user-${family}` })
  zcodeHas(store)
  const auth = await appSignIn()
  expect(auth.accountId).toBe(`${active}@example.com`)
  expect(auth.uid).toBe(`user-${active}`)
})

// ZCode 3.18 also writes credentials.json's values as "enc:v2:os:…", a
// different shape whose body carries no dots; this plugin can't read it, so
// the sign-in and the card say so, never "sign in again" (#1196). The values
// are the shape the reporter showed, not real ones.
test("ZCode 3.18's enc:v2 credentials are named as unreadable, not as signed out", async () => {
  mkdirSync(dir(), { recursive: true })
  const v2 = "enc:v2:os:" + "A".repeat(24) + ":" + "B".repeat(312)
  writeFileSync(join(dir(), "credentials.json"), JSON.stringify({ zcodejwttoken: v2, "oauth:bigmodel:access_token": v2, "oauth:active_provider": v2 }))
  writeFileSync(join(dir(), "setting.json"), "{}")
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toMatch(/ZCode keeps its sign-in in a form this plugin can't read/)

  // an account signed in before: its card's gift line says why, too
  const line = _internal.giftSignIn({ source: "zcode", key: "id1.secret1" }, false)
  expect(line.display).toMatch(/ZCode keeps its sign-in in a form this plugin can't read/)
  // a browser sign-in with no session is still asked to sign in again
  expect(_internal.giftSignIn({ key: "id1.secret1" }, false).display).toBe("this sign-in has no ZCode session: sign in again")

  // enc:v1 again: back to the old words
  zcodeHas({})
  expect(_internal.giftSignIn({ source: "zcode", key: "id1.secret1" }, false).display).toBe("this sign-in has no ZCode session: sign in again")
})

test("3.18's vault-encrypted credentials read like the older ones", async () => {
  process.env.ZCODE_CREDENTIAL_V2_SECRET = V2_KEY.toString("base64url")
  try {
    zcodeHas2({
      [KEY]: encV2("id1.secret1"),
      zcodejwttoken: encV2("Bearer j1"),
      "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })),
    })
    const hooks = await ZCodeAuthPlugin({ client: {} })
    const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
    const got = await (await m.authorize()).callback()
    expect(got.type).toBe("success")
    expect(got.accountId).toBe("ada@example.com")
    expect(got.access).toBe("id1.secret1")
    const auth = { ...got, type: "oauth" }
    expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1", base: "https://api.z.ai/api/anthropic" })

    // a fingerprint the vault doesn't name reads as nothing, without
    // taking the older values down with it
    zcodeHas2({
      [KEY]: encV2("id1.secret1"),
      zcodejwttoken: "enc:v2:os:deadbeefdeadbeefdeadbeef:aa.bb.cc",
      "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })),
    })
    expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "" })
  } finally {
    delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  }
})

// 3.18's vault form reaches the helpers too: the team plan (ownTeam), the
// key location (ownLocation) and config.json's key (configKey) all decrypt
// values from the same store, and a store that went vault reads them as
// v1-only helpers would read nothing (adv1's team2 repro).
test("3.18's vault reads the team plan, the key location and config.json's key", async () => {
  process.env.ZCODE_CREDENTIAL_V2_SECRET = V2_KEY.toString("base64url")
  try {
    zcodeHas2(
      {
        zcodejwttoken: encV2("Bearer j2"),
        "oauth:zai:access_token": encV2("tok-team"),
        "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })),
      },
      { providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org1", projectId: "p1" } } },
    )
    expect(await _internal.ownSignIn()).toMatchObject({ token: "tok-team", org: "org1", project: "p1", jwt: "j2" })

    // the key location: where ZCode 3.16+ keeps the plan key instead
    const loc = "project-key-location:v1:" + encodeURIComponent(JSON.stringify(["https://bigmodel.cn", "bigmodel", "u7", null, 1, "non-team"]))
    zcodeHas2(
      {
        zcodejwttoken: encV2("Bearer j1"),
        "oauth:bigmodel:access_token": encV2("tok-bm"),
        "oauth:bigmodel:user_info": encV2(JSON.stringify({ id: "u7", email: "q@example.com" })),
        [loc]: encV2(JSON.stringify({ organizationId: "org7", projectId: "proj7", apiKeyId: "k7" })),
      },
      { providerFamilyDomain: "bigmodel" },
    )
    const s = await _internal.ownSignIn()
    expect(s).toMatchObject({ site: "bigmodel", token: "tok-bm" })
    expect(s.loc).toMatchObject({ org: "org7", project: "proj7", apiKeyId: "k7" })

    // config.json's key (ZCode 3.15), written encrypted
    const v2 = join(homedir(), ".zcode", "v2")
    mkdirSync(join(v2, "runtime"), { recursive: true })
    writeFileSync(join(v2, "config.json"), JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: encV2("cfg.secret") } } } }))
    zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
    expect(await _internal.ownSignIn()).toMatchObject({ key: "cfg.secret", base: "https://open.bigmodel.cn/api/anthropic" })
    rmSync(join(v2, "config.json"), { force: true })
  } finally {
    delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  }
})

// keychain answers: only a denial must say itself instead of reading as
// "not signed in" (adv3's codes repro); a miss and a read cut off by its
// timeout are both no key, said plainly.
test("a keychain denial says itself, a miss and a stall do not", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const answer = async (got) => {
    _internal.vault.clear()
    _internal.keychain.read = async () => got
    if (got.denied) await expect(_internal.ownSignIn()).rejects.toThrow("keychain access was denied")
    else expect(await _internal.ownSignIn()).toBe(null)
  }
  // no item is not a denial: the store reads as signed out
  await answer({ miss: true })
  // a cut-off read is not one either
  await answer({ killed: true })
  await answer({ denied: true })
})

// the item is there and reads fine, but its key is another vault's: ZCode
// wrote the file under a newer key (a real 3.18.2 case: file rewritten, item
// not). No allowance on this computer fixes that, so the sign-in says the
// key, the card's gift line says it across runs, and neither says
// "isn't signed in" or "sign in again".
test("a key that doesn't open the file says itself, not \"signed out\"", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  _internal.keychain.read = async () => ({ mismatch: true })

  // the sign-in the user picks: the words name the key, and ZCode's fix
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("can't be read with the key this computer keeps")
  expect(got.error).toContain("sign in to ZCode again")

  // a run before the sign-in: ownSignIn is a null like any other miss
  _internal.vault.clear()
  expect(await _internal.ownSignIn()).toBe(null)

  // an account signed in before the vault went stale: its card's gift line
  // says the key too, from the flag this run read and from the one it saved
  expect(_internal.giftSignIn({ source: "zcode", key: "id1.secret1" }, false).display).toContain("can't be read with the key this computer keeps")
  expect(_internal.giftSignIn({ source: "zcode", key: "id1.secret1", stale: true }, false).display).toContain("can't be read with the key this computer keeps")
  // a browser sign-in is still asked to sign in again
  expect(_internal.giftSignIn({ key: "id1.secret1" }, false).display).toBe("this sign-in has no ZCode session: sign in again")
})

// a no is remembered for minutes, so a request in that window neither waits
// on macOS nor shows the dialog again; a request reads the remembered no
test("a denial is remembered for minutes, and says itself on the request path too", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  let reads = 0
  _internal.keychain.read = async () => {
    reads += 1
    return { denied: true }
  }
  await expect(_internal.ownSignIn()).rejects.toThrow("keychain access was denied")
  expect(reads).toBe(1)
  const miss = _internal.vault.get(V2_FP)
  expect(miss.key).toBe(null)
  expect(miss.until - Date.now()).toBeGreaterThan(4 * 60_000)

  await expect(_internal.ownSignIn({ background: true })).rejects.toThrow("keychain access was denied")
  expect(reads).toBe(1)

  // the sign-in the user picks tries once more, and says it in words
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("keychain access was denied")
  expect(got.error).toContain("Allow security to read ZCode Credential Encryption when macOS asks")
  expect(reads).toBe(2)
})

// a saved sign-in served before keeps serving when ZCode's vault is one this
// run has not read: a request does not read it (adv1/adv2's c_fallback repro)
test("a saved sign-in keeps serving when ZCode's vault is new to this run", async () => {
  zcodeHas2({ [KEY]: encV2("id1.secret1"), zcodejwttoken: encV2("Bearer j1"), "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })) })
  _internal.keychain.read = async () => ({ key: V2_KEY })
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  const auth = { ...got, type: "oauth" }

  // ZCode rotates its vault: the file names another key now
  const rotated = randomBytes(32)
  zcodeHas2({
    [KEY]: vaultEnc(rotated, "id2.secret2"),
    zcodejwttoken: vaultEnc(rotated, "Bearer j2"),
    "oauth:zai:user_info": vaultEnc(rotated, JSON.stringify({ email: "ada@example.com" })),
  })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1" })
})

// a request reads what this run has read and asks the OS nothing, so no
// request path can raise the macOS dialog (#1154); the sign-in the user
// picks is the one read, and the request path follows it from the cache
test("a request reads nothing new from the keychain", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  let reads = 0
  _internal.keychain.read = async () => {
    reads += 1
    return { key: V2_KEY }
  }
  const auth = { type: "oauth", access: "", refresh: JSON.stringify({ source: "zcode" }) }
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "" })
  expect(await _internal.stateOf(auth)).toMatchObject({ key: "" })
  expect(reads).toBe(0)

  expect(await _internal.ownSignIn({ fresh: true })).toMatchObject({ jwt: "j1" })
  expect(reads).toBe(1)
  expect(await _internal.ownSignIn({ background: true })).toMatchObject({ jwt: "j1" })
  expect(reads).toBe(1)
})

// the user saying no is remembered, but a sign-in asked for now is a question
// asked again: the user may have allowed it since
test("a sign-in made after saying no reads again", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  let reads = 0
  _internal.keychain.read = async () => {
    reads += 1
    return { denied: true }
  }
  await expect(_internal.ownSignIn()).rejects.toThrow("keychain access was denied")
  _internal.keychain.read = async () => {
    reads += 1
    return { key: V2_KEY }
  }
  expect(await _internal.ownSignIn({ fresh: true })).toMatchObject({ jwt: "j1" })
  expect(reads).toBe(2)
})

// three decrypts at once share one read: the first asks, the rest await it,
// so one page of requests can't stack up three macOS dialogs
test("concurrent decrypts share one keychain read", async () => {
  let reads = 0
  _internal.keychain.read = async () => {
    reads += 1
    await new Promise((r) => setTimeout(r, 20))
    return { key: V2_KEY }
  }
  const value = encV2("id1.secret1")
  const got = await Promise.all(Array.from({ length: 3 }, () => _internal.decryptV2(secret(), value)))
  expect(got).toEqual(["id1.secret1", "id1.secret1", "id1.secret1"])
  expect(reads).toBe(1)
})

// a read cut off by its timeout is remembered for half a minute, so one slow
// read doesn't bring the dialog back on every request that follows
test("a cut-off read is remembered for half a minute, not for minutes", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  let reads = 0
  _internal.keychain.read = async () => {
    reads += 1
    return { killed: true }
  }
  expect(await _internal.decryptV2(secret(), encV2("id1.secret1"))).toBe(null)
  expect(reads).toBe(1)
  const stall = _internal.vault.get(V2_FP)
  expect(stall.key).toBe(null)
  expect(stall.until - Date.now()).toBeGreaterThan(20_000)
  expect(stall.until - Date.now()).toBeLessThanOrEqual(30_000)
  // what follows reads the remembered stall, not the keychain
  expect(await _internal.decryptV2(secret(), encV2("id1.secret1"))).toBe(null)
  expect(await _internal.ownSignIn({ background: true })).toBe(null)
  expect(reads).toBe(1)
})

// the probe is what lets the sign-in say what macOS is about to ask, before
// it asks: the item is there, its key is gone, or nothing is known (another
// platform, a store with no vault value, or attributes that couldn't be read)
test("the probe says what the sign-in can promise before macOS asks", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const asked = []
  const answering = (got) => {
    _internal.keychain.attrs = async (fp) => {
      asked.push(fp)
      return got
    }
  }
  if (process.platform !== "darwin") {
    // no keychain to ask: nothing is known, and nothing is asked
    answering("found")
    expect(await _internal.probeKeychain()).toBe("none")
    expect(asked).toEqual([])
    return
  }
  for (const state of ["found", "absent", "unknown"]) {
    answering(state)
    expect(await _internal.probeKeychain()).toBe(state)
  }
  // it asks about the vault the value names, not one guessed
  expect(asked).toEqual([V2_FP, V2_FP, V2_FP])
  // a store with no vault value never asks: there is nothing to read
  zcodeHas({ zcodejwttoken: "Bearer j1" })
  answering("found")
  expect(await _internal.probeKeychain()).toBe("none")
  expect(asked).toHaveLength(3)
})

// what the user reads before macOS asks: the item is there and macOS will ask
// once (found), the key is gone and ZCode has to sign in again (absent), or
// the plain words, which promise nothing about the keychain
test("the sign-in says what macOS will ask, before it asks", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const instructions = async () => {
    const hooks = await ZCodeAuthPlugin({ client: {} })
    const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
    return (await m.authorize()).instructions
  }
  const at = async (got) => {
    _internal.keychain.attrs = async () => got
    return instructions()
  }
  const plain = "Uses the account the ZCode app is signed in to"
  if (process.platform !== "darwin") {
    // no keychain to ask: the plain words, whatever the store holds
    for (const state of ["found", "absent", "unknown"]) expect((await at(state)).startsWith(plain)).toBe(true)
    return
  }
  const found = await at("found")
  expect(found.startsWith("✓ ZCode's saved sign-in is on this computer.")).toBe(true)
  expect(found).toContain("security")
  const absent = await at("absent")
  expect(absent.startsWith("✗ ZCode's file holds a vault-encrypted sign-in,")).toBe(true)
  expect(absent).toContain("Sign in to ZCode again, then add this sign-in.")
  // an unreadable item promises nothing either way
  expect((await at("unknown")).startsWith(plain)).toBe(true)
  // and neither does a store with no vault value
  zcodeHas({ zcodejwttoken: "Bearer j1" })
  expect((await instructions()).startsWith(plain)).toBe(true)
})

// the sheet's own button is the control: the keychain is read after the
// person says go, not while the sheet is still being read. magpie asks
// through ask(), so the line above the button can say whether the item is
// there; the probe behind it reads attributes, never the secret
test("the sign-in waits for a person before it reads the keychain", async () => {
  const reads = []
  _internal.keychain.read = async (fp) => {
    reads.push(fp)
    return { miss: true }
  }
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  // listing the ways to sign in reads nothing
  expect(reads).toHaveLength(0)
  // OpenCode's channel: the static prompt, which promises nothing
  expect(m.prompts).toHaveLength(1)
  const [gate] = m.prompts
  expect(gate.type).toBe("select")
  expect(gate.options).toHaveLength(1)
  expect(gate.options[0].label).toBe("Read it now")
  expect(gate.message).toContain("may ask macOS once")
  expect(gate.message).toContain("security")
  expect(gate.message).toContain("ZCode Credential Encryption")
  // magpie's channel: the same button, a line that knows the answer
  if (process.platform === "darwin") {
    _internal.keychain.attrs = async () => "found"
    const found = await m.ask({})
    expect(found.type).toBe("select")
    expect(found.key).toBe("read")
    expect(found.options).toEqual([{ label: "Read it now", value: "yes" }])
    expect(found.message.startsWith("✓ ZCode's saved sign-in is on this computer.")).toBe(true)
    _internal.keychain.attrs = async () => "absent"
    expect((await m.ask({})).message.startsWith("✗ ZCode's file holds a vault-encrypted sign-in,")).toBe(true)
    _internal.keychain.attrs = async () => "unknown"
  } else {
    // no keychain to ask: the promise-free line, whatever the store holds
    expect((await m.ask({})).message).toContain("may ask macOS once")
  }
  expect((await m.ask({})).message).toContain("may ask macOS once")
  // answered once: the same question is not put again
  expect(await m.ask({ read: "yes" })).toBe(null)
  // the probe read attributes, never the secret
  expect(reads).toHaveLength(0)
})

test("a stand-in key that isn't 32 base64url bytes stands in for nothing", async () => {
  const bad = [
    Buffer.from(randomBytes(31)).toString("base64url"),
    Buffer.from(randomBytes(33)).toString("base64url"),
    Buffer.from("has!exclamation", "utf8").toString("base64url"),
    "",
  ]
  for (const standIn of bad) {
    process.env.ZCODE_CREDENTIAL_V2_SECRET = standIn
    expect(await _internal.decryptV2(secret(), "enc:v2:os:" + V2_FP + ":aa.bb.cc")).toBe(null)
  }
  delete process.env.ZCODE_CREDENTIAL_V2_SECRET
})

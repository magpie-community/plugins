// "ZCode app's sign-in" reads what ZCode keeps, as magpie's built-in did
// (internal/provider/zcode.go zcodeOwn, zcode_team.go zcodeOwnTeam), and
// follows it: a request made after ZCode switched to a team's plan, or
// signed in anew, uses what ZCode has now.
import { test, expect, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let ZCodeAuthPlugin, _internal, secret, zcodeDir
// a security(1) shim: records its args in $SHIM_LOG (one JSON array per
// line), answers as $SHIM_EXIT (0 by default), sleeping $SHIM_MS first.
// Keychain reads in tests never touch the real one.
const SHIM = mkdtempSync(join(tmpdir(), "zcode-shim-"))
writeFileSync(join(SHIM, "security"), `#!/usr/bin/env python3
import json, os, sys, time
with open(os.environ.get('SHIM_LOG') or os.devnull, 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
ms = os.environ.get('SHIM_MS')
if ms:
    time.sleep(int(ms) / 1000)
raise SystemExit(int(os.environ.get('SHIM_EXIT') or 0))
`)
chmodSync(join(SHIM, "security"), 0o755)
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
  ;({ secret, zcodeDir } = _internal)
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
// ZCODE_CREDENTIAL_V2_SECRET, and the fingerprint is sha256(key) as 24 hex
const V2_KEY = randomBytes(32)
const V2_FP = createHash("sha256").update(V2_KEY).digest("hex").slice(0, 24)
function encV2(text) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", V2_KEY, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return `enc:v2:os:${V2_FP}:` + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
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

// keychain denials: the exit code is the OSStatus's low byte, and a denial
// (UserCanceled -128, AuthFailed -25293) must say itself instead of reading
// as "not signed in" (adv3's codes repro). A denial with a usable saved
// sign-in keeps it (adv1/adv2's c_fallback repro).
test("a keychain denial says itself, exit 128/51; 45 is no denial", async () => {
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const exits = async (code, deny) => {
    _internal.vault.clear()
    _internal.denyKeychain = false
    process.env.PATH = SHIM + ":" + process.env.PATH
    process.env.SHIM_EXIT = String(code)
    try {
      if (deny) await expect(_internal.ownSignIn()).rejects.toThrow("keychain access was denied")
      else expect(await _internal.ownSignIn()).toBe(null)
    } finally {
      process.env.PATH = process.env.PATH.slice(SHIM.length + 1)
      delete process.env.SHIM_EXIT
    }
  }
  // security names no exit 45 on a read: 45 is errSecDuplicateItem, no
  // denial said, the store reads as signed out
  await exits(45, false)
  await exits(128, true)
  await exits(51, true)
})

test("a keychain denial keeps the saved sign-in it served before", async () => {
  process.env.ZCODE_CREDENTIAL_V2_SECRET = V2_KEY.toString("base64url")
  try {
    zcodeHas2({ [KEY]: encV2("id1.secret1"), zcodejwttoken: encV2("Bearer j1"), "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })) })
    const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
    const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
    const got = await (await m.authorize()).callback()
    expect(got.type).toBe("success")
    const auth = { ...got, type: "oauth" }

    // ZCode rotates its vault; the new key's read is denied, the saved
    // sign-in still serves its key
    const rotated = randomBytes(32)
    process.env.ZCODE_CREDENTIAL_V2_SECRET = rotated.toString("base64url")
    zcodeHas2({ [KEY]: encV2("id2.secret2"), zcodejwttoken: encV2("Bearer j2"), "oauth:zai:user_info": encV2(JSON.stringify({ email: "ada@example.com" })) })
    _internal.vault.clear()
    _internal.denyKeychain = false
    process.env.PATH = SHIM + ":" + process.env.PATH
    process.env.SHIM_EXIT = "128"
    try {
      expect(await _internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1" })
    } finally {
      process.env.PATH = process.env.PATH.slice(SHIM.length + 1)
      delete process.env.SHIM_EXIT
    }
  } finally {
    delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  }
})

// concurrent decrypts share one keychain read: the first spawns, the rest
// await it; a read cut off by its timeout is not remembered as a miss for
// minutes (adv2's a_concurrency and f_slowtimeout repros)
test("concurrent vault reads spawn one keychain read, and a slow one isn't a miss", async () => {
  delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  const log = join(SHIM, "log")
  process.env.PATH = SHIM + ":" + process.env.PATH
  process.env.SHIM_LOG = log
  try {
    // six concurrent reads, one spawn, and the read answers slower than
    // its timeout: cut off, nothing remembered, the next read tries again
    process.env.SHIM_EXIT = "0"
    process.env.SHIM_MS = "5100"
    _internal.vault.clear()
    const fp = createHash("sha256").update(V2_KEY).digest("hex").slice(0, 24)
    const value = "enc:v2:os:" + fp + ":aa.bb.cc"
    const reads = await Promise.all(Array.from({ length: 6 }, () => _internal.decryptV2(secret(), value)))
    expect(reads.every((r) => r === null)).toBe(true)
    expect(_internal.vault.size).toBe(0)
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean).length).toBe(1)

    // and, cut off or not, the in-flight read is shared: six callers, one spawn
    process.env.SHIM_MS = "400"
    rmSync(log, { force: true })
    await Promise.all(Array.from({ length: 6 }, () => _internal.decryptV2(secret(), value)))
    const spawnLines = readFileSync(log, "utf8").split("\n").filter(Boolean)
    expect(spawnLines.length).toBe(1)
    expect(JSON.parse(spawnLines[0]).filter((a) => a === "-a")).toHaveLength(1)
  } finally {
    process.env.PATH = process.env.PATH.slice(SHIM.length + 1)
    delete process.env.SHIM_MS
    delete process.env.SHIM_EXIT
    delete process.env.SHIM_LOG
  }
}, 12000)

test("a keychain read names the account ZCode keeps, not one guessed", async () => {
  delete process.env.ZCODE_CREDENTIAL_V2_SECRET
  zcodeHas2({ zcodejwttoken: encV2("Bearer j1") })
  _internal.vault.clear()
  const log = join(SHIM, "log")
  rmSync(log, { force: true })
  process.env.PATH = SHIM + ":" + process.env.PATH
  process.env.SHIM_EXIT = "0"
  process.env.SHIM_LOG = log
  try {
    const fp = createHash("sha256").update(V2_KEY).digest("hex").slice(0, 24)
    await _internal.decryptV2(secret(), "enc:v2:os:" + fp + ":aa.bb.cc")
    const args = JSON.parse(readFileSync(log, "utf8").split("\n").filter(Boolean)[0])
    expect(args.filter((a) => a === "-a")).toHaveLength(1)
    expect(args[args.indexOf("-a") + 1]).toBe(createHash("sha256").update(join(zcodeDir(), "credentials.json")).digest("hex"))
  } finally {
    process.env.PATH = process.env.PATH.slice(SHIM.length + 1)
    delete process.env.SHIM_EXIT
    delete process.env.SHIM_LOG
  }
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

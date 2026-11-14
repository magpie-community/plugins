// enc:v2: values, the vault form ZCode 3.18 keeps, read when the key they
// fingerprint is at hand: ZCODE_CREDENTIAL_V2_SECRET stands in for the vault
// and answers enc:v2:env:; a key of another fingerprint reads as nothing, so
// the sign-in says so rather than borrowing another account's. A v1 value and
// a v2 one in one store read side by side.
import { test, expect, beforeAll } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  process.env.ZCODE_CREDENTIAL_V2_SECRET = STAND_IN
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})

// 43 base64url chars: the shape ZCode reads its own stand-in with
const STAND_IN = "A".repeat(43)

const dir = () => join(homedir(), ".zcode", "v2")
function enc(text) {
  const key = createHash("sha256").update("test-seed").digest()
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
const KEY = Buffer.from(STAND_IN, "base64url")
const FP = createHash("sha256").update(KEY).digest("hex").slice(0, 24)
function encV2(text) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", KEY, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v2:env:" + FP + ":" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
// the v1 values go through enc, the v2 ones through encV2
function zcodeHas(v1Store, v2Store = {}, setting = {}) {
  mkdirSync(dir(), { recursive: true })
  const out = {}
  for (const [k, v] of Object.entries(v1Store)) out[k] = enc(v)
  for (const [k, v] of Object.entries(v2Store)) out[k] = encV2(v)
  writeFileSync(join(dir(), "credentials.json"), JSON.stringify(out))
  writeFileSync(join(dir(), "setting.json"), JSON.stringify(setting))
}
const KEY_NAME = "account-provider:coding-plan:account:zai-individual-coding-plan:account:u1:api-key"

test("the app's sign-in reads ZCode 3.18's vault-encrypted credentials through the stand-in", async () => {
  zcodeHas({}, { zcodejwttoken: "Bearer j1", "oauth:zai:user_info": JSON.stringify({ email: "ada@phone.local" }), "oauth:active_provider": "zai" })
  const own = _internal.ownSignIn()
  expect(own && own.jwt).toBe("j1")
  expect(own && own.user).toBe("ada")
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  expect(got.type).toBe("success")
  expect(got.accountId).toBe("ada")
  expect(got.access).toBe("j1")
})

test("a stand-in of another fingerprint reads as nothing", async () => {
  zcodeHas({}, { zcodejwttoken: "Bearer j1", "oauth:zai:user_info": JSON.stringify({ email: "ada@phone.local" }) })
  const before = process.env.ZCODE_CREDENTIAL_V2_SECRET
  try {
    process.env.ZCODE_CREDENTIAL_V2_SECRET = "B".repeat(43)
    expect(_internal.ownSignIn()).toBe(null)
  } finally {
    process.env.ZCODE_CREDENTIAL_V2_SECRET = before
  }
})

test("a v1 key and a v2 session in one store read side by side", async () => {
  zcodeHas({ [KEY_NAME]: "id1.secret1" }, { zcodejwttoken: "Bearer j1", "oauth:zai:user_info": JSON.stringify({ email: "ada@phone.local" }) })
  const own = _internal.ownSignIn()
  expect(own && own.key).toBe("id1.secret1")
  expect(own && own.jwt).toBe("j1")
})

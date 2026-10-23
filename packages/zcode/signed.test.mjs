import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { ZCodeAuthPlugin, _internal } from "./index.mjs"
import { createSigner, minePow } from "./sign.mjs"
import { createCipheriv, createHmac, createPrivateKey, createPublicKey, verify as cryptoVerify } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run in an isolated home")

const KEY = "one.secret"
const state = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: KEY, device: "device" }
const auth = { type: "oauth", access: KEY, refresh: JSON.stringify(state), expires: 0 }
const sent = []
const real = globalThis.fetch
const DER = Buffer.from("MC4CAQAwBQYDK2VwBCIEINaofm94EHDBFTX6XkGlMUU8F41qb2mXKe/DMwUJbxCh", "base64")
const SIGN_HEADERS = [
  "x-app-id",
  "x-client-nonce",
  "x-client-pow",
  "x-client-sig",
  "x-client-ts",
  "x-client-version",
  "x-session-id",
]
const POW = minePow("key", "session", "123")

function sealedKey(secretForSeal = "secret", keyIdForSeal = "one") {
  const secret = secretForSeal
  const prk = createHmac("sha256", "WD_CLIENT_SIGN_KDF_SALT").update(secret).digest()
  const key = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("ed25519_priv"), Buffer.from([1])])).digest().subarray(0, 32)
  const nonce = Buffer.alloc(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(keyIdForSeal))
  return Buffer.concat([nonce, cipher.update(Buffer.from(DER.toString("base64"))), cipher.final(), cipher.getAuthTag()]).toString("base64")
}

function makeProjectAccessToken() {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${enc({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${enc({ token_use: "project_access", api_key: "jwt-key" })}.signature`
}

function publicPem() {
  return createPublicKey(createPrivateKey({ key: DER, format: "der", type: "pkcs8" }))
}

beforeEach(() => {
  sent.length = 0
  _internal.signedSigners.clear()
  // Isolate the optional on-disk signing-key cache as well.
  try { mkdirSync(join(tmpdir(), "zcode-signed-cache"), { recursive: true }) } catch {}
  process.env.XDG_CONFIG_HOME = join(tmpdir(), `zcode-signed-cache-${process.pid}`)
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/paas/c1f3a7e2/v2/client") {
      return new Response(JSON.stringify({ code: 200, data: { privateCipher: sealedKey() } }), { headers: { "content-type": "application/json" } })
    }
    sent.push({ input: String(input), init, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ ok: true }))
  }
})


afterEach(() => {
  globalThis.fetch = real
  _internal.signedSigners.clear()
})

async function send(model) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  return opts.fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model, messages: [] }),
  })
}

async function modelsOf(options) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } }, options)
  return hooks.provider.models({ models: {} }, { auth })
}

test("PoW follows ZCode's 32-hex-character candidate format", () => {
  expect(POW).toBeTruthy()
  expect(POW).toMatch(/^[0-9a-f]{32}$/)
  const challenge = createHash("sha256").update("key\nzcode\nsession\n123").digest("hex").slice(0, 32)
  const digest = createHash("sha256").update(`${challenge}\n${POW}`).digest()
  expect(digest[0]).toBe(0)
})

test("BigModel coding models gain opt-in Signed aliases", async () => {
  const enabled = await modelsOf({ signed: true })
  expect(enabled["GLM-5.3-Signed"]).toMatchObject({ id: "GLM-5.3-Signed" })
})

test("Signed aliases stay out of the catalog unless the option is on", async () => {
  const models = await modelsOf()
  expect(models["GLM-5.3-Signed"]).toBeUndefined()
  const enabled = await modelsOf({ signed: true })
  expect(enabled["GLM-5.3-Signed"]).toMatchObject({ id: "GLM-5.3-Signed" })
})

test("a Signed alias strips its suffix and signs without fallback", async () => {
  const realPlansOf = _internal.plansOf
  _internal.plansOf = async () => ({ start: false, gift: null })
  const res = await send("GLM-5.3-Signed")
  expect(res.status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0].init.body).model).toBe("GLM-5.3")
  expect(sent[0].headers.get("x-api-key")).toBe(KEY)
  expect(sent[0].headers.get("authorization")).toBe("Bearer " + KEY)
  expect(sent[0].headers.get("x-app-id")).toBe("zcode")
  expect(sent[0].headers.get("x-client-version")).toBe("3.15.3")
  expect(sent[0].headers.get("x-session-id")).toMatch(/^[0-9a-f]{32}$/)
  expect(sent[0].headers.get("x-client-pow")).toMatch(/^[0-9a-f]{32}$/)
  expect([...sent[0].headers].map(([name]) => name.toLowerCase()).filter((name) => name.startsWith("x-"))).toEqual([...SIGN_HEADERS, "x-api-key"].sort())
  const signature = Buffer.from(sent[0].headers.get("x-client-sig"), "base64")
  expect(signature).toHaveLength(64)
  expect(cryptoVerify(null, Buffer.from(`one\n${sent[0].headers.get("x-client-ts")}\n3.15.3\n${sent[0].headers.get("x-session-id")}\n${sent[0].headers.get("x-client-nonce")}`), publicPem(), signature)).toBe(true)
  _internal.plansOf = realPlansOf
})

test("a project access token uses accessToken in the official handshake", async () => {
  const token = makeProjectAccessToken()
  const authForToken = { ...auth, access: token, refresh: JSON.stringify({ ...state, key: token }) }
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => authForToken, { id: "zcode" })
  const captures = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/paas/c1f3a7e2/v2/client") {
      captures.push({ headers: new Headers(init?.headers), body: JSON.parse(init?.body) })
      return new Response(JSON.stringify({ code: 200, data: { privateCipher: sealedKey(token, "jwt-key") } }), { headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ ok: true }))
  }
  const realPlansOf = _internal.plansOf
  _internal.plansOf = async () => ({ start: false, gift: null })
  const res = await opts.fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "GLM-5.3-Signed", messages: [] }),
  })
  expect(res.status).toBe(200)
  expect(captures).toHaveLength(1)
  expect(captures[0].body).toEqual({ accessToken: token, ts: captures[0].body.ts, nonce: captures[0].body.nonce, sig: captures[0].body.sig })
  expect(Object.keys(captures[0].body)).toEqual(["accessToken", "ts", "nonce", "sig"])
  _internal.plansOf = realPlansOf
})

test("a failed BigModel sign handshake never sends an unsigned coding request", async () => {
  const realPlansOf = _internal.plansOf
  _internal.plansOf = async () => ({ start: false, gift: null })
  _internal.signedSigners.clear()
  try { rmSync(join(process.env.XDG_CONFIG_HOME, "magpie", "zcode-sign-key.json"), { force: true }) } catch {}
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/paas/c1f3a7e2/v2/client") return new Response(JSON.stringify({ code: 403 }), { status: 403 })
    sent.push({ input: String(input), init, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ ok: true }))
  }
  await expect(send("GLM-5.3-Signed")).rejects.toThrow("BigModel sign handshake")
  expect(sent).toHaveLength(0)
  _internal.plansOf = realPlansOf
})

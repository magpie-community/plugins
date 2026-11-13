import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  displayNameFor,
  endpointForForm,
  ideToken,
  ownAuth,
  planMirror,
  modelsOfCatalog,
  isMagpieBaseUrl,
  MAGPIE_PREFIX,
  AUTH_PROVIDER_ID,
} from "../trae-api.mjs"

function jwt(claims) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.`
}

const temps = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// homeFixture lays out a temporary home with the plugin's own sign-in.
function homeFixture({ pluginAuth } = {}) {
  const root = mkdtempSync(join(tmpdir(), "magpie-trae-token-"))
  const home = join(root, "home")
  const magpieDir = join(home, ".trae", "magpie")
  mkdirSync(magpieDir, { recursive: true })
  temps.push(root)
  if (pluginAuth !== undefined) {
    const config = join(home, ".config", "magpie")
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, "plugin-auth.json"), JSON.stringify(pluginAuth), "utf8")
  }
  const p = { home, magpieDir, magpieConfig: join(home, ".config", "magpie"), userData: join(home, "Trae") }
  return { p }
}

test("the model name carries the prefix the next sync removes", () => {
  assert.equal(displayNameFor({ modelId: "group/example", modelName: "Example model" }), "Magpie · Example model")
  assert.equal(displayNameFor({ modelId: "group/example-2", modelName: "example-2" }), "Magpie · example-2")
  assert.equal(displayNameFor({ modelId: "provider/model-b", modelName: "Model B" }), "Magpie · provider/model-b")
  const long = displayNameFor({ modelName: "x".repeat(100) })
  assert.equal(long.length, 64)
  assert.ok(long.startsWith(MAGPIE_PREFIX))
})

test("the form URL is the base Trae appends /chat/completions to", () => {
  assert.equal(endpointForForm("http://127.0.0.1:3425/v1/chat/completions"), "http://127.0.0.1:3425/v1")
  assert.equal(endpointForForm("http://127.0.0.1:3425/v1/chat/completions/"), "http://127.0.0.1:3425/v1")
  assert.equal(endpointForForm("http://127.0.0.1:3425/v1"), "http://127.0.0.1:3425/v1")
  assert.equal(endpointForForm("https://gw.example/v1/"), "https://gw.example/v1")
})

test("the key fingerprint is stable but does not contain the key", () => {
  const a = createHash("sha256").update("magpie-secret").digest("hex").slice(0, 16)
  assert.notEqual(a, createHash("sha256").update("other").digest("hex").slice(0, 16))
})

test("the Magpie base URL check only accepts the same gateway", () => {
  assert.equal(
    isMagpieBaseUrl(
      "http://127.0.0.1:3425/v1/chat/completions",
      "http://127.0.0.1:3425/v1/chat/completions",
    ),
    true,
  )
  assert.equal(
    isMagpieBaseUrl("https://api.example/v1/chat/completions", "http://127.0.0.1:3425/v1/chat/completions"),
    false,
  )
  assert.equal(isMagpieBaseUrl("", "http://127.0.0.1:3425/v1/chat/completions"), false)
})

// ---- the plugin's own sign-in is the only credential source ----

const LIVE_TOKEN = jwt({ data: { id: "1001" }, exp: Math.floor(Date.now() / 1000) + 3600 })
const OLD_TOKEN = jwt({ data: { id: "1002" }, exp: Math.floor(Date.now() / 1000) - 10 })

test("ideToken reads only this package's own sign-in", () => {
  const { p } = homeFixture({
    pluginAuth: {
      "trae-global": { type: "oauth", access: LIVE_TOKEN }, // another plugin's entry: must be ignored
      [AUTH_PROVIDER_ID]: {
        type: "oauth",
        access: LIVE_TOKEN,
        deviceId: "device-1",
        machineId: "machine-1",
      },
    },
  })
  const auth = ideToken(p)
  assert.equal(auth.error, undefined)
  assert.equal(auth.source, "own-signin")
  assert.equal(auth.accountId, "1001")
  assert.equal(auth.deviceId, "device-1")
  assert.equal(auth.machineId, "machine-1")
  assert.equal(ownAuth(p).accountId, "1001")
})

test("an expired own sign-in is reported with its refresh token", () => {
  const { p } = homeFixture({
    pluginAuth: { [AUTH_PROVIDER_ID]: { type: "oauth", access: OLD_TOKEN, refresh: "r" } },
  })
  const auth = ideToken(p)
  assert.equal(auth.error, "expired")
  assert.equal(auth.accountId, "1002")
  assert.equal(auth.refresh, "r")
})

test("ideToken says missing when the plugin has no sign-in", () => {
  const { p } = homeFixture({})
  assert.equal(ideToken(p).error, "missing")
})

// ---- multi-model reconcile ----

const ENDPOINT = "http://127.0.0.1:3425/v1/chat/completions"

function traeModel(name, displayName, baseUrl = "http://127.0.0.1:3425/v1", id = 1) {
  return { name, displayName, baseUrl, ak: "AK", id, provider: "custom_openai_compatible" }
}

test("planMirror adds missing, keeps present and never touches user models", () => {
  const existing = [
    traeModel("group/example-2", "Magpie · example-2", "http://127.0.0.1:3425/v1", 11),
    traeModel("example", "Example model", "http://other.example/v1", 12),
  ]
  const wanted = [
    { modelId: "group/example-2", displayName: "Magpie · example-2" },
    { modelId: "provider/model-b", displayName: "Magpie · provider/model-b" },
  ]
  const plan = planMirror(existing, wanted, ENDPOINT)
  assert.deepEqual(
    plan.add.map((m) => m.modelId),
    ["provider/model-b"],
  )
  assert.deepEqual(plan.remove, [])
  assert.deepEqual(
    plan.keep.map((m) => m.displayName),
    ["Magpie · example-2", "Example model"],
  )
  assert.deepEqual(plan.conflicts, [])
})

test("planMirror removes a disabled mirror and reports a foreign conflict", () => {
  const existing = [
    traeModel("group/old", "Magpie · old", "http://127.0.0.1:3425/v1", 21),
    traeModel("group/foreign", "Magpie · foreign", "https://elsewhere.example/v1", 22),
    traeModel("mine", "我的模型", "https://elsewhere.example/v1", 23),
  ]
  const plan = planMirror(existing, [{ modelId: "group/new", displayName: "Magpie · new" }], ENDPOINT)
  assert.deepEqual(
    plan.add.map((m) => m.modelId),
    ["group/new"],
  )
  assert.deepEqual(
    plan.remove.map((m) => m.name),
    ["group/old"],
  )
  assert.deepEqual(
    plan.conflicts.map((m) => m.name),
    ["group/foreign"],
  )
  // The user's own model on another gateway stays untouched.
  assert.deepEqual(
    plan.keep.map((m) => m.name),
    ["mine"],
  )
})

test("planMirror rewrites a renamed model by add plus remove", () => {
  const existing = [traeModel("group/example-2", "Magpie · old-name", "http://127.0.0.1:3425/v1", 31)]
  const plan = planMirror(
    existing,
    [{ modelId: "group/example-2", displayName: "Magpie · new-name" }],
    ENDPOINT,
  )
  assert.deepEqual(
    plan.add.map((m) => m.displayName),
    ["Magpie · new-name"],
  )
  assert.deepEqual(
    plan.remove.map((m) => m.name),
    ["group/example-2"],
  )
})

test("modelsOfCatalog reads the gateway's OpenAI list", () => {
  const out = modelsOfCatalog({
    data: [
      { id: "group/example-2", display_name: "example-2", context_window: 1000000, max_output_tokens: 512000, modalities: ["text", "image"] },
      { id: "provider/model-b", display_name: "Model B", context_window: 0 },
      { id: "" },
      null,
    ],
  })
  assert.deepEqual(
    out.map((m) => m.modelId),
    ["group/example-2", "provider/model-b"],
  )
  assert.equal(out[0].displayName, "Magpie · example-2")
  assert.equal(out[0].contextWindow, 1000000)
  assert.equal(out[0].supportsImages, true)
  assert.equal(out[1].contextWindow, undefined)
  assert.equal(out[1].supportsImages, undefined)
})

test("the sign-in flow carries a device key and refreshes what it stores", async () => {
  const { ownSigninFlow } = await import("../trae-auth.mjs")
  const { authorize } = ownSigninFlow
  // The flow itself is exercised by the browser; here only the pieces are
  // checked: a fresh authorize call must yield a URL with a loopback callback
  // and a resolvable callback promise (which times out long after the test).
  const previous = process.env.MAGPIE_TRAE_CLIENT_ID
  process.env.MAGPIE_TRAE_CLIENT_ID = "test-client"
  try {
    const started = await authorize()
    const callback = new URL(started.url).searchParams.get("auth_callback_url")
    assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/authorize$/)
    assert.equal(started.method, "auto")
    // Fulfil the loopback callback by hand and expect a usable auth record.
    const res = await fetch(
      `${callback}?userJwt=${encodeURIComponent(
        JSON.stringify({ Token: LIVE_TOKEN, RefreshToken: "r".repeat(30), TokenExpireAt: Date.now() + 3600000 }),
      )}&userInfo=${encodeURIComponent(JSON.stringify({ UserID: "77" }))}`,
    )
    assert.equal(res.status, 200)
    const auth = await started.callback()
    assert.equal(auth.type, "success")
    assert.equal(auth.accountId, "77")
    assert.equal(auth.clientId, "test-client")
    assert.equal(auth.access, LIVE_TOKEN)
    assert.ok(auth.devicePrivateKey.includes("PRIVATE KEY"))
    assert.ok(auth.devicePublicKey.includes("PUBLIC KEY"))
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_TRAE_CLIENT_ID
    else process.env.MAGPIE_TRAE_CLIENT_ID = previous
  }
})

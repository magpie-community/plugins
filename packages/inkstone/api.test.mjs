// The API-key side: the catalogue it reads, the models magpie lists for the
// account, the loader, and the sign-in methods. Everything runs against the
// local fake.
import "./nonet.mjs"
import { readFileSync } from "node:fs"
import { afterEach, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { fakeInkStone, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const META = JSON.parse(readFileSync(new URL("./testdata/public-models.json", import.meta.url), "utf8"))
const auth = { type: "oauth", access: "sk-test", apiKey: "sk-test", uaaToken: "uaa-token" }

async function plugin(options) {
  return InkStoneAuthPlugin({ client: { auth: { set: async () => {} } } }, options)
}

function serve(live = [{ id: "glm-5.3" }, { id: "Agents-A1" }, { id: "intern-decision-4b" }]) {
  f.route("GET /v1/models", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer sk-test")
    return json({ object: "list", data: live })
  })
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
}

test("config declares the provider with a working npm, base URL and bootstrap models", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const provider = cfg.provider["intern-inkstone"]
  expect(provider.name).toBe("书生·端砚")
  expect(provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(provider.api).toBe(f.origin + "/v1")
  expect(Object.keys(provider.models).length).toBeGreaterThan(0)
  expect(provider.models["glm-5.3"].limit.context).toBe(1048576)
})

test("the listing is the key's live set intersected with the public metadata", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  const models = await p.provider.models({ id: "intern-inkstone", models: {} }, { auth })
  expect(Object.keys(models).sort()).toEqual(["Agents-A1", "glm-5.3"])
  expect(models["glm-5.3"].limit.context).toBe(1048576)
  expect(models["glm-5.3"].reasoning).toBe(true)
  expect(models["Agents-A1"].capabilities.input.image).toBe(true)
  expect(models["glm-5.3"].variants).toBeUndefined()
  // the magpie-only price markers reach provider.models too
  expect(models["glm-5.3"].rate).toBe(8)
  expect(models["glm-5.3"].free).toBeUndefined()
  expect(models["Agents-A1"].free).toBe(true)
  expect(models["Agents-A1"].rate).toBeUndefined()
})

test("config's bootstrap models carry the free/rate markers too", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const models = cfg.provider["intern-inkstone"].models
  expect(models["Sage-A1.5"].free).toBe(true)
  expect(models["Sage-A1.5"].rate).toBeUndefined()
  expect(models["glm-5.3"].rate).toBe(8)
  expect(models["glm-5.3"].free).toBeUndefined()
})

test("an account with no API key advertises no models", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const noKey = { type: "oauth", access: "", uaaToken: "uaa-token" }
  expect(await p.provider.models({ id: "intern-inkstone", models: { "glm-5.3": {} } }, { auth: noKey })).toEqual({})
  expect(await p.auth.loader(async () => noKey)).toEqual({})
})

test("a key the platform refused lists nothing, not the bootstrap set", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ error: "unauthorized" }, 401))
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
  const p = await plugin()
  expect(await p.provider.models({ id: "intern-inkstone", models: { "glm-5.3": {} } }, { auth })).toEqual({})
})

test("a catalogue read that fails keeps the declared models", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ error: "boom" }, 500))
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
  const p = await plugin()
  const given = { "glm-5.3": {} }
  const got = await p.provider.models({ id: "intern-inkstone", models: given }, { auth })
  expect(got).toEqual(given)
})

test("an account with no auth yet still sees the bootstrap list", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const declared = cfg.provider["intern-inkstone"].models
  expect(await p.provider.models({ id: "intern-inkstone", models: {} }, {})).toEqual(declared)
})

test("the loader serves the models with the key at the platform's base URL", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  expect(loader.apiKey).toBe("sk-test")
  expect(loader.baseURL).toBe(f.origin + "/v1")
  // the loader hands the host a fetch: preflight, rewrite and error
  // translation ride on it (preflight.test.mjs covers the pieces; this is
  // the wiring)
  expect(typeof loader.fetch).toBe("function")
})

test("the loader's fetch prechecks images before anything leaves", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  let asked = 0
  f.route("POST /v1/chat/completions", () => (asked++, json({ ok: true })))
  // nine tiny images: refused locally, the platform never sees it
  const body = JSON.stringify({
    model: "Sage-A1.5",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }, ...Array.from({ length: 9 }, () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${tiny}` } }))] }],
  })
  const res = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body, headers: { "content-type": "application/json" } })
  expect(res.status).toBe(400)
  const said = await res.json()
  expect(said.error.message).toContain("extra inputs are not permitted")
  expect(asked).toBe(0)
  // eight pass through to the fake, rewritten with detail: auto
  const small = JSON.parse(body)
  small.messages[0].content.pop()
  const res2 = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify(small), headers: { "content-type": "application/json" } })
  expect(res2.status).toBe(200)
  expect(asked).toBe(1)
})

test("the loader's fetch translates the plan's image refusals for the host", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  // the plan answers a 400 invalid_media the host would misread: the fetch
  // hands the host a shape it asks the next member at instead
  f.route("POST /v1/chat/completions", () => json({ code: "invalid_media", message: "too many images in request" }, 400))
  const res = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(400)
  const said = await res.json()
  expect(said.error.message).toContain("extra inputs are not permitted")
  // 端砚原话不进响应体的任何字段（宿主 wordsOf 对整个 body 匹配，"exceeded"
  // 会误中 quotaWords）；只进日志
  expect(said.error.message).not.toContain("too many images in request")
  expect(said.body).toBeUndefined()
  expect(JSON.stringify(said)).not.toContain("too many images in request")
})

test("the loader's fetch leaves everything else alone", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  // a models GET and a 429 pass through untouched
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  const models = await loader.fetch(`${f.origin}/v1/models`)
  expect(models.status).toBe(200)
  f.route("POST /v1/chat/completions", () => json({ error: { code: "rate_limit_exceeded" } }, 429))
  const res = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(429)
})

test("the sign-in methods cover browser, API key, and API key + console token", async () => {
  // a machine with a Chromium browser, whatever the test machine has
  const p = await plugin({ browserCandidates: () => ["/opt/chromium/chrome"] })
  const labels = p.auth.methods.map((m) => m.label)
  expect(labels[0]).toContain("Browser sign-in")
  expect(labels[1]).toContain("API key only")
  expect(labels[2]).toContain("console token")
  // the browser method must not block the host's authorize call: the browser
  // work runs in its callback (the host's authorize deadline is short)
  const browser = p.auth.methods[0]
  const result = browser.authorize({})
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    // a displayless CI runner is refused up front, not left with a window it cannot open
    expect(result.type).toBe("failed")
    expect(result.error).toContain("needs a display")
  } else {
    expect(result.method).toBe("auto")
    expect(typeof result.callback).toBe("function")
    expect(result.instructions).toContain("Sign in there")
    expect(result.url).toBe("")
  }
  // the browser method's key prompt is optional; a non-sk- one is refused
  expect(browser.prompts[0].validate("")).toBeUndefined()
  expect(browser.prompts[0].validate("sk-abc")).toBeUndefined()
  expect(browser.prompts[0].validate("nope")).toContain("sk-")
})

test("with no Chromium browser the browser sign-in fails at authorize and names the other sign-ins (#825)", async () => {
  // a display is claimed so a displayless runner reaches the browser check
  const display = process.env.DISPLAY
  process.env.DISPLAY = display || ":99"
  try {
    const p = await plugin({ browserCandidates: () => [] })
    const result = p.auth.methods[0].authorize({})
    // never "opened" with instructions that say a window opens
    expect(result.type).toBe("failed")
    expect(result.opened).toBeUndefined()
    expect(result.callback).toBeUndefined()
    expect(result.error).toContain("Microsoft Edge, Google Chrome or Chromium")
    expect(result.error).toContain('"API key only"')
    expect(result.error).toContain('"API key + console token"')
    // the names it gives are the other methods' own labels
    expect(p.auth.methods[1].label).toStartWith("API key only")
    expect(p.auth.methods[2].label).toStartWith("API key + console token")
    if (process.platform === "darwin") expect(result.error).toContain("Safari can't be used")
    else expect(result.error).not.toContain("Safari")
  } finally {
    if (display === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = display
  }
})

test("the API-key + console-token method reads the token out of a pasted cookie", async () => {
  f = fakeInkStone()
  serve()
  f.route("GET /api/tokenplan/v1/users/validate", () => json({ code: 0, data: { name: "张三", phone: "12345678901" } }))
  const p = await plugin()
  const method = p.auth.methods[2]
  // a full cookie string must be reduced to just the uaa-token value
  const okResult = await method.authorize({
    apiKey: "sk-test",
    uaaToken: "sid=SESSIONSECRET; uaa-token=abc.def.ghi; other=1",
  })
  expect(okResult.type).toBe("success")
  expect(okResult.uaaToken).toBe("abc.def.ghi")
  expect(JSON.stringify(okResult)).not.toContain("SESSIONSECRET")
  // host save() stores {...inputs, ...result.metadata} under metadata (#826):
  // the result's metadata carries the parsed token, so the pasted cookie
  // string, with its other session cookies, is not what gets saved
  expect(okResult.metadata.uaaToken).toBe("abc.def.ghi")
  expect(okResult.metadata.apiKey).toBe("sk-test")
  // a bare token value is accepted as-is
  const bare = await method.authorize({ apiKey: "sk-test", uaaToken: "abc.def.ghi" })
  expect(bare.type).toBe("success")
  expect(bare.uaaToken).toBe("abc.def.ghi")
  // base64 padding at the end is still a bare token
  const padded = await method.authorize({ apiKey: "sk-test", uaaToken: "abc.def.gh==" })
  expect(padded.type).toBe("success")
  // a string without a uaa-token is refused, never stored verbatim
  for (const junk of ["sid=SESSIONSECRET", "Cookie: uaa-token=abc", "abc=def", "uaa-token", "abc def", "short"]) {
    const bad = await method.authorize({ apiKey: "sk-test", uaaToken: junk })
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("uaa-token")
  }
})

test("cleanDetail masks real uaa-token, sk-, Bearer and JWT runs", async () => {
  const { cleanDetail } = await import("./lib/protocol.mjs")
  expect(cleanDetail("failed: uaa-token=secretValue123456")).toBe("failed: ***")
  expect(cleanDetail("cookie: uaa_token: secretValue123456; other")).toBe("cookie: ***; other")
  expect(cleanDetail("auth header: Bearer opaqueToken123456")).toBe("auth header: ***")
  expect(cleanDetail("key is sk-12345678abcdef")).toBe("key is ***")
  expect(cleanDetail("jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig")).toBe("jwt: ***")
  // diagnostic words must stay
  expect(cleanDetail("error: token expired")).toBe("error: token expired")
})

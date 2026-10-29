import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { CatPawAuthPlugin, _internal } from "./index.mjs"
import { fakeCatPaw } from "./fake.mjs"
import capturedRound from "./testdata/captured-round.json"
import capturedTurn from "./testdata/captured-turn.json"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process. The upstream base is monkey-patched because
// CatPaw's is a module constant (the origin is fixed by the vendor).

let fake
let plugin
let saved = {}
let tmpDir
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeCatPaw()
  tmpDir = mkdtempSync(join(tmpdir(), "catpaw-auth-test-"))
  // point the desktop auth path at a fake auth.json
  const authPath = join(tmpDir, "auth.json")
  writeFileSync(authPath, JSON.stringify({ auth: { accessToken: fake.state.token }, account: { uid: "u1", name: "Tester" } }))
  process.env.CATPAW_AUTH_PATH = authPath
  // the credit balance is a separate host in the vendor; point it at the fake
  process.env.CATPAW_BALANCE_URL = `${fake.url}/api/gateway/credit/balance`
  // replace the origin with the fake server
  // the plugin reads ORIGIN at call time only inside gatewayHeaders/fetch, so
  // monkey-patching the global fetch to route to the fake works: we swap the
  // global fetch for one that rewrites the URL host to the fake server
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const patched = url.replace("https://ai.catpaw.meituan.com", fake.url).replace("https://catx.nocode.cn", fake.url)
    return realFetch(patched, init)
  }
  plugin = await CatPawAuthPlugin({ client })
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.token, expires: 0, source: "desktop", accountId: "Tester" }
})

describe("config", () => {
  test("lists the desktop client's models", async () => {
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider.catpaw.name).toBe("妙手 CatPaw")
    const ids = Object.keys(cfg.provider.catpaw.models)
    expect(ids).toContain("longcat-2.0")
    expect(ids).toContain("kimi-k3")
    expect(ids).toContain("glm-5.3-flash")
    // no modalities and no invented limit: the text-only conversation prompt
    // takes no images, and the client publishes no per-model windows
    expect(cfg.provider.catpaw.models["longcat-2.0"].modalities).toBeUndefined()
    expect(cfg.provider.catpaw.models["longcat-2.0"].limit).toBeUndefined()
  })
})

describe("sign-in methods", () => {
  test("reads the desktop client's auth.json live", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("桌面端"))
    expect(method).toBeTruthy()
    const flow = method.authorize()
    expect(flow.method).toBe("auto")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.token)
    expect(result.source).toBe("desktop")
    expect(result.uid).toBe("u1")
  })

  test("manual paste works through the host's authorize → callback contract", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ token: "pasted-token" })
    expect(flow.method).toBe("auto")
    expect(typeof flow.callback).toBe("function")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted-token")
    expect(await method.authorize({ token: "" })).toMatchObject({ type: "failed" })
  })

  test("web sign-in: login-config names the entry, poll-token hands the token once claimed", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    expect(method).toBeTruthy()
    const flow = await method.authorize()
    expect(flow.method).toBe("auto")
    expect(flow.url).toContain("state=")
    expect(flow.url).toContain("sid=")
    expect(flow.url).toContain("redirect=")
    // the sid is not claimed yet: arm it one poll in (the callback polls
    // every second, so the token appears on its second pass)
    const sid = new URL(flow.url).searchParams.get("sid")
    const cb = flow.callback()
    await new Promise((r) => setTimeout(r, 1200))
    fake.state.webSids.set(sid, "web-cat-token")
    const result = await cb
    expect(result.type).toBe("success")
    expect(result.access).toBe("web-cat-token")
    expect(result.source).toBe("web")
    expect(result.accountId).toBe("网页用户")
    expect(result.uid).toBe("42")
    expect(fake.state.pollCalls).toBeGreaterThanOrEqual(2)
    expect(fake.state.currentUserCalls).toBe(1)
  })
})

describe("chat", () => {
  test("round → event → turn, cumulative frames diffed to deltas", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // the deltas build up the answer
    expect(text).toContain('"content":"你"')
    expect(text).toContain('"content":"好"')
    expect(text).toContain('"content":"，"')
    expect(text).toContain('"content":"收到"')
    // reasoning is diffed too
    expect(text).toContain('"reasoning_content":"思"')
    expect(text).toContain('"reasoning_content":"考"')
    // the stream ends with stop + [DONE]
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    // the conversation machine ran all three steps in order
    expect(fake.state.rounds).toBe(1)
    expect(fake.state.events).toBe(1)
    expect(fake.state.turns).toBe(1)
    expect(fake.state.conversations[0].prompt).toBe("hi")
    expect(fake.state.conversations[0].modelType).toBe(77)
  })

  test("non-stream returns the full answer", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const answer = await res.json()
    expect(answer.model).toBe("kimi-k3")
    expect(answer.choices[0].message.content).toBe("你好，收到")
    expect(answer.choices[0].message.reasoning_content).toBe("思考")
    expect(answer.choices[0].finish_reason).toBe("stop")
    expect(fake.state.conversations[0].modelType).toBe(83)
  })

  test("multi-turn messages flatten into one prompt", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        stream: false,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      }),
    })
    expect(fake.state.conversations[0].prompt).toContain("[System Instructions]\nbe terse")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq1")
    expect(fake.state.conversations[0].prompt).toContain("[Assistant]\na1")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq2")
  })

  test("a single user message passes as-is", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "just this" }] }),
    })
    expect(fake.state.conversations[0].prompt).toBe("just this")
    expect(fake.state.conversations[0].modelType).toBe(0)
  })

  test("an SSE error frame surfaces as an error chunk", async () => {
    fake.state.turnError = "sse-error"
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await res.text()
    expect(text).toContain('"error"')
    expect(text).toContain("vendor broke")
  })

  test("a request carrying tools is refused with a clear 400", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain("cannot run tools")
  })

  test("a request carrying tool results is refused, images are refused", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const toolRes = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: "hi" }, { role: "tool", content: "result" }] }),
    })
    expect(toolRes.status).toBe(400)
    expect((await toolRes.json()).error.message).toContain("cannot continue a tool call")
    const imgRes = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: [{ type: "image", image_url: { url: "data:image/png;base64,AAAA" } }] }] }),
    })
    expect(imgRes.status).toBe(400)
    expect((await imgRes.json()).error.message).toContain("cannot take images")
  })

  test("the OpenAI image shapes (image_url, input_image) are refused too", async () => {
    const loader = await plugin.auth.loader(getAuth)
    for (const type of ["image_url", "input_image"]) {
      const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "longcat-2.0",
          messages: [{ role: "user", content: [{ type: "text", text: "看这张图" }, { type, image_url: { url: "https://example.com/x.png" } }] }],
        }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error.message).toContain("cannot take images")
    }
  })

  test("unknown model is rejected", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "not-a-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(400)
  })

  test("a web sign-in spends its own token, without any auth.json on the machine", async () => {
    // the desktop file moves away entirely: the web sign-in must not need it
    const was = process.env.CATPAW_AUTH_PATH
    process.env.CATPAW_AUTH_PATH = join(tmpDir, "absent-web-test.json")
    // sign in through the web flow itself: the sid is claimed, poll-token
    // hands out its token, and that account is what chats
    const webMethod = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    const flow = await webMethod.authorize()
    const sid = new URL(flow.url).searchParams.get("sid")
    fake.state.webSids.set(sid, "web-tok-1")
    const signedIn = await flow.callback()
    expect(signedIn.type).toBe("success")
    saved = { type: "oauth", access: signedIn.access, refresh: "", expires: 0, accountId: signedIn.accountId, name: signedIn.accountId, source: "web" }
    try {
      const loader = await plugin.auth.loader(getAuth)
      const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(res.status).toBe(200)
      // the request went out under the web account's token, not the
      // desktop file's, and the card shows the web account's name
      expect(fake.state.conversations[0].token).toBe("web-tok-1")
      // the conversation body fields are the client's captured protocol
      expect(fake.state.conversations[0].permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.error).toBeUndefined()
      expect(usage.user).toBe("网页用户")
      expect(usage.windows[0].display).toContain("credit")
    } finally {
      process.env.CATPAW_AUTH_PATH = was
    }
  })

  test("the desktop account and a web account never cross: A's request is not spent on B", async () => {
    // the desktop file holds the fake's own token; account A signed in on
    // the web with a different one — A's chat must carry A's token
    const webMethod = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    const flow = await webMethod.authorize()
    const sid = new URL(flow.url).searchParams.get("sid")
    fake.state.webSids.set(sid, "acct-A-token")
    const signedIn = await flow.callback()
    expect(signedIn.type).toBe("success")
    saved = { type: "oauth", access: signedIn.access, refresh: "", expires: 0, accountId: signedIn.accountId, name: signedIn.accountId, source: "web" }
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(fake.state.conversations[0].token).toBe("acct-A-token")
  })

  test("a refused token says 401", async () => {
    saved = { type: "oauth", access: "gone", expires: 0, source: "manual" }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(401)
    const answer = await res.json().catch(() => null)
    expect(answer?.error?.message ?? "").toMatch(/round 失败/)
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/embeddings", { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})

describe("usage", () => {
  // the credit endpoint takes `X-Auth-Token`, not the conversation gateway's
  // `Cookie: X-Passport-Token`: sending the cookie there answers 401 / code
  // 4010, which magpie reads as the sign-in having expired
  test("reads the credit balance with X-Auth-Token", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // a clean read says nothing about the sign-in: that absence is what lets
    // magpie clear a lapse (a "kept" here would leave the mark on forever)
    expect(usage.signIn).toBeUndefined()
    expect(usage.windows[0].display).toBe("1134.67 credit")
    expect(usage.plan).toBe("体验版")
    expect(fake.state.balanceCalls).toBe(1)
  })

  test("a refused token says the sign-in expired", async () => {
    saved = { type: "oauth", access: "not-the-token", expires: 0, source: "manual" }
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("expired")
    expect(usage.error).toContain("重新登录")
  })

  test("a missing desktop file is not the sign-in expiring", async () => {
    const was = process.env.CATPAW_AUTH_PATH
    process.env.CATPAW_AUTH_PATH = join(tmpDir, "absent.json")
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.signIn).toBe("kept")
      expect(usage.error).toContain("未找到妙手登录态文件")
    } finally {
      process.env.CATPAW_AUTH_PATH = was
    }
  })
})

describe("captured protocol", () => {
  test("gatewayHeaders matches the captured client headers key for key", () => {
    // _internal doesn't expose gatewayHeaders directly; build one through
    // the only place its shape is fully visible — reconstruct from source is
    // fragile, so compare against the exported header set instead
    const captured = capturedRound.headers
    const ours = _internal.gatewayHeadersForTest("tok")
    // every header the client sent, our request sends too — with the same
    // value where the value is a constant, and the same shape where it is
    // per-request random (the trace ids)
    // the base set (what gatewayHeaders returns) plus what fetch adds and
    // what the round route's extraHeaders carry — together they must cover
    // every header the client sent
    const roundExtras = { "m-spanid": "0.2", "m-spanname": "conversation.round" }
    const combined = { accept: "application/json, text/plain, */*", ...ours, ...roundExtras }
    for (const [key, value] of Object.entries(captured)) {
      const lower = key.toLowerCase()
      if (lower === "m-host") {
        // the client machine's LAN IP: deliberately not sent (see index.mjs)
        expect(ours).not.toHaveProperty("m-host")
        continue
      }
      if (["accept-encoding", "content-length"].includes(lower)) continue // transport-level
      const oursKey = Object.keys(combined).find((k) => k.toLowerCase() === lower)
      expect(oursKey, key).toBeTruthy()
      if (["m-traceid", "x-request-id", "x-trace-id"].includes(lower)) {
        expect(String(combined[key])).toMatch(/^[0-9a-f-]{32,36}$/)
      } else {
        expect(String(combined[oursKey]), key).toBe(String(value))
      }
    }
    expect(ours["m-traceid"]).toBe(ours["x-trace-id"])
  })

  test("the round body carries the captured protocol fields", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const sent = fake.state.conversations[0]
    expect(sent.permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
    // one client identity end to end: the body's source/mode are the same
    // captured request's values as the headers are
    expect(sent.source).toBe(capturedRound.bodyProtocol.source)
    expect(sent.mode).toBe(capturedRound.bodyProtocol.mode)
  })

  test("the captured turn request carries the same permissionMode", () => {
    expect(capturedTurn.bodyProtocol.permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
    expect(capturedRound.headers["user-agent"]).toBe(capturedTurn.headers["user-agent"])
  })
})

describe("helpers", () => {
  test("model type mapping", () => {
    expect(_internal.modelTypeOf("longcat-2.0")).toBe(77)
    expect(_internal.modelTypeOf("kimi-k3")).toBe(83)
    expect(_internal.modelTypeOf("unknown")).toBe(77)
  })
})

// yetone/magpie#969: a Go key whose plan wasn't known yet (billing/
// subscriptions slow or failing, no plan saved with the key) was sent to the
// Provider API, which refuses Go: "Your Go plan doesn't include API access.
// Upgrade to Provider or higher …". That refusal now says the key is Go's:
// the chat completion is asked again at /alpha/generate, and the plan is
// kept, in memory and with the key.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

// talking leaves out the decision model (Jev, jev.test.mjs), which every
// plan's list has beside the models it talks to
const talking = (ms) => {
  delete ms[_internal.JEV]
  return ms
}

const real = globalThis.fetch
const subWait = _internal.waits.subWait
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.waits.subWait = subWait
})

const REFUSAL = {
  error: {
    type: "forbidden",
    message: "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
  },
}
const finish = JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 1 } })

// a Go account Command Code's billing doesn't answer for, its plan unsaved
function setUp(provider = () => Response.json(REFUSAL, { status: 403 })) {
  const asked = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    asked.push(path)
    if (path === "/alpha/billing/subscriptions") return new Response("", { status: 503 })
    if (path.startsWith("/provider/")) return provider(path)
    if (path === "/alpha/generate") return new Response(JSON.stringify({ type: "text-delta", text: "hi" }) + "\n" + finish + "\n")
    return new Response("", { status: 404 })
  }
  _internal.waits.subWait = 10
  return asked
}

async function plugin(auth) {
  const saved = []
  const hooks = await CommandCodePlugin({ client: { auth: { set: async (a) => saved.push(a) } } })
  const opts = await hooks.auth.loader(async () => auth)
  return { hooks, opts, saved }
}

const chat = (opts, path = "/provider/v1/chat/completions") =>
  opts.fetch("https://api.commandcode.ai" + path, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
  })

test("a chat completion the Provider API refuses as Go's is answered at /alpha/generate", async () => {
  const asked = setUp()
  const { opts, saved } = await plugin({ type: "api", key: "go-key" })
  const res = await chat(opts)
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).choices[0].message.content).toBe("hi")
  expect(asked.filter((p) => p !== "/alpha/billing/subscriptions")).toEqual(["/provider/v1/chat/completions", "/alpha/generate"])
  // kept with the key, as usage keeps the plan it reads
  expect(saved.map((a) => a.body.metadata)).toEqual([{ plan: "Go" }])
})

test("once refused, the key's next requests go straight to /alpha/generate", async () => {
  const asked = setUp()
  const { opts } = await plugin({ type: "api", key: "go-key" })
  await chat(opts)
  asked.length = 0
  expect((await chat(opts)).status).toBe(200)
  expect(asked).toEqual(["/alpha/generate"])
})

test("the key's models are Go's after the refusal", async () => {
  setUp((path) => (path === "/provider/v1/models" ? new Response("", { status: 500 }) : Response.json(REFUSAL, { status: 403 })))
  const auth = { type: "api", key: "go-key" }
  const { hooks, opts } = await plugin(auth)
  await chat(opts)
  const ms = talking(await hooks.provider.models({ models: {} }, { auth }))
  expect(Object.keys(ms)).toEqual(_internal.GO_MODELS.filter((m) => !_internal.GO_REFUSED.has(m.id)).map((m) => m.id))
})

test("a refusal that isn't Go's goes on as it came", async () => {
  const asked = setUp(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }))
  const { opts, saved } = await plugin({ type: "api", key: "key" })
  const res = await chat(opts)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("Invalid API key")
  expect(asked).not.toContain("/alpha/generate")
  expect(saved).toEqual([])
})

test("Go's refusal of another endpoint goes on as it came, and the key is Go's from then", async () => {
  const asked = setUp()
  const { opts, saved } = await plugin({ type: "api", key: "go-key" })
  const res = await chat(opts, "/provider/v1/messages")
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toContain("Go plan doesn't include API access")
  expect(asked).not.toContain("/alpha/generate")
  expect(saved.map((a) => a.body.metadata)).toEqual([{ plan: "Go" }])
  asked.length = 0
  expect((await chat(opts)).status).toBe(200)
  expect(asked).toEqual(["/alpha/generate"])
})

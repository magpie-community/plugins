// Command Code's Jev (typesafe/jev), TypeSafe's System One: a decision
// model, which the CLI (command-code 1.88.2) asks at POST
// /provider/v1/systemone with {model, state, questions} and its usual
// headers, and which /provider/v1/models doesn't list (joeliu96872540 on
// X: magpie couldn't get it). The plugin says the provider decides, lists
// Jev marked as a decision model for every plan, and sends magpie's
// System One questions on as the CLI sends them.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
let zdr
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
  if (zdr === undefined) delete process.env.CMD_ZDR
  else process.env.CMD_ZDR = zdr
})
zdr = process.env.CMD_ZDR

// ANSWER is System One's answer as the CLI's schema has it (wR: model,
// answers by question, usage)
const ANSWER = { model: "typesafe/jev", answers: { ok: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 41, output_tokens: 3 } }
const QUESTION = {
  model: "typesafe/jev",
  state: { text: "ping" },
  questions: { ok: { type: "noul", instructions: "Is this a test?" } },
}

function record(reply = () => Response.json(ANSWER)) {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
    sent.push({ url, path, method: init.method, headers, body })
    if (path === "/provider/v1/systemone") return reply()
    if (path === "/provider/v1/models") return Response.json({ data: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" }] })
    if (path === "/alpha/billing/credits") return Response.json({ credits: {} })
    return new Response("", { status: 404 })
  }
  return sent
}

async function loader(plan = "Pro", magpie, client) {
  const hooks = await CommandCodePlugin({ magpie, client })
  return hooks.auth.loader(async () => ({ type: "api", key: "user-key", metadata: { plan } }))
}

// ask posts a System One question as magpie's AskSystemOne and gateway do:
// to the loader's fetch at its base's /systemone
const ask = (opts, q = QUESTION, headers = { "Content-Type": "application/json" }) =>
  opts.fetch("https://api.commandcode.ai/provider/v1/systemone", { method: "POST", headers, body: JSON.stringify(q) })

test("the provider says it decides, and its config lists Jev as a decision model", async () => {
  const hooks = await CommandCodePlugin()
  const config = {}
  await hooks.config(config)
  const p = config.provider["commandcode-plan"]
  expect(p.decide).toBe(true)
  expect(p.models["typesafe/jev"]).toMatchObject({ name: "Jev", decides: true, tool_call: false })
  // the chat models aren't marked
  expect(p.models["claude-sonnet-5"].decides).toBeUndefined()
})

test("every plan's list has Jev, marked, though Command Code's list doesn't name it", async () => {
  record()
  const hooks = await CommandCodePlugin()
  const config = {}
  await hooks.config(config)
  const provider = { models: config.provider["commandcode-plan"].models }
  for (const plan of ["Pro", "GOAT", "Max", "Go"]) {
    _internal.subsSeen.clear()
    const out = await hooks.provider.models(provider, { auth: { type: "api", key: "k-" + plan, metadata: { plan } } })
    expect(out["typesafe/jev"]?.decides).toBe(true)
    expect(out["typesafe/jev"].name).toBe("Jev")
    // nothing else is marked
    expect(Object.values(out).filter((m) => m.decides).map((m) => m.id)).toEqual(["typesafe/jev"])
  }
  // the list can't be had: the default list stands in, Jev with it
  globalThis.fetch = async () => new Response("", { status: 503 })
  const out = await hooks.provider.models(provider, { auth: { type: "api", key: "k", metadata: { plan: "Pro" } } })
  expect(out["typesafe/jev"]).toBeDefined()
})

test("a question goes to /provider/v1/systemone as the CLI asks it, and its answer comes back as it came", async () => {
  const sent = record()
  const opts = await loader()
  const res = await ask(opts, QUESTION, {
    "Content-Type": "application/json",
    "x-magpie-work-dir": encodeURIComponent("/Users/me/shop"),
    "x-magpie-work-git": "yes",
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(ANSWER)
  expect(sent).toHaveLength(1)
  const s = sent[0]
  expect(s.url).toBe("https://api.commandcode.ai/provider/v1/systemone")
  expect(s.method).toBe("POST")
  expect(JSON.parse(s.body)).toEqual(QUESTION)
  // the CLI's buildCommandAuthHeaders, and nothing else
  expect(Object.fromEntries(s.headers)).toEqual({
    "content-type": "application/json",
    "user-agent": "cli",
    "x-command-code-version": "1.88.2",
    "x-cli-environment": "production",
    "x-project-slug": "shop",
    "x-taste-learning": "false",
    "x-session-id": s.headers.get("x-session-id"),
    authorization: "Bearer user-key",
  })
  expect(s.headers.get("x-session-id")).toMatch(/^[0-9a-f-]{36}$/)
  expect([s.url, ...[...s.headers].flat(), s.body].join("\n")).not.toMatch(/magpie/i)
})

test("Jev's other names go as the CLI names it", async () => {
  for (const name of ["jev", "jev-latest", "typesafe-ai/jev", "typesafe/jev"]) {
    const sent = record()
    await ask(await loader(), { ...QUESTION, model: name })
    expect(JSON.parse(sent[0].body).model).toBe("typesafe/jev")
  }
})

test("Zero Data Retention asks System One for it too", async () => {
  const sent = record()
  const magpie = { option: (p, k) => p === "commandcode-plan" && k === "zdr" }
  await ask(await loader("Pro", magpie))
  expect(sent[0].headers.get("x-cmd-zdr")).toBe("1")
  delete process.env.CMD_ZDR
  const plain = record()
  await ask(await loader())
  expect(plain[0].headers.get("x-cmd-zdr")).toBeNull()
})

test("a refusal is said as the chat's are, the account kept", async () => {
  record(() => new Response('{"error":{"message":"MODEL_NOT_IN_PLAN: Jev available in Provider and above plans"}}', { status: 400 }))
  const res = await ask(await loader())
  expect(res.status).toBe(403)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("Model not in plan: Jev available in Provider and above plans")
})

test("a Go key refused the Provider API is kept as Go's", async () => {
  record(() => new Response('{"error":{"message":"Your Go plan doesn\'t include API access. Upgrade to Provider or higher."}}', { status: 403 }))
  const saved = []
  const res = await ask(await loader("", undefined, { auth: { set: async (x) => saved.push(x) } }))
  expect(res.status).toBe(403)
  expect(_internal.subsSeen.get("user-key")?.sub?.plan).toBe("Go")
  expect(saved[0]?.body?.metadata?.plan).toBe("Go")
})

test("a question that isn't JSON is refused here, nothing sent", async () => {
  const sent = record()
  const opts = await loader()
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/systemone", { method: "POST", body: "is this a test?" })
  expect(res.status).toBe(400)
  expect(sent).toHaveLength(0)
})

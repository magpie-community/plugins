// @a1pha1nthefog on X (2026-11-20): dsh (DeepSeek Harness) on Factory's
// Opus 5.5 still got content_policy_rejected on 0.1.52, on the first turn of
// a fresh session. 0.1.51 had already sent the request again with every tool
// renamed and been refused again, so it is the request's content. dsh opens
// its prompt with its own identity line (dsh-system-prompt's
// harness:identity section) and its preset's model line, the class of pi's
// and omp's openings Factory refuses. The fixture is dsh 0.2.1-rc.2's own
// first request (testdata/dsh-0.2.1-chat.json).
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE, harnessText } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages"
const dsh = JSON.parse(await Bun.file(new URL("./testdata/dsh-0.2.1-chat.json", import.meta.url)).text())
const PROMPT = dsh.messages[0].content
const OPENING = "You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the factory/claude-opus-5-5 model.\n\n"
const ADAPTED = "You are an AI agent.\n\nCurrent model: factory/claude-opus-5-5.\n\n" + harnessText(PROMPT.slice(OPENING.length))

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

test("the fixture opens as dsh's prompt does", () => {
  expect(PROMPT.startsWith(OPENING)).toBe(true)
})

test("dsh's identity and model lines go plain on chat completions, the rest of its request as dsh wrote it", async () => {
  const send = await loaded()
  const b = await send(chat, { ...dsh, model: "glm-5.3" })
  const text = JSON.stringify(b)
  expect(text).not.toContain("DeepSeek Harness")
  expect(text).not.toContain("DeepSeek Runtime")
  expect(text).not.toContain("You are a coding agent powered by")
  expect(b.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\n" + ADAPTED })
  expect(b.messages.slice(1)).toEqual(dsh.messages.slice(1))
})

test("dsh's prompt is adapted in Messages' system and Responses' instructions", async () => {
  const send = await loaded()
  const m = await send(messages, { model: "claude-opus-5-5", max_tokens: 64, system: PROMPT, messages: dsh.messages.slice(1).map((x) => ({ role: x.role, content: x.content })) })
  expect(JSON.stringify(m.system)).not.toContain("DeepSeek Harness")
  expect(m.system.map((s) => s.text)).toEqual([DROID_LINE, ADAPTED])
  expect(m.messages.map((x) => x.content)).toEqual(dsh.messages.slice(1).map((x) => x.content))
  const r = await send(responses, { model: "gpt-6.1", instructions: PROMPT, input: [{ role: "user", content: "1" }] })
  expect(r.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
})

test("only the lines at a line's start change: the user's own words and a quote mid-line stay", async () => {
  const send = await loaded()
  const own = "Explain: You are an AI agent powered by DeepSeek Harness. and You are a coding agent powered by the x model."
  const b = await send(chat, { model: "glm-5.3", messages: [{ role: "system", content: "Keep this. " + own }, { role: "user", content: "You are an AI agent powered by DeepSeek Harness." }] })
  expect(b.messages[0].content).toBe(DROID_LINE + "\n" + harnessText("Keep this. " + own))
  expect(b.messages[1].content).toBe("You are an AI agent powered by DeepSeek Harness.")
})

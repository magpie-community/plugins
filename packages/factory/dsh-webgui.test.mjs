// @a1pha1nthefog on X (2026-11-20): dsh (DeepSeek Harness) on Factory's
// Opus 5.5 was still content_policy_rejected on 0.1.53, before any output,
// with the Web GUI notes in its system prompt and a 174-skill catalog in a
// user turn. The browser sentence of dsh's Web GUI paragraph is a line
// Antigravity turned away as dsh's (agy-cli 0.1.88); it goes with "gives"
// for "provides". dsh's skill catalog is client metadata like a tool's
// description, so "harness" in it reads "runtime". The prompt is dsh
// 0.2.2-rc.3's real Web GUI system prompt (testdata, from agy-cli's test).
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE, harnessText } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages"
const WEB = await Bun.file(new URL("./testdata/dsh-0.2.2-rc.3-web-system.txt", import.meta.url)).text()
const BROWSER = "The browser provides no implicit DOM, route, or screenshot context."
const GIVES = "The browser gives no implicit DOM, route, or screenshot context."

// dsh-tool-skill 0.2.2-rc.5's renderCatalogMessage, with two entries
const catalog = (head) =>
  [
    "<system-reminder>",
    head,
    "",
    "<available_skills>",
    "- `dsh-ops`: Operate the DeepSeek Harness checkout and its agent harness tools.",
    "- `release`: Tag and publish a release.",
    "</available_skills>",
    "",
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
    "</system-reminder>",
  ].join("\n")
const FIRST = catalog("A skill is a reusable set of task-specific instructions. The following skills are available in this session:")
const CHANGED = catalog("The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:")

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

test("the fixture is dsh's Web GUI prompt, browser sentence and all", () => {
  expect(WEB).toContain("You are interacting with the user through the DeepSeek Harness Web GUI")
  expect(WEB.split(BROWSER).length).toBe(2)
})

test("the Web GUI's browser sentence goes with gives, in Messages, chat and Responses, the rest of its paragraph as written", async () => {
  const send = await loaded()
  const m = await send(messages, { model: "claude-opus-5-5", max_tokens: 64, system: WEB, messages: [{ role: "user", content: "1" }] })
  const system = m.system.map((s) => s.text).join("\n")
  expect(system).not.toContain(BROWSER)
  expect(system).toContain(GIVES)
  // only that word of the paragraph changes, beside 0.1.53's and 0.1.52's rewordings
  const para = (t) => t.slice(t.indexOf("You are interacting with the user"))
  expect(para(system)).toBe(harnessText(para(WEB)).replace(BROWSER, GIVES))
  const b = await send(chat, { model: "glm-5.3", messages: [{ role: "system", content: WEB }, { role: "user", content: "1" }] })
  expect(b.messages[0].content).not.toContain(BROWSER)
  expect(b.messages[0].content.startsWith(DROID_LINE + "\n")).toBe(true)
  const r = await send(responses, { model: "gpt-6.1", instructions: WEB, input: [{ role: "user", content: "1" }] })
  expect(r.instructions).toContain(GIVES)
  expect(r.instructions).not.toContain(BROWSER)
})

test("the user's own words quoting the sentence stay", async () => {
  const send = await loaded()
  const b = await send(chat, { model: "glm-5.3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Why does it say: " + BROWSER }] })
  expect(b.messages[1].content).toBe("Why does it say: " + BROWSER)
})

test("dsh's skill catalog in a user turn says runtime for harness, first or changed, on every route", async () => {
  const send = await loaded()
  for (const block of [FIRST, CHANGED]) {
    const want = block.replace("DeepSeek Harness checkout and its agent harness tools", "DeepSeek Runtime checkout and its agent runtime tools")
    const m = await send(messages, { model: "claude-opus-5-5", max_tokens: 64, system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: block }, { type: "text", text: "1" }] }] })
    expect(m.messages[0].content[0].text).toBe(want)
    expect(m.messages[0].content[1].text).toBe("1")
    const b = await send(chat, { model: "glm-5.3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: block }, { role: "user", content: "1" }] })
    expect(b.messages[1].content).toBe(want)
    const r = await send(responses, { model: "gpt-6.1", instructions: "Be brief.", input: [{ role: "user", content: [{ type: "input_text", text: block }] }] })
    expect(r.input[0].content[0].text).toBe(want)
  }
})

test("harness in the user's own words stays, beside a catalog joined to them as one text", async () => {
  const send = await loaded()
  // magpie can join a reminder block and the user's words into one string,
  // so the block is adapted as the block it was and the words after it kept
  const joined = FIRST + "\nwhy is the harness listed?"
  const typed = "Explain:\n" + FIRST.replace("</system-reminder>", "")
  const b = await send(chat, { model: "glm-5.3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Our test harness broke." }, { role: "user", content: joined }, { role: "user", content: typed }] })
  expect(b.messages[1].content).toBe("Our test harness broke.")
  expect(b.messages[2].content).toBe(FIRST.replace("DeepSeek Harness checkout and its agent harness tools", "DeepSeek Runtime checkout and its agent runtime tools") + "\nwhy is the harness listed?")
  expect(b.messages[3].content).toBe(typed)
})

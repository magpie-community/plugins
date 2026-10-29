import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => { throw new Error("credential writes disabled") } } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

// ZCode restores a file read from before compaction as one reminder carrying
// both the read arguments and the file's text. Factory refuses the fixed
// "Called the Read tool with the following input:" opening, which the
// arguments-only reminder never carries.
const args = { file_path: "/tmp/project/docs/notes.md" }
const body = "# Notes\n\nKeep these instructions.\n"
const restored = "<system-reminder>\nCalled the Read tool with the following input: " + JSON.stringify(args) + "\nResult of calling the Read tool:\n" + body + "</system-reminder>"
const renamed = "<system-reminder>\nPreviously read file with these arguments: " + JSON.stringify(args) + "\nResult of calling the Read tool:\n" + body + "</system-reminder>"

test("Messages: renames ZCode's restored-read opening and keeps the arguments and file text", async () => {
  const { l, seen } = await loaded()
  const request = { model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: restored }] }] }
  const url = "https://api.factory.ai/api/llm/a/v1/messages"
  await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.messages[0].content[0].text).toBe(renamed)
  const once = seen[0].body
  await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: once })
  expect(seen[1].body).toBe(once)
})

test("Chat: renames a restored-read reminder inside a joined user turn", () => {
  const path = "/api/llm/o/v1/chat/completions"
  const message = "Continue.\n\n" + restored
  const out = JSON.parse(_internal.droidBody(path, JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: message }], max_tokens: 32 })))
  // droidChat opens the request with its own line, so the user turn follows it.
  expect(out.messages[0].content).toBe(_internal.DROID_LINE)
  expect(out.messages[1].content).toBe("Continue.\n\n" + renamed)
})

test("encodes a refused client phrase quoted inside the restored file text", () => {
  const path = "/api/llm/o/v1/responses"
  const quoted = body + "Note: You have been invoked in the following environment:\n- Platform: darwin\n"
  const input = "<system-reminder>\nCalled the Read tool with the following input: " + JSON.stringify(args) + "\nResult of calling the Read tool:\n" + quoted + "</system-reminder>"
  const out = JSON.parse(_internal.droidBody(path, JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: [{ type: "input_text", text: input }] }] })))
  const text = out.input[0].content[0].text
  expect(text).not.toContain("Called the Read tool with the following input:")
  expect(text).toContain("Previously read file with these arguments: " + JSON.stringify(args))
  expect(text).toContain("Tool output encoded as a JSON string")
  expect(text).toContain(args.file_path)
})

test("leaves a plain read result, a non-read argument, and quoted copies alone", () => {
  const path = "/api/llm/o/v1/responses"
  const inputs = [
    // A read result without a read call in front stays a read result.
    "<system-reminder>\nResult of calling the Read tool:\n1\t# Notes\n</system-reminder>",
    // The opening line, but no result body: not this shape.
    "<system-reminder>\nCalled the Read tool with the following input: " + JSON.stringify(args) + "\n</system-reminder>\nTrailing text.",
    // Arguments that are not a read call.
    "<system-reminder>\nCalled the Read tool with the following input: {}\nResult of calling the Read tool:\n" + body + "</system-reminder>",
    // The phrase quoted inside a larger text is left as it is.
    "Here is what it looked like:\n\n" + restored,
  ]
  for (const text of inputs) {
    const out = JSON.parse(_internal.droidBody(path, JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: [{ type: "input_text", text }] }] })))
    expect(out.input[0].content[0].text).toBe(text)
  }
})

test("still renames Claude Code's arguments-only reminder", () => {
  const path = "/api/llm/o/v1/responses"
  const input = "<system-reminder>\nCalled the Read tool with the following input: " + JSON.stringify(args) + "\n</system-reminder>"
  const out = JSON.parse(_internal.droidBody(path, JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: [{ type: "input_text", text: input }] }] })))
  expect(out.input[0].content[0].text).toBe("<system-reminder>\nPreviously read file with these arguments: " + JSON.stringify(args) + "\n</system-reminder>")
})

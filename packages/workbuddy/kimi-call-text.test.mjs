// Kimi K3.1 Pro refuses an assistant turn with tool_calls and no text
// (Gloria335056 on X: 400 "Invalid request parameters" from dsh on
// kimi-k3.1-pro alone; plugins #1213 measured the same model on QwenWork,
// where one space is served). The history is dsh 0.2.1's second request,
// after its read call, as it reached magpie's gateway.
import { expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const { callText } = _internal

const call = { id: "read_0_a4137ac1", type: "function", function: { name: "read", arguments: '{"file_path":"a.txt"}' } }
const history = (content) => [
  { role: "system", content: "You are DeepSeek Harness." },
  { role: "user", content: "Read the file a.txt with your file tool and tell me its content." },
  { role: "assistant", content, reasoning_content: "Simple task: read a.txt.", tool_calls: [call] },
  { role: "tool", content: "<path>a.txt</path>\n<content>\n1: hello\n</content>", tool_call_id: "read_0_a4137ac1" },
]

async function upstream(plugin, url, model, messages) {
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (u, init) => {
    if (String(u).includes("/chat/completions")) sent.push(JSON.parse(unz(init.body)))
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const hooks = await plugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const res = await loader.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true, max_completion_tokens: 32000, messages }) })
    expect(res.status).toBe(200)
  } finally {
    globalThis.fetch = realFetch
  }
  expect(sent.length).toBe(1)
  return sent[0].messages
}

const AI = [WorkBuddyAIAuthPlugin, "https://www.workbuddy.ai/v2/chat/completions"]
const CN = [WorkBuddyAuthPlugin, "https://copilot.tencent.com/v2/chat/completions"]

for (const [name, [plugin, url]] of Object.entries({ "workbuddy-ai": AI, workbuddy: CN })) {
  for (const model of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
    test(`${name} ${model}: dsh's call-only turn (content null) goes with one space`, async () => {
      const m = await upstream(plugin, url, model, history(null))
      const a = m.find((x) => x.role === "assistant")
      expect(a.content).toBe(" ")
      expect(a.tool_calls).toEqual([call])
      expect(a.reasoning).toBe("Simple task: read a.txt.")
    })
  }
}

test("an empty string or empty text parts get the space too", () => {
  for (const content of ["", [], [{ type: "text", text: "" }]]) {
    const b = { model: "kimi-k3.1-pro", messages: history(content) }
    expect(callText(b)).toBe(true)
    expect(b.messages[2].content).toBe(" ")
  }
})

test("a call-only turn with text, and a turn with no call, go as they came", () => {
  const b = { model: "kimi-k3.1-pro", messages: [...history("Reading it."), { role: "assistant", content: "" }] }
  expect(callText(b)).toBe(false)
  expect(b.messages[2].content).toBe("Reading it.")
  expect(b.messages[4].content).toBe("")
})

test("other models keep the empty turn: kimi-k3 took it on www.workbuddy.ai", async () => {
  for (const model of ["kimi-k3", "kimi-k3-1", "kimi-k2.6", "deepseek-v4.1-flash", "glm-5.3"]) {
    const m = await upstream(...AI, model, history(null))
    expect(m.find((x) => x.role === "assistant").content).toBeNull()
  }
})

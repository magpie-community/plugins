// Runs the hooks the way magpie's gateway calls them — onRequest as a
// request comes in, onResponse with the finished reply — against channels
// faked with fetch: no network, no account.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { onRequest, onResponse, reset, settled, options } from "./notify.hooks.mjs"
import { opensTurn, ending, hasTools } from "./turn.mjs"
import { send, usable } from "./channels.mjs"

const realFetch = globalThis.fetch
let calls = []
let answer = () => Response.json({ ok: true })
let clock = 1_000_000

beforeEach(() => {
  calls = []
  answer = () => Response.json({ ok: true })
  clock = 1_000_000
  reset(() => clock)
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body })
    return answer(String(url), init)
  }
})
afterEach(() => { globalThis.fetch = realFetch })

const ntfy = { type: "ntfy", topic: "t-123" }
const ctx = (protocol, extra = {}) => ({
  protocol, agent: "claude", session: "sess-1", cwd: "/home/ted/code/magpie-plugins", origin: "local",
  model: "claude-opus", state: {}, ...extra,
  options: { channels: [ntfy], ...(extra.options ?? {}) },
})
const minutes = (n) => { clock += n * 60_000 }

// one request/reply pair, each with a context of its own as the gateway gives
async function exchange(protocol, body, reply, extra = {}) {
  const c = ctx(protocol, extra)
  onRequest(body, c)
  const reports = []
  c.report = (code) => reports.push(code)
  onResponse(reply, c)
  await settled()
  return reports
}

// ---- Anthropic Messages (Claude Code) ----
const tools = [{ name: "Bash", input_schema: { type: "object" } }]
const aUser = { model: "m", tools, messages: [{ role: "user", content: "fix the test" }] }
const aToolUse = { type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }
const aResult = { model: "m", tools, messages: [...aUser.messages, { role: "assistant", content: aToolUse.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }
const aFinal = { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "All tests pass now." }] }

test("a long Claude Code turn is pushed once, when the model stops asking for tools", async () => {
  expect(await exchange("anthropic", aUser, aToolUse)).toEqual(["skipped"])
  minutes(4)
  expect(await exchange("anthropic", aResult, aToolUse)).toEqual(["skipped"])
  minutes(2)
  expect(await exchange("anthropic", aResult, aFinal)).toEqual(["ready"])
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://ntfy.sh")
  const sent = JSON.parse(calls[0].body)
  expect(sent.topic).toBe("t-123")
  expect(sent.title).toBe("✅ Claude Code done · magpie-plugins")
  expect(sent.message).toContain("took 6 min")
  expect(sent.message).toContain("Model: claude-opus")
  expect(sent.message).not.toContain("All tests pass") // text is opt-in
})

test("a short turn sends nothing", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(1)
  expect(await exchange("anthropic", aResult, aFinal)).toEqual(["skipped"])
  expect(calls).toHaveLength(0)
})

test("a new user message restarts the turn's clock", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(10)
  await exchange("anthropic", aUser, aToolUse) // the user interrupted and asked again
  minutes(1)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(0)
})

test("side calls without tools neither open nor close a turn", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(5)
  const title = { model: "haiku", messages: [{ role: "user", content: "title this" }] }
  expect(await exchange("anthropic", title, aFinal)).toEqual([])
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(1)
})

test("a failed request ends the turn with a failure push, unless errors is off", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(5)
  await exchange("anthropic", aResult, null, { success: false })
  expect(JSON.parse(calls[0].body).title).toStartWith("❌ Claude Code failed")
  calls = []
  await exchange("anthropic", aUser, aToolUse, { options: { errors: false } })
  minutes(5)
  await exchange("anthropic", aResult, null, { success: false, options: { errors: false } })
  expect(calls).toHaveLength(0)
})

test("includeText adds the reply, cut to maxTextLength; lang zh", async () => {
  const o = { includeText: true, maxTextLength: 10, lang: "zh" }
  await exchange("anthropic", aUser, aToolUse, { options: o })
  minutes(3)
  await exchange("anthropic", aResult, aFinal, { options: o })
  const sent = JSON.parse(calls[0].body)
  expect(sent.title).toBe("✅ Claude Code 完成 · magpie-plugins")
  expect(sent.message).toContain("用时 3 分钟")
  expect(sent.message).toContain("All tests …")
})

test("cooldown: two turns closing within it send one push", async () => {
  await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0, cooldownSeconds: 60 } })
  await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0, cooldownSeconds: 60 } })
  expect(calls).toHaveLength(1)
})

test("other gateways' keys and agents off the list are left alone", async () => {
  await exchange("anthropic", aUser, aFinal, { origin: "team-key", options: { minMinutes: 0 } })
  await exchange("anthropic", aUser, aFinal, { session: "s2", options: { minMinutes: 0, agents: ["codex"] } })
  expect(calls).toHaveLength(0)
  await exchange("anthropic", aUser, aFinal, { session: "s3", origin: "team-key", options: { minMinutes: 0, allOrigins: true } })
  expect(calls).toHaveLength(1)
})

test("no channel, no work", async () => {
  const c = ctx("anthropic", { options: { channels: [] } })
  onRequest(aUser, c)
  expect(c.state.notify).toBeUndefined()
})

test("a channel that answers an error code is reported unavailable", async () => {
  answer = () => Response.json({ errcode: 310000, errmsg: "sign not match" })
  const r = await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0, channels: [{ type: "dingtalk", webhook: "https://oapi.dingtalk.com/robot/send?access_token=x" }] } })
  expect(r).toEqual(["unavailable"])
})

test("a thrown fetch never reaches the request", async () => {
  answer = () => { throw new Error("offline") }
  const r = await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0 } })
  expect(r).toEqual(["unavailable"])
})

// ---- the other APIs ----
test("Responses (Codex): function calls keep the turn open, a message closes it", () => {
  const body = { tools: [{ type: "function", name: "shell" }], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }
  expect(opensTurn(body, "responses")).toBe(true)
  expect(opensTurn({ ...body, input: [...body.input, { type: "function_call_output", call_id: "c", output: "x" }] }, "responses")).toBe(false)
  expect(opensTurn({ input: "hi" }, "responses")).toBe(true)
  expect(ending({ status: "completed", output: [{ type: "function_call", name: "shell" }] }, "responses").done).toBe(false)
  expect(ending({ status: "completed", output: [{ type: "local_shell_call" }] }, "responses").done).toBe(false)
  expect(ending({ status: "incomplete", output: [] }, "responses").done).toBe(false)
  expect(ending({ status: "completed", output: [{ type: "reasoning" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] }, "responses")).toEqual({ done: true, text: "done" })
})

test("Chat completions", () => {
  expect(opensTurn({ messages: [{ role: "user", content: "x" }] }, "chat")).toBe(true)
  expect(opensTurn({ messages: [{ role: "tool", content: "x" }] }, "chat")).toBe(false)
  expect(ending({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }] }, "chat").done).toBe(false)
  expect(ending({ choices: [{ finish_reason: "length", message: { content: "x" } }] }, "chat").done).toBe(false)
  expect(ending({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }, "chat")).toEqual({ done: true, text: "ok" })
  expect(ending({ error: { message: "x" } }, "chat").done).toBe(false)
})

test("Gemini", () => {
  expect(hasTools({ tools: [{ functionDeclarations: [{ name: "a" }] }] }, "gemini")).toBe(true)
  expect(hasTools({ tools: [{}] }, "gemini")).toBe(false)
  expect(opensTurn({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, "gemini")).toBe(true)
  expect(opensTurn({ contents: [{ role: "user", parts: [{ functionResponse: { name: "a" } }] }] }, "gemini")).toBe(false)
  expect(ending({ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "a" } }] } }] }, "gemini").done).toBe(false)
  expect(ending({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hm", thought: true }, { text: "ok" }] } }] }, "gemini")).toEqual({ done: true, text: "ok" })
})

test("Anthropic: max_tokens and server tools keep the turn open", () => {
  expect(ending({ stop_reason: "max_tokens", content: [{ type: "text", text: "x" }] }, "anthropic").done).toBe(false)
  expect(ending({ stop_reason: "end_turn", content: [{ type: "server_tool_use" }] }, "anthropic").done).toBe(false)
  expect(opensTurn({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, "anthropic")).toBe(true)
})

// ---- channels ----
const m = { title: "T", body: "B", ok: true, event: { kind: "done" } }

test("each channel posts where and what its service documents", async () => {
  await send({ type: "ntfy", topic: "x", server: "https://ntfy.example.com/", token: "tk" }, m)
  expect(calls.at(-1).url).toBe("https://ntfy.example.com")
  expect(calls.at(-1).init.headers.authorization).toBe("Bearer tk")

  await send({ type: "bark", key: "K" }, m)
  expect(calls.at(-1).url).toBe("https://api.day.app/push")
  expect(JSON.parse(calls.at(-1).body)).toMatchObject({ device_key: "K", title: "T", body: "B", group: "magpie" })

  await send({ type: "serverchan", key: "SCT123abc" }, m)
  expect(calls.at(-1).url).toBe("https://sctapi.ftqq.com/SCT123abc.send")
  expect(calls.at(-1).body).toBe("title=T&desp=B")
  await send({ type: "serverchan", key: "sctp42tXYZ" }, m)
  expect(calls.at(-1).url).toBe("https://42.push.ft07.com/send/sctp42tXYZ.send")

  await send({ type: "wecom", webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k" }, m)
  expect(JSON.parse(calls.at(-1).body)).toEqual({ msgtype: "text", text: { content: "T\nB" } })

  await send({ type: "telegram", token: "123:abc", chatId: 42 }, m)
  expect(calls.at(-1).url).toBe("https://api.telegram.org/bot123:abc/sendMessage")
  expect(JSON.parse(calls.at(-1).body)).toMatchObject({ chat_id: 42, text: "T\nB" })

  await send({ type: "webhook", url: "https://hooks.example.com/x", headers: { "x-k": "v" } }, m)
  expect(calls.at(-1).init.headers["x-k"]).toBe("v")
  expect(JSON.parse(calls.at(-1).body)).toEqual({ title: "T", body: "B", event: { kind: "done" } })
})

test("Feishu and DingTalk sign with the robot's secret", async () => {
  await send({ type: "feishu", webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x", secret: "s3" }, m)
  const f = JSON.parse(calls.at(-1).body)
  expect(f.msg_type).toBe("text")
  expect(f.sign).toBe(createHmac("sha256", `${f.timestamp}\ns3`).update("").digest("base64"))

  await send({ type: "dingtalk", webhook: "https://oapi.dingtalk.com/robot/send?access_token=x", secret: "SEC" }, m)
  const u = new URL(calls.at(-1).url)
  const ts = u.searchParams.get("timestamp")
  expect(u.searchParams.get("sign")).toBe(createHmac("sha256", "SEC").update(`${ts}\nSEC`).digest("base64"))
})

test("a channel missing what it needs is dropped from the options", () => {
  expect(usable({ type: "ntfy" })).toBe(false)
  expect(usable({ type: "telegram", token: "x" })).toBe(false)
  expect(usable({ type: "nope", url: "x" })).toBe(false)
  expect(usable({ type: "bark", key: "k", off: true })).toBe(false)
  expect(options({ channels: [{ type: "ntfy" }, ntfy] }).channels).toEqual([ntfy])
  expect(options({ channels: ntfy, agents: "claude, codex" }).agents).toEqual(["claude", "codex"])
})

test("Bark's success answer (code 200) is a success", async () => {
  answer = () => Response.json({ code: 200, message: "success" })
  expect((await send({ type: "bark", key: "K" }, m)).ok).toBe(true)
})

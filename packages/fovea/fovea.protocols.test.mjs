// One request per client protocol magpie's gateway serves (ctx.protocol:
// anthropic, chat, responses, gemini), each carrying the block and item
// types real clients send beyond the common ones: server tools, redacted
// thinking, citations, search results, legacy functions, reasoning_details,
// audio and files, custom and computer tools, item references, Gemini
// thought signatures and function responses.
//
// The window is set so every old item is in reach (cut_step 1, two kept):
// these check what fovea does to each kind of item, and what it must leave
// alone. fovea.probe.test.mjs checks the same contracts over whole sessions
// with the shipped defaults.
//
// Caching, per protocol: Anthropic's breakpoints are cache_control objects
// on blocks (their place and ttl are the agent's); Chat and Responses cache
// on the prefix by themselves and are steered by top-level fields
// (prompt_cache_key, prompt_cache_retention, previous_response_id); Gemini
// by cachedContent. So every top-level field stays byte-identical, and
// every cache_control stays where it was, with its value.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { onRequest } from "./fovea.middleware.js"

const DEFAULTS = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).magpie.options
const EDGE = { ...DEFAULTS, threshold: 0, keep_recent: 2, keep_recent_tokens: 0, cut_step: 1 }
const MODES = ["off", "always"]

const json = (v) => JSON.stringify(v)
const same = (a, b) => expect(json(a)).toBe(json(b))
const send = (body, options) => onRequest(structuredClone(body), { options }) ?? body

const TASK = "Fix the flaky scheduler test in internal/sched: the retry timing assertion fails under load. " + "context ".repeat(40)
const LONG = "An explanation of what was found and why. ".repeat(90)
const BIG = "line of tool output 😀 with text\n".repeat(200)
const IMAGE_NOTE = "[fovea: old image omitted]"
const TOPIC_NOTE = "[fovea: prior topic not carried]"

function topLevelSame(before, after, listKey) {
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const k of Object.keys(before)) if (k !== listKey) same(after[k], before[k])
}

function cachePaths(v, path = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => cachePaths(x, `${path}[${i}]`, out))
  else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k === "cache_control") out.push(`${path}.cache_control=${json(v[k])}`)
      else cachePaths(v[k], `${path}.${k}`, out)
    }
  }
  return out
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
function noLoneSurrogate(v) {
  const s = json(v)
  // JSON.stringify escapes a lone surrogate as \udXXX; a pair it writes as is
  expect(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|\\ud[c-f][0-9a-f]{2}/i.test(s)).toBe(false)
  expect(LONE.test(s)).toBe(false)
}

function common(raw, sent, listKey) {
  topLevelSame(raw, sent, listKey)
  expect(cachePaths(sent)).toEqual(cachePaths(raw))
  expect(sent[listKey].length).toBe(raw[listKey].length)
  noLoneSurrogate(sent)
  // a second pass finds nothing left to do: what fovea sent, it sends again
  same(send(sent, EDGE), sent)
}

// ── anthropic ──────────────────────────────────────────────────────────

function anthropic() {
  return {
    model: "claude-test", max_tokens: 32000, stream: true, metadata: { user_id: "u" },
    thinking: { type: "enabled", budget_tokens: 16000 },
    system: [{ type: "text", text: "S".repeat(3000), cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: [{ name: "Read", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: [
      { role: "user", content: [{ type: "text", text: TASK }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: LONG, signature: "sig_1" },
        { type: "redacted_thinking", data: "EmwKAhgB" + "r".repeat(500) },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "go retry timing" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://e.x/a", title: "A", encrypted_content: "enc" + "w".repeat(3000), page_age: "1 day" }] },
        { type: "text", text: LONG, citations: [{ type: "web_search_result_location", url: "https://e.x/a", title: "A", encrypted_index: "ei1", cited_text: "retry" }] },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/a.go" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: [
          { type: "text", text: BIG },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3000) }, cache_control: { type: "ephemeral", ttl: "1h" } },
        ] },
        { type: "search_result", source: "https://docs.x/sched", title: "sched docs", content: [{ type: "text", text: BIG }], citations: { enabled: true } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0" + "P".repeat(3000) }, title: "spec", citations: { enabled: true } },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: BIG, cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
      { role: "user", content: [{ type: "text", text: "go on" }] },
    ],
  }
}

for (const saccade of MODES) {
  test(`anthropic (saccade ${saccade}): server tools, redacted thinking, citations, search results, documents and 1h breakpoints`, () => {
    const raw = anthropic()
    const sent = send(raw, { ...EDGE, saccade })
    common(raw, sent, "messages")
    const was = raw.messages, now = sent.messages
    // a saccade drops the old topic entirely — the task message goes with it
    if (saccade === "off") same(now[0], was[0])
    // the signer's and the provider's blocks
    for (const k of [0, 1, 2, 3, 5]) same(now[1].content[k], was[1].content[k])
    // sources are not history: whole
    same(now[2].content[1], was[2].content[1])
    same(now[2].content[2], was[2].content[2])
    // a tool result keeps its id, its error flag and its own breakpoint
    expect(now[2].content[0].tool_use_id).toBe("toolu_1")
    expect(now[2].content[0].is_error).toBe(true)
    same(now[4].content[0].cache_control, { type: "ephemeral" })
    // an old image is a note that keeps the 1h breakpoint
    same(now[2].content[0].content[1], { type: "text", text: saccade === "off" ? IMAGE_NOTE : TOPIC_NOTE, cache_control: { type: "ephemeral", ttl: "1h" } })
    // prose and tool output are thinned; the text keeps its citations
    same(now[1].content[4].citations, was[1].content[4].citations)
    const thinned = [now[1].content[4].text, now[2].content[0].content[0].text, now[4].content[0].content]
    for (const t of thinned) expect(t).toContain("[fovea:")
  })
}

// ── chat ───────────────────────────────────────────────────────────────

function chat() {
  return {
    model: "chat-test", stream: true, stream_options: { include_usage: true }, prompt_cache_key: "session-42",
    reasoning_effort: "high", tool_choice: "auto", parallel_tool_calls: true, user: "u", store: false,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "S".repeat(2000) },
      // OpenRouter, Qwen and others take Anthropic-style breakpoints in Chat parts
      { role: "developer", content: [{ type: "text", text: "D".repeat(2000), cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", text: TASK }] },
      { role: "assistant", content: null, reasoning_content: LONG,
        reasoning_details: [{ type: "reasoning.text", text: LONG, signature: "sig", format: "anthropic-claude-v1", index: 0 }, { type: "reasoning.encrypted", data: "enc" + "e".repeat(800), index: 1 }],
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.go\"}" } },
          { id: "call_2", type: "function", function: { name: "read", arguments: "{\"path\":\"b.go\"}" } },
        ] },
      { role: "tool", tool_call_id: "call_1", content: BIG },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: BIG }] },
      { role: "user", content: [
        { type: "text", text: LONG, cache_control: { type: "ephemeral" } },
        { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(3000), detail: "high" } },
        { type: "input_audio", input_audio: { data: "U".repeat(3000), format: "wav" } },
        { type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64," + "P".repeat(3000) } },
      ] },
      // the legacy functions API, still sent by older clients
      { role: "assistant", content: null, function_call: { name: "read", arguments: "{}" } },
      { role: "function", name: "read", content: BIG },
      { role: "assistant", content: LONG, refusal: null, name: "agent" },
      { role: "user", content: "go on" },
      { role: "assistant", content: "ok" },
    ],
  }
}

for (const saccade of MODES) {
  test(`chat (saccade ${saccade}): parallel tool calls, reasoning_details, Chat breakpoints, audio, files and legacy functions`, () => {
    const raw = chat()
    const sent = send(raw, { ...EDGE, saccade })
    common(raw, sent, "messages")
    const was = raw.messages, now = sent.messages
    if (saccade === "off") for (const i of [0, 1, 2, 3, 7]) same(now[i], was[i]) // system, developer, task, the calls
    for (let i = 0; i < was.length; i++) {
      expect(now[i].role).toBe(was[i].role)
      expect(now[i].tool_call_id).toBe(was[i].tool_call_id)
      expect(now[i].name).toBe(was[i].name)
    }
    // audio and files are sources, like documents: whole
    same(now[6].content[2], was[6].content[2])
    same(now[6].content[3], was[6].content[3])
    // an old image_url becomes a Chat text part
    same(now[6].content[1], { type: "text", text: saccade === "off" ? IMAGE_NOTE : TOPIC_NOTE })
    expect(now[6].content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(now[9].refusal).toBe(null)
    const thinned = [now[4].content, now[5].content[0].text, now[6].content[0].text, now[8].content, now[9].content]
    for (const t of thinned) expect(t).toContain("[fovea:")
  })
}

// ── responses ──────────────────────────────────────────────────────────

const OPAQUE = ["reasoning", "function_call", "custom_tool_call", "computer_call", "computer_call_output", "web_search_call", "local_shell_call", "local_shell_call_output", "item_reference"]

function responses() {
  return {
    model: "gpt-test", stream: true, store: false, prompt_cache_key: "thread-7", prompt_cache_retention: "24h",
    include: ["reasoning.encrypted_content"], reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "low" },
    instructions: "codex base instructions " + "I".repeat(2000), tool_choice: "auto", parallel_tool_calls: false,
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }, { type: "custom", name: "apply_patch" }, { type: "web_search" }],
    input: [
      { role: "developer", content: "sandbox policy " + "P".repeat(500) },
      { role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n" + "A".repeat(3000) }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: TASK }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: LONG }], encrypted_content: "gAAAA" + "e".repeat(1500) },
      { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: LONG, annotations: [] }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{\"command\":[\"go\",\"test\"]}" },
      { type: "function_call_output", call_id: "call_1", output: [
        { type: "input_text", text: BIG },
        { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(3000), detail: "auto" },
      ] },
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch\n" + "+x\n".repeat(900) + "*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_2", output: BIG },
      { type: "computer_call", id: "cu_1", call_id: "call_3", action: { type: "click", x: 1, y: 2 }, pending_safety_checks: [], status: "completed" },
      { type: "computer_call_output", call_id: "call_3", output: { type: "computer_screenshot", image_url: "data:image/png;base64," + "C".repeat(3000) } },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "go retry" } },
      { type: "local_shell_call", id: "ls_1", call_id: "call_4", action: { type: "exec", command: ["ls"], env: {} }, status: "completed" },
      { type: "local_shell_call_output", id: "call_4", output: BIG },
      { type: "item_reference", id: "msg_0" },
      { type: "message", role: "user", content: [
        { type: "input_text", text: LONG },
        { type: "input_image", image_url: "data:image/png;base64," + "B".repeat(3000), detail: "high" },
        { type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64," + "P".repeat(3000) },
      ] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
    ],
  }
}

for (const saccade of MODES) {
  test(`responses (saccade ${saccade}): reasoning, custom, computer, shell and web-search items, item references, files and cache fields`, () => {
    const raw = responses()
    const sent = send(raw, { ...EDGE, saccade })
    common(raw, sent, "input")
    const was = raw.input, now = sent.input
    if (saccade === "off") for (const i of [0, 1, 2]) same(now[i], was[i]) // the preamble
    for (let i = 0; i < was.length; i++) {
      if (OPAQUE.includes(was[i].type)) same(now[i], was[i])
      expect(now[i].call_id).toBe(was[i].call_id)
    }
    // an assistant message keeps its id, status and annotations
    expect(now[4].id).toBe("msg_1")
    expect(now[4].status).toBe("completed")
    same(now[4].content[0].annotations, [])
    // files are sources: whole; old images become input_text
    same(now[15].content[2], was[15].content[2])
    const note = saccade === "off" ? IMAGE_NOTE : TOPIC_NOTE
    same(now[6].output[1], { type: "input_text", text: note })
    same(now[15].content[1], { type: "input_text", text: note })
    const thinned = [now[4].content[0].text, now[6].output[0].text, now[8].output, now[15].content[0].text]
    for (const t of thinned) expect(t).toContain("[fovea:")
  })
}

test("responses with previous_response_id: the history lives on the server, the request carries only new items, nothing is touched", () => {
  const raw = { model: "gpt-test", previous_response_id: "resp_9", prompt_cache_key: "thread-7",
    input: [{ type: "function_call_output", call_id: "call_9", output: BIG.repeat(30) }] }
  for (const options of [DEFAULTS, EDGE]) expect(onRequest(structuredClone(raw), { options })).toBeUndefined()
})

test("responses: a custom_tool_call is an answer — the preamble ends there, even without a reasoning item", () => {
  const raw = responses()
  raw.input.splice(3, 2) // no reasoning, no assistant message: the first answer is the function_call
  raw.input.splice(3, 0, { type: "custom_tool_call", id: "ctc_0", call_id: "call_0", name: "apply_patch", input: "patch" }, { type: "custom_tool_call_output", call_id: "call_0", output: BIG })
  const sent = send(raw, EDGE)
  same(sent.input[2], raw.input[2])
  expect(sent.input[4].output).toContain("[fovea:")
})

// ── gemini ─────────────────────────────────────────────────────────────

function gemini() {
  return {
    systemInstruction: { parts: [{ text: "S".repeat(2000) }] },
    tools: [{ functionDeclarations: [{ name: "read_file", parameters: { type: "OBJECT" } }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 0, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    cachedContent: "cachedContents/abc123",
    contents: [
      { role: "user", parts: [{ text: TASK }] },
      { role: "model", parts: [
        { text: LONG, thought: true },
        { text: LONG },
        { functionCall: { id: "fc_1", name: "read_file", args: { path: "a.go" } }, thoughtSignature: "sig" + "g".repeat(300) },
      ] },
      { role: "user", parts: [{ functionResponse: { id: "fc_1", name: "read_file", response: { output: BIG } } }] },
      { role: "user", parts: [
        { text: LONG },
        { inlineData: { mimeType: "image/png", data: "A".repeat(3000) } },
        { inlineData: { mimeType: "application/pdf", data: "P".repeat(3000) } },
        { fileData: { mimeType: "video/mp4", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/x" } },
      ] },
      { role: "model", parts: [
        { text: LONG, thoughtSignature: "sig2" },
        { functionCall: { id: "fc_2", name: "read_file", args: {} } },
      ] },
      { role: "user", parts: [{ functionResponse: { id: "fc_2", name: "read_file", response: { error: BIG, exit_code: 1 } } }] },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ text: "go on" }] },
    ],
  }
}

for (const saccade of MODES) {
  test(`gemini (saccade ${saccade}): thoughts, thought signatures, function calls and responses, images, files and cachedContent`, () => {
    const raw = gemini()
    const sent = send(raw, { ...EDGE, saccade })
    common(raw, sent, "contents")
    const was = raw.contents, now = sent.contents
    if (saccade === "off") same(now[0], was[0]) // the task
    for (let i = 0; i < was.length; i++) {
      expect(now[i].role).toBe(was[i].role)
      expect(now[i].parts.length).toBe(was[i].parts.length)
    }
    // thoughts, anything a signature covers, function calls, files: whole
    for (const [i, k] of [[1, 0], [1, 2], [3, 2], [3, 3], [4, 0], [4, 1]]) same(now[i].parts[k], was[i].parts[k])
    // a function response keeps its id, name and keys; its strings are thinned
    for (const i of [2, 5]) {
      expect(now[i].parts[0].functionResponse.id).toBe(was[i].parts[0].functionResponse.id)
      expect(now[i].parts[0].functionResponse.name).toBe("read_file")
      expect(Object.keys(now[i].parts[0].functionResponse.response)).toEqual(Object.keys(was[i].parts[0].functionResponse.response))
    }
    expect(now[5].parts[0].functionResponse.response.exit_code).toBe(1)
    same(now[3].parts[1], { text: saccade === "off" ? IMAGE_NOTE : TOPIC_NOTE })
    const thinned = [now[1].parts[1].text, now[2].parts[0].functionResponse.response.output, now[3].parts[0].text, now[5].parts[0].functionResponse.response.error]
    for (const t of thinned) expect(t).toContain("[fovea:")
  })
}

test("gemini, saccade auto: a follow-up to the task keeps the old context; a new topic collapses it", () => {
  const options = { ...EDGE, saccade: "auto" }
  const follow = gemini()
  follow.contents.at(-1).parts[0].text = "the scheduler retry timing assertion in internal/sched still fails under load"
  expect(json(send(follow, options))).not.toContain(TOPIC_NOTE)
  const shift = gemini()
  shift.contents.at(-1).parts[0].text = "unrelated: draft a release announcement email aimed at marketing newsletter readers"
  expect(json(send(shift, options))).toContain(TOPIC_NOTE)
})

test("gemini, state_marker: a state block in a text part stays whole and lifts the task exemption", () => {
  const marker = "<!-- fovea:state -->"
  const raw = gemini()
  raw.contents[3].parts[0].text = marker + "\n" + LONG
  // the task must be long enough to be worth cutting once the state block
  // lifts its exemption
  raw.contents[0].parts[0].text = TASK + " " + "ctx ".repeat(400)
  const sent = send(raw, { ...EDGE, state_marker: marker })
  same(sent.contents[3].parts[0], raw.contents[3].parts[0])
  expect(sent.contents[0].parts[0].text).not.toBe(raw.contents[0].parts[0].text)
})

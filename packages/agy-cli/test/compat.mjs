import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
// The smoke suite covers the fetch/ACP/MCP path; these cases cover batched
// client payloads that the sequential fake ACP server cannot emit itself.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compat-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, clipMiddle, withStateLock, execOnce };\n")
const { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, clipMiddle, withStateLock, execOnce } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2VB" } }
const result = (id, name, text) => ({
  block: { type: "tool_result", tool_use_id: id, content: text },
  call: { id, name },
  result: { content: [{ type: "text", text }], isError: false },
})
const bodyFor = content => ({ messages: [{ role: "assistant", content: [] }, { role: "user", content }] })

test("images and dimension notes belong to their preceding result in a batch", () => {
  const a = result("call_a", "Read", "first")
  const b = result("call_b", "Read", "second")
  const body = bodyFor([a.block, image, { type: "text", text: "[Image: first screenshot]" }, b.block])
  const { results } = inspectToolTurn([a, b], body)
  assert.deepEqual(results[0].result.content.map(part => part.type), ["text", "image", "text"])
  assert.equal(results[0].result.content[1].data, image.source.data)
  assert.deepEqual(results[1].result.content, [{ type: "text", text: "second" }])
})

test("a companion cannot attach to a different preceding tool", () => {
  const skill = result("call_skill", "Skill", "Launching skill: review")
  const read = result("call_read", "Read", "file text")
  for (const text of ["ARGUMENTS: review", "Tool loaded.", "[Image: screenshot]"]) {
    assert.throws(() => inspectToolTurn([skill, read], bodyFor([skill.block, read.block, { type: "text", text }])), /text beside a live tool_result/)
  }
})

test("ordinary user text beside live tool results steers a replay without becoming a tool response", () => {
  const call = result("call_read", "Read", "file contents")
  const instruction = { type: "text", text: "Continue reviewing the image pipeline" }
  for (const blocks of [[call.block, instruction], [instruction, call.block]]) {
    const body = bodyFor(blocks)
    const inspected = inspectToolTurn([call], body)
    assert.equal(inspected.userSteered, true, "mixed user text requires a fresh user prompt")
    assert.deepEqual(inspected.results[0].result.content, call.result.content,
      "user instructions must not be attached to an MCP function response")
    const replay = renderInitialPromptParts(body, null, true).map(part => part.text || "").join("")
    assert.ok(replay.includes("Continue reviewing the image pipeline"),
      "the replay must carry the original user instruction")
    assert.ok(replay.includes("file contents"), "the replay must retain the real tool result")
  }
})

test("text plus an image before a live tool_result steers a replay and keeps the image off the MCP result", () => {
  const call = result("call_read", "Read", "file contents")
  const instruction = { type: "text", text: "look at this" }
  const body = bodyFor([instruction, image, call.block])
  const inspected = inspectToolTurn([call], body)
  assert.equal(inspected.userSteered, true)
  assert.deepEqual(inspected.results[0].result.content, call.result.content,
    "images before a result must not be spliced into the MCP function response")
  const parts = renderInitialPromptParts(body, null, true)
  const replay = parts.map(part => part.text || "").join("")
  assert.ok(replay.includes("look at this"))
  assert.ok(replay.includes("file contents"))
  assert.ok(parts.some(part => part.type === "image" && part.data === image.source.data),
    "the replay must carry the original image bytes")
})

test("an image alone before a live tool_result steers a replay and keeps the image off the MCP result", () => {
  const call = result("call_read", "Read", "file contents")
  const body = bodyFor([image, call.block])
  const inspected = inspectToolTurn([call], body)
  assert.equal(inspected.userSteered, true, "an image with no preceding text must still set userSteered")
  assert.deepEqual(inspected.results[0].result.content, call.result.content,
    "images before a result must not be spliced into the MCP function response")
  const parts = renderInitialPromptParts(body, null, true)
  assert.ok(parts.some(part => part.type === "image" && part.data === image.source.data),
    "the replay must carry the original image bytes")
  assert.ok(parts.map(part => part.text || "").join("").includes("file contents"),
    "the replay must retain the real tool result")
})

test("a partial ID rename maps by full history without discarding the live ID anchor", () => {
  const original = [
    { type: "tool_use", id: "original_a", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "original_b", name: "Read", input: { path: "b" } },
  ]
  const expectedMessages = [{ role: "user", content: "read both" }, { role: "assistant", content: original }]
  const history = structuredClone(expectedMessages)
  history[1].content[1].id = "renamed_b"
  const turn = { finalized: false }
  const proc = { turn, expectedMessages, matchesHistory: value => historyKey(value) === historyKey(expectedMessages) }
  const calls = original.map(call => ({ ...call, mcpResponded: false }))
  allProcs.add(proc)
  calls.forEach(call => toolCalls.set(call.id, { proc, turn, call }))
  try {
    const blocks = ["original_a", "renamed_b"].map(id => ({ type: "tool_result", tool_use_id: id, content: "done" }))
    const matched = matchToolResults({ messages: [...history, { role: "user", content: blocks }] }, blocks)
    assert.deepEqual(matched.map(item => item.match?.call?.id), ["original_a", "original_b"])
  } finally {
    allProcs.delete(proc)
    calls.forEach(call => toolCalls.delete(call.id))
  }
})

test("history replay keeps image bytes between their original surrounding text", () => {
  const parts = renderInitialPromptParts({ messages: [
    { role: "user", content: [{ type: "text", text: "before first image" }, image, { type: "text", text: "after first image" }] },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "current question" },
  ] }, null, true)
  assert.deepEqual(parts.map(part => part.type), ["text", "image", "text"])
  assert.ok(parts[0].text.endsWith("Human: before first image"))
  assert.ok(parts[2].text.startsWith("after first image\nAssistant: old reply"))
  assert.ok(parts[2].text.endsWith("<current_turn>\ncurrent question\n</current_turn>"))
})

test("state lock recovers a stale lock only after its owning process has exited", () => {
  const file = path.join(workspace, "dead-owner-state.json")
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: 2147483647 }))
  const old = new Date(Date.now() - 10_000)
  fs.utimesSync(file + ".lock", old, old)
  let wrote = false
  withStateLock(file, () => { wrote = true })
  assert.equal(wrote, true)
  assert.equal(fs.existsSync(file + ".lock"), false)
})

async function captureExec(callback, mode = "close") {
  const originalSpawn = childProcess.spawn
  const originalEnv = process.env
  const originalSetTimeout = globalThis.setTimeout
  const calls = []
  const delays = []
  const inherited = { PATH: "parent-path", AGY_CLI_DISABLE_AUTO_UPDATE: "false" }
  try {
    process.env = inherited
    globalThis.setTimeout = (callback, delay, ...args) => {
      delays.push(delay)
      return originalSetTimeout(callback, mode === "timeout" ? 0 : delay, ...args)
    }
    childProcess.spawn = (file, args, options) => {
      calls.push({ file, args, options })
      if (mode === "throw") throw new Error("fixture spawn failure")
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = signal => {
        calls.at(-1).signal = signal
        queueMicrotask(() => child.emit("close", null))
      }
      queueMicrotask(() => {
        child.stdout.write("fixture output")
        child.stderr.write("fixture error output")
        if (mode === "close") child.emit("close", 7)
        if (mode === "error") child.emit("error", new Error("fixture async failure"))
      })
      return child
    }
    syncBuiltinESMExports()
    await callback(calls, delays, inherited)
    assert.equal(inherited.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    process.env = originalEnv
    globalThis.setTimeout = originalSetTimeout
  }
}

test("execOnce agy branch forces hidden windows and keeps a user-set update value without mutating options", async () => {
  await captureExec(async (calls, delays) => {
    const env = Object.freeze({ CALLER_ONLY: "kept", AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
    const opts = Object.freeze({ env, windowsHide: false, cwd: "workspace", timeoutMs: 1234 })
    const args = Object.freeze(["models"])
    const result = await execOnce("agy", args, opts)
    assert.deepEqual(result, { err: null, stdout: "fixture output", stderr: "fixture error output", code: 7, timedOut: false })
    assert.equal(calls[0].file, "agy")
    assert.equal(calls[0].args, args)
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
    assert.equal(calls[0].options.env.CALLER_ONLY, "kept")
    assert.equal(calls[0].options.env.PATH, "parent-path")
    assert.equal(calls[0].options.cwd, "workspace")
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"])
    assert.deepEqual(delays, [1234])
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
    assert.equal(opts.windowsHide, false)
  })
})

test("execOnce taskkill uses generic spawn, keeps caller env and cannot expose a window", async () => {
  await captureExec(async (calls, delays) => {
    const args = Object.freeze(["/T", "/F", "/PID", "12345"])
    for (const env of [Object.freeze({ CALLER_ONLY: "kept" }), Object.freeze({ AGY_CLI_DISABLE_AUTO_UPDATE: "false" })]) {
      const opts = Object.freeze({ env, windowsHide: false, timeoutMs: 3000 })
      const result = await execOnce("taskkill", args, opts)
      const actual = calls.at(-1)
      assert.equal(actual.file, "taskkill")
      assert.equal(actual.args, args)
      assert.equal(actual.options.windowsHide, true, "taskkill must remain hidden after caller overrides")
      assert.equal(actual.options.env, env, "taskkill must use generic spawn without agy env injection")
      assert.deepEqual(actual.options.env, env)
      assert.equal(opts.windowsHide, false)
      assert.equal(result.code, 7)
      assert.equal(result.stdout, "fixture output")
      assert.equal(result.stderr, "fixture error output")
      assert.equal(result.timedOut, false)
    }
    await execOnce("taskkill", args)
    assert.equal(calls.at(-1).options.env, undefined, "taskkill without caller env must inherit the parent environment")
    assert.deepEqual(delays, [3000, 3000, 30000])
  })
})

test("execOnce taskkill retains its three-second deadline and kills only its child", async () => {
  await captureExec(async (calls, delays) => {
    const result = await execOnce("taskkill", ["/T", "/F", "/PID", "12345"], { timeoutMs: 3000 })
    assert.deepEqual(delays, [3000])
    assert.equal(calls[0].signal, "SIGKILL")
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.equal(result.stdout, "fixture output")
  }, "timeout")
})

test("execOnce still collects synchronous and asynchronous spawn failures", async () => {
  for (const mode of ["throw", "error"]) {
    await captureExec(async () => {
      const result = await execOnce("taskkill", [])
      assert.match(result.err.message, /fixture/)
      assert.equal(result.code, null)
      assert.equal(result.timedOut, false)
    }, mode)
  }
})

test("text that names a notice tag it never closes is routed by its writer, not refused", () => {
  const call = result("call_shell", "shell", "done")
  const wrap = text => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` })
  // the gateway wraps a Codex developer message, which here quotes a reminder tag
  const developer = wrap("Hook context: output is wrapped in <system-reminder> blocks.")
  const nested = wrap("<system-reminder>earlier note</system-reminder> and more")
  for (const block of [developer, nested]) {
    const inspected = inspectToolTurn([call], bodyFor([call.block, block]))
    assert.equal(inspected.userSteered, false, "a developer message is not the user steering")
    const text = inspected.results[0].result.content.map(part => part.text || "").join("\n")
    assert.ok(text.includes("earlier note") || text.includes("Hook context"), "the developer text reaches the model")
  }
  // a user typing the tag name steers, and the replay carries the words
  const typed = { type: "text", text: "why does the <system-reminder tag show up in my chat?" }
  for (const blocks of [[call.block, typed], [typed, call.block]]) {
    const body = bodyFor(blocks)
    const inspected = inspectToolTurn([call], body)
    assert.equal(inspected.userSteered, true)
    assert.deepEqual(inspected.results[0].result.content, call.result.content)
    const replay = renderInitialPromptParts(body, null, true).map(part => part.text || "").join("")
    assert.ok(replay.includes("why does the"), "the user's words are replayed")
  }
  // a notice that opens and is cut short is still turned away
  assert.throws(() => inspectToolTurn([call], bodyFor([call.block, { type: "text", text: "<system-update>cut short" }])), /text beside a live tool_result/)
})

test("clipMiddle stays close to limit instead of dropping 25% on marker overflow", () => {
  const utf8Len = text => Buffer.byteLength(text, "utf8")
  const text = "HEAD_MARK " + "a".repeat(107_000) + " TAIL_MARK"
  const limit = 106_000
  const clipped = clipMiddle(text, limit)
  assert.ok(utf8Len(clipped) <= limit, `clipped size ${utf8Len(clipped)} exceeded limit ${limit}`)
  assert.ok(utf8Len(clipped) >= limit - 64, `clipped size ${utf8Len(clipped)} lost too much of budget ${limit}`)
  assert.ok(clipped.startsWith("HEAD_MARK ") && clipped.endsWith(" TAIL_MARK"))
  assert.match(clipped, /\[\.\.\. \d+ bytes omitted \.\.\.\]/)

  // Multi-byte UTF-8 boundary stays within limit without splitting characters.
  const multi = "首部" + "中".repeat(4000) + "尾部"
  const multiLimit = 9000
  const multiClipped = clipMiddle(multi, multiLimit)
  assert.ok(utf8Len(multiClipped) <= multiLimit)
  assert.ok(utf8Len(multiClipped) >= multiLimit - 64)
  assert.ok(multiClipped.startsWith("首部") && multiClipped.endsWith("尾部"))
})

test("current_turn clipping trims meta reminders and trailing system blocks before user text", () => {
  const utf8Len = text => Buffer.byteLength(text, "utf8")
  const userPrompt = "Please update the sidebar layout and proceed with the refactor."
  const body = {
    system: "System instructions. " + "s".repeat(7000),
    messages: [
      { role: "user", content: "Previous conversation summary. " + "h".repeat(14_000) },
      { role: "assistant", content: [{ type: "text", text: "Preview is ready. " + "a".repeat(2400) }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nResult of calling the Read tool:\n" + "f".repeat(22_000) + "\n</system-reminder>" },
          { type: "text", text: "<system-reminder>\nResult of calling the Read tool:\n" + "g".repeat(22_000) + "\n</system-reminder>" },
          { type: "text", text: "<system-reminder>\nProject instructions:\n" + "p".repeat(20_000) + "\n</system-reminder>" },
          { type: "text", text: "<local-command-caveat>local command</local-command-caveat>" },
          { type: "text", text: "<local-command-stdout>Compacted</local-command-stdout>" },
          { type: "text", text: userPrompt },
        ],
      },
      { role: "system", content: [{ type: "text", text: "Deferred tools and skills:\n" + "d".repeat(42_000) }] },
    ],
  }
  const prompt = renderInitialPromptParts(body, "/workspace/demo", false).map(part => part.text || "").join("")
  assert.ok(utf8Len(prompt) <= 112 * 1024, `prompt size ${utf8Len(prompt)} exceeded 112 KiB`)
  assert.ok(prompt.includes(userPrompt), "sandwiched user prompt must survive <current_turn> clipping")
  assert.ok(prompt.endsWith("\n</current_turn>"))

  // Extreme meta bloat (>260 KiB) still keeps the short user prompt verbatim.
  const extreme = {
    ...body,
    messages: [
      body.messages[0],
      body.messages[1],
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\n" + "r".repeat(100_000) + "\n</system-reminder>" },
          { type: "text", text: "<system-reminder>\n" + "q".repeat(100_000) + "\n</system-reminder>" },
          { type: "text", text: userPrompt },
        ],
      },
      { role: "system", content: [{ type: "text", text: "Trailing system catalog:\n" + "z".repeat(60_000) }] },
    ],
  }
  const extremePrompt = renderInitialPromptParts(extreme, "/workspace/demo", false).map(part => part.text || "").join("")
  assert.ok(utf8Len(extremePrompt) <= 112 * 1024, `extreme prompt size ${utf8Len(extremePrompt)} exceeded 112 KiB`)
  assert.ok(extremePrompt.includes(userPrompt), "user prompt must survive extreme meta/system bloat")

  // Fresh turn without head or history also protects user text over reminders.
  const fresh = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\n" + "m".repeat(80_000) + "\n</system-reminder>" },
          { type: "text", text: userPrompt },
        ],
      },
      { role: "system", content: [{ type: "text", text: "Environment:\n" + "e".repeat(60_000) }] },
    ],
  }
  const freshPrompt = renderInitialPromptParts(fresh, null, true).map(part => part.text || "").join("")
  assert.ok(utf8Len(freshPrompt) <= 112 * 1024)
  assert.ok(freshPrompt.includes(userPrompt), "user prompt must survive clipping on a fresh turn")
})


// A client that interrupts a tool call keeps its own copy of the step
// (a partial text before the call, the call rejected), so the history no
// longer matches the live session. Opening a new session for it starts a cold
// cache: the Default Agent's system prompt names the conversation, so nothing
// of the old prefix can hit. The bridge instead parks the same session at the
// rows both sides still share and resumes it, sending only what follows.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

globalThis.fetch = () => { throw new Error("offline fixture") }

const INTERRUPT = "The user doesn't want to proceed with this tool use. The tool use was rejected."
const methods = (kit, method) => kit.acpLog.filter((entry) => entry.method === method)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

// the bridge's own events, as it writes them to stderr
function captureEvents() {
  const events = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...rest) {
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("[agy-bridge] ")) {
        try { events.push(JSON.parse(line.slice(13))) } catch {}
      }
    }
    return write.call(this, chunk, ...rest)
  }
  return { events, restore: () => { process.stderr.write = write } }
}

function recordPrompts(kit, seen) {
  kit.defaultPrompt = async (agent) => {
    seen.prompts.push(JSON.stringify(agent.prompt))
    await agent.text("OK")
    return { stopReason: "end_turn" }
  }
}

// A turn that ran `steps` tool steps with results, then emitted one more call
// (B); the client then interrupts B with its own record of that step.
async function interruptedAfter(kit, steps = 0, edit = (body) => body) {
  const seen = { prompts: [] }
  kit.prompts.push(async (agent) => {
    for (let i = 1; i <= steps; i++) await agent.tool("Read", { path: `/fixture/${i}` })
    seen.call = await agent.tool("Read", { path: "/fixture/b" })
    return { stopReason: "end_turn" }
  })
  recordPrompts(kit, seen)
  let body = baseBody()
  let parsed = await readSse(await kit.request(body))
  for (let i = 1; i <= steps; i++) {
    assert.equal(parsed.stopReason, "tool_use")
    body = continueWithToolResults(body, parsed, () => `result ${i} `.repeat(200))
    parsed = await readSse(await kit.request(body))
  }
  assert.equal(parsed.stopReason, "tool_use")
  const use = parsed.content.find((block) => block.type === "tool_use")
  const interrupted = structuredClone(body)
  interrupted.messages.push(
    { role: "assistant", content: [{ type: "text", text: "I will read the file." }, { type: "tool_use", id: use.id, name: use.name, input: use.input }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: use.id, content: INTERRUPT, is_error: true },
      { type: "text", text: "[Request interrupted by user for tool use]" },
      { type: "text", text: "Never mind the file. Reply OK." },
    ] },
  )
  return { seen, body: edit(interrupted) }
}

async function withKit(options, fn) {
  const kit = await createBridgeKit({ agentVersion: "1.5.19", sessionResume: true, ...options })
  try { return await fn(kit) } finally { await kit.dispose() }
}

// The kill of the kit's first agy waits until `release` is called, as a real
// agy takes a moment to exit after SIGTERM.
function holdFirstExit(kit) {
  let release
  const released = new Promise((resolve) => { release = resolve })
  const { child } = kit.acpSpawns[0]
  child.kill = (signal = "SIGTERM") => {
    child.onKill?.(signal)
    released.then(() => child.finish(null, signal))
    return true
  }
  return release
}

// As holdFirstExit, with a real process standing in for the old agy's pid
// (another host can only check the pid): `release` ends it, then the exit.
function holdFirstExitWithPid(kit) {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" })
  kit.acpSpawns[0].child.pid = sleeper.pid
  const release = holdFirstExit(kit)
  const gone = once(sleeper, "exit")
  return {
    pid: sleeper.pid,
    release: async () => {
      sleeper.kill("SIGKILL")
      await gone
      release()
    },
  }
}

const stateEntries = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).entries : []

async function until(check, ms = 2_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("an interrupted step the client recorded differently resumes the same session, not a new one", async () => {
  await withKit({}, async (kit) => {
    const { seen, body } = await interruptedAfter(kit)
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/new").length, 1, "no cold new session")
    const resumes = methods(kit, "session/resume")
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].params.sessionId, methods(kit, "session/prompt")[0].sessionId)
    assert.equal(seen.prompts.length, 1)
    const prompt = seen.prompts[0]
    // the parting point is named by the last shared row: the opening, quoted once
    assert.match(prompt, /after the user's message that begins \\"start the task\\" is not in the client's conversation/)
    assert.ok(prompt.includes("Never mind the file. Reply OK."))
    assert.ok(prompt.includes("I will read the file."), "the client's own record of the step goes in")
    assert.equal(prompt.split("start the task").length, 2, "the shared opening stays in the session, not replayed")
    // the call the client interrupted was never answered over MCP
    assert.equal(seen.call ?? null, null)

    // the next turn goes on in the resumed session as a plain delta
    const next = structuredClone(body)
    next.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] }, { role: "user", content: "Reply OK again." })
    const again = await readSse(await kit.request(next))
    assert.equal(again.stopReason, "end_turn")
    assert.equal(methods(kit, "session/new").length, 1)
    assert.equal(methods(kit, "session/resume").length, 1)
    assert.equal(seen.prompts.length, 2)
    assert.ok(seen.prompts[1].includes("Reply OK again."))
    assert.ok(!seen.prompts[1].includes("Never mind the file"), "no replay after the rebase")
    assert.ok(!seen.prompts[1].includes("not in the client's conversation"))
  })
})

test("interrupted after three steps: the session is cut after the last step's results, none sent again", async () => {
  await withKit({}, async (kit) => {
    const { seen, body } = await interruptedAfter(kit, 3)
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/new").length, 1)
    assert.equal(methods(kit, "session/resume").length, 1)
    const prompt = seen.prompts[0]
    // the parting point names the step: step 3's call and its arguments
    assert.match(prompt, /after the results of your Read \{\\"path\\":\\"\/fixture\/3\\"\} call is not in the client's conversation/)
    for (const i of [1, 2, 3]) assert.ok(!prompt.includes(`result ${i}`), `step ${i}'s result is in the session already`)
    assert.ok(prompt.includes("I will read the file."))
    assert.ok(prompt.includes("Never mind the file. Reply OK."))
    assert.ok(prompt.length < 2_000, `a small prompt (${prompt.length} bytes)`)
  })
})

test("a session/resume that fails falls back to the whole replay in a new session", async () => {
  await withKit({ sessionResumeError: { code: -32000, message: "no such session (test)" } }, async (kit) => {
    const { seen, body } = await interruptedAfter(kit)
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/resume").length, 1)
    assert.equal(methods(kit, "session/new").length, 2)
    assert.equal(seen.prompts.length, 1)
    assert.ok(seen.prompts[0].includes("start the task"), "the full history is replayed")
    assert.ok(seen.prompts[0].includes("Never mind the file. Reply OK."))
    assert.ok(!seen.prompts[0].includes("not in the client's conversation"))
  })
})

test("without session/resume the interrupted step still replays into a new session", async () => {
  await withKit({ sessionResume: false }, async (kit) => {
    const { seen, body } = await interruptedAfter(kit)
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/new").length, 2)
    assert.equal(methods(kit, "session/resume").length, 0)
    assert.ok(seen.prompts[0].includes("start the task"), "the full history is replayed")
    assert.ok(seen.prompts[0].includes("Never mind the file. Reply OK."))
  })
})

test("changed instructions are no rebase: the session's system prompt is not the request's", async () => {
  await withKit({}, async (kit) => {
    const { seen, body } = await interruptedAfter(kit, 0, (b) => ({ ...b, system: "You are another test agent." }))
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/resume").length, 0)
    assert.equal(methods(kit, "session/new").length, 2)
    assert.ok(seen.prompts[0].includes("start the task"))
  })
})

test("a tail past half the conversation is no rebase: the session would carry it twice", async () => {
  await withKit({}, async (kit) => {
    const { seen, body } = await interruptedAfter(kit, 0, (b) => {
      b.messages.at(-2).content[0].text = "I will read the file. ".repeat(100)
      return b
    })
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/resume").length, 0)
    assert.equal(methods(kit, "session/new").length, 2)
    assert.ok(seen.prompts[0].includes("start the task"), "the whole history is replayed")
  })
})

test("a changed work dir is no rebase", async () => {
  await withKit({}, async (kit) => {
    const { seen, body } = await interruptedAfter(kit)
    const other = fs.mkdtempSync(path.join(kit.tmp, "other-dir-"))
    const response = await readSse(await kit.request(body, { headers: { "x-magpie-work-dir": encodeURIComponent(other) } }))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(kit, "session/resume").length, 0)
    assert.ok(seen.prompts[0].includes("start the task"))
  })
})

test("a retry of the same request while agy stops is not dropped again, and goes on in the rebased session", async () => {
  await withKit({}, async (kit) => {
    const capture = captureEvents()
    try {
      const { seen, body } = await interruptedAfter(kit)
      const release = holdFirstExit(kit)
      const first = kit.request(body)
      await until(() => capture.events.some((event) => event.action === "drop_live"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const retry = kit.request(structuredClone(body))
      await new Promise((resolve) => setTimeout(resolve, 50))
      // the old agy has not exited: nothing resumed its session yet
      assert.equal(methods(kit, "session/resume").length, 0)
      release()
      const [a, b] = await Promise.all([first, retry])
      const statuses = [a.status, b.status].sort()
      const answered = a.status === 200 ? a : b
      assert.equal((await readSse(answered)).stopReason, "end_turn")
      if (statuses[0] !== 200 || statuses[1] !== 200) await (a.status === 200 ? b : a).text()
      assert.equal(capture.events.filter((event) => event.action === "drop_live").length, 1, "the retry found no live call")
      assert.equal(methods(kit, "session/resume").length, 1)
      assert.equal(methods(kit, "session/new").length, 1)
      assert.equal(seen.call ?? null, null, "the interrupted call got no MCP answer")
    } finally {
      capture.restore()
    }
  })
})

// Two hosts share the state file (a reload): the new one takes the entry
// while the old one is still stopping its agy, and resumes the session
// only once that agy's pid is gone (rebaseHolderGone), never beside it.
async function twoHosts(freshOptions, fn) {
  const shared = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "agy-rebase-state-"))
  const env = { AGY_BRIDGE_STATE_FILE: path.join(shared, "sessions.json") }
  const old = await createBridgeKit({ agentVersion: "1.5.19", sessionResume: true, tmpdir: shared, env })
  const fresh = await createBridgeKit({ agentVersion: "1.5.19", sessionResume: true, ...freshOptions, tmpdir: shared, env: { ...env, ...freshOptions.env } })
  try {
    return await fn({ old, fresh, file: env.AGY_BRIDGE_STATE_FILE })
  } finally {
    await old.dispose()
    await fresh.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
}

async function parkedByOld(old, file) {
  const { body } = await interruptedAfter(old)
  const holder = holdFirstExitWithPid(old)
  const pending = old.request(body)
  await until(() => stateEntries(file).some((entry) => entry.rebase))
  const entry = stateEntries(file).find((item) => item.rebase)
  return { body, holder, pending, entry }
}

test("a host that starts while the old one stops resumes the rebase entry only once the old agy is gone", async () => {
  await twoHosts({}, async ({ old, fresh, file }) => {
    const { body, holder, pending, entry } = await parkedByOld(old, file)
    assert.equal(entry.stopping, true)
    assert.equal(entry.holder.pid, holder.pid, "the entry names the agy that still holds the session")
    const seen = { prompts: [] }
    recordPrompts(fresh, seen)
    // an ordinary request, as the client sends it again to the new host
    const answer = fresh.request(structuredClone(body))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(methods(fresh, "session/resume").length, 0, "nothing resumes while the old agy runs")
    assert.equal(fresh.acpSpawns.length, 0, "no agy started in the session's folder yet")
    await holder.release()
    const response = await readSse(await answer)
    assert.equal(response.stopReason, "end_turn")
    assert.equal(methods(fresh, "session/new").length, 0)
    assert.equal(methods(fresh, "session/resume").length, 1)
    assert.equal(methods(fresh, "session/resume")[0].params.sessionId, methods(old, "session/prompt")[0].sessionId)
    assert.match(seen.prompts[0], /not in the client's conversation/)
    assert.equal(seen.prompts[0].split("start the task").length, 2, "no replay")
    await (await pending).text()
    // the old host left the folder to the host that resumed in it
    assert.ok(fs.existsSync(entry.workspace), "the resumed session's folder is not removed by the old host")
  })
})

test("the old host does not save a rebase entry another host already took", async () => {
  await twoHosts({}, async ({ old, fresh, file }) => {
    const { body, holder, pending, entry } = await parkedByOld(old, file)
    const marker = path.join(entry.workspace, "handoff-marker")
    fs.writeFileSync(marker, "")
    recordPrompts(fresh, { prompts: [] })
    const answer = fresh.request(structuredClone(body))
    let rewritten
    try {
      await until(() => !stateEntries(file).some((item) => item.key === entry.key))
      const other = baseBody({ messages: [{ role: "user", content: "A separate conversation." }] })
      assert.equal((await readSse(await old.request(other))).stopReason, "end_turn")
      await until(() => stateEntries(file).some((item) => item.key !== entry.key))
      rewritten = stateEntries(file).some((item) => item.key === entry.key && item.rebase)
    } finally {
      await holder.release()
    }
    await (await pending).text()
    assert.equal((await readSse(await answer)).stopReason, "end_turn")
    assert.equal(methods(fresh, "session/resume")[0]?.params.sessionId, entry.sessionId)
    assert.equal(fresh.acpSpawns[0].cwd, entry.workspace)
    assert.deepEqual({ rewritten, workspacePreserved: fs.existsSync(marker) },
      { rewritten: false, workspacePreserved: true })
  })
})

test("an old agy that outlives the wait: the new host replays in a new session, never resumes beside it", async () => {
  await twoHosts({ env: { AGY_BRIDGE_REBASE_HOLDER_WAIT_MS: "200" } }, async ({ old, fresh, file }) => {
    const capture = captureEvents()
    try {
      const { body, holder, pending } = await parkedByOld(old, file)
      const seen = { prompts: [] }
      recordPrompts(fresh, seen)
      const response = await readSse(await fresh.request(structuredClone(body)))
      assert.equal(response.stopReason, "end_turn")
      assert.equal(methods(fresh, "session/resume").length, 0)
      assert.equal(methods(fresh, "session/new").length, 1)
      assert.ok(seen.prompts[0].includes("start the task"), "the whole history is replayed")
      assert.ok(!seen.prompts[0].includes("not in the client's conversation"))
      assert.ok(capture.events.some((event) => event.park_miss === "holder_alive"))
      await holder.release()
      await (await pending).text()
    } finally {
      capture.restore()
    }
  })
})

test("another history under the same conversation key that shares only the opening leaves the rebase entry alone", async () => {
  await twoHosts({}, async ({ old, fresh, file }) => {
    const capture = captureEvents()
    try {
      const { holder, pending, entry } = await parkedByOld(old, file)
      assert.equal(entry.count, 1, "the shared rows are the opening alone")
      const seen = { prompts: [] }
      recordPrompts(fresh, seen)
      const other = baseBody()
      other.messages.push(
        { role: "assistant", content: [{ type: "text", text: "A different reply." }] },
        { role: "user", content: "A different question." },
      )
      const response = await readSse(await fresh.request(other))
      assert.equal(response.stopReason, "end_turn")
      assert.equal(methods(fresh, "session/resume").length, 0, "not taken by a branch the session never had")
      assert.ok(seen.prompts[0].includes("A different reply."), "replayed as before")
      assert.ok(!seen.prompts[0].includes("not in the client's conversation"))
      assert.ok(capture.events.some((event) => event.park_miss === "rebase"))
      // (its own finished turn is parked under the key next, in place of the
      // rebase entry: the old request then replays, as any lost session)
      await holder.release()
      await (await pending).text()
    } finally {
      capture.restore()
    }
  })
})

test("a steer whose results agy already took is no rebase: the results are not sent again as if new", async () => {
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "0" } }, async (kit) => {
    const seen = { prompts: [] }
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      seen.call = await agent.tool("Read", { path: "/fixture/a" })
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    })
    recordPrompts(kit, seen)
    const opening = baseBody()
    const parsed = await readSse(await kit.request(opening))
    const body = continueWithToolResults(opening, parsed, () => "REAL_RESULT_42")
    body.messages.at(-1).content.push({ type: "text", text: "Steer to new instruction" })
    const response = await readSse(await kit.request(body))
    assert.equal(response.stopReason, "end_turn")
    assert.ok(seen.call, "the steer answered the call over MCP before its commit wait ran out")
    assert.equal(methods(kit, "session/resume").length, 0)
    assert.equal(methods(kit, "session/new").length, 2)
    assert.ok(seen.prompts[0].includes("start the task"), "replayed whole in a new session")
    assert.ok(!seen.prompts[0].includes("not in the client's conversation"))
  })
})

test("a silenced call is never answered over MCP while the parked agy stops", async () => {
  await withKit({}, async (kit) => {
    const capture = captureEvents()
    try {
      const { seen, body } = await interruptedAfter(kit, 1)
      const release = holdFirstExit(kit)
      const first = kit.request(body)
      await until(() => capture.events.some((event) => event.action === "drop_live"))
      // the agy is still running (its exit held), its MCP socket open: the
      // call is silenced, not answered with an error
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(seen.call ?? null, null)
      release()
      assert.equal((await readSse(await first)).stopReason, "end_turn")
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(seen.call ?? null, null, "the interrupted call got no MCP answer")
      assert.equal(methods(kit, "session/resume").length, 1)
    } finally {
      capture.restore()
    }
  })
})

test("image_result: a result with an image and a history the client changed resumes the session, the image in the prompt", async () => {
  await withKit({ promptImages: true }, async (kit) => {
    const capture = captureEvents()
    try {
      const seen = { prompts: [] }
      kit.prompts.push(async (agent) => {
        seen.call = await agent.tool("Read", { path: "/fixture/shot.png" })
        return { stopReason: "end_turn" }
      })
      recordPrompts(kit, seen)
      const opening = baseBody()
      const parsed = await readSse(await kit.request(opening))
      const use = parsed.content.find((block) => block.type === "tool_use")
      const body = structuredClone(opening)
      body.messages.push(
        { role: "assistant", content: [{ type: "text", text: "Looking at the picture." }, { type: "tool_use", id: use.id, name: use.name, input: use.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: [
          { type: "text", text: "the picture" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ] }] },
      )
      const response = await readSse(await kit.request(body))
      assert.equal(response.stopReason, "end_turn")
      const drop = capture.events.find((event) => event.action === "drop_live")
      assert.equal(drop?.reason, "image_result")
      assert.equal(methods(kit, "session/resume").length, 1)
      assert.equal(methods(kit, "session/new").length, 1)
      const prompt = methods(kit, "session/prompt").at(-1).params.prompt
      assert.ok(prompt.some((part) => part.type === "image" && part.data === PNG), "the image goes in")
      assert.ok(seen.prompts[0].includes("Looking at the picture."))
    } finally {
      capture.restore()
    }
  })
})

test("tools_grew: a step agy already ended, answered with a grown catalog, resumes the session with the new tools", async () => {
  await withKit({}, async (kit) => {
    const capture = captureEvents()
    try {
      const seen = { prompts: [] }
      kit.prompts.push(async (agent) => {
        // agy ends the step without waiting for the call (the steer can't
        // take the results into it)
        agent.tool("Read", { path: "/fixture/a" }).then((reply) => { seen.call = reply })
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { stopReason: "end_turn" }
      })
      recordPrompts(kit, seen)
      const opening = baseBody()
      const parsed = await readSse(await kit.request(opening))
      assert.equal(parsed.stopReason, "tool_use")
      const body = continueWithToolResults(opening, parsed, () => "result A")
      body.tools = [...body.tools, { name: "Grep", description: "Search files.", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }]
      const response = await readSse(await kit.request(body))
      assert.equal(response.stopReason, "end_turn")
      const drop = capture.events.find((event) => event.action === "drop_live")
      assert.equal(drop?.reason, "tools_grew")
      assert.equal(methods(kit, "session/resume").length, 1)
      assert.equal(methods(kit, "session/new").length, 1)
      assert.ok(seen.prompts[0].includes("result A"))
      assert.equal(seen.prompts[0].split("start the task").length, 1, "no replay")
      assert.ok(kit.listings.at(-1).tools.includes("Grep"), "agy lists the grown catalog")
    } finally {
      capture.restore()
    }
  })
})

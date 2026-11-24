// Two live branches sharing a base conversationKey (for instance a main
// session and a forked sidechat carrying the same prompt-cache key) must keep
// independent live sessions instead of overwriting each other's warm process,
// returning 503 while the sibling streams, or killing each other's tool turns.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, sleep } from "./testkit.mjs"

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try { return await fn(kit) } finally { await kit.dispose() }
}

function textOf(parsed) {
  return (parsed.content || []).filter((block) => block.type === "text").map((block) => block.text).join("")
}

function promptText(agent) {
  return (agent.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function currentTurnText(agent) {
  const full = promptText(agent)
  return full.includes("<current_turn>") ? full.slice(full.lastIndexOf("<current_turn>")) : full
}

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

test("parent resuming from prefix keeps forked sibling's warm session alive while both run concurrently", async () => {
  const stderr = captureStderr()
  try {
    await withKit({}, async (kit) => {
      let releaseParent
      const parentGate = new Promise((resolve) => { releaseParent = resolve })
      kit.defaultPrompt = async (agent) => {
        const cur = currentTurnText(agent)
        if (cur.includes("PARENT_SLOW")) {
          await agent.text("parent streaming ")
          await parentGate
          await agent.text("done")
          return { stopReason: "end_turn" }
        }
        await agent.text(`reply:${cur.trim().slice(0, 32)}`)
        return { stopReason: "end_turn" }
      }

      const headers = { "x-magpie-session": "shared-parent-cache-key" }
      const u0 = { role: "user", content: "shared opening turn" }
      const turn0 = await readSse(await kit.request(baseBody({ system: "shared sys", messages: [u0] }), { headers }))
      const a0 = { role: "assistant", content: [{ type: "text", text: textOf(turn0) }] }

      // Forked sidechat advances the shared live session while parent is idle.
      const side1Msg = { role: "user", content: "SIDE_1 first side question" }
      const side1 = await readSse(await kit.request(baseBody({ system: "shared sys", messages: [u0, a0, side1Msg] }), { headers }))
      const side1Reply = { role: "assistant", content: [{ type: "text", text: textOf(side1) }] }
      assert.equal(kit.acpSpawns.length, 1)

      // Parent wakes up from [u0, a0] (strict prefix of the live session) and streams.
      const parent2Msg = { role: "user", content: "PARENT_SLOW follow-up" }
      const parentReq = kit.request(baseBody({ system: "shared sys", messages: [u0, a0, parent2Msg] }), { headers })
      await sleep(40)
      assert.equal(kit.acpSpawns.length, 2, "parent opens a sibling branch instead of destroying sidechat's warm proc")

      // While parent is actively streaming, sidechat sends its next turn.
      // It must reuse its preserved warm proc without 503 or replay.
      const side2Msg = { role: "user", content: "SIDE_2 second side question" }
      const side2Res = await kit.request(
        baseBody({ system: "shared sys", messages: [u0, a0, side1Msg, side1Reply, side2Msg] }),
        { headers },
      )
      assert.equal(side2Res.status, 200, `expected 200, got ${side2Res.status}`)
      const side2 = await readSse(side2Res)
      assert.equal(side2.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, 2, "sidechat reused its preserved warm proc with no new spawn")

      releaseParent()
      const parent2Res = await parentReq
      assert.equal(parent2Res.status, 200)
      const parent2 = await readSse(parent2Res)
      assert.equal(textOf(parent2), "parent streaming done")

      // Subsequent turns on both branches stay pinned to their own live procs.
      const parent2Reply = { role: "assistant", content: [{ type: "text", text: textOf(parent2) }] }
      const side2Reply = { role: "assistant", content: [{ type: "text", text: textOf(side2) }] }
      const p3 = await readSse(await kit.request(
        baseBody({ system: "shared sys", messages: [u0, a0, parent2Msg, parent2Reply, { role: "user", content: "PARENT_3" }] }),
        { headers },
      ))
      const s3 = await readSse(await kit.request(
        baseBody({ system: "shared sys", messages: [u0, a0, side1Msg, side1Reply, side2Msg, side2Reply, { role: "user", content: "SIDE_3" }] }),
        { headers },
      ))
      assert.equal(p3.stopReason, "end_turn")
      assert.equal(s3.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, 2, "both branches stay warm on their own procs")
      assert.deepEqual(stderr.lines.filter((row) => row.action === "superseded"), [])
    })
  } finally {
    stderr.restore()
  }
})

test("different multi-turn prompt during active streaming opens a sibling branch, while identical resend still returns 503", async () => {
  await withKit({}, async (kit) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    kit.defaultPrompt = async (agent) => {
      const cur = currentTurnText(agent)
      if (cur.includes("STREAM_MAIN")) {
        await agent.text("main ")
        await gate
        await agent.text("finished")
        return { stopReason: "end_turn" }
      }
      await agent.text(`branch:${cur.trim()}`)
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "same-key-streaming" }
    const u0 = { role: "user", content: "opening" }
    const first = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0] }), { headers }))
    const a0 = { role: "assistant", content: [{ type: "text", text: textOf(first) }] }

    const mainBody = baseBody({ system: "sys", messages: [u0, a0, { role: "user", content: "STREAM_MAIN work" }] })
    const mainReq = kit.request(mainBody, { headers })
    await sleep(40)

    // Exact duplicate resend of the streaming turn is still rejected with 503.
    const dupRes = await kit.request(mainBody, { headers })
    assert.equal(dupRes.status, 503)
    await dupRes.text()

    // Forked sibling with a different prompt gets its own branch without 503.
    const sideRes = await kit.request(
      baseBody({ system: "sys", messages: [u0, a0, { role: "user", content: "SIDE_QUESTION" }] }),
      { headers },
    )
    assert.equal(sideRes.status, 200)
    const sideParsed = await readSse(sideRes)
    assert.equal(sideParsed.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2)

    release()
    const mainParsed = await readSse(await mainReq)
    assert.equal(textOf(mainParsed), "main finished")
    assert.equal(kit.acpSpawns.length, 2)
  })
})

test("diverged longer branch does not supersede parent's detached pending tool turn", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const cur = currentTurnText(agent)
      if (cur.includes("PARENT_TOOL")) {
        const reply = await agent.tool("Read", { path: "/parent.txt" })
        await agent.text(`parent:${reply?.result?.content?.[0]?.text || ""}`)
        return { stopReason: "end_turn" }
      }
      await agent.text(`side:${cur.trim().slice(0, 20)}`)
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "same-key-detached-tool" }
    const u0 = { role: "user", content: "opening" }
    const t0 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0] }), { headers }))
    const a0 = { role: "assistant", content: [{ type: "text", text: textOf(t0) }] }

    // Parent enters a detached pending tool wait at turn 2 (base = [u0, a0]).
    const parentToolBody = baseBody({ system: "sys", messages: [u0, a0, { role: "user", content: "PARENT_TOOL run" }] })
    const parentPending = await readSse(await kit.request(parentToolBody, { headers }))
    assert.equal(parentPending.stopReason, "tool_use")

    // A diverged sibling branch that already has its own turns past [u0, a0] arrives.
    const sideBody = baseBody({
      system: "sys",
      messages: [
        u0,
        a0,
        { role: "user", content: "SIDE_TURN_1" },
        { role: "assistant", content: [{ type: "text", text: "side answer 1" }] },
        { role: "user", content: "SIDE_TURN_2" },
      ],
    })
    const sideRes = await kit.request(sideBody, { headers })
    assert.equal(sideRes.status, 200)
    assert.equal((await readSse(sideRes)).stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2)

    // Parent's original pending tool turn is still intact and completes on its proc.
    const parentDoneRes = await kit.request(continueWithToolResults(parentToolBody, parentPending, () => "parent-ok"), { headers })
    assert.equal(parentDoneRes.status, 200)
    const parentDone = await readSse(parentDoneRes)
    assert.equal(textOf(parentDone), "parent:parent-ok")
    assert.equal(kit.acpSpawns.length, 2)
  })
})

test("unmatched tool_result from a diverged sibling branch replays in its own branch instead of 503ing against a streaming sibling", async () => {
  await withKit({}, async (kit) => {
    let releaseStream
    const streamGate = new Promise((resolve) => { releaseStream = resolve })
    kit.defaultPrompt = async (agent) => {
      const cur = currentTurnText(agent)
      if (cur.includes("SIDE_STREAM")) {
        await agent.text("side ")
        await streamGate
        await agent.text("complete")
        return { stopReason: "end_turn" }
      }
      await agent.text("replayed parent tool round")
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "same-key-tool-result" }
    const u0 = { role: "user", content: "opening" }
    const t0 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0] }), { headers }))
    const a0 = { role: "assistant", content: [{ type: "text", text: textOf(t0) }] }

    // Side branch streams actively on the base convKey.
    const sideReq = kit.request(
      baseBody({ system: "sys", messages: [u0, a0, { role: "user", content: "SIDE_STREAM long reply" }] }),
      { headers },
    )
    await sleep(40)

    // Parent branch sends a complete tool round whose user turn diverged at index 2.
    const parentToolRound = baseBody({
      system: "sys",
      messages: [
        u0,
        a0,
        { role: "user", content: "PARENT_DIFFERENT_PROMPT" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_parent_branch_123", name: "Read", input: { path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_parent_branch_123", content: "file content" }] },
      ],
    })
    const parentRes = await kit.request(parentToolRound, { headers })
    assert.equal(parentRes.status, 200, `expected 200, got ${parentRes.status}`)
    const parentParsed = await readSse(parentRes)
    assert.equal(textOf(parentParsed), "replayed parent tool round")
    assert.equal(kit.acpSpawns.length, 2)

    releaseStream()
    const sideParsed = await readSse(await sideReq)
    assert.equal(textOf(sideParsed), "side complete")
  })
})

test("per-conversation sibling branch cap retires oldest idle branches", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "16" } }, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text(`ok:${agent.index}`)
      return { stopReason: "end_turn" }
    }
    const headers = { "x-magpie-session": "same-key-branch-cap" }
    const u0 = { role: "user", content: "opening" }
    const t0 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0] }), { headers }))
    const a0 = { role: "assistant", content: [{ type: "text", text: textOf(t0) }] }

    // Create 6 distinct branches diverging from [u0, a0].
    for (let i = 1; i <= 6; i++) {
      const b1 = { role: "user", content: `BRANCH_${i}_STEP_1` }
      const r1 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0, a0, b1] }), { headers }))
      assert.equal(r1.stopReason, "end_turn")
    }
    const alive = kit.acpSpawns.filter((proc) => proc.exitCode === null && !proc.killed)
    assert.ok(alive.length <= 4, `expected <= 4 live branches, got ${alive.length}`)
  })
})

test("interleaved multi-step tool loops on two sibling branches sharing x-magpie-session stay isolated", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const cur = currentTurnText(agent)
      if (cur.includes("PARENT_LOOP")) {
        const r1 = await agent.tool("Read", { path: "/p1" })
        const r2 = await agent.tool("Read", { path: "/p2" })
        await agent.text(`parent:${r1?.result?.content?.[0]?.text}|${r2?.result?.content?.[0]?.text}`)
        return { stopReason: "end_turn" }
      }
      if (cur.includes("SIDE_LOOP")) {
        const r1 = await agent.tool("Read", { path: "/s1" })
        const r2 = await agent.tool("Read", { path: "/s2" })
        await agent.text(`side:${r1?.result?.content?.[0]?.text}|${r2?.result?.content?.[0]?.text}`)
        return { stopReason: "end_turn" }
      }
      await agent.text("init ok")
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "same-key-interleaved-tools" }
    const u0 = { role: "user", content: "opening" }
    const t0 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0] }), { headers }))
    const a0 = { role: "assistant", content: [{ type: "text", text: textOf(t0) }] }

    // Side branch completes one turn on the shared proc, then parent wakes up from prefix.
    const sideIntro = { role: "user", content: "side intro" }
    const s0 = await readSse(await kit.request(baseBody({ system: "sys", messages: [u0, a0, sideIntro] }), { headers }))
    const s0Reply = { role: "assistant", content: [{ type: "text", text: textOf(s0) }] }

    const parentBody1 = baseBody({ system: "sys", messages: [u0, a0, { role: "user", content: "PARENT_LOOP go" }] })
    const sideBody1 = baseBody({ system: "sys", messages: [u0, a0, sideIntro, s0Reply, { role: "user", content: "SIDE_LOOP go" }] })

    const [pStep1, sStep1] = await Promise.all([
      kit.request(parentBody1, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
      kit.request(sideBody1, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
    ])
    assert.equal(pStep1.stopReason, "tool_use")
    assert.equal(sStep1.stopReason, "tool_use")

    const parentBody2 = continueWithToolResults(parentBody1, pStep1, () => "p-out-1")
    const sideBody2 = continueWithToolResults(sideBody1, sStep1, () => "s-out-1")
    const [pStep2, sStep2] = await Promise.all([
      kit.request(parentBody2, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
      kit.request(sideBody2, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
    ])
    assert.equal(pStep2.stopReason, "tool_use")
    assert.equal(sStep2.stopReason, "tool_use")

    const parentBody3 = continueWithToolResults(parentBody2, pStep2, () => "p-out-2")
    const sideBody3 = continueWithToolResults(sideBody2, sStep2, () => "s-out-2")
    const [pDone, sDone] = await Promise.all([
      kit.request(parentBody3, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
      kit.request(sideBody3, { headers }).then((r) => { assert.equal(r.status, 200); return readSse(r) }),
    ])
    assert.equal(textOf(pDone), "parent:p-out-1|p-out-2")
    assert.equal(textOf(sDone), "side:s-out-1|s-out-2")
    assert.equal(kit.acpSpawns.length, 2, "two interleaved sibling tool loops stay on two procs")
  })
})

test("parked sibling branches resume independently without deleting each other's snapshot", async () => {
  const { createHash } = await import("node:crypto")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { INDEX_FILE } = await import("./testkit.mjs")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sibling-park-"))
  const prevState = process.env.AGY_BRIDGE_STATE_FILE
  process.env.AGY_BRIDGE_STATE_FILE = path.join(tmp, "sessions.json")
  try {
    const src = fs.readFileSync(INDEX_FILE, "utf8")
    const modFile = path.join(tmp, "index-export.mjs")
    fs.writeFileSync(
      modFile,
      src.replace(/from "\.\//g, `from "${path.dirname(INDEX_FILE).replace(/\\/g, "/")}/`) +
        "\nexport { takeParked, park, parked };\n",
    )
    const { takeParked, park, parked } = await import(`file://${modFile}?t=${Date.now()}`)
    parked.clear()

    const base = `acct:test:${createHash("sha256").update("sibling-park").digest("hex")}`
    const branch = `${base}#req_12345678`
    const hA = [
      { role: "user", content: "open" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "branch A" },
      { role: "assistant", content: [{ type: "text", text: "reply A" }] },
    ]
    const hB = [
      { role: "user", content: "open" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "branch B" },
      { role: "assistant", content: [{ type: "text", text: "reply B" }] },
    ]
    const mkProc = (convKey, sessionId, expectedMessages) => ({
      convKey,
      sessionId,
      expectedMessages,
      instructions: "sys",
      instructionsInSession: false,
      workDir: null,
      workspace: null,
      canPark: () => true,
    })

    park(mkProc(base, "sess-A", hA))
    park(mkProc(branch, "sess-B", hB))

    const resumedB = takeParked(base, { workDir: null, instructions: "sys", history: hB })
    assert.equal(resumedB?.sessionId, "sess-B")
    const resumedA = takeParked(base, { workDir: null, instructions: "sys", history: hA })
    assert.equal(resumedA?.sessionId, "sess-A")
  } finally {
    if (prevState === undefined) delete process.env.AGY_BRIDGE_STATE_FILE
    else process.env.AGY_BRIDGE_STATE_FILE = prevState
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

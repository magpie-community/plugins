// plugins#1239: pi declared read, bash, edit and write, and the model saw
// only agy's own manage_task. agy reads a client's tools from the bridge's
// ide-tools MCP server, which it starts by running `nc`; when that never
// runs (agy 1.5 doesn't run the nc.cmd a failed nc.exe build leaves on
// Windows) or never answers, agy lists nothing and the turn went ahead
// without a single client tool. Now such a session fails and says why, a
// live agy that never listed the tools a request declares is replaced, and
// on Windows a failed nc.exe build is tried again.
//
// bun test ./tools-listed.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { READ_TOOL, baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const FAST_WAIT = { AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" }
// The platform-neutral cases run as Linux on every OS; Windows has its own below.
const LINUX = { platform: "linux" }

async function withKit(options, fn) {
  const kit = await createBridgeKit({ ...options, env: { ...FAST_WAIT, ...(options.env || {}) } })
  kit.defaultPrompt = async (agent) => {
    await agent.text("ok")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
  }
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const prompts = (kit) => kit.acpLog.filter((entry) => entry.method === "session/prompt")

// pi's own tool names (the reporter's request), Anthropic shape
const PI_TOOLS = ["read", "bash", "edit", "write"].map((name) => ({
  name,
  description: `pi's ${name}`,
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}))

test("a session whose agy never lists the request's tools fails and says why, with no turn run", async () => {
  await withKit({ ...LINUX, listTools: false }, async (kit) => {
    const response = await kit.request(baseBody({ tools: PI_TOOLS }))
    const text = await response.text()
    assert.equal(response.status, 502, text)
    const error = JSON.parse(text).error
    assert.match(error.message, /agy never loaded the request's 4 tools/)
    assert.match(error.message, /`nc`/)
    assert.equal(prompts(kit).length, 0, "a turn ran with none of the client's tools")
  })
})

test("a request with no tools still runs when agy lists none", async () => {
  await withKit({ ...LINUX, listTools: false }, async (kit) => {
    const parsed = await readSse(await kit.request(baseBody({ tools: [] })))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    assert.equal(parsed.stopReason, "end_turn")
  })
})

test("a live agy that never listed the tools a follow-up declares is replaced by one that does", async () => {
  // agy started for a request with no tools; its MCP server keeps no watch,
  // so a catalog the bridge swaps in is never listed again
  await withKit({ ...LINUX, watchTools: false }, async (kit) => {
    const first = baseBody({ tools: [], messages: [{ role: "user", content: "one" }] })
    assert.equal((await readSse(await kit.request(first))).stopReason, "end_turn")
    const follow = baseBody({
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "one" }, { role: "assistant", content: "ok" }, { role: "user", content: "two" }],
    })
    const parsed = await readSse(await kit.request(follow))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    const last = prompts(kit).at(-1)
    assert.ok(kit.listings.some((listing) => listing.spawn === last.spawn && listing.tools.includes("Read")),
      `the agy that ran the follow-up never listed Read: ${JSON.stringify(kit.listings)}`)
  })
})

test("a live agy that lists the swapped catalog keeps the conversation", async () => {
  await withKit(LINUX, async (kit) => {
    const first = baseBody({ tools: [], messages: [{ role: "user", content: "one" }] })
    assert.equal((await readSse(await kit.request(first))).stopReason, "end_turn")
    const follow = baseBody({
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "one" }, { role: "assistant", content: "ok" }, { role: "user", content: "two" }],
    })
    assert.equal((await readSse(await kit.request(follow))).stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(kit.listings.some((listing) => listing.tools.includes("Read")))
  })
})

test("agy can call tools whose prefixed names would exceed 64 characters", async () => {
  const name = "mcp__synthetic_workspace_connector__read_registered_catalog_marker"
  const boundary = "b".repeat(64 - "mcp_ide-tools_".length)
  const tools = [READ_TOOL, { ...READ_TOOL, name: boundary }, { ...READ_TOOL, name }]
  await withKit(LINUX, async (kit) => {
    let alias
    kit.prompts.push(async (agent) => {
      const { result } = await agent.listTools()
      const listed = result.tools.map((tool) => tool.name)
      assert.deepEqual(listed.slice(0, 2), [READ_TOOL.name, boundary])
      alias = listed[2]
      assert.match("mcp_ide-tools_" + alias, /^[a-zA-Z0-9_-]{1,64}$/)
      assert.notEqual(alias, name)
      assert.deepEqual(result.tools[2].inputSchema, READ_TOOL.input_schema)
      const reply = await agent.tool(alias, { path: "/synthetic" })
      assert.equal(reply.result.content[0].text, "catalog marker")
      await agent.text("ok")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({ tools })
    const first = await readSse(await kit.request(body))
    assert.equal(first.error, null)
    const call = first.content.find((block) => block.type === "tool_use")
    assert.equal(call.name, name)
    assert.deepEqual(call.input, { path: "/synthetic" })
    const next = continueWithToolResults(body, first, () => "catalog marker")
    assert.equal((await readSse(await kit.request(next))).stopReason, "end_turn")

    kit.prompts.push(async (agent) => {
      const { result } = await agent.listTools()
      assert.equal(result.tools[0].name, alias)
      assert.equal(new Set(result.tools.map((tool) => tool.name)).size, 2)
      await agent.text("ok")
      return { stopReason: "end_turn" }
    })
    const follow = baseBody({
      tools: [tools[2], { ...READ_TOOL, name: alias }],
      messages: [
        ...next.messages,
        { role: "assistant", content: "ok" },
        { role: "user", content: "check refreshed catalog" },
      ],
    })
    const refreshed = await readSse(await kit.request(follow))
    assert.equal(refreshed.error, null)
    assert.equal(refreshed.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

// Windows: agy 1.5 runs nc.exe from PATH and never nc.cmd.
const BUN = "C:\\Users\\Test\\magpie\\magpie-bun.exe"
const ncExeFirst = (env) => fs.existsSync(path.join(String(env.PATH).split(path.delimiter)[0], "nc.exe"))

test("Windows: a failed nc.exe build is named in the error and tried again later", async () => {
  let builds = 0
  const onSpawn = (file, args) => {
    if (args[0] !== "build") return 0
    builds++
    if (builds === 1) return 1
    fs.writeFileSync(args[args.indexOf("--outfile") + 1], "MZ fake nc.exe")
    return 0
  }
  await withKit({ platform: "win32", execPath: BUN, versions: { ...process.versions, bun: "1.4.2" }, onSpawn, listTools: ncExeFirst }, async (kit) => {
    const response = await kit.request(baseBody({ tools: PI_TOOLS, system: "first" }))
    const text = await response.text()
    assert.equal(response.status, 502, text)
    const message = JSON.parse(text).error.message
    assert.match(message, /nc\.exe, the program agy runs to reach them, could not be built \(bun build exited with 1/)
    assert.match(message, /nc\.cmd/)
    assert.equal(prompts(kit).length, 0)

    // Not again at once: a build that fails costs up to two minutes.
    await kit.request(baseBody({ tools: PI_TOOLS, system: "second" })).then((r) => r.text())
    assert.equal(builds, 1)

    kit.clock.advance(5 * 60 * 1000)
    const parsed = await readSse(await kit.request(baseBody({ tools: PI_TOOLS, system: "third" })))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    assert.equal(builds, 2)
    assert.ok(kit.listings.some((listing) => listing.tools.includes("read")))
  })
})

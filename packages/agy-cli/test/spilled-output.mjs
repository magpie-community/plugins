import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// agy cut a tool result short and saved the whole of it in its own folder,
// where the client (on another machine than magpie in Docker, Dani Ariyanto
// on Discord) can't read it: the bridge answers that read itself.
function spill(agyDir, text, session = "s1", step = "4") {
  const file = path.join(agyDir, "brain", session, ".system_generated", "steps", step, "output.txt")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

async function readThrough(kit, args) {
  let reply
  kit.prompts.push(async (agent) => {
    const [proc] = [...kit.module.__agyTestAllProcs]
    reply = await agent.tool("Read", args(proc.agyDir))
    if (reply?.result) await agent.text("read it")
  })
  const result = await readSse(await kit.request(baseBody()))
  return { reply, result }
}

test("a read of agy's own saved output is answered by the bridge, never sent to the client", async () => {
  const kit = await createBridgeKit()
  try {
    const { reply, result } = await readThrough(kit, (dir) => ({ path: spill(dir, "alpha\nbeta\ngamma\n") }))
    assert.equal(reply.result.isError, false)
    assert.equal(reply.result.content[0].text, "     1\talpha\n     2\tbeta\n     3\tgamma")
    assert.equal(result.content.find((item) => item.type === "tool_use"), undefined)
    assert.equal(result.content.find((item) => item.type === "text")?.text, "read it")
  } finally {
    await kit.dispose()
  }
})

test("offset and limit pick the lines of a saved output", async () => {
  const kit = await createBridgeKit()
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const { reply } = await readThrough(kit, (dir) => ({ file_path: spill(dir, lines), offset: 4, limit: 2 }))
    assert.equal(reply.result.content[0].text, "     4\tline 4\n     5\tline 5")
  } finally {
    await kit.dispose()
  }
})

test("any other file, or a link out of agy's folder, still goes to the client", async () => {
  for (const place of ["outside", "link", "not a step"]) {
    const kit = await createBridgeKit()
    try {
      const { reply, result } = await readThrough(kit, (dir) => {
        if (place === "outside") return { path: spill(path.join(kit.tmp, "elsewhere"), "x") }
        if (place === "not a step") {
          const file = path.join(dir, "brain", "s1", "notes.txt")
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, "x")
          return { path: file }
        }
        const target = path.join(kit.tmp, "secret.txt")
        fs.writeFileSync(target, "secret")
        const file = path.join(dir, "brain", "s1", ".system_generated", "steps", "4", "output.txt")
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.symlinkSync(target, file)
        return { path: file }
      })
      assert.equal(reply, undefined, `${place}: answered by the bridge`)
      const call = result.content.find((item) => item.type === "tool_use")
      assert.ok(call, `${place}: not sent to the client`)
      assert.equal(call.name, "Read")
    } finally {
      await kit.dispose()
    }
  }
})

test("a tool that isn't a read is never answered from the saved output", async () => {
  const kit = await createBridgeKit()
  try {
    const { result } = await (async () => {
      let reply
      kit.prompts.push(async (agent) => {
        const [proc] = [...kit.module.__agyTestAllProcs]
        reply = await agent.tool("Bash", { command: spill(proc.agyDir, "x") })
      })
      const body = baseBody({ tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] })
      return { reply, result: await readSse(await kit.request(body)) }
    })()
    assert.equal(result.content.find((item) => item.type === "tool_use")?.name, "Bash")
  } finally {
    await kit.dispose()
  }
})

// #1047: on Windows agy's nc dials run a GUI-subsystem nc.exe that Bun builds
// once and every session and later host reuses, never nc.cmd (cmd.exe, a
// console program that can be handed a window and a conhost per dial). At
// exit every agy is ended with its tree, and its workspace is removed.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { windowsNcBuild, windowsTreeKill } from "../platform.mjs"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

function workDir(kit, name) {
  const dir = path.join(kit.tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const BUN = "C:\\Users\\Test\\magpie\\bun.exe"
const body = (text) => baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: text }] })

function buildsOf(kit) {
  return kit.otherSpawns.filter(({ args }) => args[0] === "build")
}

// Stands in for `bun build --compile`: writes the --outfile it was asked for.
function writeOutfile(file, args) {
  if (args[0] !== "build") return 0
  fs.writeFileSync(args[args.indexOf("--outfile") + 1], "MZ fake nc.exe")
  return 0
}

async function windowsKit(options = {}) {
  const kit = await createBridgeKit({ platform: "win32", execPath: BUN, versions: { ...process.versions, bun: "1.4.2" }, onSpawn: writeOutfile, ...options })
  kit.defaultPrompt = async (agent) => {
    await agent.text("ok")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
  }
  return kit
}

async function turn(kit, text, workDir) {
  const parsed = await readSse(await kit.request(body(text), workDir ? { headers: { "x-magpie-work-dir": workDir } } : {}))
  assert.equal(parsed.error, null, JSON.stringify(parsed.error))
  assert.equal(parsed.stopReason, "end_turn")
}

function agyPathDir(kit, index = -1) {
  const env = kit.acpSpawns.at(index).env
  return String(env.PATH).split(path.delimiter)[0]
}

test("windowsNcBuild compiles a hidden-console exe under Bun only", () => {
  assert.deepEqual(windowsNcBuild(BUN, "C:\\p\\mcp-server.mjs", "C:\\t\\nc.exe", { bun: "1.4.2" }), {
    file: BUN,
    args: ["build", "--compile", "--windows-hide-console", "C:\\p\\mcp-server.mjs", "--outfile", "C:\\t\\nc.exe"],
  })
  assert.equal(windowsNcBuild("C:\\opencode\\opencode.exe", "s", "o", { bun: "1.4.2" }), null)
  assert.equal(windowsNcBuild("C:\\node\\node.exe", "s", "o", { node: "22.0.0" }), null)
  assert.equal(windowsNcBuild(BUN, "s", "o", { node: "22.0.0" }), null)
})

test("windowsTreeKill ends every agy with its tree in one run", () => {
  assert.deepEqual(windowsTreeKill([12, 34, 12, 0, undefined, -1]), { file: "taskkill", args: ["/T", "/F", "/PID", "12", "/PID", "34"] })
  assert.equal(windowsTreeKill([undefined]), null)
})

test("Windows sessions dial a shared nc.exe built once, never nc.cmd", async () => {
  const kit = await windowsKit()
  try {
    await turn(kit, "one", workDir(kit, "w1"))
    await turn(kit, "two", workDir(kit, "w2"))
    assert.equal(kit.acpSpawns.length, 2)
    const builds = buildsOf(kit)
    assert.equal(builds.length, 1)
    assert.equal(builds[0].file, BUN)
    assert.ok(builds[0].args.includes("--windows-hide-console"))
    const dir = agyPathDir(kit, 0)
    assert.match(path.basename(dir), /^magpie-agy-bridge-nc-[0-9a-f]{16}$/)
    assert.equal(agyPathDir(kit, 1), dir)
    assert.deepEqual(fs.readdirSync(dir), ["nc.exe"])
    assert.ok(!fs.readdirSync(kit.tmp).some((name) => name.startsWith("magpie-agy-bridge-bin-") || name.startsWith("magpie-agy-bridge-ncbuild-")))

    // A later host with the same runtime and server reuses the exe.
    const later = await windowsKit()
    try {
      fs.cpSync(dir, path.join(later.tmp, path.basename(dir)), { recursive: true })
      await turn(later, "three")
      assert.equal(buildsOf(later).length, 0)
      assert.equal(path.basename(agyPathDir(later)), path.basename(dir))
    } finally {
      await later.dispose()
    }
  } finally {
    await kit.dispose()
  }
})

test("Windows falls back to nc.cmd when the runtime can't build nc.exe", async () => {
  for (const options of [{ execPath: "C:\\opencode\\opencode.exe", versions: { ...process.versions, bun: undefined } }, { onSpawn: () => 1 }]) {
    const kit = await windowsKit(options)
    try {
      await turn(kit, "hi")
      const dir = agyPathDir(kit)
      assert.match(path.basename(dir), /^magpie-agy-bridge-bin-/)
      assert.deepEqual(fs.readdirSync(dir), ["nc.cmd"])
      assert.ok(!fs.readdirSync(kit.tmp).some((name) => name.startsWith("magpie-agy-bridge-nc")))
    } finally {
      await kit.dispose()
    }
  }
})

test("at exit on Windows every live agy's tree is ended and the workspaces removed; the shared nc.exe stays", async () => {
  const kit = await windowsKit()
  try {
    await turn(kit, "one", workDir(kit, "w1"))
    await turn(kit, "two", workDir(kit, "w2"))
    const procs = [...kit.module.__agyTestAllProcs]
    assert.equal(procs.length, 2)
    procs.forEach((proc, index) => { proc.child.pid = 4100 + index })
    const workspaces = procs.map((proc) => proc.workspace)
    const dir = agyPathDir(kit)
    kit.module.__agyTestReapOnExit()
    const kills = kit.spawnSyncs.filter(({ file }) => file === "taskkill")
    assert.equal(kills.length, 1)
    assert.deepEqual(kills[0].args, ["/T", "/F", "/PID", "4100", "/PID", "4101"])
    assert.equal(kills[0].opts.windowsHide, true)
    for (const workspace of workspaces) assert.ok(!fs.existsSync(workspace), workspace)
    assert.ok(fs.existsSync(path.join(dir, "nc.exe")))
  } finally {
    await kit.dispose()
  }
})

test("at exit a shim dir this host made is removed", async () => {
  const kit = await windowsKit({ onSpawn: () => 1 })
  try {
    await turn(kit, "hi")
    const dir = agyPathDir(kit)
    kit.module.__agyTestReapOnExit()
    assert.ok(!fs.existsSync(dir))
  } finally {
    await kit.dispose()
  }
})

// #1047: on Windows agy's nc dials run a GUI-subsystem nc.exe that Bun builds
// once and every session and later host reuses, never nc.cmd (cmd.exe, a
// console program that can be handed a window and a conhost per dial). At
// exit every agy is ended with its tree, and its workspace is removed.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
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
  // magpie's plugin host runs a Bun renamed magpie-bun.exe
  const MAGPIE_BUN = "C:\\Users\\u\\AppData\\Local\\magpie\\bun\\1.4.2\\magpie-bun.exe"
  assert.deepEqual(windowsNcBuild(MAGPIE_BUN, "s", "o", { bun: "1.4.2" }), {
    file: MAGPIE_BUN,
    args: ["build", "--compile", "--windows-hide-console", "s", "--outfile", "o"],
  })
  assert.equal(windowsNcBuild("C:\\x\\magpie-bun.exe", "s", "o", { node: "22.0.0" }), null)
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
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
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

// #1097: Bun's compile can't read its own path when it holds non-ASCII
// characters (a Chinese user name): it fails with "failed to copy bun
// executable into temporary file: ENOENT". The build runs a copy of the
// runtime in an ASCII-only folder, removed after.
test("a runtime under a non-ASCII folder builds nc.exe from an ASCII copy", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nonascii-"))
  const runtimeDir = path.join(outside, "\u6d4b\u8bd5")
  fs.mkdirSync(runtimeDir)
  const runtime = path.join(runtimeDir, "magpie-bun.exe")
  fs.writeFileSync(runtime, "MZ fake bun")
  const seen = []
  const kit = await windowsKit({
    execPath: runtime,
    onSpawn: (file, args) => {
      if (args[0] === "build") seen.push({ file, copied: fs.existsSync(file) && fs.readFileSync(file, "utf8") })
      return writeOutfile(file, args)
    },
  })
  try {
    await turn(kit, "hi")
    const builds = buildsOf(kit)
    assert.equal(builds.length, 1)
    assert.notEqual(builds[0].file, runtime)
    assert.match(builds[0].file, /^[\x20-\x7e]+$/)
    assert.equal(path.basename(builds[0].file), "magpie-bun.exe")
    assert.deepEqual(seen, [{ file: builds[0].file, copied: "MZ fake bun" }])
    const dir = agyPathDir(kit)
    assert.match(path.basename(dir), /^magpie-agy-bridge-nc-[0-9a-f]{16}$/)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    // The copy goes with the build dir.
    for (let i = 0; i < 1000 && fs.existsSync(builds[0].file); i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(builds[0].file), false)
    assert.ok(!fs.readdirSync(kit.tmp).some((name) => name.startsWith("magpie-agy-bridge-ncbuild-")))
  } finally {
    await kit.dispose()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

// #1097 (Hy1an): each nc dir holds a whole Bun runtime (~115MB) and its key
// changes with mcp-server.mjs, so plugin updates piled them up for a week. A
// build drops this runtime's older dirs at once; another runtime's dirs, and
// ones from before the marker, keep the week.
test("a new nc.exe build removes this runtime's older nc dirs and keeps others", async () => {
  const first = await windowsKit()
  let marker
  try {
    await turn(first, "one")
    marker = fs.readFileSync(path.join(agyPathDir(first), "runtime"), "utf8")
    assert.match(marker, /^[0-9a-f]{16}$/)
  } finally {
    await first.dispose()
  }
  const kit = await windowsKit()
  try {
    const plant = (name, runtime) => {
      const dir = path.join(kit.tmp, "magpie-agy-bridge-nc-" + name)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "nc.exe"), "MZ old")
      if (runtime) fs.writeFileSync(path.join(dir, "runtime"), runtime)
      return dir
    }
    const older = plant("aaaaaaaaaaaaaaaa", marker)
    const foreign = plant("bbbbbbbbbbbbbbbb", "0123456789abcdef")
    const legacy = plant("cccccccccccccccc", null)
    await turn(kit, "two")
    assert.equal(buildsOf(kit).length, 1)
    const current = agyPathDir(kit)
    for (let i = 0; i < 1000 && fs.existsSync(older); i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(older), false, "this runtime's older nc dir stayed")
    assert.ok(fs.existsSync(path.join(foreign, "nc.exe")), "another runtime's nc dir was removed")
    assert.ok(fs.existsSync(path.join(legacy, "nc.exe")), "an unmarked nc dir was removed before its week")
    assert.ok(fs.existsSync(path.join(current, "nc.exe")))
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

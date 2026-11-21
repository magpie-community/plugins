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

// #1428: Bun's `bun build --compile` writes a ~115MB copy of itself in the
// build cwd and re-reads it as a PE. A cwd inside %LOCALAPPDATA%\Temp can
// reject that write (Error initializing PE file: InvalidPEFile) while the
// same build outside Temp succeeds. The cached nc.exe stays under tmp, named
// by the same dirKey. A non-ASCII home (#1097) is never a build cwd or a
// place the Bun runtime is copied to.
function under(parent, child) {
  const rel = path.relative(parent, child || "")
  return Boolean(child) && (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)))
}

function ncExeOnPath(env) {
  return fs.existsSync(path.join(String(env.PATH).split(path.delimiter)[0], "nc.exe"))
}

const PE_STDERR = "Error initializing PE file: InvalidPEFile\nfailed to write compiled executable\n"

function peFailure() {
  return { code: 1, stderr: PE_STDERR, exitWithoutClose: true }
}

async function settled(dir) {
  const leftover = () => fs.readdirSync(dir).filter((name) => name.startsWith("magpie-agy-bridge-ncbuild-"))
  for (let i = 0; i < 1000 && leftover().length; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(leftover(), [], dir)
}

test("#1428: a Temp cwd that can hold the PE write builds nc.exe once, in Temp", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-outside-"))
  const kit = await windowsKit({ env: { PUBLIC: outside } })
  try {
    await turn(kit, "one")
    const builds = buildsOf(kit)
    assert.equal(builds.length, 1)
    assert.ok(under(kit.tmp, builds[0].opts.cwd), builds[0].opts.cwd)
    assert.match(path.basename(builds[0].opts.cwd), /^magpie-agy-bridge-ncbuild-/)
    const dir = agyPathDir(kit)
    assert.ok(under(kit.tmp, dir))
    assert.match(path.basename(dir), /^magpie-agy-bridge-nc-[0-9a-f]{16}$/)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    assert.match(fs.readFileSync(path.join(dir, "runtime"), "utf8"), /^[0-9a-f]{16}$/)
    await settled(kit.tmp)
    await settled(outside)
  } finally {
    await kit.dispose()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("#1428: a Temp cwd that rejects the PE write builds nc.exe outside Temp", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-outside-"))
  let tmp = ""
  const seen = []
  const kit = await windowsKit({
    env: { PUBLIC: outside },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      if (under(tmp, opts.cwd)) return peFailure()
      return writeOutfile(file, args)
    },
  })
  tmp = kit.tmp
  try {
    const started = performance.now()
    await turn(kit, "one")
    const elapsed = performance.now() - started
    assert.ok(elapsed < 2_000, `Temp failure still took ${Math.round(elapsed)}ms`)
    assert.deepEqual(seen.map((cwd) => under(tmp, cwd)), [true, false])
    assert.ok(under(outside, seen[1]), seen[1])
    assert.match(path.basename(seen[1]), /^magpie-agy-bridge-ncbuild-/)
    const dir = agyPathDir(kit)
    assert.ok(under(kit.tmp, dir), "the shared nc.exe moved out of the temp cache")
    assert.match(path.basename(dir), /^magpie-agy-bridge-nc-[0-9a-f]{16}$/)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    assert.equal(fs.readFileSync(path.join(dir, "nc.exe"), "utf8"), "MZ fake nc.exe")
    await settled(kit.tmp)
    await settled(outside)

    const later = await windowsKit({ env: { PUBLIC: outside } })
    try {
      fs.cpSync(dir, path.join(later.tmp, path.basename(dir)), { recursive: true })
      await turn(later, "two")
      assert.equal(buildsOf(later).length, 0)
      assert.equal(path.basename(agyPathDir(later)), path.basename(dir))
    } finally {
      await later.dispose()
    }
  } finally {
    await kit.dispose()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("#1428: a non-ASCII home is not a build cwd and not where Bun is copied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-home-"))
  const home = path.join(root, "张三")
  const local = path.join(home, "AppData", "Local")
  const tempDir = path.join(local, "Temp")
  const runtimeDir = path.join(home, ".cache", "magpie", "bun")
  const outside = path.join(root, "Public")
  fs.mkdirSync(tempDir, { recursive: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(outside)
  const runtime = path.join(runtimeDir, "magpie-bun.exe")
  fs.writeFileSync(runtime, "MZ fake bun")
  const seen = []
  const kit = await windowsKit({
    execPath: runtime,
    tmpdir: tempDir,
    env: { LOCALAPPDATA: local, PUBLIC: outside, USERPROFILE: home },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push({ file, cwd: opts.cwd, copied: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" })
      if (opts.cwd.includes("张三")) return peFailure()
      return writeOutfile(file, args)
    },
  })
  try {
    await turn(kit, "hi")
    assert.ok(seen.length >= 1, `expected an outside build, saw ${JSON.stringify(seen)}`)
    assert.ok(seen.every((build) => !build.cwd.includes("张三")), JSON.stringify(seen.map((build) => build.cwd)))
    assert.ok(seen.every((build) => !under(tempDir, build.cwd)), JSON.stringify(seen.map((build) => build.cwd)))
    assert.ok(seen.every((build) => /^[\x20-\x7e]+$/.test(build.file)), JSON.stringify(seen.map((build) => build.file)))
    const built = seen.at(-1)
    assert.ok(under(outside, built.cwd), built.cwd)
    assert.ok(under(outside, built.file), built.file)
    assert.equal(path.basename(built.file), "magpie-bun.exe")
    assert.equal(built.copied, "MZ fake bun")
    const dir = agyPathDir(kit)
    assert.ok(under(tempDir, dir), dir)
    assert.match(path.basename(dir), /^magpie-agy-bridge-nc-[0-9a-f]{16}$/)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    await settled(tempDir)
    await settled(outside)
    assert.equal(fs.readdirSync(local).some((name) => name.startsWith("magpie-agy-bridge-nc")), false)
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: an immediate non-zero build names the cwd, and a second outside failure is not attempted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-fail-"))
  const local = path.join(root, "Local")
  const pub = path.join(root, "Public")
  fs.mkdirSync(local)
  fs.mkdirSync(pub)
  const seen = []
  const kit = await windowsKit({
    env: { LOCALAPPDATA: local, PUBLIC: pub, AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" },
    listTools: ncExeOnPath,
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      return { code: 1, stderr: PE_STDERR }
    },
  })
  try {
    const response = await kit.request(baseBody({
      model: "agy-cli/gemini-4-argon",
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }))
    const text = await response.text()
    assert.equal(response.status, 502, text)
    const message = JSON.parse(text).error.message
    assert.match(message, /bun build exited with 1/)
    assert.match(message, /InvalidPEFile/)
    assert.match(message, new RegExp(`cwd ${seen[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.equal(seen.length, 2, `futile builds: ${JSON.stringify(seen)}`)
    assert.ok(under(kit.tmp, seen[0]))
    assert.ok(under(local, seen[1]), seen[1])
    assert.ok(!seen.some((cwd) => under(pub, cwd)), "a failed outside-Temp build was tried again")
    assert.match(path.basename(agyPathDir(kit)), /^magpie-agy-bridge-bin-/)
    await settled(kit.tmp)
    await settled(local)
    await settled(pub)
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: a build that never exits is not started again outside Temp", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-hang-"))
  const seen = []
  const kit = await windowsKit({
    env: { PUBLIC: outside, AGY_BRIDGE_NC_BUILD_TIMEOUT_MS: "200", AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" },
    listTools: ncExeOnPath,
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      return { hang: true }
    },
  })
  try {
    const started = performance.now()
    const response = await kit.request(baseBody({
      model: "agy-cli/gemini-4-argon",
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }))
    const elapsed = performance.now() - started
    const text = await response.text()
    assert.equal(response.status, 502, text)
    assert.match(JSON.parse(text).error.message, /bun build timed out after 0\.2s/)
    assert.equal(seen.length, 1, `a hung Temp build was repeated: ${JSON.stringify(seen)}`)
    assert.ok(under(kit.tmp, seen[0]))
    assert.ok(elapsed < 2_000, `hung build took ${Math.round(elapsed)}ms`)
    await settled(kit.tmp)
    await settled(outside)
  } finally {
    await kit.dispose()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("#1428: execOnce stops when bun build exits, even if its pipes stay open", async () => {
  const kit = await windowsKit({
    onSpawn: (file, args) => {
      if (args[0] !== "build") return 0
      return peFailure()
    },
  })
  try {
    const started = performance.now()
    const result = await kit.module.__agyTestExecOnce(BUN, ["build", "--compile", "server.mjs", "--outfile", "nc.exe"], {
      cwd: kit.tmp,
      timeoutMs: 5_000,
      exitEnds: true,
    })
    const elapsed = performance.now() - started
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /InvalidPEFile/)
    assert.ok(elapsed < 1_000, `exit waited ${Math.round(elapsed)}ms for close`)
    const child = kit.otherSpawns.at(-1).child
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  } finally {
    await kit.dispose()
  }
})

test("#1428: execOnce reports a signal kill while the pipes stay open", async () => {
  const seen = []
  const kit = await windowsKit({
    env: { LOCALAPPDATA: null, AGY_BRIDGE_NC_BUILD_TIMEOUT_MS: "5000", AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" },
    listTools: ncExeOnPath,
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      return { code: null, signal: "SIGKILL", stderr: "edr\n", exitWithoutClose: true }
    },
  })
  try {
    const started = performance.now()
    const direct = await kit.module.__agyTestExecOnce(BUN, ["build", "--compile", "server.mjs", "--outfile", "nc.exe"], {
      cwd: kit.tmp,
      timeoutMs: 5_000,
      exitEnds: true,
    })
    const directElapsed = performance.now() - started
    assert.equal(direct.timedOut, false)
    assert.equal(direct.code, null)
    assert.equal(direct.signal, "SIGKILL")
    assert.match(direct.stderr, /edr/)
    assert.ok(directElapsed < 1_000, `signal exit waited ${Math.round(directElapsed)}ms`)
    const held = kit.otherSpawns.at(-1).child
    assert.equal(held.stdout.destroyed, true)
    assert.equal(held.stderr.destroyed, true)
    held.stderr.emit("data", "after settle")
    assert.doesNotMatch(direct.stderr, /after settle/)

    seen.length = 0
    const response = await kit.request(baseBody({
      model: "agy-cli/gemini-4-argon",
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }))
    const elapsed = performance.now() - started
    const text = await response.text()
    assert.equal(response.status, 502, text)
    assert.match(JSON.parse(text).error.message, /bun build exited with signal SIGKILL/)
    assert.equal(seen.length, 1, `a signal kill was retried: ${JSON.stringify(seen)}`)
    assert.ok(elapsed < 2_000, `signal kill took ${Math.round(elapsed)}ms`)
  } finally {
    await kit.dispose()
  }
})

test("#1428: execOnce keeps stderr that arrives after exit and before the drain timer", async () => {
  const kit = await windowsKit({
    onSpawn: (file, args) => {
      if (args[0] !== "build") return 0
      return { code: 1, exitWithoutClose: true, stderr: PE_STDERR, stderrDelayMs: 15 }
    },
  })
  try {
    const started = performance.now()
    const result = await kit.module.__agyTestExecOnce(BUN, ["build", "--compile", "server.mjs", "--outfile", "nc.exe"], {
      cwd: kit.tmp,
      timeoutMs: 5_000,
      exitEnds: true,
    })
    const elapsed = performance.now() - started
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /InvalidPEFile/)
    assert.ok(elapsed < 1_000, `drain waited ${Math.round(elapsed)}ms`)
    const child = kit.otherSpawns.at(-1).child
    assert.equal(child.stderr.destroyed, true)
  } finally {
    await kit.dispose()
  }
})

test("#1428: EXDEV on rename stages nc.exe inside the cache dir and leaves no tmp", async () => {
  const original = fs.promises.rename
  const renames = []
  let cache = ""
  fs.promises.rename = async (from, to) => {
    renames.push([String(from), String(to)])
    if (cache && String(to).startsWith(cache) && path.basename(from) === "nc.exe" && path.basename(to) === "nc.exe") {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), { code: "EXDEV" })
    }
    return original.call(fs.promises, from, to)
  }
  const kit = await windowsKit()
  cache = kit.tmp
  try {
    await turn(kit, "one")
    const dir = agyPathDir(kit)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    assert.equal(fs.readFileSync(path.join(dir, "nc.exe"), "utf8"), "MZ fake nc.exe")
    const staged = renames.find(([from, to]) => path.basename(from).startsWith(".nc-") && from.endsWith(".tmp") && path.basename(to) === "nc.exe")
    assert.ok(staged, `expected a staged rename, saw ${JSON.stringify(renames)}`)
    assert.match(path.basename(staged[0]), new RegExp(`^\\.nc-${process.pid}-[0-9a-f]{8}\\.tmp$`))
    assert.equal(path.dirname(staged[0]), dir)
    assert.equal(path.dirname(staged[1]), dir)
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp") || name.startsWith(".nc-")), false)
    assert.equal(fs.readdirSync(kit.tmp).some((name) => name.endsWith(".tmp")), false)
  } finally {
    fs.promises.rename = original
    await kit.dispose()
  }
})

test("#1097: a read-only PUBLIC falls back to ProgramData when copying Bun", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-ro-"))
  const home = path.join(root, "张三")
  const runtimeDir = path.join(home, "bun")
  const pub = path.join(root, "Public")
  const program = path.join(root, "ProgramData")
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(pub)
  fs.mkdirSync(program)
  const originalMkdtemp = fs.promises.mkdtemp
  fs.promises.mkdtemp = async (prefix, options) => {
    if (path.dirname(String(prefix)) === pub) {
      throw Object.assign(new Error(`EACCES: permission denied, mkdtemp '${prefix}'`), { code: "EACCES" })
    }
    return originalMkdtemp.call(fs.promises, prefix, options)
  }
  const runtime = path.join(runtimeDir, "magpie-bun.exe")
  fs.writeFileSync(runtime, "MZ fake bun")
  const seen = []
  const kit = await windowsKit({
    execPath: runtime,
    env: { PUBLIC: pub, ProgramData: program },
    onSpawn: (file, args) => {
      if (args[0] !== "build") return 0
      seen.push({ file, copied: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" })
      return writeOutfile(file, args)
    },
  })
  try {
    await turn(kit, "hi")
    assert.equal(seen.length, 1, JSON.stringify(seen))
    assert.ok(under(program, seen[0].file), seen[0].file)
    assert.ok(!under(pub, seen[0].file), seen[0].file)
    assert.ok(!under(kit.tmp, seen[0].file), seen[0].file)
    assert.equal(path.basename(seen[0].file), "magpie-bun.exe")
    assert.equal(seen[0].copied, "MZ fake bun")
    const dir = agyPathDir(kit)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    await settled(program)
    await settled(kit.tmp)
  } finally {
    fs.promises.mkdtemp = originalMkdtemp
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: a base where copying Bun fails at copyFile is skipped for build cwd so ProgramData runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-copyfail-"))
  const home = path.join(root, "张三")
  const runtimeDir = path.join(home, "bun")
  const pub = path.join(root, "Public")
  const program = path.join(root, "ProgramData")
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(pub)
  fs.mkdirSync(program)
  const runtime = path.join(runtimeDir, "magpie-bun.exe")
  fs.writeFileSync(runtime, "MZ fake bun")
  const originalCopy = fs.promises.copyFile
  fs.promises.copyFile = async (src, dest, mode) => {
    if (under(pub, String(dest))) {
      throw Object.assign(new Error(`EACCES: blocked exe write '${dest}'`), { code: "EACCES" })
    }
    return originalCopy.call(fs.promises, src, dest, mode)
  }
  let scratch = ""
  const seen = []
  const kit = await windowsKit({
    execPath: runtime,
    env: { PUBLIC: pub, ProgramData: program },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push({ file, cwd: opts.cwd })
      if (under(scratch, opts.cwd)) return peFailure()
      return writeOutfile(file, args)
    },
  })
  scratch = kit.tmp
  try {
    await turn(kit, "hi")
    assert.equal(seen.length, 2, JSON.stringify(seen))
    assert.ok(under(program, seen[0].file), seen[0].file)
    assert.ok(under(scratch, seen[0].cwd), seen[0].cwd)
    assert.ok(under(program, seen[1].cwd), seen[1].cwd)
    assert.ok(seen.every((entry) => !under(pub, entry.cwd)), JSON.stringify(seen))
    await settled(program)
    await settled(pub)
    await settled(scratch)
  } finally {
    fs.promises.copyFile = originalCopy
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: empty ASCII build bases with an ASCII Bun reports no ASCII build folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-nobase-"))
  const nonAsciiTmp = path.join(root, "张三", "Temp")
  fs.mkdirSync(nonAsciiTmp, { recursive: true })
  const seen = []
  const kit = await windowsKit({
    tmpdir: nonAsciiTmp,
    env: {
      TEMP: nonAsciiTmp,
      TMP: nonAsciiTmp,
      LOCALAPPDATA: path.join(root, "张三", "Local"),
      PUBLIC: null,
      ProgramData: null,
      AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200",
    },
    listTools: ncExeOnPath,
    onSpawn: (file, args) => {
      if (args[0] !== "build") return 0
      seen.push(file)
      return writeOutfile(file, args)
    },
  })
  try {
    const response = await kit.request(baseBody({
      model: "agy-cli/gemini-4-argon",
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }))
    const text = await response.text()
    assert.equal(response.status, 502, text)
    const message = JSON.parse(text).error.message
    assert.match(message, /no ASCII-only folder available to build nc\.exe/)
    assert.equal(seen.length, 0)
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: a non-ASCII Bun runtime is copied outside an 8.3 ASCII Temp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-83-"))
  const home = path.join(root, "张三")
  const runtimeDir = path.join(home, "bun")
  const shortTemp = path.join(root, "ZHANGS~1", "AppData", "Local", "Temp")
  const pub = path.join(root, "Public")
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(shortTemp, { recursive: true })
  fs.mkdirSync(pub)
  const runtime = path.join(runtimeDir, "magpie-bun.exe")
  fs.writeFileSync(runtime, "MZ fake bun")
  const seen = []
  const kit = await windowsKit({
    execPath: runtime,
    tmpdir: shortTemp,
    env: {
      TEMP: shortTemp,
      TMP: shortTemp,
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      PUBLIC: pub,
    },
    onSpawn: (file, args) => {
      if (args[0] !== "build") return 0
      seen.push({ file, copied: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" })
      return writeOutfile(file, args)
    },
  })
  try {
    await turn(kit, "hi")
    assert.equal(seen.length, 1, JSON.stringify(seen))
    assert.ok(under(pub, seen[0].file), seen[0].file)
    assert.equal(path.basename(seen[0].file), "magpie-bun.exe")
    assert.equal(seen[0].copied, "MZ fake bun")
    assert.ok(!under(shortTemp, seen[0].file), seen[0].file)
    assert.match(seen[0].file, /^[\x20-\x7e]+$/)
    const dir = agyPathDir(kit)
    assert.ok(under(shortTemp, dir), dir)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
    await settled(shortTemp)
    await settled(pub)
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: a lowercase TMP directory is a Temp root, so a dir inside it is not a build cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-roots-"))
  const tmpRoot = path.join(root, "TmpRoot")
  const nested = path.join(tmpRoot, "Public")
  const program = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-program-"))
  fs.mkdirSync(nested, { recursive: true })
  let scratch = ""
  const seen = []
  const kit = await windowsKit({
    env: { LOCALAPPDATA: null, TMP: null, tmp: tmpRoot, PUBLIC: nested, ProgramData: program },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      if (under(scratch, opts.cwd) || under(nested, opts.cwd)) return peFailure()
      return writeOutfile(file, args)
    },
  })
  scratch = kit.tmp
  try {
    await turn(kit, "one")
    assert.equal(seen.length, 2, JSON.stringify(seen))
    assert.ok(under(scratch, seen[0]), seen[0])
    assert.ok(under(program, seen[1]), seen[1])
    assert.ok(seen.every((cwd) => !under(nested, cwd)), JSON.stringify(seen))
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(program, { recursive: true, force: true })
  }
})

test("#1428: LOCALAPPDATA\\Temp is a Temp root when the env name is lowercase", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-localtemp-"))
  const local = path.join(root, "Local")
  const blocked = path.join(local, "Temp", "Public")
  const program = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-program-"))
  fs.mkdirSync(blocked, { recursive: true })
  const originalMkdtemp = fs.promises.mkdtemp
  fs.promises.mkdtemp = async (prefix, options) => {
    if (path.dirname(String(prefix)) === local) {
      throw Object.assign(new Error(`EACCES: permission denied, mkdtemp '${prefix}'`), { code: "EACCES" })
    }
    return originalMkdtemp.call(fs.promises, prefix, options)
  }
  let scratch = ""
  const seen = []
  const kit = await windowsKit({
    env: { LOCALAPPDATA: null, localappdata: local, PUBLIC: blocked, ProgramData: program },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      if (under(scratch, opts.cwd) || under(blocked, opts.cwd)) return peFailure()
      return writeOutfile(file, args)
    },
  })
  scratch = kit.tmp
  try {
    await turn(kit, "one")
    assert.equal(seen.length, 2, JSON.stringify(seen))
    assert.ok(under(scratch, seen[0]), seen[0])
    assert.ok(under(program, seen[1]), seen[1])
    assert.ok(seen.every((cwd) => !under(blocked, cwd)), JSON.stringify(seen))
  } finally {
    fs.promises.mkdtemp = originalMkdtemp
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(program, { recursive: true, force: true })
  }
})

test("#1428: Windows build bases dedupe case-insensitively, and a lowercase programdata is used", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-case-"))
  const pub = path.join(root, "Public")
  fs.mkdirSync(pub)
  const missing = path.join(root, "Missing", "Public")
  const forwardUpper = missing.replace(/\\/g, "/").toUpperCase()
  const backLower = missing.replace(/\//g, "\\").toLowerCase()
  const original = fs.promises.mkdtemp
  const calls = []
  fs.promises.mkdtemp = async (prefix, options) => {
    calls.push(String(prefix))
    return original.call(fs.promises, prefix, options)
  }
  let scratch = ""
  const seen = []
  const kit = await windowsKit({
    env: {
      LOCALAPPDATA: null,
      LocalAppData: forwardUpper,
      PUBLIC: backLower,
      programdata: pub,
    },
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      if (under(scratch, opts.cwd)) return peFailure()
      return writeOutfile(file, args)
    },
  })
  scratch = kit.tmp
  try {
    await turn(kit, "one")
    assert.equal(seen.length, 2, JSON.stringify(seen))
    assert.ok(under(scratch, seen[0]), seen[0])
    assert.ok(under(pub, seen[1]), seen[1])
    const deduped = calls.filter((prefix) => /missing[/\\]+public/i.test(prefix))
    assert.equal(deduped.length, 1, calls.join("\n"))
    const dir = agyPathDir(kit)
    assert.deepEqual(fs.readdirSync(dir).sort(), ["nc.exe", "runtime"])
  } finally {
    fs.promises.mkdtemp = original
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: a base that cannot hold a build dir names that directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nc-mkdir-"))
  const pub = path.join(root, "Public")
  fs.writeFileSync(pub, "not a directory")
  const seen = []
  const kit = await windowsKit({
    env: { PUBLIC: pub, LOCALAPPDATA: null, AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" },
    listTools: ncExeOnPath,
    onSpawn: (file, args, opts) => {
      if (args[0] !== "build") return 0
      seen.push(opts.cwd)
      return { code: 1, stderr: PE_STDERR }
    },
  })
  try {
    const response = await kit.request(baseBody({
      model: "agy-cli/gemini-4-argon",
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }))
    const text = await response.text()
    assert.equal(response.status, 502, text)
    const message = JSON.parse(text).error.message
    assert.match(message, new RegExp(`could not create build dir in ${pub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.doesNotMatch(message, /bun build exited with an error/)
    assert.equal(seen.length, 1)
    assert.ok(under(kit.tmp, seen[0]), seen[0])
  } finally {
    await kit.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("#1428: build dir cleanup retries a busy Windows handle", async () => {
  const original = fs.promises.rm
  const calls = []
  fs.promises.rm = async (target, options) => {
    calls.push({ target: String(target), options })
    return original.call(fs.promises, target, options)
  }
  const kit = await windowsKit()
  try {
    await turn(kit, "one")
    await settled(kit.tmp)
    const buildRm = calls.filter((call) => call.target.includes("magpie-agy-bridge-ncbuild-"))
    assert.ok(buildRm.length >= 1, JSON.stringify(calls))
    for (const call of buildRm) {
      assert.equal(call.options.recursive, true)
      assert.equal(call.options.force, true)
      assert.equal(call.options.maxRetries, 3)
      assert.equal(call.options.retryDelay, 100)
    }
  } finally {
    fs.promises.rm = original
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

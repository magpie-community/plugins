// The migration of the legacy agent-lens samples into harnessweight is done
// on the way to the path, so two hosts (the hook and the service) can reach
// it at the same time. These tests pin the outcome of that race: one path,
// and no sample left behind.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, realpathSync, rmSync, readdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"
import { spawn } from "node:child_process"
import { magpieDir, toolsLog, usageLog } from "../lib/paths.mjs"

const PATHS_URL = new URL("../lib/paths.mjs", import.meta.url).href

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hw-migration-")))
  return dir
}

// A config dir that still holds the legacy samples.
function legacy(base, rows = [{ t: Date.now(), agent: "dsh", id: "legacy" }]) {
  writeFileSync(join(base, "plugins.json"), "{}")
  mkdirSync(join(base, "agent-lens"))
  writeFileSync(join(base, "agent-lens", "tools.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""))
  return base
}

function cleanup(dir) {
  try { chmodSync(dir, 0o755) } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })
}

test("a host that already migrated is never sent back to the legacy directory", () => {
  const base = sandbox()
  try {
    // The other host won the race: the new directory is there, the old one
    // is gone.
    mkdirSync(join(base, "harnessweight"))
    writeFileSync(join(base, "harnessweight", "tools.jsonl"), "")
    assert.equal(toolsLog({ directory: base }), join(base, "harnessweight", "tools.jsonl"))
  } finally {
    cleanup(base)
  }
})

test("both directories present keeps the new one and leaves the legacy samples alone", () => {
  const base = sandbox()
  try {
    legacy(base)
    mkdirSync(join(base, "harnessweight"))
    writeFileSync(join(base, "harnessweight", "tools.jsonl"), "")
    assert.equal(toolsLog({ directory: base }), join(base, "harnessweight", "tools.jsonl"))
    // The legacy samples are untouched, not moved and not deleted.
    assert.equal(existsSync(join(base, "agent-lens", "tools.jsonl")), true)
  } finally {
    cleanup(base)
  }
})

test("a migration that cannot happen keeps the legacy directory usable", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, () => {
  const base = sandbox()
  try {
    legacy(base)
    chmodSync(base, 0o555)
    // The rename cannot succeed here, so the samples must stay readable
    // where they are instead of pointing at a directory that never appears.
    assert.equal(toolsLog({ directory: base }), join(base, "agent-lens", "tools.jsonl"))
    assert.equal(existsSync(join(base, "agent-lens", "tools.jsonl")), true)
  } finally {
    cleanup(base)
  }
})

// Hosts that ask for the path at the same time must get the same answer.
// The loser of the rename is the interesting one: the samples are already
// moved, so answering with the legacy path would hide them.
test("concurrent hosts agree on one path and every sample survives", async () => {
  const base = sandbox()
  try {
    legacy(base, Array.from({ length: 50 }, (_, i) => ({ t: Date.now(), agent: "dsh", id: "row-" + i })))
    const workers = 8
    mkdirSync(join(base, "ready"))
    const child = `
      import { writeFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      import { toolsLog } from ${JSON.stringify(PATHS_URL)};
      const base = ${JSON.stringify(base)};
      writeFileSync(join(base, "ready", ${JSON.stringify("x")} + process.argv[1]), "");
      while (!existsSync(join(base, "go"))) await new Promise((r) => setTimeout(r, 2));
      process.stdout.write(toolsLog({ directory: base }));
    `
    const runs = Array.from({ length: workers }, (_, i) => new Promise((resolve, reject) => {
      const child1 = spawn(process.execPath, ["--input-type=module", "-e", child, String(i)], { encoding: "utf8" })
      let out = ""
      let err = ""
      child1.stdout.on("data", (c) => { out += c })
      child1.stderr.on("data", (c) => { err += c })
      child1.on("error", reject)
      child1.on("close", (code) => resolve({ code, out, err }))
    }))
    // Release them together.
    const deadline = Date.now() + 10000
    while (existsSync(join(base, "ready")) && Date.now() < deadline) {
      const ready = readdirSync(join(base, "ready"))
      if (ready.length >= workers) break
      await new Promise((r) => setTimeout(r, 10))
    }
    writeFileSync(join(base, "go"), "")
    const results = await Promise.all(runs)
    for (const r of results) assert.equal(r.code, 0, r.err)
    const paths = new Set(results.map((r) => r.out))
    assert.equal(paths.size, 1, "every host must name the same file: " + [...paths].join(", "))
    const expected = join(base, "harnessweight", "tools.jsonl")
    assert.equal([...paths][0], expected)
    // The migration happened exactly once and the samples are all there.
    assert.equal(existsSync(join(base, "agent-lens")), false)
    const rows = readFileSync(expected, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(rows.length, 50)
    assert.equal(new Set(rows.map((r) => r.id)).size, 50)
  } finally {
    cleanup(base)
  }
})

test("hook and service agree on the path in every branch", () => {
  const base = sandbox()
  try {
    legacy(base)
    // The host names the directory (service) and runs the hook with the
    // same directory as its working directory (hook). Both must land on
    // the same file, whichever spelling they use.
    const fromService = toolsLog({ directory: base })
    const fromHook = toolsLog({ directory: join(base, "..", base.split("/").pop()) })
    assert.equal(fromService, fromHook)
    assert.equal(fromService, join(base, "harnessweight", "tools.jsonl"))
    // The usage log follows the same directory.
    assert.equal(usageLog({ directory: base }), join(base, "usage.jsonl"))
    // An explicit data directory is used as given, by both sides.
    const data = join(base, "samples")
    mkdirSync(data)
    assert.equal(toolsLog({ directory: base, dataDir: data }), join(data, "tools.jsonl"))
    assert.equal(usageLog({ directory: base, usageLog: join(base, "u.jsonl") }), join(base, "u.jsonl"))
  } finally {
    cleanup(base)
  }
})

test("a symlinked config dir is named the same way by both hosts", () => {
  const base = sandbox()
  const linkPath = join(dirname(base), "hw-migration-link-" + basename(base))
  try {
    legacy(base)
    symlinkSync(base, linkPath)
    const real = realpathSync(base)
    // The service is told the symlinked path, the hook sees the real one.
    assert.equal(toolsLog({ directory: linkPath }), join(real, "harnessweight", "tools.jsonl"))
    assert.equal(toolsLog({ directory: real }), join(real, "harnessweight", "tools.jsonl"))
    assert.equal(magpieDir({ directory: linkPath }), real)
  } finally {
    rmSync(linkPath, { force: true })
    cleanup(base)
  }
})

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(root, "bridge.mjs"), "utf8")
const cases = [
  ["no lock", "a second process cannot write", text => text
    .replace('return locked(p, () => {', 'return (() => {')
    .replace('    return "connected"\n  })\n}', '    return "connected"\n  })()\n}')],
  ["no stale-lock recovery", "reclaims a crashed writer", text => text.replace('fs.unlinkSync(lock)\n      return locked(p, fn)', 'throw new Error("stale lock")')],
  ["no commit precondition", "rejects a user edit between read", text => text.replace('if (read(file) !== before) throw new Error("Configuration changed during update; retry")', '')],
  ["no restore duplicate guard", "disconnect refuses duplicated", text => text.replace('if (matches.length > 1) throw new Error("Managed plugin duplicated; retain Yuri recovery files")', '')],
  ["no URL guard", "rejects non-HTTP", text => text.replace('if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Magpie API URL")', '')],
  ["no key charset guard", "rejects whitespace, control", text => text.replace(' || !/^[\\x21-\\x7e]+$/.test(control.gatewayKey)', '')],
  ["no recovery target guard", "recovery refuses a journal targeting", text => text.replace('if (!p.configs.includes(pending.file)) throw new Error("Recovery target changed; retain Yuri recovery files")', '')],
]

for (const [name, pattern, mutate] of cases) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yuri-mutation-"))
  try {
    for (const file of ["package.json", "yuri.test.mjs", "bridge.mjs", "index.mjs", "yuri.agent.js"]) {
      fs.copyFileSync(path.join(root, file), path.join(directory, file))
    }
    fs.cpSync(path.join(root, "vendor"), path.join(directory, "vendor"), { recursive: true })
    const run = () => spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, "yuri.test.mjs"], { cwd: directory, encoding: "utf8", timeout: 20_000 })
    const baseline = run()
    assert.equal(baseline.status, 0, `${name}: baseline failed\n${baseline.stdout}${baseline.stderr}`)
    const mutant = mutate(source)
    assert.notEqual(mutant, source, `${name}: guarded source line moved`)
    fs.writeFileSync(path.join(directory, "bridge.mjs"), mutant)
    const syntax = spawnSync(process.execPath, ["--check", "bridge.mjs"], { cwd: directory, encoding: "utf8" })
    assert.equal(syntax.status, 0, `${name}: mutation must stay valid JavaScript`)
    const result = run()
    assert.notEqual(result.status, 0, `${name}: mutation survived`)
    assert.equal(result.signal, null, `${name}: test must fail, not time out`)
    console.log(`KILLED: ${name}`)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

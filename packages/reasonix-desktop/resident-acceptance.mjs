// Exercise normal plugin disable in a real resident Magpie host. No accounts,
// real agent configuration, or inference requests are used.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { parseTOML } from "./vendor.mjs"

const exec = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-resident-"))
const repo = path.resolve(fileURLToPath(new URL(".", import.meta.url)))
const magpie = process.env.MAGPIE_BIN || "magpie"
const probe = net.createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const addr = `127.0.0.1:${port}`
const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"), XDG_STATE_HOME: path.join(root, ".state"), REASONIX_HOME: path.join(root, ".reasonix"), REASONIX_STATE_HOME: path.join(root, ".reasonix-state"), MAGPIE_NO_ACCOUNTS: "1", MAGPIE_ADDR: addr }
const dir = env.REASONIX_HOME
const config = path.join(dir, "config.toml")
const credentials = path.join(dir, ".env")
const original = '# resident fixture\ndefault_model = "mine/model"\n'
const run = args => exec(magpie, args, { cwd: root, env, timeout: 120000, maxBuffer: 2 << 20 })
const until = async predicate => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error("Resident Magpie did not complete the expected state transition")
}
let child
let closed
try {
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "magpie"), { recursive: true })
  fs.writeFileSync(config, original)
  fs.writeFileSync(credentials, "OTHER_KEY=fixture-original\n")
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "magpie/providers.json"), JSON.stringify({ providers: [{ id: "fixture", name: "Fixture", key: "fixture-only", chat: "http://127.0.0.1:9/v1", models: ["model"] }] }))
  await run(["plugin", "add", repo])
  await run(["reasonix-desktop", "fixture/model"])
  child = spawn(magpie, ["serve"], { cwd: root, env, stdio: "ignore" })
  closed = new Promise(resolve => child.once("exit", resolve))
  await until(async () => {
    try { return (await fetch(`http://${addr}/api/hello`, { signal: AbortSignal.timeout(500) })).ok } catch { return false }
  })
  await fetch(`http://${addr}/v1/models`, { signal: AbortSignal.timeout(10000) })
  await until(() => parseTOML(fs.readFileSync(config, "utf8")).default_model === "magpie-agent/fixture/model")
  await run(["plugin", "off", repo])
  // Refreshing the catalog observes plugins.json and closes the old host.
  await fetch(`http://${addr}/v1/models`, { signal: AbortSignal.timeout(10000) })
  await until(() => fs.readFileSync(config, "utf8") === original)
  assert.equal(fs.readFileSync(credentials, "utf8"), "OTHER_KEY=fixture-original\n")
  console.log("PASS: disabling the plugin with resident Magpie restores TOML and credentials without a manual sync")
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
    await closed
    clearTimeout(timer)
  }
  fs.rmSync(root, { recursive: true, force: true })
}

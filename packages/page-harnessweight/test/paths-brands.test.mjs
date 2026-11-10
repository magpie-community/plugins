import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { magpieDir, usageLog, toolsLog } from "../lib/paths.mjs"
import { gatewayUrl } from "../lib/brands.mjs"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"

function isolated(fn) {
  const dir = mkdtempSync(join(tmpdir(), "harnessweight-paths-"))
  const cwd = process.cwd()
  const keys = ["XDG_CONFIG_HOME", "MAGPIE_ADDR", "MAGPIE_GATEWAY_URL", "HOME"]
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  process.env.HOME = realpathSync(dir)
  process.chdir(dir)
  try { return fn(dir) } finally {
    process.chdir(cwd)
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k]
      else process.env[k] = previous[k]
    }
    // dir is the absolute directory created by mkdtempSync above.
    rmSync(realpathSync(dir), { recursive: true, force: true })
  }
}

test("hook process and service process select the same files", () => isolated((dir) => {
  const real = realpathSync(dir)
  writeFileSync(join(real, "plugins.json"), "{}")
  // The host runs the hook with its cwd on the config dir; the service is
  // told the same dir through input.directory. Two processes, one answer.
  const hook = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { toolsLog, usageLog } from ${JSON.stringify(new URL("../lib/paths.mjs", import.meta.url).href)}
    process.stdout.write(JSON.stringify({ tools: toolsLog(), usage: usageLog() }))
  `], { cwd: real, encoding: "utf8", timeout: 10000 })
  assert.equal(hook.status, 0, hook.stderr || String(hook.error || ""))
  const fromHook = JSON.parse(hook.stdout)
  assert.equal(fromHook.tools, join(real, "harnessweight", "tools.jsonl"))
  assert.equal(fromHook.usage, join(real, "usage.jsonl"))
  assert.equal(fromHook.tools, toolsLog({ directory: real }))
  assert.equal(fromHook.usage, usageLog({ directory: real }))
}))

test("server forwards host input.directory to its usage and tools readers", async () => {
  const entry = new URL("../index.mjs", import.meta.url).href
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harnessweight-portable-")))
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"
      const { default: plugin } = await import(${JSON.stringify(entry)})
      assert.equal(process.env.HARNESSWEIGHT_PORT, undefined)
      await plugin.server({ directory: ${JSON.stringify(directory)} }, { token: "test", port: ${port} })
      let response
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          response = await fetch("http://127.0.0.1:${port}/api/summary?k=test")
          break
        } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
      }
      assert.ok(response, "service should start")
      const body = await response.json()
      assert.equal(body.sources.usageLog, ${JSON.stringify(join(directory, "usage.jsonl"))})
      assert.equal(body.sources.toolsLog, ${JSON.stringify(join(directory, "harnessweight", "tools.jsonl"))})
      process.exit(0)
    `], { encoding: "utf8", timeout: 10000 })
    assert.equal(result.status, 0, result.stderr || String(result.error || ""))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("portable host directory wins, including a fresh directory", () => isolated((dir) => {
  process.env.XDG_CONFIG_HOME = join(dir, "xdg")
  writeFileSync(join(dir, "providers.json"), "{}")
  const directory = join(realpathSync(dir), "fresh-portable")
  assert.equal(magpieDir({ directory }), directory)
  assert.equal(usageLog({ directory }), join(directory, "usage.jsonl"))
  assert.equal(toolsLog({ directory }), join(directory, "harnessweight", "tools.jsonl"))
  assert.equal(usageLog({ directory, usageLog: "custom.jsonl" }), resolve("custom.jsonl"))
  assert.equal(toolsLog({ directory, dataDir: "samples" }), resolve("samples/tools.jsonl"))
}))

for (const marker of ["usage.jsonl", "plugins.json", "providers.json"]) {
  test(`hook cwd and service input agree with ${marker}`, () => isolated((dir) => {
    process.env.XDG_CONFIG_HOME = join(dir, "wrong-xdg")
    writeFileSync(join(dir, marker), "")
    const real = realpathSync(dir)
    assert.equal(magpieDir(), real)
    assert.equal(magpieDir({ directory: dir }), real)
    assert.equal(usageLog(), usageLog({ directory: dir }))
    assert.equal(toolsLog(), toolsLog({ directory: dir }))
  }))
}

test("a symlinked config dir names the same directory as its real path", () => isolated((dir) => {
  writeFileSync(join(dir, "plugins.json"), "{}")
  const link = join(dir, "link")
  symlinkSync(dir, link)
  const real = realpathSync(dir)
  assert.equal(magpieDir({ directory: link }), real)
  assert.equal(magpieDir({ directory: dir }), real)
  assert.equal(magpieDir({ directory: join(link, "not-yet") }), join(real, "not-yet"))
}))

test("standalone uses absolute XDG and rejects relative XDG", () => isolated((dir) => {
  const expectedHome = magpieDir({ directory: join(homedir(), ".config", "magpie") })
  assert.equal(magpieDir(), expectedHome)
  process.env.XDG_CONFIG_HOME = "relative-config"
  assert.equal(magpieDir(), expectedHome)
  process.env.XDG_CONFIG_HOME = join(dir, "xdg")
  assert.equal(magpieDir(), join(realpathSync(dir), "xdg", "magpie"))
}))

test("legacy samples migrate within the selected portable directory", () => isolated((dir) => {
  writeFileSync(join(dir, "plugins.json"), "{}")
  const real = realpathSync(dir)
  mkdirSync(join(real, "agent-lens"))
  writeFileSync(join(real, "agent-lens", "tools.jsonl"), "sample\n")
  assert.equal(toolsLog(), join(real, "harnessweight", "tools.jsonl"))
  assert.equal(existsSync(join(real, "harnessweight", "tools.jsonl")), true)
  assert.equal(existsSync(join(real, "agent-lens")), false)
}))

test("gateway respects explicit overrides and host address forms", () => isolated(() => {
  assert.equal(gatewayUrl(), "http://127.0.0.1:3425")
  for (const [addr, expected] of [
    ["localhost:18086", "localhost:18086"],
    [" 127.0.0.1:1234 ", "127.0.0.1:1234"],
    ["0.0.0.0:1234", "127.0.0.1:1234"],
    ["[::]:1234", "127.0.0.1:1234"],
    ["[::1]:1234", "[::1]:1234"],
    ["[2001:DB8::1]:1234", "[2001:DB8::1]:1234"],
  ]) {
    process.env.MAGPIE_ADDR = addr
    assert.equal(gatewayUrl(), `http://${expected}`)
  }
  for (const addr of ["bad", "::1:1234", "localhost:abc", "host:123/path"]) {
    process.env.MAGPIE_ADDR = addr
    assert.equal(gatewayUrl(), "http://127.0.0.1:3425")
  }
  process.env.MAGPIE_ADDR = "localhost:18086"
  process.env.MAGPIE_GATEWAY_URL = "https://gateway.example/"
  assert.equal(gatewayUrl(), "https://gateway.example")
  assert.equal(gatewayUrl({ gatewayUrl: "http://custom:8080///" }), "http://custom:8080")
}))

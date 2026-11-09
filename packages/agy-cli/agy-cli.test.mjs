// Runs the suites in test/ (brought over from gitxm/yce-magpie-agy, MIT), each
// in a bun process of its own: they mock node:child_process, move the clock and
// set the bridge's environment, and smoke.mjs ends with process.exit.
import { expect, test } from "bun:test"
import path from "node:path"

const dir = path.join(import.meta.dir, "test")
const hook = path.join(dir, "cp-hook.mjs")

function run(args, timeout) {
  const result = Bun.spawnSync({ cmd: [process.execPath, ...args], cwd: dir, env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) console.error(output)
  return { code: result.exitCode, output }
}

for (const [name, mocks] of [
  ["platform.mjs", true],
  ["compat.mjs", true],
  ["prompt-guard.mjs", false],
  ["upstream-error.mjs", false],
  ["tool-schema.mjs", false],
  ["step-usage.mjs", false],
  ["mcp-server.mjs", false],
  ["usage.mjs", true],
  ["catalog.mjs", false],
  ["usage-settlement.mjs", false],
  ["repeat-batch.mjs", false],
]) {
  test(`test/${name}`, () => {
    const { code, output } = run(["test", "--timeout", "30000", ...(mocks ? ["--preload", hook] : []), `./${name}`], 240_000)
    expect(output).toMatch(/\b[1-9]\d* pass\b/)
    expect(code).toBe(0)
  }, 250_000)
}

test("test/smoke.mjs against a fake agy", () => {
  const { code, output } = run([path.join(dir, "smoke.mjs")], 240_000)
  expect(output).toMatch(/ALL OK \(\d+ checks\)/)
  expect(code).toBe(0)
}, 250_000)

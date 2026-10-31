import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = import.meta.dir
const script = join(dir, "bin", "agent-office.mjs")
const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-cli-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const SECRET = "SECRET-CLI-PROMPT"
function homeWithSession() {
  const h = tmp()
  const project = join(h, ".claude", "projects", "-tmp-cli-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/tmp/cli-project", timestamp: "2026-10-28T10:00:00.000Z", message: { role: "user", content: SECRET } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/tmp/cli-project", timestamp: "2026-10-28T10:01:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
  ].join("\n"))
  return h
}

function envFor(home) {
  const cfg = tmp()
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: join(home, ".cache") }
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "OMP_HOME", "OMP_CONFIG_DIR", "KIMI_CODE_HOME", "KIMI_CONFIG_DIR", "GROK_HOME", "GROK_CONFIG_DIR", "COPILOT_HOME", "COPILOT_CONFIG_DIR", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "MAGPIE_AGENT_OFFICE_PAGE", "WMAD_OMP_SESSIONS_DIR"]) delete env[k]
  return env
}

function run(args, home) {
  const r = Bun.spawnSync({ cmd: [process.execPath, script, ...args], cwd: dir, env: envFor(home), stdout: "pipe", stderr: "pipe" })
  expect(r.exitCode).toBe(0)
  return new TextDecoder().decode(r.stdout)
}

test("--json prints the same snapshot and honours --private", () => {
  const h = homeWithSession()
  const snap = JSON.parse(run(["--json", "--hours", "1"], h))
  expect(snap.text).toBe(true)
  expect(snap.sessions.length).toBe(1)
  expect(snap.sessions[0].project).toBe("cli-project")
  expect(snap.sessions[0].title).toBe(SECRET)
  expect(snap.sessions[0].query).toBe(SECRET)

  const priv = JSON.parse(run(["--json", "--hours", "1", "--private"], h))
  expect(priv.text).toBe(false)
  expect(priv.sessions[0].query).toBe("")
  expect(priv.sessions[0].messages).toEqual([])
  const text = JSON.stringify(priv)
  expect(text).not.toContain(SECRET)
})

test("the standalone server serves the page, live data and options", async () => {
  const h = homeWithSession()
  const proc = Bun.spawn({ cmd: [process.execPath, script, "--no-open", "--port", "0", "--hours", "1"], cwd: dir, env: envFor(h), stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ""
  const deadline = Date.now() + 8000
  try {
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ value: new Uint8Array(), done: false }), 500))])
      if (r.done) break
      out += decoder.decode(r.value, { stream: true })
    }
    expect(out).toMatch(/http:\/\/127\.0\.0\.1:\d+/)
    const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const ping = await (await fetch(base + "/api/ping")).json()
    expect(ping.name).toBe("agent-office")
    const page = await (await fetch(base + "/")).text()
    expect(page).toContain("Agent Office")
    const live = await (await fetch(base + "/live.js")).text()
    expect(live).toContain(SECRET)
    const opts = await (await fetch(base + "/api/options", { method: "POST", body: JSON.stringify({ text: false }) })).json()
    expect(opts.text).toBe(false)
    const priv = await (await fetch(base + "/live.js")).text()
    expect(priv).not.toContain(SECRET)
  } finally {
    proc.kill()
    await proc.exited
    reader.releaseLock()
  }
})

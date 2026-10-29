import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const dir = import.meta.dir
const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-privacy-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const claudeLine = (o) => JSON.stringify(o)
const T = (n) => `2026-10-28T10:${String(n).padStart(2, "0")}:00.000Z`
const SECRET_PROMPT = "SECRET-PROMPT please do not leak"
const SECRET_REPLY = "SECRET-REPLY"
const SECRET_CMD = "SECRET-CMD curl -u admin:hunter2 x"

function seedSession(home) {
  const project = join(home, ".claude", "projects", "-Users-me-secret-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "secret.jsonl"), [
    claudeLine({ type: "user", sessionId: "secret", cwd: "/Users/me/secret-project", timestamp: T(1), message: { role: "user", content: SECRET_PROMPT } }),
    claudeLine({ type: "assistant", sessionId: "secret", cwd: "/Users/me/secret-project", timestamp: T(2), message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "text", text: SECRET_REPLY }, { type: "tool_use", id: "t1", name: "Bash", input: { command: SECRET_CMD } }] } }),
  ].join("\n"))
}

function runHost(spec, options, after = "", where = "xdg") {
  const home = tmp()
  const cfg = tmp()
  const work = tmp()
  seedSession(home)
  if (where !== "none") {
    const doc = JSON.stringify({ plugins: [{ spec, options }] })
    if (where === "cwd") writeFileSync(join(work, "plugins.json"), doc)
    else {
      mkdirSync(join(cfg, "magpie"), { recursive: true })
      writeFileSync(join(cfg, "magpie", "plugins.json"), doc)
    }
  }
  const out = tmp()
  const mod = pathToFileURL(join(dir, "office.hooks.mjs")).href
  const code = `const h = await import(${JSON.stringify(mod + "?privacy=" + Math.random())}); h.start(); ${after} h.stop(); h.write();`
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: join(home, ".cache"), MAGPIE_AGENT_OFFICE_PAGE: out }
  // an agent's own home override must not reach the sessions of the real user
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "GROK_HOME", "FACTORY_HOME_OVERRIDE", "CURSOR_CONFIG_DIR", "KIMI_CODE_HOME", "MINIMAX_DATA_DIR", "CLINE_SESSION_DATA_DIR", "CLINE_DATA_DIR", "CLINE_DIR"]) delete env[k]
  const r = spawnSync(process.execPath, ["-e", code], { cwd: where === "cwd" ? work : dir, env, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`host run failed: ${r.stderr || r.stdout}`)
  return readFileSync(join(out, "live.js"), "utf8")
}

const snapshot = (live) => JSON.parse(live.slice("globalThis.AgentOfficeLive = ".length).replace(/;\s*$/, ""))
const noSecrets = (live) => {
  for (const secret of [SECRET_PROMPT, "SECRET-PROMPT", SECRET_REPLY, SECRET_CMD, "SECRET-CMD", "hunter2"]) expect(live).not.toContain(secret)
}

// The host is loaded the way magpie loads it, with an install's options and
// one Claude Code session that carries a secret in the prompt, the reply and
// a tool argument. With text off none of the three may reach live.js.
// magpie writes npm specs with @latest (or a pinned @version); a local
// folder is written as its absolute path.
const specs = [
  "@magpie-community/page-agent-office@latest",
  "@magpie-community/page-agent-office@0.1.0",
  "@magpie-community/page-agent-office",
  "QingJ01/magpie-agent-office",
  dir,
]
for (const spec of specs) {
  test(`${spec}: text:false writes no prompt, reply or tool argument`, () => {
    const live = runHost(spec, { text: false })
    const snap = snapshot(live)
    expect(snap.text).toBe(false)
    expect(snap.sessions.length).toBe(1)
    const s = snap.sessions[0]
    expect(s.title).toBe("secret-project")
    expect(s.step).toBe("Bash")
    expect(s.query).toBe("")
    expect(s.reply).toBe("")
    noSecrets(live)
  })
}

test("a portable magpie's plugins.json in the host cwd is read", () => {
  const live = runHost("@magpie-community/page-agent-office@latest", { text: false }, "", "cwd")
  expect(snapshot(live).text).toBe(false)
  noSecrets(live)
})

test("no plugins.json fails closed", () => {
  const live = runHost("@magpie-community/page-agent-office@latest", { text: true }, "", "none")
  expect(snapshot(live).text).toBe(false)
  noSecrets(live)
})

test("an unmatched spec fails closed", () => {
  const live = runHost("someone-else@latest", { text: true })
  expect(snapshot(live).text).toBe(false)
  noSecrets(live)
})

test("a request's ctx.options can turn text on after failing closed", () => {
  const call = `await h.onRequest({ model: "m", tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] }, { origin: "local", protocol: "anthropic", agent: "cursor", session: "g2", cwd: "/tmp", model: "m", query: "SECRET-GATEWAY-PROMPT", options: { text: true }, state: {}, report() {} });`
  const live = runHost("someone-else@latest", { text: false }, call)
  expect(snapshot(live).text).toBe(true)
  expect(live).toContain("SECRET-GATEWAY-PROMPT")
})

test("a request without ctx.options keeps text:false", () => {
  const call = `await h.onRequest({ model: "m", tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] }, { origin: "local", protocol: "anthropic", agent: "cursor", session: "g1", cwd: "/tmp", model: "m", query: "SECRET-GATEWAY-PROMPT", state: {}, report() {} });`
  const live = runHost("@magpie-community/page-agent-office", { text: false }, call)
  const snap = JSON.parse(live.slice("globalThis.AgentOfficeLive = ".length).replace(/;\s*$/, ""))
  expect(snap.text).toBe(false)
  expect(live).not.toContain("SECRET-GATEWAY-PROMPT")
})

test("text:true still shows what the session says", () => {
  const live = runHost("@magpie-community/page-agent-office@latest", { text: true })
  expect(live).toContain("SECRET-PROMPT")
  expect(live).toContain("SECRET-REPLY")
  expect(live).toContain("SECRET-CMD")
})

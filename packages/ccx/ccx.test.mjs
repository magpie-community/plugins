import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// a fake ccx that logs its arguments and answers as the real one does
const dir = mkdtempSync(join(tmpdir(), "tools-ccx-"))
const log = join(dir, "args.log")
const fake = join(dir, "ccx")
writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $3" in
  "usage ") echo '{"available": true, "claude": {"level": "near", "used_percentage": 93, "resets_at_epoch": 1800000000, "source": "codexbar"}, "codex": {"level": "limit", "used_percentage": 100, "resets_at_epoch": null, "source": "codex", "window": "weekly"}}' ;;
  "call list_sessions") echo 'Claude sessions, newest first:'; echo '1. “Fix the parser” 10-23 17:29 · not linked · id=0df7bf5a-5fd1-49ec-9aee-3b3beb8c8714' ;;
  "call read_session") echo '{"title": "Fix the parser", "cwd": "/p", "text": "User: fix it", "offset": 0, "next_offset": null, "total_chars": 12}' ;;
  *) echo "✗ no such session" >&2; exit 1 ;;
esac
`)
chmodSync(fake, 0o755)
let tool
beforeAll(async () => {
  process.env.CCX_BIN = fake
  ;({ tool } = await (await import("./index.mjs")).CcxTools({}))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })
const lastArgs = () => readFileSync(log, "utf8").trim().split("\n").at(-1)

test("gives three tools, each with a JSON Schema and an execute", () => {
  expect(Object.keys(tool).sort()).toEqual(["read", "sessions", "usage"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(40)
    expect(t.args.type).toBe("object")
  }
})

test("usage answers both apps' windows", async () => {
  expect(await call("usage", {})).toEqual({
    available: true,
    claude: { level: "near", used_percent: 93, resets_at: "2027-01-15T08:00:00.000Z", window: "5-hour", from: "codexbar" },
    codex: { level: "limit", used_percent: 100, resets_at: null, window: "weekly", from: "codex" },
  })
  expect(lastArgs()).toBe("usage --json")
})

test("sessions asks ccx for the app named, in the folder given", async () => {
  expect(await call("sessions", { app: "claude", cwd: "/p", query: " parser " })).toContain("id=0df7bf5a")
  expect(lastArgs()).toBe("call codex list_sessions -C /p --query parser")
  await call("sessions", { app: "codex", cwd: "/p" })
  expect(lastArgs()).toBe("call claude list_sessions -C /p")
  await expect(call("sessions", { app: "cursor", cwd: "/p" })).rejects.toThrow('"claude" or "codex"')
  await expect(call("sessions", { app: "claude", cwd: "p" })).rejects.toThrow("absolute path")
})

test("read pages through a session and checks the id", async () => {
  expect(await call("read", { app: "claude", session_id: "0df7bf5a-5fd1-49ec-9aee-3b3beb8c8714", offset: 6000 }))
    .toMatchObject({ app: "Claude Code", text: "User: fix it", next_offset: null })
  expect(lastArgs()).toBe("call codex read_session --session-id 0df7bf5a-5fd1-49ec-9aee-3b3beb8c8714 --offset 6000")
  await expect(call("read", { app: "codex", session_id: "--offset=1; rm" })).rejects.toThrow("session id")
})

test("says how to get ccx when it isn't installed", async () => {
  process.env.CCX_BIN = join(dir, "missing")
  await expect(call("usage", {})).rejects.toThrow("ccx isn't installed")
  process.env.CCX_BIN = fake
})

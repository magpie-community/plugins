// Run with HOME=$(mktemp -d) bun test: the version this plugin asks as is
// the ZCode client installed on this machine, read from the engines it
// unpacked, and ZCode answering that version with a 200 whose whole body is
// {"code":0,"msg":""} is said as the 400 it is — not passed on as a reply
// magpie rests the account for, nor as a stream a turn ends without a stop
// reason in (plugins#1639, plugins#1635).
import { test, expect, beforeAll } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"

let _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ _internal } = await import("./index.mjs"))
})

// an installed ZCode unpacks one engine folder per version it can fall back to
const engines = (folders) => {
  const root = mkdtempSync(join(tmpdir(), "zcode-engines-"))
  for (const [platform, name] of folders) mkdirSync(join(root, platform, name), { recursive: true })
  return root
}

test("the version asked as is the client installed, its highest engine, under any platform folder", () => {
  // windows-x86_64 is where ZCode unpacks on Windows, darwin-aarch64 on a Mac
  for (const platform of ["windows-x86_64", "darwin-aarch64"]) {
    const root = engines([[platform, "3.17.2"], [platform, "4.0.0"], [platform, "4.1.2"], [platform, "cache"]])
    try {
      expect(_internal.installedAppVersion(root)).toBe("4.1.2")
      expect(_internal.appVersion(root)).toBe("4.1.2")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// plugins#1639: zcode.z.ai answers 3.17.2 with an empty 200, so no machine
// asks as that any more, whatever is installed on it
test("no ZCode installed, or an old one, asks as the newest client ZCode serves", () => {
  expect(_internal.FALLBACK_APP_VERSION).toBe("4.0.0")
  expect(_internal.APP_VERSION).toBe("4.0.0")
  const none = engines([["windows-x86_64", "cache"]])
  const old = engines([["darwin-aarch64", "3.14.3"]])
  try {
    expect(_internal.installedAppVersion(none)).toBe("")
    expect(_internal.appVersion(none)).toBe("4.0.0")
    expect(_internal.installedAppVersion(old)).toBe("3.14.3")
    expect(_internal.appVersion(old)).toBe("4.0.0")
  } finally {
    rmSync(none, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
  }
  expect(_internal.installedAppVersion(join(tmpdir(), "no-zcode-at-all"))).toBe("")
  expect(_internal.appVersion(join(tmpdir(), "no-zcode-at-all"))).toBe("4.0.0")
})

test("ZCODE_APP_VERSION says what to ask as, an install there or not", () => {
  process.env.ZCODE_APP_VERSION = "5.6.7"
  try {
    expect(_internal.appVersion(join(tmpdir(), "no-zcode-at-all"))).toBe("5.6.7")
  } finally {
    delete process.env.ZCODE_APP_VERSION
  }
  // anything that isn't a version is no version to ask as
  process.env.ZCODE_APP_VERSION = "latest"
  try {
    expect(_internal.appVersion(join(tmpdir(), "no-zcode-at-all"))).toBe(_internal.FALLBACK_APP_VERSION)
  } finally {
    delete process.env.ZCODE_APP_VERSION
  }
})

// what ZCode sends a client version it will not serve: all of it, 64 bytes
const EMPTY = JSON.stringify({ code: 0, msg: "", logid: "20261127172322c360cb19f4fd74daf8fd" })
const json = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } })

test("an empty 200 is the version refused, said as a 400 that names both versions", async () => {
  expect(_internal.refusedEnvelope(EMPTY)).toBe(true)
  const res = await _internal.spentSaid(json(EMPTY))
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.type).toBe("error")
  expect(body.error.type).toBe("invalid_request_error")
  expect(body.error.message).toContain(_internal.APP_VERSION)
})

test("a reply carries something, and goes on as it came", async () => {
  const reply = JSON.stringify({ code: 0, msg: "", data: { models: [] } })
  expect(_internal.refusedEnvelope(reply)).toBe(false)
  const res = await _internal.spentSaid(json(reply))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(reply)
})

test("a stream's body is never read here", async () => {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n'
  const res = await _internal.spentSaid(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(sse)
})

test("a spent bucket's 200 is still the 429 it was", async () => {
  const spent = JSON.stringify({ code: 1113, msg: "no resource package" })
  const res = await _internal.spentSaid(json(spent))
  expect(res.status).toBe(429)
  expect(await res.text()).toBe(spent)
})

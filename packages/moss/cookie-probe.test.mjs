// The cookie probe: the completion signal for a sign-in window without CDP.
// Unit tests use an INJECTED sqlite opener (no real database) against a dummy
// Cookies file — cookieRows copies the file before opening, so the file must
// exist for the injected opener to be reached.
import "./nonet.mjs"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { chromiumMicros, cookieBaseline, cookieRows, profileHasNewCookie, sessionRowOf } from "./lib/cookieProbe.mjs"

/** A profile whose Default/Network/Cookies exists (a dummy file; the opener is injected). */
const fakeProfile = () => {
  const dir = join(tmpdir(), `moss-probe-unit-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, "Default", "Network"), { recursive: true })
  writeFileSync(join(dir, "Default", "Network", "Cookies"), "dummy sqlite")
  return dir
}
/** A fake sqlite opener returning fixed rows. */
const store = (rows) => () => rows
const row = (over = {}) => ({
  host_key: ".mosi.cn",
  name: "moss_studio_prod_access_token",
  creation_utc: chromiumMicros(Date.now() - 60_000),
  last_update_utc: chromiumMicros(Date.now()),
  expires_utc: chromiumMicros(Date.now() + 86_400_000),
  ...over,
})

describe("cookieRows", () => {
  test("a locked database reads as 'not yet' ([]), never throws", () => {
    const dir = fakeProfile()
    expect(cookieRows(dir, { sqliteOpen: () => { throw new Error("database is locked") } })).toEqual([])
  })
  test("a missing Cookies file reads as 'not yet' without calling the opener", () => {
    let calls = 0
    const rows = cookieRows(join(tmpdir(), "moss-probe-missing"), { sqliteOpen: () => { calls++; return [] } })
    expect(calls).toBe(0)
    expect(rows).toEqual([])
  })

  test("the old Default/Cookies layout is still read when Network/Cookies is absent", () => {
    const dir = join(tmpdir(), `moss-probe-old-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(dir, "Default"), { recursive: true })
    writeFileSync(join(dir, "Default", "Cookies"), "dummy sqlite")
    const rows = [{ name: "moss_studio_prod_access_token" }]
    expect(cookieRows(dir, { sqliteOpen: () => rows })).toBe(rows)
  })
})

describe("sessionRowOf", () => {
  test("finds the first console session row and ignores other cookies", () => {
    const rows = [{ name: "other", host_key: ".mosi.cn" }, row()]
    expect(sessionRowOf(rows)?.name).toBe("moss_studio_prod_access_token")
    expect(sessionRowOf([{ name: "other", host_key: ".mosi.cn" }])).toBeNull()
  })
})

describe("cookieBaseline", () => {
  test("keeps only console-session rows on the console's domains", () => {
    const dir = fakeProfile()
    const rows = [
      row(),
      row({ name: "lang", host_key: ".mosi.cn" }), // not a session cookie
      row({ host_key: ".evil-mosi.cn" }), // look-alike domain
    ]
    expect(cookieBaseline(dir, { sqliteOpen: store(rows) })).toHaveLength(1)
  })
})

describe("profileHasNewCookie", () => {
  test("a fresh (first sign-in) profile with no rows is not 'finished'", () => {
    const dir = fakeProfile()
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([]) })).toBe(false)
  })

  test("a new session row after the launch completes the wait", () => {
    const dir = fakeProfile()
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([row()]) })).toBe(true)
  })

  test("the previous sign-in's row (in the baseline) does not count", () => {
    const dir = fakeProfile()
    const old = row()
    const baseline = cookieBaseline(dir, { sqliteOpen: store([old]) })
    expect(profileHasNewCookie(dir, baseline, { sqliteOpen: store([old]) })).toBe(false)
  })

  test("an overwritten row (same creation, moved last_update) counts as new", () => {
    const dir = fakeProfile()
    const old = row()
    const baseline = cookieBaseline(dir, { sqliteOpen: store([old]) })
    const renewed = row({ last_update_utc: old.last_update_utc + 3600_000_000 })
    expect(profileHasNewCookie(dir, baseline, { sqliteOpen: store([renewed]) })).toBe(true)
  })

  test("an expired new row does not count; a session cookie without expiry does", () => {
    const dir = fakeProfile()
    const expired = row({ expires_utc: chromiumMicros(Date.now() - 1000) })
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([expired]) })).toBe(false)
    const session = row({ expires_utc: 0 })
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([session]) })).toBe(true)
  })

  test("a session cookie on a look-alike domain is rejected", () => {
    const dir = fakeProfile()
    const evil = row({ host_key: ".evil-mosi.cn" })
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([evil]) })).toBe(false)
  })

  test("a non-session cookie row is ignored", () => {
    const dir = fakeProfile()
    const lang = row({ name: "lang" })
    expect(profileHasNewCookie(dir, [], { sqliteOpen: store([lang]) })).toBe(false)
  })
})

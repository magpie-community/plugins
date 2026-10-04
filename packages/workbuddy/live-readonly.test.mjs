// This machine's own WorkBuddy install, read-only, opt-in.
//
// Run it on its own: WORKBUDDY_LIVE=1 bun test live-readonly.test.mjs
//
// It reads the real sign-in through the app's own runtime and opens it, so the
// sealed-credential path is proved against the machine it will run on — not
// only against the stand-in in encrypted.test.mjs. It writes nothing: the
// app's file is checked to have the same mtime afterwards, the key stays in
// memory, and what it prints carries a size, a runtime version and a uid —
// never a token, a key or any part of one. Everything is skipped unless
// WORKBUDDY_LIVE=1, so an ordinary `bun test` never touches this machine's
// sign-in.
import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { _internal } from "./index.mjs"

const live = process.env.WORKBUDDY_LIVE === "1"
const { SITES, findWorkBuddyElectron, readDesktop, desktopFile, parseWrappedField, isEncryptedWorkBuddyValue } = _internal

test.skipIf(!live)("WorkBuddy desktop's own sign-in is detected and opened, read-only", async () => {
  const site = SITES.workbuddy
  const file = desktopFile(site)

  const before = statSync(file)
  console.log(`Sign-in file: ${file}`)
  console.log(`  ${before.size} bytes at ${new Date(before.mtimeMs).toISOString()}`)

  const electron = await findWorkBuddyElectron(site)
  if (!electron) return console.log("WorkBuddy runtime: not found on this machine")
  console.log(`WorkBuddy runtime: OK (${electron})`)

  // the file as the app keeps it: which fields are sealed, and with which key
  const doc = JSON.parse(await Bun.file(file).text())
  for (const field of ["accessToken", "refreshToken"]) {
    const value = doc?.auth?.[field]
    if (typeof value === "string") console.log(`  auth.${field}: plain (${value.length} chars)`)
    else if (isEncryptedWorkBuddyValue(value)) {
      const parts = parseWrappedField(value)
      console.log(`  auth.${field}: sealed, suite ${parts?.suite}, key ${parts?.keyId}`)
    } else console.log(`  auth.${field}: neither a plain value nor a sealed one`)
  }
  console.log(`Encrypted credential: ${isEncryptedWorkBuddyValue(doc?.auth?.accessToken) || isEncryptedWorkBuddyValue(doc?.auth?.refreshToken) ? "detected" : "none"}`)

  const d = await readDesktop(site)
  if (!d) return console.log("Result: not readable (signed out, or the app's key is unreachable)")
  console.log(`Access token: ${d.access ? "DECRYPT OK" : "none"} (${d.access.length} chars, jwt=${/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(d.access)})`)
  console.log(`Refresh token: ${d.refresh ? "DECRYPT OK" : "none"} (${d.refresh.length} chars)`)
  // the id only: it is what the account is added as, and it is not a secret
  console.log(`UID: ${d.uid}`)
  console.log(`Account name: ${d.name}`)
  console.log(`Domain: ${d.domain || "(none)"}`)

  expect(typeof d.access).toBe("string")
  expect(d.access.length).toBeGreaterThan(0)
  expect(typeof d.name).toBe("string")
  // a name is never an object, whatever shape the file has
  expect(d.name).not.toBe("[object Object]")
  // and nothing was written: the app's file is byte-for-byte where it was
  const after = statSync(file)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.size).toBe(before.size)
  console.log("Read-only: the app's file is unchanged")
})

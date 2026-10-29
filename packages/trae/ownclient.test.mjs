// The account this machine's own Trae CN client is signed in as checks in
// on the client's device id, read from the client's storage.json and
// never written; every other account keeps its own (yetone/magpie#1920).
import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

const DC = "1234567890123456" // the client's: 16 digits, as #808's
let f, dir, file

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trae-own-"))
  file = join(dir, "storage.json")
  _internal.ownClient.paths = () => [join(dir, "missing.json"), file]
})

// clientFile writes a client's storage.json at p: its sign-in as userId,
// and the device ids dcs (the key iCubeAuthInfo://icube-dc:<id>)
function clientFile(p, userId, { encoded = true, dcs = [DC] } = {}) {
  const auth = JSON.stringify({ token: "client-jwt", refreshToken: "client-refresh", userId, host: "https://api.trae.cn" })
  const doc = { "telemetry.machineId": "m".repeat(64), [`iCubeAuthInfo://icube.cloudide`]: encoded ? encode(auth) : auth }
  for (const d of dcs) doc[`iCubeAuthInfo://icube-dc:${d}`] = "device-key-pair"
  writeFileSync(p, JSON.stringify(doc))
}
afterEach(() => {
  f?.close()
  f = undefined
  _internal.ownClient.paths = () => []
  rmSync(dir, { recursive: true, force: true })
})

// encode is the client's codec run forwards, the inverse of clientDecode
function encode(text, header = "746305100000") {
  const salt = header === "746305100000"
    ? xor([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37],
      [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
    : undefined
  const random = randomBytes(32)
  const key = createHash("sha512").update(Buffer.concat([createHash("sha512").update(random).digest(), salt])).digest()
  const body = Buffer.from(text, "utf8")
  const c = createCipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32))
  const enc = Buffer.concat([c.update(Buffer.concat([createHash("sha512").update(body).digest(), body])), c.final()])
  return Buffer.concat([Buffer.from(header, "hex"), random, enc]).toString("base64")
}
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]))

function client(userId, opts) {
  clientFile(file, userId, opts)
}

async function checkIn(auth = signedIn()) {
  // one fake at a time: a second opened over the first would put the
  // first's host back as the realm's own when it closes
  f?.close()
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 0 }))
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 0 }))
  const o = await (await TraeCNAuthPlugin({ client: {} })).auth.loader(async () => auth)
  await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" })
  return f.seen.at(-1).headers
}

// the account's own device, in the client's shape (ugDevice, #194)
const plugins = (h, a = signedIn()) => {
  expect(h.get("x-device-id")).toBe(_internal.ugDevice(a))
  expect(h.get("x-device-id")).toMatch(/^\d{16}$/)
  expect(h.get("x-device-brand")).toBeTruthy()
  expect(h.get("x-device-type")).toBe("Windows")
  expect(h.get("x-os-version")).toBe("10.0.22631")
}

test("the account the client is signed in as checks in on the client's device and this machine's OS", async () => {
  client("u-1")
  const before = readFileSync(file, "utf8")
  const mtime = statSync(file).mtimeMs
  const h = await checkIn()
  expect(h.get("x-device-id")).toBe(DC)
  expect(h.has("x-device-brand")).toBe(false)
  const m = _internal.thisMachine()
  expect(h.get("x-device-type")).toBe(m.type)
  expect(h.get("x-os-version")).toBe(m.os)
  // the account's own token, never the client's
  expect(h.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(h.get("x-app-version")).toBe("0.1.69")
  // read, never written
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(statSync(file).mtimeMs).toBe(mtime)
})

test("a client's sign-in stored as plain JSON is read too", async () => {
  client("u-1", { encoded: false })
  expect((await checkIn()).get("x-device-id")).toBe(DC)
})

test("an account the client isn't signed in as keeps its own device", async () => {
  client("someone-else")
  plugins(await checkIn())
})

test("an account with no uid keeps its own device", async () => {
  client("")
  plugins(await checkIn(signedIn({ uid: "" })), signedIn({ uid: "" }))
})

test("a client with no single device names none", async () => {
  client("u-1", { dcs: [] })
  plugins(await checkIn())
  client("u-1", { dcs: [DC, "6543210987654321"] })
  plugins(await checkIn())
  client("u-1", { dcs: ["not-digits"] })
  plugins(await checkIn())
})

test("a client file that can't be made out names no device", async () => {
  writeFileSync(file, "{not json")
  plugins(await checkIn())
  writeFileSync(file, JSON.stringify({ [`iCubeAuthInfo://icube-dc:${DC}`]: "x", "iCubeAuthInfo://icube.cloudide": "dGFtcGVyZWQ=" + "A".repeat(200) }))
  plugins(await checkIn())
  // a value whose check fails (one byte changed) is not read as anyone
  const bad = Buffer.from(encode(JSON.stringify({ userId: "u-1" })), "base64")
  bad[bad.length - 20] ^= 1
  writeFileSync(file, JSON.stringify({ [`iCubeAuthInfo://icube-dc:${DC}`]: "x", "iCubeAuthInfo://icube.cloudide": bad.toString("base64") }))
  plugins(await checkIn())
})

// A machine can hold more than one Trae CN client profile (Trae CN and
// TRAE SOLO CN both write one, and so does a client started with its own
// --user-data-dir). Each profile's storage.json names the account that
// profile is signed in as, and that account's device — so two accounts can
// each have a real client's device, which is what a check-in needs. The
// plugin read only the first profile, and gave up on all of them the moment
// one named an account it wasn't looking for.
test("each account finds its own profile's client device, not the first profile's", async () => {
  const other = join(dir, "other.json")
  _internal.ownClient.paths = () => [file, other]
  clientFile(file, "u-1", { dcs: [DC] })
  clientFile(other, "u-2", { dcs: ["7654321098765432"] })
  // u-2's device is in the second profile: reading only the first said no
  expect((await checkIn(signedIn({ uid: "u-2" }))).get("x-device-id")).toBe("7654321098765432")
  // and u-1's is still in the first
  expect((await checkIn(signedIn({ uid: "u-1" }))).get("x-device-id")).toBe(DC)
})

test("a profile signed in as someone else doesn't hide a later profile's device", async () => {
  const other = join(dir, "other.json")
  _internal.ownClient.paths = () => [file, other]
  clientFile(file, "someone-else", { dcs: [DC] })
  clientFile(other, "u-2", { dcs: ["7654321098765432"] })
  expect((await checkIn(signedIn({ uid: "u-2" }))).get("x-device-id")).toBe("7654321098765432")
})

test("a profile that can't be read doesn't hide a later profile's device", async () => {
  const other = join(dir, "other.json")
  _internal.ownClient.paths = () => [file, other]
  writeFileSync(file, "{not json")
  clientFile(other, "u-2", { dcs: ["7654321098765432"] })
  expect((await checkIn(signedIn({ uid: "u-2" }))).get("x-device-id")).toBe("7654321098765432")
})

test("no client on this machine: the account's own device, as before", async () => {
  plugins(await checkIn())
})

test("only the check-in goes on the client's device; the chat's pages keep the account's", async () => {
  client("u-1")
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 0 }))
  const o = await (await TraeCNAuthPlugin({ client: {} })).auth.loader(async () => signedIn())
  await o.fetch(f.origin + "/trae/api/v2/pay/ide_user_ent_usage", { method: "POST", body: "{}" })
  expect(f.seen[0].headers.get("x-device-id")).toBe("1234567890123456789")
})

test("the client's codec decodes what it encodes, and refuses another header", () => {
  expect(_internal.clientDecode(encode('{"userId":"7"}'))).toBe('{"userId":"7"}')
  expect(() => _internal.clientDecode(Buffer.concat([Buffer.from("000000000000", "hex"), randomBytes(120)]).toString("base64"))).toThrow()
})

test("where each OS keeps the client's storage.json", () => {
  const p = _internal.clientStoragePaths
  // the paths are joined with this system's separator: the composition is
  // what is checked, so they are read as one system spells them
  const same = (ps) => ps.map((x) => x.replaceAll(sep, "/"))
  // a profile is the IDE's, TRAE SOLO CN's, or the trae-cn folder some
  // installs use: each is a client of the same realm with its own sign-in
  expect(same(p("darwin", "/Users/a", {}))).toEqual([
    "/Users/a/Library/Application Support/Trae CN/User/globalStorage/storage.json",
    "/Users/a/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json",
  ])
  expect(same(p("win32", "/h", { APPDATA: "/h/Roam" }))).toEqual([
    "/h/Roam/Trae CN/User/globalStorage/storage.json",
    "/h/Roam/TRAE SOLO CN/User/globalStorage/storage.json",
    "/h/Roam/trae-cn/User/globalStorage/storage.json",
    "/h/AppData/Roaming/Trae CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/TRAE SOLO CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/trae-cn/User/globalStorage/storage.json",
  ])
  // linux lists the same three profiles under .config, in the same order
  expect(same(p("linux", "/home/a", {}))).toEqual([
    "/home/a/.config/Trae CN/User/globalStorage/storage.json",
    "/home/a/.config/TRAE SOLO CN/User/globalStorage/storage.json",
    "/home/a/.config/trae-cn/User/globalStorage/storage.json",
  ])
  expect(same(p("linux", "/home/a", { XDG_CONFIG_HOME: "/x" }))).toEqual([
    "/x/Trae CN/User/globalStorage/storage.json",
    "/x/TRAE SOLO CN/User/globalStorage/storage.json",
    "/x/trae-cn/User/globalStorage/storage.json",
  ])
  // a root named twice is asked once: APPDATA the same as the home's own
  expect(same(p("win32", "/h", { APPDATA: "/h/AppData/Roaming" }))).toEqual([
    "/h/AppData/Roaming/Trae CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/TRAE SOLO CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/trae-cn/User/globalStorage/storage.json",
  ])
  // the same folder spelled with another case, separator or a trailing one
  // is still that folder (the fix: string equality read it twice)
  expect(same(p("win32", "/h", { APPDATA: "\\H\\APPDATA\\roaming\\" })).length).toBe(3)
  // and a different APPDATA is a root of its own, beside the home's
  expect(same(p("win32", "/h", { APPDATA: "/other/Roam" }))).toEqual([
    "/other/Roam/Trae CN/User/globalStorage/storage.json",
    "/other/Roam/TRAE SOLO CN/User/globalStorage/storage.json",
    "/other/Roam/trae-cn/User/globalStorage/storage.json",
    "/h/AppData/Roaming/Trae CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/TRAE SOLO CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/trae-cn/User/globalStorage/storage.json",
  ])
  // no APPDATA at all: the home's own alone
  expect(same(p("win32", "/h", {}))).toEqual([
    "/h/AppData/Roaming/Trae CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/TRAE SOLO CN/User/globalStorage/storage.json",
    "/h/AppData/Roaming/trae-cn/User/globalStorage/storage.json",
  ])
})

test("this machine's OS as the client names it", () => {
  const w = _internal.thisMachine("win32")
  expect(w.type).toBe("windows")
  expect(w.os).toMatch(/^Windows /)
  expect(_internal.thisMachine("darwin")).toEqual({ type: "mac", os: expect.stringMatching(/^macOS \d/) })
  expect(_internal.thisMachine("linux").type).toBe("linux")
})

// plugins#436 (moxuanchen, Windows 11, TRAE CN 3.4.4, plugin 0.2.24): two
// accounts, A and B. Both of that machine's profiles, %APPDATA%\Trae CN and
// %APPDATA%\TRAE SOLO CN, were signed in as A, with the same device. A
// checked in (100 credits); B got 9074, and the reporter had to run
// clientDevice by hand to learn that B's claim had gone on magpie's own
// device. The message says which device a refused claim went on, and why.
async function refused(uid, answer = { code: 9074, message: "当前参与用户太多，请稍后再试" }) {
  f?.close()
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: false }))
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json(answer))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  return hooks.auth.checkin(async () => signedIn({ uid }))
}

function reporterProfiles() {
  const cn = join(dir, "Trae CN", "storage.json")
  const solo = join(dir, "TRAE SOLO CN", "storage.json")
  for (const p of [cn, solo]) mkdirSync(join(p, ".."), { recursive: true })
  _internal.ownClient.paths = () => [cn, solo]
  clientFile(cn, "uid-a", { dcs: [DC] })
  clientFile(solo, "uid-a", { dcs: [DC] })
}

test("B's 9074 says it went on magpie's own device, since both profiles here are A's (#436)", async () => {
  reporterProfiles()
  const out = await refused("uid-b")
  expect(out).toEqual({
    outcome: "ineligible",
    message: "当前参与用户太多，请稍后再试 (9074) — Trae CN did not take this check-in for this account's device (sent on magpie's own device for this account: 2 Trae CN client profiles are on this machine, none signed in as this account)",
  })
  // it names neither uid nor either device
  expect(out.message).not.toContain("uid-a")
  expect(out.message).not.toContain(DC)
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe(_internal.ugDevice(signedIn({ uid: "uid-b" })))
})

test("A's refusal says it went on the client's device; one account in two profiles is no conflict (#436)", async () => {
  reporterProfiles()
  const out = await refused("uid-a", { code: 9095, message: "this device has checked in today" })
  expect(out).toEqual({ outcome: "ineligible", message: "this device has checked in today (sent on this machine's Trae CN client's device, signed in as this account)" })
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe(DC)
})

test("a client device another account's profile also has is named as shared (#436)", async () => {
  const other = join(dir, "other.json")
  _internal.ownClient.paths = () => [file, other]
  clientFile(file, "uid-a", { dcs: [DC] })
  clientFile(other, "uid-b", { dcs: [DC] })
  const out = await refused("uid-b", { code: 9095, message: "this device has checked in today" })
  expect(out.message).toContain("another profile here, signed in as another account, has the same device")
  expect(f.seen.at(-1).headers.get("x-device-id")).toBe(DC)
})

test("one profile, signed in as someone else, is counted in the singular (#436)", async () => {
  client("uid-a")
  const out = await refused("uid-b")
  expect(out.message).toContain("(sent on magpie's own device for this account: 1 Trae CN client profile is on this machine, none signed in as this account)")
})

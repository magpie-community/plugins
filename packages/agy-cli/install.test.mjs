// install.mjs installs agy where the machine has none (magpie's sign-in
// runs it, niuniu_8964 on X: agy-cli in magpie's container) and keeps its
// own copy current. A local server stands in for Antigravity's manifests
// and downloads; nothing here reaches the network.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { EventEmitter } from "node:events"
import { agyPlatform, drained, installAgy, installedVersion, untarMember, updateOwnAgy } from "./install.mjs"
import { agyCandidates, ownAgyPath } from "./platform.mjs"

const unix = process.platform !== "win32"

// tar builds a ustar archive of [name, bytes, type?] entries.
function tar(entries) {
  const blocks = []
  for (const [name, data, type = "0"] of entries) {
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0)
    header.write("0000755\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
    header.write("00000000000\0", 136)
    header.write("        ", 148)
    header.write(type, 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const script = (version) => Buffer.from(`#!/bin/sh\necho "agy ${version}"\n`)
const sha = (b) => createHash("sha512").update(b).digest("hex")

let server
const files = new Map() // path → body
let manifest = null
let slow = false
let root

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/manifests/")) {
        return manifest ? Response.json({ ...manifest, url: `http://127.0.0.1:${server.port}${manifest.url}` }) : new Response("no", { status: 404 })
      }
      const body = files.get(url.pathname)
      if (!body) return new Response("no", { status: 404 })
      if (slow) {
        return new Response(new ReadableStream({
          async pull(c) {
            await Bun.sleep(50)
            c.enqueue(new Uint8Array(1024))
          },
        }))
      }
      return new Response(body)
    },
  })
  process.env.AGY_BRIDGE_INSTALL_BASE = `http://127.0.0.1:${server.port}/manifests/`
})

afterAll(() => {
  server.stop(true)
  delete process.env.AGY_BRIDGE_INSTALL_BASE
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"))
  files.clear()
  manifest = null
  slow = false
})

function release(version, entries) {
  const body = tar(entries ?? [["antigravity", script(version)]])
  files.set(`/r/${version}.tar.gz`, body)
  manifest = { version, url: `/r/${version}.tar.gz`, sha512: sha(body) }
}

test("each machine is named as Antigravity's installer names it", () => {
  expect(agyPlatform("linux", "x64", false)).toBe("linux_amd64")
  expect(agyPlatform("linux", "arm64", true)).toBe("linux_arm64_musl")
  expect(agyPlatform("darwin", "arm64")).toBe("darwin_arm64")
  expect(agyPlatform("win32", "x64")).toBe("windows_amd64")
  expect(agyPlatform("linux", "ia32", false)).toBe(null)
  expect(agyPlatform("android", "arm64", false)).toBe(null)
})

test("the plugin's own agy is in its own data folder, found after the user's", () => {
  expect(ownAgyPath({ XDG_DATA_HOME: "/config/data" }, "/config/home", "linux")).toBe("/config/data/magpie-agy-cli/agy")
  expect(ownAgyPath({}, "/home/u", "linux")).toBe("/home/u/.local/share/magpie-agy-cli/agy")
  expect(ownAgyPath({ XDG_DATA_HOME: "relative" }, "/home/u", "linux")).toBe("/home/u/.local/share/magpie-agy-cli/agy")
  expect(ownAgyPath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u", "win32")).toBe("C:\\Users\\u\\AppData\\Local\\magpie-agy-cli\\agy.exe")
  const c = agyCandidates({ PATH: "/usr/bin", XDG_DATA_HOME: "/config/data" }, "/config/home", "linux")
  expect(c.at(-1)).toBe("/config/data/magpie-agy-cli/agy")
  expect(c[0]).toBe("/usr/bin/agy")
})

test("agy is taken out of its archive, past a long name and a ./ prefix", async () => {
  const archive = path.join(root, "a.tar.gz")
  const long = "x".repeat(150)
  fs.writeFileSync(archive, tar([
    ["././@LongLink", Buffer.from(long + "\0"), "L"],
    ["short", Buffer.from("not this one")],
    ["README", Buffer.alloc(700, 65)],
    ["./antigravity", Buffer.alloc(5000, 7)],
  ]))
  const out = path.join(root, "agy")
  expect(await untarMember(archive, "antigravity", out)).toBe(true)
  expect(fs.readFileSync(out).equals(Buffer.alloc(5000, 7))).toBe(true)
  expect(await untarMember(archive, "nothere", path.join(root, "none"))).toBe(false)
  expect(fs.existsSync(path.join(root, "none"))).toBe(false)
})

test.if(unix)("installs the manifest's agy, checked and runnable, leaving nothing else", async () => {
  release("1.5.9")
  const bin = path.join(root, "data", "magpie-agy-cli", "agy")
  expect(await installAgy({ bin, platform: "linux_amd64" })).toBe("1.5.9")
  expect(fs.statSync(bin).mode & 0o111).not.toBe(0)
  expect(Bun.spawnSync([bin]).stdout.toString()).toContain("agy 1.5.9")
  expect(installedVersion(bin)).toBe("1.5.9")
  expect(fs.readdirSync(path.dirname(bin)).sort()).toEqual(["agy", "agy.version"])
})

test.if(unix)("a download that isn't the manifest's is never installed", async () => {
  release("1.5.9")
  manifest.sha512 = sha(Buffer.from("something else"))
  const bin = path.join(root, "agy")
  await expect(installAgy({ bin, platform: "linux_amd64" })).rejects.toThrow(/checksum/)
  expect(fs.readdirSync(root)).toEqual([])
})

test.if(unix)("an agy that doesn't run here isn't put in place of one that does", async () => {
  release("1.5.9")
  const bin = path.join(root, "agy")
  await installAgy({ bin, platform: "linux_amd64" })
  release("1.6.0", [["antigravity", Buffer.from("#!/bin/sh\necho 'cannot execute: required file not found' >&2\nexit 126\n")]])
  await expect(installAgy({ bin, platform: "linux_amd64" })).rejects.toThrow(/doesn't run here \(cannot execute/)
  expect(Bun.spawnSync([bin]).stdout.toString()).toContain("agy 1.5.9")
  expect(installedVersion(bin)).toBe("1.5.9")
})

test.if(unix)("a manifest the server won't give says so", async () => {
  await expect(installAgy({ bin: path.join(root, "agy"), platform: "linux_amd64" })).rejects.toThrow(/answered 404/)
})

test.if(unix)("an install given up stops its download and leaves nothing", async () => {
  release("1.5.9")
  slow = true
  const bin = path.join(root, "agy")
  const ctl = new AbortController()
  const done = installAgy({ bin, platform: "linux_amd64", signal: ctl.signal })
  await Bun.sleep(200)
  ctl.abort()
  await expect(done).rejects.toThrow()
  expect(fs.readdirSync(root)).toEqual([])
})

test.if(unix)("only the plugin's own copy is kept current, and not when the user turned updates off", async () => {
  const bin = path.join(root, "agy")
  release("1.5.9")
  expect(await updateOwnAgy({ bin, platform: "linux_amd64", env: {} })).toBe("none")
  await installAgy({ bin, platform: "linux_amd64" })
  expect(await updateOwnAgy({ bin, platform: "linux_amd64", env: {} })).toBe("current")
  release("1.6.0")
  expect(await updateOwnAgy({ bin, platform: "linux_amd64", env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } })).toBe("off")
  expect(await updateOwnAgy({ bin, platform: "linux_amd64", env: {}, used: "/usr/local/bin/agy" })).toBe("not used")
  expect(installedVersion(bin)).toBe("1.5.9")
  expect(await updateOwnAgy({ bin, platform: "linux_amd64", env: {}, used: bin })).toBe("updated")
  expect(Bun.spawnSync([bin]).stdout.toString()).toContain("agy 1.6.0")
  expect(installedVersion(bin)).toBe("1.6.0")
})

test("waiting on a full stream leaves no listener behind", async () => {
  // a 260MB agy waits thousands of times; each wait used to leave an
  // error listener (MaxListenersExceededWarning in magpie's container)
  const out = new EventEmitter()
  for (let i = 0; i < 20; i++) {
    const wait = drained(out)
    out.emit("drain")
    await wait
  }
  expect(out.listenerCount("error")).toBe(0)
  expect(out.listenerCount("drain")).toBe(0)
  const failed = drained(out)
  out.emit("error", new Error("disk full"))
  await expect(failed).rejects.toThrow("disk full")
  expect(out.listenerCount("drain")).toBe(0)
})

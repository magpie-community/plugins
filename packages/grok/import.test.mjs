// A CPA xAI account file is translated into the sign-in Grok Build keeps in
// a home of the plugin's own. The file is only read: a CPA refresh token
// rotates, so the account is migrated, not shared.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = `https://auth.x.ai::${CLIENT_ID}`

const dir = mkdtempSync(join(tmpdir(), "grok-import-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const real = { GROK_BIN_DIR: process.env.GROK_BIN_DIR, GROK_HOME: process.env.GROK_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME, PATH: process.env.PATH }
afterEach(() => {
  for (const [k, v] of Object.entries(real)) v === undefined ? delete process.env[k] : (process.env[k] = v)
})

// a token the plugin can read claims from, never a real one
function jwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${part({ alg: "none" })}.${part(claims)}.sig`
}

const goodToken = jwt({ iss: "https://auth.x.ai", aud: [CLIENT_ID], sub: "user-1" })

// cpaFile writes what CPA keeps for one xAI account, with fields overridden.
function cpaFile(over = {}) {
  const file = join(dir, `cpa-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      type: "xai",
      auth_kind: "oauth",
      access_token: goodToken,
      refresh_token: "rt-1",
      expired: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
      last_refresh: new Date(Date.now() - 60_000).toISOString(),
      disabled: false,
      email: "someone@example.com",
      sub: "user-1",
      token_type: "Bearer",
      base_url: "https://cli-chat-proxy.grok.com/v1",
      ...over,
    }),
  )
  return file
}

// sandbox gives the plugin a Grok Build to find and a home of its own, so
// no real home, PATH or sign-in is ever read. With exe false there is no
// Grok Build to find anywhere. The fake CLI is never run: import only
// checks that it is there.
function sandbox({ exe = true } = {}) {
  const bin = mkdtempSync(join(dir, "bin-"))
  if (exe) {
    const cli = join(bin, process.platform === "win32" ? "grok.exe" : "grok")
    writeFileSync(cli, "#!/bin/sh\nexit 0\n")
    chmodSync(cli, 0o755)
  }
  process.env.GROK_BIN_DIR = bin
  process.env.GROK_HOME = mkdtempSync(join(dir, "home-"))
  process.env.HOME = mkdtempSync(join(dir, "user-"))
  process.env.PATH = exe ? [bin, "/usr/bin", "/bin"].join(delimiter) : "/nonexistent"
  const config = mkdtempSync(join(dir, "config-"))
  process.env.XDG_CONFIG_HOME = config
  return config
}

async function importFrom(path) {
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === "Import CPA Grok account JSON")
  const asked = await m.authorize({ path })
  return { asked, done: () => asked.callback() }
}

const homes = (config) => {
  const d = join(config, "opencode-grok-auth")
  return existsSync(d) ? readdirSync(d) : []
}

test("an enabled CPA xAI account becomes the sign-in of a home of the plugin's own", async () => {
  const config = sandbox()
  const file = cpaFile()
  const before = readFileSync(file, "utf8")
  const { asked, done } = await importFrom(file)

  // the warning is read before the sign-in is made, not after
  expect(asked.url).toBe("")
  expect(asked.method).toBe("auto")
  expect(asked.instructions).toContain("CPA")

  const r = await done()
  expect(r.type).toBe("success")
  expect(r.access).toBe(goodToken)
  expect(r.accountId).toBe("someone@example.com")
  expect(dirname(r.refresh)).toBe(join(config, "opencode-grok-auth"))
  expect(basename(r.refresh)).not.toBe("")

  // Grok Build's own shape, under the scope key its auth.json uses
  const all = JSON.parse(readFileSync(join(r.refresh, "auth.json"), "utf8"))
  expect(Object.keys(all)).toEqual([SCOPE])
  expect(all[SCOPE].key).toBe(goodToken)
  expect(all[SCOPE].auth_mode).toBe("oidc")
  expect(all[SCOPE].refresh_token).toBe("rt-1")
  expect(all[SCOPE].oidc_issuer).toBe("https://auth.x.ai")
  expect(all[SCOPE].oidc_client_id).toBe(CLIENT_ID)
  expect(all[SCOPE].user_id).toBe("user-1")
  expect(all[SCOPE].email).toBe("someone@example.com")
  // Windows has no 0600, so only the mode a POSIX home gives is checked
  if (process.platform !== "win32") expect(statSync(join(r.refresh, "auth.json")).mode & 0o777).toBe(0o600)

  // the CPA file is read, never rewritten
  expect(readFileSync(file, "utf8")).toBe(before)
})

test("what isn't an enabled CPA xAI OAuth account is refused, with no home made", async () => {
  const cases = [
    ["not JSON at all", () => {
      const f = join(dir, "not-json.json")
      writeFileSync(f, "this is not JSON")
      return f
    }, "not valid JSON"],
    ["no such file", () => join(dir, "missing.json"), "choose a CPA Grok account JSON file"],
    ["not an xAI account", () => cpaFile({ type: "openai" }), "not an enabled xAI OAuth account"],
    ["not an OAuth account", () => cpaFile({ auth_kind: "api_key" }), "not an enabled xAI OAuth account"],
    ["a disabled account", () => cpaFile({ disabled: true }), "not an enabled xAI OAuth account"],
    ["no refresh token", () => cpaFile({ refresh_token: "" }), "missing its tokens or identity"],
    ["no user", () => cpaFile({ sub: "" }), "missing its tokens or identity"],
    ["no email", () => cpaFile({ email: "" }), "missing its tokens or identity"],
    ["timestamps that don't parse", () => cpaFile({ expired: "yesterday" }), "invalid token timestamps"],
    ["a timestamp that is a list", () => cpaFile({ expired: ["2026-10-09T15:16:26Z"] }), "invalid token timestamps"],
    ["a timestamp that isn't a string", () => cpaFile({ last_refresh: 1759936586 }), "invalid token timestamps"],
    ["another issuer's token", () => cpaFile({ access_token: jwt({ iss: "https://accounts.example.com", aud: [CLIENT_ID] }) }), "not for the Grok Build xAI account"],
    ["another client's token", () => cpaFile({ access_token: jwt({ iss: "https://auth.x.ai", aud: ["someone-else"] }) }), "not for the Grok Build xAI account"],
    ["a token that isn't a token", () => cpaFile({ access_token: "opaque" }), "not for the Grok Build xAI account"],
  ]
  for (const [what, make, why] of cases) {
    const config = sandbox()
    await expect(importFrom(make())).rejects.toThrow(why)
    expect(homes(config), what).toEqual([])
  }
})

test("no Grok Build to refresh the sign-in with is refused first", async () => {
  sandbox({ exe: false })
  await expect(importFrom(cpaFile())).rejects.toThrow("install Grok Build first")
  // one put in a folder of the user's choosing (magpie in Docker) is named too
  await expect(importFrom(cpaFile())).rejects.toThrow("set GROK_BIN_DIR to the folder holding its grok binary")
})

test("a token that has already ended is still taken, its renewal left to the CLI", async () => {
  const config = sandbox()
  const expired = new Date(Date.now() - 3600_000).toISOString()
  const { done } = await importFrom(cpaFile({ expired }))
  const r = await done()
  expect(r.type).toBe("success")
  expect(r.expires).toBe(Date.parse(expired))
  expect(homes(config)).toHaveLength(1)
})

test("a home that can't be made is refused before anything is written", async () => {
  const config = sandbox()
  // a file where the plugin's folder goes: mkdirSync fails. This is the
  // mkdir step; the cleanup after a write that fails is not exercised here.
  writeFileSync(join(config, "opencode-grok-auth"), "")
  const { done } = await importFrom(cpaFile())
  await expect(done()).rejects.toThrow()
  expect(readFileSync(join(config, "opencode-grok-auth"), "utf8")).toBe("")
})

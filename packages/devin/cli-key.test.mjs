// An account taken from the CLI's sign-in uses the key credentials.toml
// has now, as magpie's built-in re-reads it: a `devin auth login` since
// changes it. Others keep the key they were saved with.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const was = process.env.XDG_DATA_HOME
const wasAppData = process.env.APPDATA
const data = mkdtempSync(join(tmpdir(), "devin-data-"))
process.env.XDG_DATA_HOME = data
process.env.APPDATA = data
afterAll(() => {
  was === undefined ? delete process.env.XDG_DATA_HOME : (process.env.XDG_DATA_HOME = was)
  wasAppData === undefined ? delete process.env.APPDATA : (process.env.APPDATA = wasAppData)
})

test("the CLI's account follows credentials.toml; a browser sign-in stays", async () => {
  const cli = { type: "api", key: "saved", metadata: { cli: "true", server: "https://s.example" } }
  expect(await _internal.live(cli)).toEqual({ key: "saved", server: "https://s.example" })
  mkdirSync(join(data, "devin"))
  writeFileSync(join(data, "devin", "credentials.toml"), 'windsurf_api_key = "rotated"\napi_server_url = "https://t.example/"\n')
  expect(await _internal.live(cli)).toEqual({ key: "rotated", server: "https://t.example" })
  expect(await _internal.live({ type: "api", key: "own", metadata: {} })).toMatchObject({ key: "own" })
})

// OpenCode 1 keeps an auth's metadata as strings only and drops an
// auth.json entry with any other value (#396), so the CLI sign-in saves
// every value, cli included, as a string.
test("the CLI sign-in saves only string metadata", async () => {
  mkdirSync(join(data, "devin"), { recursive: true })
  writeFileSync(join(data, "devin", "credentials.toml"), 'windsurf_api_key = "cli-key"\napi_server_url = "https://server.codeium.com"\n')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ userStatus: { email: "me@example.com", planStatus: { planInfo: { planName: "Pro", devinInfo: { orgId: "org-1" } } }, teamId: "team-1" } }), { status: 200, headers: { "content-type": "application/json" } })
  try {
    const hooks = await DevinAuthPlugin({})
    const method = hooks.auth.methods.find((m) => m.authorize && m.label === "Devin CLI's sign-in")
    const r = await (await method.authorize()).callback()
    expect(r.type).toBe("success")
    expect(r.metadata.cli).toBe("true")
    for (const [k, v] of Object.entries(r.metadata)) expect([k, typeof v]).toEqual([k, "string"])
  } finally {
    globalThis.fetch = realFetch
  }
})

// An account taken from the CLI's sign-in uses the key credentials.toml
// has now, as magpie's built-in re-reads it: a `devin auth login` since
// changes it. Others keep the key they were saved with.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _internal } from "./index.mjs"

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
  const cli = { type: "api", key: "saved", metadata: { cli: true, server: "https://s.example" } }
  expect(await _internal.live(cli)).toEqual({ key: "saved", server: "https://s.example" })
  mkdirSync(join(data, "devin"))
  writeFileSync(join(data, "devin", "credentials.toml"), 'windsurf_api_key = "rotated"\napi_server_url = "https://t.example/"\n')
  expect(await _internal.live(cli)).toEqual({ key: "rotated", server: "https://t.example" })
  expect(await _internal.live({ type: "api", key: "own", metadata: {} })).toMatchObject({ key: "own" })
})

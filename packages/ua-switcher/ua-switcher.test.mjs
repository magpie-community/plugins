import { check } from "../../scripts/middleware.mjs"
import * as mod from "./schema.middleware.mjs"
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// the gateway middleware half: Anthropic tool-schema top-level cleanup,
// run the way magpie's gateway runs it (scripts/middleware.mjs)
check(import.meta.dir, mod)

// the plugin host half: loads outside magpie, against a throwaway config
// and providers file (the same setup the upstream repo's selftest uses),
// and hands back its hooks without touching a real magpie install
test("the plugin loads and returns its chat.headers hook", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ua-switcher-pkg-"))
  const cfgPath = path.join(dir, "ua-switcher.json")
  const provPath = path.join(dir, "providers.json")
  fs.writeFileSync(cfgPath, JSON.stringify({ profile: "off", port: 0, autoVersions: false }))
  fs.writeFileSync(provPath, JSON.stringify({ providers: [] }))
  process.env.UA_SWITCHER_CONFIG = cfgPath
  process.env.UA_SWITCHER_PROVIDERS = provPath
  const { UASwitcherPlugin } = await import("./index.mjs")
  const hooks = await UASwitcherPlugin(
    { client: { app: { log: async () => {} } }, directory: dir },
    {},
  )
  expect(typeof hooks["chat.headers"]).toBe("function")
})

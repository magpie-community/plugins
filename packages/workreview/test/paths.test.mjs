import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { configRoot, dataRoot, readDataLocation, resolveConfigPath } from "../lib/paths.mjs"

const home = "/home/u"

test("follows Work Review's data dir on each platform", () => {
  expect(dataRoot({ home, platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } })).toBe(
    path.join("C:\\Users\\u\\AppData\\Roaming", "work-review"),
  )
  expect(dataRoot({ home, platform: "darwin", env: {} })).toBe(
    path.join(home, "Library", "Application Support", "work-review"),
  )
  expect(dataRoot({ home, platform: "linux", env: {} })).toBe(path.join(home, ".local", "share", "work-review"))
  expect(dataRoot({ home, platform: "linux", env: { XDG_DATA_HOME: "/xdg/data" } })).toBe(
    path.join("/xdg/data", "work-review"),
  )
})

test("reads the config dir separately on Linux", () => {
  expect(configRoot({ home, platform: "linux", env: {} })).toBe(path.join(home, ".config", "work-review"))
  expect(configRoot({ home, platform: "darwin", env: {} })).toBe(
    path.join(home, "Library", "Application Support", "work-review"),
  )
})

test("WORK_REVIEW_HOME wins (portable mode and custom installs)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workreview-home-"))
  expect(resolveConfigPath({ home, platform: "win32", env: { WORK_REVIEW_HOME: dir, APPDATA: "C:\\x" } })).toBe(
    path.join(dir, "config.json"),
  )
})

test("a moved data dir in data-location.json wins", () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "workreview-cfg-"))
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), "workreview-data-"))
  fs.mkdirSync(path.join(cfg, "work-review"), { recursive: true })
  fs.writeFileSync(
    path.join(cfg, "work-review", "data-location.json"),
    JSON.stringify({ data_dir: moved }),
  )
  const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: path.join(cfg, "unused") }
  expect(readDataLocation({ home, platform: "linux", env })).toBe(path.resolve(moved))
  expect(resolveConfigPath({ home, platform: "linux", env })).toBe(path.join(path.resolve(moved), "config.json"))
})

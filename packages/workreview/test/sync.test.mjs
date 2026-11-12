import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { desired, syncOnce } from "../lib/sync.mjs"

const bridge = {
  text_model: {
    provider: "custom",
    endpoint: "http://127.0.0.1:3425/v1",
    api_key: "magpie-workreview",
    model: "group/cheap-first",
  },
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workreview-sync-"))
  const configPath = path.join(dir, "work-review", "config.json")
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ai_mode: "summary",
        text_model: {
          provider: "siliconflow",
          endpoint: "https://api.siliconflow.cn/v1",
          api_key: "sk-user",
          model: "deepseek-ai/DeepSeek-V4-Flash",
          enable_thinking: null,
          max_output_tokens: 4096,
        },
        text_model_profiles: [{ id: "default-text-model" }],
      },
      null,
      2,
    ),
  )
  return {
    dir,
    configPath,
    bridgePath: path.join(dir, "bridge.json"),
    statePath: path.join(dir, "state.json"),
    read: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
    writeBridge: (value) => fs.writeFileSync(path.join(dir, "bridge.json"), JSON.stringify(value ?? {}, null, 2)),
  }
}

test("a complete bridge writes the four keys and keeps the rest", () => {
  const s = sandbox()
  s.writeBridge(bridge)
  expect(syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })).toBe("applied")
  const cfg = s.read()
  expect(cfg.ai_mode).toBe("summary")
  expect(cfg.text_model).toEqual({
    provider: "custom",
    endpoint: "http://127.0.0.1:3425/v1",
    api_key: "magpie-workreview",
    model: "group/cheap-first",
    enable_thinking: null,
    max_output_tokens: 4096,
  })
  expect(cfg.text_model_profiles).toEqual([{ id: "default-text-model" }])
})

test("syncing again changes nothing", () => {
  const s = sandbox()
  s.writeBridge(bridge)
  syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })
  const before = fs.readFileSync(s.configPath, "utf8")
  expect(syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })).toBe("current")
  expect(fs.readFileSync(s.configPath, "utf8")).toBe(before)
})

test("an empty bridge puts the user's text_model back", () => {
  const s = sandbox()
  const original = s.read().text_model
  s.writeBridge(bridge)
  syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })
  s.writeBridge({})
  expect(syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })).toBe("restored")
  expect(s.read().text_model).toEqual(original)
  expect(fs.existsSync(s.statePath)).toBe(false)
})

test("a bridge with an incomplete model is a disconnect, not a half write", () => {
  expect(desired({ text_model: { endpoint: "http://127.0.0.1:3425/v1", model: "group/cheap-first" } })).toBeNull()
  expect(desired({ text_model: { endpoint: "", api_key: "k", model: "m" } })).toBeNull()
  expect(desired({})).toBeNull()
  expect(desired(bridge)).toEqual(bridge.text_model)
})

test("a missing config.json is reported, not created", () => {
  const s = sandbox()
  fs.rmSync(s.configPath)
  s.writeBridge(bridge)
  const logged = []
  expect(
    syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath, log: (m) => logged.push(m) }),
  ).toBe("missing")
  expect(fs.existsSync(s.configPath)).toBe(false)
  expect(logged.join("\n")).toContain("not at")
})

test("restores a text_model that did not exist before", () => {
  const s = sandbox()
  const cfg = s.read()
  delete cfg.text_model
  fs.writeFileSync(s.configPath, JSON.stringify(cfg, null, 2))
  s.writeBridge(bridge)
  syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })
  expect(s.read().text_model.model).toBe("group/cheap-first")
  s.writeBridge({})
  syncOnce({ bridgePath: s.bridgePath, statePath: s.statePath, configPath: s.configPath })
  expect("text_model" in s.read()).toBe(false)
})

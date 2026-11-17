import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  APP_DATA_ID,
  BASE_URL_SCHEMA,
  PICKER_GROUP,
  PROFILE_ID,
  appDataDirFor,
  applyProfile,
  pathsFor,
  startBridge,
  sync,
  wanted,
} from "./bridge.mjs"
import { agent, connect } from "./cteno.agent.js"

const gateway = {
  url: "http://127.0.0.1:3425",
  v1: "http://127.0.0.1:3425/v1",
  key: "magpie-cteno",
}

const userProfiles = JSON.stringify(
  {
    profiles: [
      {
        id: "my-own",
        name: "My DeepSeek",
        api_format: "openai",
        chat: {
          api_key: "secret://vault/deepseek",
          base_url: "https://api.example.com/v1",
          model: "deepseek-v4-pro",
          temperature: 0.7,
          max_tokens: 8192,
          context_window_tokens: 128000,
        },
        compress: {
          api_key: "secret://vault/deepseek",
          base_url: "https://api.example.com/v1",
          model: "deepseek-v4-flash",
          temperature: 0.3,
          max_tokens: 4096,
          context_window_tokens: 128000,
        },
      },
    ],
    default_profile_id: "my-own",
    subscription_compress: { codex: "gpt-5.4-mini" },
    default_image_backend: null,
    default_vision_backend: null,
    light_model: { profileId: "my-own", lane: "compress" },
    base_url_schema: 1,
  },
  null,
  2,
) + "\n"

let root
let p

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-cteno-"))
  p = pathsFor({ home: root, platform: "darwin", env: {} })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const get = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)

const pick = (modelId, modelExtra = {}) => {
  const model = { id: modelId, ...modelExtra }
  const out = connect({ gateway, model })
  put(p.control, JSON.stringify({ model: modelId, ...out }, null, 2) + "\n")
}

const off = () => {
  if (!fs.existsSync(p.control)) return
  put(p.control, "{}\n")
}

test("agent descriptor and connect match magpie's plugged-agent contract", () => {
  expect(agent.id).toBe("cteno")
  expect(agent.name).toBe("Cteno")
  expect(agent.bin).toBe("cteno-host-cli")
  expect(agent.dir).toBe("~/.cteno")
  expect(agent.config).toBe("~/.config/magpie-cteno/connection.json")
  expect(agent.model).toBe("model")
  expect(agent.ua).toEqual(["cteno"])
  expect(agent.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)

  const out = connect({
    gateway,
    model: { id: "deepseek/deepseek-flash", context: 131072, output: 16384, images: true, efforts: ["low", "high"] },
  })
  expect(out).toEqual({
    baseURL: "http://127.0.0.1:3425/v1",
    gatewayKey: "magpie-cteno",
    modelInfo: { context: 131072, output: 16384, images: true, thinking: true },
  })
})

test("appDataDirFor resolves OS app-data folders and CTENO_APP_DATA_DIR override", () => {
  expect(appDataDirFor({ home: "/Users/alice", platform: "darwin", env: {} })).toBe(
    `/Users/alice/Library/Application Support/${APP_DATA_ID}`,
  )
  expect(appDataDirFor({ home: "C:\\Users\\alice", platform: "win32", env: { APPDATA: "D:\\Roaming" } })).toBe(
    path.join("D:\\Roaming", APP_DATA_ID),
  )
  expect(appDataDirFor({ home: "/home/alice", platform: "linux", env: {} })).toBe(
    `/home/alice/.local/share/${APP_DATA_ID}`,
  )
  expect(appDataDirFor({ home: "/home/alice", platform: "linux", env: { XDG_DATA_HOME: "/xdg/data" } })).toBe(
    `/xdg/data/${APP_DATA_ID}`,
  )
  expect(
    appDataDirFor({
      home: "/Users/alice",
      platform: "darwin",
      env: { CTENO_APP_DATA_DIR: "/tmp/custom-cteno-data" },
    }),
  ).toBe("/tmp/custom-cteno-data")
})

test("connect writes the magpie profile beside user profiles, and disconnect restores byte for byte", () => {
  const customFormatting = userProfiles.replace(/\n/g, "\r\n").replace(/\r\n$/, "")
  put(p.profiles, customFormatting)

  pick("deepseek/deepseek-flash", { context: 65536, output: 8192, images: false, efforts: ["none"] })
  expect(sync(p)).toBe("connected")

  const store = JSON.parse(get(p.profiles))
  expect(store.default_profile_id).toBe(PROFILE_ID)
  expect(store.subscription_compress).toEqual({ codex: "gpt-5.4-mini" })
  expect(store.light_model).toEqual({ profileId: "my-own", lane: "compress" })
  expect(store.base_url_schema).toBe(BASE_URL_SCHEMA)
  expect(store.profiles).toHaveLength(2)
  expect(store.profiles[0].id).toBe("my-own")
  expect(store.profiles[1]).toEqual({
    id: PROFILE_ID,
    name: "deepseek/deepseek-flash",
    api_format: "anthropic",
    picker_group: PICKER_GROUP,
    supports_vision: false,
    chat: {
      api_key: "magpie-cteno",
      base_url: "http://127.0.0.1:3425/v1",
      model: "deepseek/deepseek-flash",
      temperature: 0.7,
      max_tokens: 8192,
      context_window_tokens: 65536,
    },
    compress: {
      api_key: "magpie-cteno",
      base_url: "http://127.0.0.1:3425/v1",
      model: "deepseek/deepseek-flash",
      temperature: 0.3,
      max_tokens: 8192,
      context_window_tokens: 65536,
    },
  })

  // Switching models updates only the magpie entry and still restores the very first file
  pick("claude/claude-sonnet-4-6", { context: 200000, output: 16384, images: true, efforts: ["medium", "high"] })
  expect(sync(p)).toBe("connected")
  const updated = JSON.parse(get(p.profiles))
  expect(updated.profiles).toHaveLength(2)
  expect(updated.profiles[1].name).toBe("claude/claude-sonnet-4-6")
  expect(updated.profiles[1].supports_vision).toBe(true)
  expect(updated.profiles[1].thinking).toBe(true)
  expect(updated.profiles[1].chat.max_tokens).toBe(16384)
  expect(updated.profiles[1].compress.max_tokens).toBe(8192)

  off()
  expect(sync(p)).toBe("disconnected")
  expect(Buffer.from(get(p.profiles))).toEqual(Buffer.from(customFormatting))
  expect(get(p.state)).toBeNull()
})

test("when profiles.json did not exist, connect creates it with base_url_schema 1 and disconnect removes it", () => {
  pick("deepseek/deepseek-flash")
  expect(sync(p)).toBe("connected")

  const created = JSON.parse(get(p.profiles))
  expect(created.base_url_schema).toBe(BASE_URL_SCHEMA)
  expect(created.default_profile_id).toBe(PROFILE_ID)
  expect(created.profiles).toHaveLength(1)
  expect(created.profiles[0].id).toBe(PROFILE_ID)

  off()
  expect(sync(p)).toBe("disconnected")
  expect(get(p.profiles)).toBeNull()
  expect(get(p.state)).toBeNull()
})

test("user edits made while connected are preserved on disconnect", () => {
  put(p.profiles, userProfiles)
  pick("deepseek/deepseek-flash")
  sync(p)

  // Simulate Cteno saving a second user profile while connected
  const mid = JSON.parse(get(p.profiles))
  mid.profiles.push({
    id: "added-while-connected",
    name: "Added",
    api_format: "anthropic",
    chat: mid.profiles[0].chat,
    compress: mid.profiles[0].compress,
  })
  put(p.profiles, JSON.stringify(mid, null, 2) + "\n")

  off()
  sync(p)

  const after = JSON.parse(get(p.profiles))
  expect(after.profiles.map((x) => x.id)).toEqual(["my-own", "added-while-connected"])
  expect(after.default_profile_id).toBe("my-own")
})

test("if the user switched Cteno's default profile while connected, disconnect keeps their new default", () => {
  put(p.profiles, userProfiles)
  pick("deepseek/deepseek-flash")
  sync(p)

  const mid = JSON.parse(get(p.profiles))
  mid.default_profile_id = "proxy-auto"
  put(p.profiles, JSON.stringify(mid, null, 2) + "\n")

  off()
  sync(p)

  const after = JSON.parse(get(p.profiles))
  expect(after.profiles.map((x) => x.id)).toEqual(["my-own"])
  expect(after.default_profile_id).toBe("proxy-auto")
})

test("a second pass with no change writes nothing, and file permissions are preserved", () => {
  if (process.platform === "win32") return
  put(p.profiles, userProfiles)
  fs.chmodSync(p.profiles, 0o640)
  pick("deepseek/deepseek-flash")
  sync(p)

  expect(fs.statSync(p.profiles).mode & 0o777).toBe(0o640)
  expect(fs.statSync(p.state).mode & 0o777).toBe(0o600)

  const before = fs.statSync(p.profiles).mtimeMs
  const stateBefore = get(p.state)
  sync(p)
  expect(fs.statSync(p.profiles).mtimeMs).toBe(before)
  expect(get(p.state)).toBe(stateBefore)
})

test("applyProfile is idempotent when profiles.json already matches", () => {
  const want = wanted(
    JSON.stringify({
      model: "deepseek/deepseek-flash",
      baseURL: gateway.v1,
      gatewayKey: gateway.key,
      modelInfo: {},
    }),
  )
  const once = applyProfile(userProfiles, want)
  expect(applyProfile(once, want)).toBe(once)
})

test("refuses malformed JSON, bad schemas, bad URLs and symlinks without touching user files", () => {
  const badStores = [
    "{not json",
    "[]\n",
    '{"profiles": {}}\n',
    '{"profiles": [{}]}\n',
  ]
  for (const raw of badStores) {
    put(p.profiles, raw)
    pick("deepseek/deepseek-flash")
    expect(() => sync(p)).toThrow()
    try {
      sync(p)
    } catch (e) {
      expect(e.refusal).toBe(true)
    }
    expect(get(p.profiles)).toBe(raw)
    expect(get(p.state)).toBeNull()
  }

  put(p.profiles, userProfiles)
  put(
    p.control,
    JSON.stringify({ model: "deepseek/deepseek-flash", baseURL: "ftp://bad", gatewayKey: "magpie-cteno" }),
  )
  expect(() => sync(p)).toThrow()
  expect(get(p.profiles)).toBe(userProfiles)

  if (process.platform !== "win32") {
    fs.rmSync(p.profiles, { force: true })
    const target = path.join(root, "real-profiles.json")
    put(target, userProfiles)
    fs.mkdirSync(path.dirname(p.profiles), { recursive: true })
    fs.symlinkSync(target, p.profiles)
    pick("deepseek/deepseek-flash")
    expect(() => sync(p)).toThrow()
    expect(get(target)).toBe(userProfiles)
    expect(fs.lstatSync(p.profiles).isSymbolicLink()).toBe(true)
  }
})

test("startBridge follows connection.json across connect, model switch, Cteno overwrite and disconnect", async () => {
  put(p.profiles, userProfiles)
  const stop = startBridge(p, {
    interval: 20,
    onError: (e) => {
      throw e
    },
  })
  const settle = (ok) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const look = () =>
        ok() ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("timeout")) : setTimeout(look, 10)
      look()
    })

  try {
    pick("deepseek/deepseek-flash")
    await settle(() => {
      const s = JSON.parse(get(p.profiles) ?? "{}")
      return s.default_profile_id === PROFILE_ID && s.profiles?.some((x) => x.name === "deepseek/deepseek-flash")
    })

    // If a running Cteno overwrites profiles.json from memory without the magpie row, bridge re-applies it
    put(p.profiles, userProfiles)
    await settle(() => {
      const s = JSON.parse(get(p.profiles) ?? "{}")
      return s.profiles?.some((x) => x.id === PROFILE_ID)
    })

    pick("openai/gpt-5.4")
    await settle(() => {
      const s = JSON.parse(get(p.profiles) ?? "{}")
      return s.profiles?.some((x) => x.name === "openai/gpt-5.4")
    })

    off()
    await settle(() => get(p.profiles) === userProfiles && get(p.state) === null)
  } finally {
    stop()
  }
})

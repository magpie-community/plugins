import { expect, test } from "bun:test"
import { agent, connect } from "./lorca.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-lorca" }

test("exports agent metadata for Lorca", () => {
  expect(agent).toMatchObject({
    id: "lorca",
    name: "Lorca",
    config: "~/.lorca/credentials.json",
    format: "json",
    dir: "~/.lorca",
    ua: ["lorca"],
    library: {
      mcp: "~/.lorca/mcp.json",
      mcpFormat: "claude",
    },
    // Parent of the provider key. Naming the key itself makes magpie 0.1.4253
    // lift it out of connect's result and refuse with "no keys to write".
    merge: ["custom"],
  })
})

test("connect maps models, gateway and thinking levels correctly", () => {
  const models = [
    {
      id: "deepseek/pro",
      name: "DeepSeek Pro",
      context: 128000,
      output: 8192,
      images: true,
      efforts: ["none", "minimal", "low", "high", "unknown_level"],
    },
    {
      id: "plain-model",
      efforts: [],
    },
    null,
    {},
  ]

  const out = connect({ gateway, models })
  const provider = out["custom.custom:magpie"]
  expect(provider).toBeDefined()
  expect(provider.name).toBe("Magpie")
  expect(provider.api).toBe("chat-completions")
  expect(provider.base_url).toBe("http://127.0.0.1:3425/v1")
  expect(provider.api_key).toBe("magpie-lorca")
  expect(typeof provider.created_at).toBe("number")

  expect(provider.models).toHaveLength(2)
  expect(provider.models[0]).toEqual({
    id: "deepseek/pro",
    name: "DeepSeek Pro",
    context_window: 128000,
    max_output: 8192,
    images: true,
    levels: ["off", "minimal", "low", "high"],
  })
  expect(provider.models[1]).toEqual({
    id: "plain-model",
    images: false,
  })
})

// KEY is the provider connect returns. merge must be its parent: magpie's
// merged() (internal/agent/plugged.go) lifts an object returned at a merge
// path out of the result and writes its members. magpie 0.1.4253 then
// refuses a connect-only plugin once that result is empty, before those
// members are counted — "connect returned no keys to write" (plugins#1362).
// A later magpie counts the lifted members; this is the check that failed.
const KEY = "custom.custom:magpie"

function keysToWrite(merge, returned) {
  const out = { ...returned }
  const kvs = []
  for (const m of merge) {
    const v = out[m]
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    delete out[m]
    for (const k of Object.keys(v).sort()) kvs.push({ path: `${m}.${k}`, value: v[k] })
  }
  if (Object.keys(out).length === 0) {
    throw new Error("connect returned no keys to write")
  }
  for (const k of Object.keys(out).sort()) kvs.push({ path: k, value: out[k] })
  return kvs
}

function getPath(file, path) {
  let cur = file
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(file, path, value) {
  const parts = path.split(".")
  let cur = file
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object" || Array.isArray(cur[parts[i]])) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function deletePath(file, path) {
  const parts = path.split(".")
  let cur = file
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== "object") return
    cur = cur[parts[i]]
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]]
}

// made are merge paths, and the objects they sit in, that the file didn't
// have. magpie removes one afterwards when disconnect leaves it {}.
function madePaths(merge, before) {
  const out = []
  for (const m of merge) {
    const parts = m.split(".")
    for (let i = 0; i < parts.length; i++) {
      const k = parts.slice(0, i + 1).join(".")
      if (getPath(before, k) === undefined && !out.includes(k)) out.push(k)
    }
  }
  return out
}

function connectFile(before, models) {
  const returned = connect({ gateway, models })
  const kvs = keysToWrite(agent.merge, returned)
  const next = structuredClone(before)
  const had = {}
  for (const kv of kvs) {
    if (!(kv.path in had)) {
      const prev = getPath(before, kv.path)
      had[kv.path] = prev === undefined ? null : structuredClone(prev)
    }
    setPath(next, kv.path, structuredClone(kv.value))
  }
  return { file: next, had, made: madePaths(agent.merge, before) }
}

function disconnectFile(file, had, made) {
  const next = structuredClone(file)
  for (const k of Object.keys(had)) {
    if (had[k] === null) deletePath(next, k)
    else setPath(next, k, structuredClone(had[k]))
  }
  for (let i = made.length - 1; i >= 0; i--) {
    const v = getPath(next, made[i])
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) deletePath(next, made[i])
  }
  return next
}

test("merge names custom, so connect's provider key is written", () => {
  expect(agent.merge).toEqual(["custom"])
  const returned = connect({ gateway, models: [] })
  expect(Object.keys(returned)).toEqual([KEY])
  expect(() => keysToWrite(agent.merge, returned)).not.toThrow()
})

test("connect writes custom:magpie beside sibling providers and other keys", () => {
  const before = {
    theme: "dark",
    kept: { n: 1 },
    custom: { "custom:mine": { base_url: "x" } },
  }
  const { file, had, made } = connectFile(before, [{ id: "deepseek/pro", name: "DeepSeek Pro" }])
  expect(file.theme).toBe("dark")
  expect(file.kept).toEqual({ n: 1 })
  expect(file.custom["custom:mine"]).toEqual({ base_url: "x" })
  const provider = file.custom["custom:magpie"]
  expect(provider.name).toBe("Magpie")
  expect(provider.api).toBe("chat-completions")
  expect(provider.base_url).toBe(gateway.v1)
  expect(provider.api_key).toBe(gateway.key)
  expect(provider.models).toEqual([{ id: "deepseek/pro", name: "DeepSeek Pro", images: false }])
  expect(typeof provider.created_at).toBe("number")
  expect(Object.keys(file.custom).sort()).toEqual(["custom:magpie", "custom:mine"])

  const after = disconnectFile(file, had, made)
  expect(after).toEqual(before)
})

test("disconnect removes a custom object magpie created and leaves other keys", () => {
  const before = { theme: "dark" }
  const { file, had, made } = connectFile(before, [])
  expect(file.custom["custom:magpie"].name).toBe("Magpie")
  expect(file.theme).toBe("dark")
  expect(disconnectFile(file, had, made)).toEqual(before)
})

test("disconnect restores a custom:magpie the user already had", () => {
  const before = {
    theme: "dark",
    custom: {
      "custom:mine": { base_url: "x" },
      "custom:magpie": { name: "Mine", extra: 1 },
    },
  }
  const { file, had, made } = connectFile(before, [])
  expect(file.custom["custom:magpie"].name).toBe("Magpie")
  expect(file.custom["custom:magpie"].extra).toBeUndefined()
  expect(file.custom["custom:mine"]).toEqual({ base_url: "x" })
  expect(disconnectFile(file, had, made)).toEqual(before)
})

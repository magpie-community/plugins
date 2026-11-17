import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agent, connect } from "./openbitfun.agent.js"
import { INSTANCE, importIssue, mergeModels, readLibraryMcp, revertModels, sync, wanted } from "./bridge.mjs"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-openbitfun-key" }

// An app.json as OpenBitFun writes one: 2-space indent, key order kept, keys it
// does not know about preserved.
const appJson = () =>
  JSON.stringify(
    {
      ai: {
        models: [
          {
            id: "deepseek/deepseek-v4-flash",
            name: "My own",
            provider: "openai",
            model_name: "deepseek/deepseek-v4-flash",
            base_url: "https://api.example.com/v1",
            api_key: "sk-mine",
            enabled: true,
            category: "general_chat",
            capabilities: ["text_chat"],
            recommended_for: [],
          },
        ],
        default_models: { primary: "deepseek/deepseek-v4-flash", fast: null },
      },
      app: { language: "zh-CN" },
      last_modified: 1794882444100,
      version: "1.0.9",
    },
    null,
    2,
  ) + "\n"

function workspace(bridge) {
  const dir = mkdtempSync(join(tmpdir(), "openbitfun-bridge-"))
  const paths = { bridge: join(dir, "bridge.json"), library: join(dir, "mcp.json"), state: join(dir, "state.json"), config: join(dir, "app.json") }
  writeFileSync(paths.config, appJson())
  if (bridge !== undefined) writeFileSync(paths.bridge, JSON.stringify({ bridge }))
  return { dir, paths, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test("is a switch, not a model picker, and says where magpie keeps its file", async () => {
  expect(agent).toMatchObject({ id: "openbitfun", name: "OpenBitFun", format: "json" })
  expect(agent.model).toBeUndefined()
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.magpie.agent).toBe("./openbitfun.agent.js")
  expect(pkg.magpie.icon).toBeUndefined()
  expect(agent.icon).toBe("https://openbitfun.com/assets/openbitfun-app-mark.png")
})

test("connect writes one bridge key holding the gateway and a slim model list", () => {
  const out = connect({
    gateway,
    models: [
      { id: "group/work", name: "Work group", context: 400_000, output: 64_000, images: true, pricing: { prompt: "1" }, native_endpoints: ["/v1/messages"] },
      { id: "plain", name: "plain" },
      null,
      { name: "no id" },
    ],
  })
  expect(Object.keys(out)).toEqual(["bridge"])
  expect(out.bridge).toEqual({
    version: 1,
    url: "http://127.0.0.1:3425/v1",
    key: "magpie-openbitfun-key",
    models: [
      { id: "group/work", name: "Work group", context: 400_000, output: 64_000, images: true },
      { id: "plain" },
    ],
  })
})

test("connect without models still says where the gateway is", () => {
  expect(connect({ gateway }).bridge.models).toEqual([])
})

test("a catalog entry OpenBitFun cannot persist is not imported", () => {
  expect(importIssue({ id: "a", context: 31_999 })).toBe("contextTooSmall")
  expect(importIssue({ id: "a", context: 32_000 })).toBeUndefined()
  expect(importIssue({ id: "a", output: 0 })).toBe("invalidLimits")
  expect(importIssue({ id: "a", context: 2 ** 33 })).toBe("invalidLimits")
  expect(importIssue({ id: "a", output: 12.5 })).toBe("invalidLimits")
})

test("an entry carries what OpenBitFun's own importer writes", () => {
  const [entry] = mergeModels([], {
    url: "http://127.0.0.1:3425",
    key: "k",
    models: [{ id: "group/work", name: "Work", context: 400_000, output: 64_000, images: true }],
  })
  expect(entry).toEqual({
    id: "group/work",
    name: "Magpie",
    provider: "openai",
    model_name: "group/work",
    base_url: "http://127.0.0.1:3425/v1",
    api_key: "k",
    context_window: 400_000,
    max_tokens: 64_000,
    enabled: true,
    category: "multimodal",
    capabilities: ["text_chat", "function_calling", "image_understanding"],
    recommended_for: [],
    metadata: {
      model_source: "magpie",
      provider_instance_id: INSTANCE,
      magpie_catalog_name: "Work",
      magpie_max_output_tokens: 64_000,
    },
    auth: { type: "api_key" },
  })
})

test("an advertised output over the 40% cap is cut to it, and unknown context keeps the default", () => {
  const [capped] = mergeModels([], { url: gateway.v1, key: "k", models: [{ id: "a", context: 100_000, output: 90_000 }] })
  expect(capped.max_tokens).toBe(40_000)
  const [unknown] = mergeModels([], { url: gateway.v1, key: "k", models: [{ id: "b", output: 999_999 }] })
  expect(unknown.context_window).toBeUndefined()
  expect(unknown.max_tokens).toBe(Math.floor(128_128 * 40 / 100))
})

test("ids that collide with another entry or with a reserved name get a suffix", () => {
  const current = [
    { id: "taken", model_name: "x" },
    { id: "primary", model_name: "y" },
  ]
  const ids = mergeModels(current, {
    url: gateway.v1,
    key: "k",
    models: [{ id: "taken" }, { id: "primary" }, { id: "taken" }, { id: "fresh" }],
  }).map((model) => model.id)
  expect(ids).toEqual(["taken", "primary", "taken-2", "primary-2", "taken-3", "fresh"])
})

test("the user's own entries stay, byte for byte", () => {
  const current = [{ id: "deepseek/deepseek-v4-flash", name: "My own", api_key: "sk-mine" }]
  const out = mergeModels(current, { url: gateway.v1, key: "k", models: [{ id: "group/work" }] })
  expect(out[0]).toBe(current[0])
  expect(out).toHaveLength(2)
})

test("a reconnect follows the gateway and the catalog, and keeps the user's settings", () => {
  const [stored] = mergeModels([], { url: gateway.v1, key: "old-key", models: [{ id: "a", context: 200_000, output: 8_000 }] })
  const changed = { ...stored, api_key: "old-key", enabled: false, temperature: 0.3 }
  const [, refreshed] = mergeModels([{ id: "mine" }, changed], {
    url: "http://127.0.0.1:9999/v1",
    key: "new-key",
    models: [{ id: "a", context: 300_000, output: 16_000 }],
  })
  expect(refreshed.id).toBe(changed.id)
  expect(refreshed.enabled).toBe(false)
  expect(refreshed.temperature).toBe(0.3)
  expect(refreshed.base_url).toBe("http://127.0.0.1:9999/v1")
  expect(refreshed.api_key).toBe("new-key")
  expect(refreshed.context_window).toBe(300_000)
  expect(refreshed.max_tokens).toBe(16_000)
})

test("a model magpie no longer offers leaves the list, and another's entries do not", () => {
  const [ours] = mergeModels([], { url: gateway.v1, key: "k", models: [{ id: "gone" }] })
  const theirs = {
    id: "theirs",
    model_name: "theirs",
    metadata: { model_source: "magpie", provider_instance_id: "random-uuid-from-openbitfun" },
  }
  const out = mergeModels([ours, theirs], { url: gateway.v1, key: "k", models: [{ id: "kept" }] })
  expect(out.map((model) => model.model_name)).toEqual(["theirs", "kept"])
})

test("switching off takes out only what magpie wrote", () => {
  const theirs = { id: "theirs", model_name: "theirs" }
  const [ours] = mergeModels([], { url: gateway.v1, key: "k", models: [{ id: "ours" }] })
  expect(revertModels([theirs, ours])).toEqual([theirs])
  expect(revertModels([ours, ours])).toEqual([])
})

test("a bridge file magpie did not write, or a broken one, is no instruction", () => {
  expect(wanted(null)).toBeNull()
  expect(wanted({})).toBeNull()
  expect(wanted({ bridge: { version: 2, url: gateway.v1, key: "k", models: [] } })).toBeNull()
  expect(wanted({ bridge: { version: 1, url: gateway.v1, key: "  ", models: [] } })).toBeNull()
  expect(wanted({ bridge: { version: 1, url: gateway.v1, key: "k" } })).toBeNull()
  for (const url of ["file:///tmp/key", "http://k@host", "https://host/?key=secret", "http://host/#k", "not a url"]) {
    expect(wanted({ bridge: { version: 1, url, key: "k", models: [] } })).toBeNull()
  }
  expect(wanted({ bridge: { version: 1, url: gateway.v1, key: "k", models: [{ id: "a" }] } })).not.toBeNull()
})

test("sync writes the entries in place and puts the file back exactly", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "group/work", name: "Work", context: 400_000, output: 64_000 }] }).bridge)
  const original = readFileSync(found.paths.config, "utf8")
  try {
    expect(await sync(found.paths)).toBe("connected")
    const written = JSON.parse(readFileSync(found.paths.config, "utf8"))
    expect(written.ai.models).toHaveLength(2)
    expect(written.ai.models[0].name).toBe("My own")
    expect(written.ai.models[1].model_name).toBe("group/work")
    expect(written.ai.default_models.primary).toBe("deepseek/deepseek-v4-flash")
    expect(written.last_modified).toBe(1794882444100)

    rmSync(found.paths.bridge)
    expect(await sync(found.paths)).toBe("disconnected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(original)
  } finally {
    found.done()
  }
})

test("sync reports no change when there is nothing to change", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "a" }] }).bridge)
  try {
    await sync(found.paths)
    const once = readFileSync(found.paths.config, "utf8")
    expect(await sync(found.paths)).toBe("connected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(once)
  } finally {
    found.done()
  }
})

test("a number the file spelled 1.0 comes back spelled 1.0", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "a" }] }).bridge)
  const text = readFileSync(found.paths.config, "utf8").replace('"app": {', '"app": {\n    "zoom_level": 1.0,')
  writeFileSync(found.paths.config, text)
  try {
    expect(await sync(found.paths)).toBe("connected")
    expect(readFileSync(found.paths.config, "utf8")).toContain('"zoom_level": 1,')
    rmSync(found.paths.bridge)
    expect(await sync(found.paths)).toBe("disconnected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(text)
  } finally {
    found.done()
  }
})

test("a file edited while connected keeps the edit and loses only our entries", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "a" }] }).bridge)
  try {
    await sync(found.paths)
    const edited = JSON.parse(readFileSync(found.paths.config, "utf8"))
    edited.ai.models.push({ id: "added-by-hand", name: "Mine" })
    writeFileSync(found.paths.config, JSON.stringify(edited, null, 2))
    rmSync(found.paths.bridge)
    expect(await sync(found.paths)).toBe("disconnected")
    const back = JSON.parse(readFileSync(found.paths.config, "utf8"))
    expect(back.ai.models.map((model) => model.id)).toEqual(["deepseek/deepseek-v4-flash", "added-by-hand"])
  } finally {
    found.done()
  }
})

test("an OpenBitFun that never ran is not given a config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbitfun-absent-"))
  const paths = { bridge: join(dir, "bridge.json"), library: join(dir, "mcp.json"), state: join(dir, "state.json"), config: join(dir, "app.json") }
  try {
    writeFileSync(paths.bridge, JSON.stringify(connect({ gateway, models: [{ id: "a" }] })))
    expect(await sync(paths)).toBe("no-openbitfun")
    expect(existsSync(paths.config)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty catalog leaves the entries as they are", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "a" }] }).bridge)
  try {
    await sync(found.paths)
    const withEntry = readFileSync(found.paths.config, "utf8")
    writeFileSync(found.paths.bridge, JSON.stringify(connect({ gateway, models: [] })))
    expect(await sync(found.paths)).toBe("connected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(withEntry)
  } finally {
    found.done()
  }
})

test("a file that is not JSON config is left alone", async () => {
  const found = workspace(connect({ gateway, models: [{ id: "a" }] }).bridge)
  try {
    writeFileSync(found.paths.config, "{ not json")
    expect(await sync(found.paths)).toBe("unreadable")
    expect(readFileSync(found.paths.config, "utf8")).toBe("{ not json")
  } finally {
    found.done()
  }
})

test("what a model can do comes from the gateway's own list, not magpie's images flag", async () => {
  // magpie hands every model images: true on 0.1.4332, so /v1/models decides.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        data: [
          { id: "text-only", tool_call: true, modalities: { input: ["text"], output: ["text"] } },
          { id: "sees", tool_call: true, modalities: { input: ["text", "image"], output: ["text"] } },
          { id: "no-tools", tool_call: false, modalities: { input: ["text"] } },
        ],
      }),
  })
  const url = `http://127.0.0.1:${server.port}/v1`
  const found = workspace({ version: 1, url, key: "k", models: [] })
  writeFileSync(found.paths.bridge, JSON.stringify({
    bridge: { version: 1, url, key: "k", models: [{ id: "text-only", images: true }, { id: "sees", images: true }, { id: "no-tools", images: true }] },
  }))
  try {
    expect(await sync(found.paths)).toBe("connected")
    const models = JSON.parse(readFileSync(found.paths.config, "utf8")).ai.models.slice(1)
    expect(models[0].capabilities).toEqual(["text_chat", "function_calling"])
    expect(models[0].category).toBe("general_chat")
    expect(models[1].capabilities).toEqual(["text_chat", "function_calling", "image_understanding"])
    expect(models[1].category).toBe("multimodal")
    expect(models[2].capabilities).toEqual(["text_chat"])
  } finally {
    server.stop(true)
    found.done()
  }
})

test("a gateway that cannot be asked keeps what magpie said", async () => {
  const found = workspace({ version: 1, url: "http://127.0.0.1:1/v1", key: "k", models: [{ id: "a", images: true }] })
  try {
    expect(await sync(found.paths)).toBe("connected")
    expect(JSON.parse(readFileSync(found.paths.config, "utf8")).ai.models[1].capabilities).toEqual([
      "text_chat", "function_calling", "image_understanding",
    ])
  } finally {
    found.done()
  }
})

test("the agent takes magpie's Library skills and MCP servers", () => {
  expect(agent.library).toEqual({
    mcp: "~/.config/magpie-openbitfun/library/mcp.json",
    mcpFormat: "cursor",
    skills: "$APPDATA/openbitfun/skills",
  })
  // OpenBitFun reads instructions per workspace only, so there is no file to
  // point magpie's shared instructions at.
  expect(agent.library.instructions).toBeUndefined()
})

test("Library MCP servers are merged into app.json, beside the user's own", async () => {
  const found = workspace(connect({ gateway, models: [] }).bridge)
  writeFileSync(found.paths.config, JSON.stringify({
    ai: { models: [] },
    mcp_servers: { mcpServers: { mine: { command: "my-server", autoStart: true } } },
  }, null, 2))
  writeFileSync(found.paths.library, JSON.stringify({
    mcpServers: { docs: { url: "https://example.test/mcp" }, mine: { command: "shared-edition" } },
  }))
  try {
    expect(await sync(found.paths)).toBe("connected")
    const servers = JSON.parse(readFileSync(found.paths.config, "utf8")).mcp_servers.mcpServers
    expect(servers.docs).toEqual({ url: "https://example.test/mcp" })
    expect(servers.mine).toEqual({ command: "shared-edition" })
  } finally {
    found.done()
  }
})

test("a server magpie stops giving goes back to what the user had, or away", async () => {
  const found = workspace(undefined)
  writeFileSync(found.paths.config, JSON.stringify({
    ai: { models: [] },
    mcp_servers: { mcpServers: { mine: { command: "my-server" }, theirs: { command: "only-theirs" } } },
  }, null, 2))
  const original = readFileSync(found.paths.config, "utf8")
  writeFileSync(found.paths.library, JSON.stringify({
    mcpServers: { mine: { command: "shared-edition" }, added: { command: "theirs-not" } },
  }))
  try {
    await sync(found.paths)
    rmSync(found.paths.library)
    expect(await sync(found.paths)).toBe("disconnected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(original)
  } finally {
    found.done()
  }
})

test("servers that are not a list of mcpServers are no instruction", () => {
  const found = workspace(undefined)
  try {
    writeFileSync(found.paths.library, "not json")
    expect(readLibraryMcp(found.paths.library)).toBeNull()
    writeFileSync(found.paths.library, JSON.stringify({ servers: {} }))
    expect(readLibraryMcp(found.paths.library)).toBeNull()
    writeFileSync(found.paths.library, JSON.stringify({ mcpServers: [] }))
    expect(readLibraryMcp(found.paths.library)).toBeNull()
    writeFileSync(found.paths.library, JSON.stringify({ mcpServers: {} }))
    expect(readLibraryMcp(found.paths.library)).toEqual({})
  } finally {
    found.done()
  }
})

test("a library that emptied itself takes the servers back out", async () => {
  const found = workspace(undefined)
  writeFileSync(found.paths.config, JSON.stringify({ ai: { models: [] }, mcp_servers: { mcpServers: { mine: {} } } }, null, 2))
  const original = readFileSync(found.paths.config, "utf8")
  writeFileSync(found.paths.library, JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }))
  try {
    await sync(found.paths)
    expect(Object.keys(JSON.parse(readFileSync(found.paths.config, "utf8")).mcp_servers.mcpServers)).toEqual(["mine", "docs"])
    writeFileSync(found.paths.library, JSON.stringify({ mcpServers: {} }))
    expect(await sync(found.paths)).toBe("connected")
    expect(readFileSync(found.paths.config, "utf8")).toBe(original)
  } finally {
    found.done()
  }
})

test("an emptied library and a switched-off agent both give the file back exactly", async () => {
  const found = workspace(undefined)
  const text = JSON.stringify({ ai: { models: [] }, app: { zoom_level: 1.0, language: "zh-CN" } }, null, 2) + "\n"
  writeFileSync(found.paths.config, text)
  writeFileSync(found.paths.bridge, JSON.stringify(connect({ gateway, models: [] })))
  writeFileSync(found.paths.library, JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }))
  try {
    await sync(found.paths)
    expect(readFileSync(found.paths.config, "utf8")).toContain('"docs"')
    // magpie keeps the file and empties it, then the agent is switched off.
    writeFileSync(found.paths.library, JSON.stringify({ mcpServers: {} }))
    await sync(found.paths)
    rmSync(found.paths.bridge)
    await sync(found.paths)
    expect(readFileSync(found.paths.config, "utf8")).toBe(text)
  } finally {
    found.done()
  }
})

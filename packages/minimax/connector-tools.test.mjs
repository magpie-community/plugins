// The connector tools over a fake request transport: no server, each
// test answering the two gateway calls itself and checking what went out.
// Covers site/account stripping, the catalog's partial and provider
// failures, is_error and broken result_json, bad arguments stopped before
// they could be sent, abort propagation, and the matrix-only call guard.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createConnectorTools, _internal } from "./connector-tools.mjs"

const LIST = "/minimax-cloud/api/v1/connectors/connected-tools/list"
const CALL = "/minimax-cloud/api/v1/connectors/tools/call"

const entry = (name, over = {}) => ({
  provider: "matrix",
  provider_tool_name: "mcp_" + name,
  runtime_tool_name: "connector__matrix__" + name,
  description: name + " tool",
  input_schema_json: JSON.stringify({ type: "object" }),
  ...over,
})

// transport(script) is a request() fake: script[path] answers or throws;
// sent records every call as {site, path, body, signal, timeoutMs, account}.
function transport(script) {
  const sent = []
  const request = async (site, path, body, opts = {}) => {
    sent.push({ site, path, body, signal: opts.signal, timeoutMs: opts.timeoutMs, account: opts.account })
    const h = script[path]
    if (!h) throw new Error("no fake for " + path)
    if (h instanceof Error) throw h
    return typeof h === "function" ? h({ site, body }) : h
  }
  return { request, sent }
}

const catalog = (tools, over = {}) => ({ tools, partial: false, provider_failures: [], ...over })

test("a direct tool calls the gateway with the catalog's own routing, site and account stripped", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image")]),
    [CALL]: { result_json: JSON.stringify({ success_items: [{ node_id: "n1", file_name: "a.png" }] }) },
  })
  const { tool } = createConnectorTools(t.request)
  const out = await tool.generate_image.execute(
    { site: "minimax-code-global", account: "minimax-code-global#u42", requests: [{ prompt: "a cat" }] },
    { abort: new AbortController().signal },
  )
  expect(out).toEqual({ success_items: [{ node_id: "n1", file_name: "a.png" }] })
  const [list, call] = t.sent
  expect(list.site).toBe("minimax-code-global")
  expect(list.account).toBe("minimax-code-global#u42")
  expect(list.body).toEqual({})
  expect(call.path).toBe(CALL)
  expect(call.body).toEqual({
    provider: "matrix",
    provider_tool_name: "mcp_generate_image",
    runtime_tool_name: "connector__matrix__generate_image",
    arguments_json: JSON.stringify({ requests: [{ prompt: "a cat" }] }),
  })
  // site/account never reach the gateway arguments
  expect(JSON.parse(call.body.arguments_json).site).toBeUndefined()
  expect(JSON.parse(call.body.arguments_json).account).toBeUndefined()
})

test("the default site is minimax-code and no account is sent when none is given", async () => {
  const t = transport({
    [LIST]: catalog([entry("get_voice_list", { input_schema_json: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }) })]),
    [CALL]: { result_json: JSON.stringify({ code: 0, message: "ok", available_voices: [], total: 0 }) },
  })
  const { tool } = createConnectorTools(t.request)
  await tool.get_voice_list.execute({}, { abort: new AbortController().signal })
  expect(t.sent.every((r) => r.site === "minimax-code")).toBe(true)
  expect(t.sent.every((r) => r.account === undefined)).toBe(true)
})

test("ctx.abort is the signal the transport gets", async () => {
  const t = transport({
    [LIST]: catalog([entry("describe_images")]),
    [CALL]: { result_json: "{}" },
  })
  const { tool } = createConnectorTools(t.request)
  const ac = new AbortController()
  await tool.describe_images.execute({ image_info: [{ url: "https://x/a.png" }] }, { abort: ac.signal })
  expect(t.sent.every((r) => r.signal === ac.signal)).toBe(true)
})

test("list_tools answers the catalog and reports partial and provider failures", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image"), entry("search_images")], {
      partial: true,
      provider_failures: [{ provider: "email", code: "auth", message: "expired" }],
    }),
  })
  const { tool } = createConnectorTools(t.request)
  const out = await tool.list_tools.execute({ keyword: "image" }, {})
  expect(out.tools.map((x) => x.tool_name)).toEqual(["connector__matrix__generate_image", "connector__matrix__search_images"])
  expect(out.partial).toBe(true)
  expect(out.provider_failures).toEqual([{ provider: "email", code: "auth", message: "expired" }])
})

test("tool_schema shows the catalog's own schemas", async () => {
  const input = { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] }
  const t = transport({
    [LIST]: catalog([
      entry("get_asset_url", {
        input_schema_json: JSON.stringify(input),
        output_schema_json: JSON.stringify({ type: "object", properties: { code: { type: "integer" } } }),
      }),
    ]),
  })
  const { tool } = createConnectorTools(t.request)
  const out = await tool.tool_schema.execute({ tool_name: "connector__matrix__get_asset_url" }, {})
  expect(out.input_schema).toEqual(input)
  expect(out.output_schema).toEqual({ type: "object", properties: { code: { type: "integer" } } })
  expect(out.provider).toBe("matrix")
})

test("call_tool routes a matrix call and parses result_json", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image")]),
    [CALL]: { result_json: JSON.stringify({ node_id: "n9" }) },
  })
  const { tool } = createConnectorTools(t.request)
  const out = await tool.call_tool.execute(
    { tool_name: "connector__matrix__generate_image", arguments: { prompt: "x" } },
    {},
  )
  expect(out).toEqual({ node_id: "n9" })
})

test("call_tool refuses a non-matrix tool so other integrations stay unreachable", async () => {
  const t = transport({})
  const { tool } = createConnectorTools(t.request)
  await expect(
    tool.call_tool.execute({ tool_name: "connector__email_workbench_credentials__session", arguments: {} }, {}),
  ).rejects.toThrow(/only calls connector__matrix__/)
  expect(t.sent).toHaveLength(0)
})

test("is_error from the gateway is thrown with its code and message, not shaped like a result", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image")]),
    [CALL]: { is_error: true, error_code: "quota_exceeded", error_message: "weekly limit reached" },
  })
  const { tool } = createConnectorTools(t.request)
  await expect(
    tool.generate_image.execute({ requests: [{ prompt: "x" }] }, {}),
  ).rejects.toThrow("quota_exceeded: weekly limit reached")
})

test("a broken result_json is an error, not a silent null", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image")]),
    [CALL]: { result_json: "{not json" },
  })
  const { tool } = createConnectorTools(t.request)
  await expect(
    tool.generate_image.execute({ requests: [{ prompt: "x" }] }, {}),
  ).rejects.toThrow(/result_json is not valid JSON/)
})

test("bad arguments are refused before the call leaves", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image", {
      input_schema_json: JSON.stringify({ type: "object", properties: { requests: { type: "array" } }, required: ["requests"], additionalProperties: false }),
    })]),
  })
  const { tool } = createConnectorTools(t.request)
  // 'requests' is required by the catalog schema
  await expect(tool.generate_image.execute({ prompt: "x" }, {})).rejects.toThrow(/bad arguments/)
  // the catalog is read to judge them; the priced call never goes out
  expect(t.sent.map((r) => r.path)).toEqual([LIST])
})

// #955: the catalog's generate_image schema as hokaii6990-boop's
// `magpie tool minimax_tool_schema --tool_name connector__matrix__generate_image --json`
// printed it on a CN-site account on 2026-11-11.
const liveImage = readFileSync(new URL("./testdata/generate-image-schema-955.json", import.meta.url), "utf8")

test("generate_image takes the catalog's area, n, output_format and reference_images (#955)", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image", { input_schema_json: liveImage })]),
    [CALL]: { result_json: JSON.stringify({ success_items: [{ node_id: "n1", file_name: "image_1.png" }] }) },
  })
  const { tool } = createConnectorTools(t.request)
  const request = { prompt: "a fox, as 图1", aspect_ratio: "21:9", area: "2K", n: 2, output_format: "png", reference_images: [{ url: "https://upload.example/a.png", mime_type: "image/png" }] }
  await tool.generate_image.execute({ requests: [request] }, {})
  const calls = t.sent.filter((r) => r.path === CALL)
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body.arguments_json)).toEqual({ requests: [request] })
})

test("generate_image is refused by the catalog's schema, and says so (#955)", async () => {
  const t = transport({ [LIST]: catalog([entry("generate_image", { input_schema_json: liveImage })]) })
  const { tool } = createConnectorTools(t.request)
  // resolution is the old name; the catalog took it away
  await expect(tool.generate_image.execute({ requests: [{ prompt: "x", resolution: "2K" }] }, {}))
    .rejects.toThrow("arguments.requests[0].resolution is not an accepted argument (checked against the account's catalog schema for connector__matrix__generate_image)")
  expect(t.sent.filter((r) => r.path === CALL)).toHaveLength(0)
})

test("a tool the catalog gives no schema is held to the bundled copy, and says so", async () => {
  const t = transport({ [LIST]: catalog([entry("generate_image", { input_schema_json: "" })]) })
  const { tool } = createConnectorTools(t.request)
  await expect(tool.generate_image.execute({ requests: [{ prompt: "x", model: "image-01" }] }, {}))
    .rejects.toThrow("(checked against the bundled schema for connector__matrix__generate_image (the catalog gave none))")
  expect(t.sent.filter((r) => r.path === CALL)).toHaveLength(0)
})

test("the bundled generate_image schema is the catalog's of 2026-11-11 (#955)", () => {
  const { tool } = createConnectorTools(async () => ({}))
  const shown = tool.generate_image.args
  expect(shown.properties.requests).toEqual(JSON.parse(liveImage).properties.requests)
  expect(Object.keys(shown.properties.requests.items.properties)).not.toContain("resolution")
  expect(Object.keys(shown.properties.requests.items.properties)).not.toContain("input_urls")
  expect(tool.generate_image.description).not.toContain("input_urls")
})

test("video validation follows the per-model allOf rules", async () => {
  const video = {
    type: "object",
    properties: {
      model: { type: "string", enum: ["MiniMax-H3", "MiniMax-H3-Max", "MiniMax-Hailuo-2.3"] },
      prompt: { type: "string" },
      duration: { type: "integer" },
      reference_images: { type: "array", items: { type: "object" } },
      last_frame_image: { type: "object" },
    },
    required: ["prompt", "model"],
    additionalProperties: false,
    allOf: [
      { if: { properties: { model: { const: "MiniMax-Hailuo-2.3" } }, required: ["model"] },
        then: { not: { anyOf: [{ required: ["reference_images"] }, { required: ["last_frame_image"] }] } } },
      { if: { properties: { model: { const: "MiniMax-H3" } }, required: ["model"] },
        then: { properties: { duration: { minimum: 4, maximum: 15, type: "integer" } }, required: ["duration"] } },
    ],
  }
  const t = transport({
    [LIST]: catalog([entry("submit_video_generation", { input_schema_json: JSON.stringify(video) })]),
    [CALL]: { result_json: JSON.stringify({ task_id: "t1" }) },
  })
  const { tool } = createConnectorTools(t.request)
  // Hailuo + reference_images: the allOf not/anyOf refuses it
  await expect(
    tool.submit_video_generation.execute(
      { model: "MiniMax-Hailuo-2.3", prompt: "p", reference_images: [{ url: "u" }] },
      {},
    ),
  ).rejects.toThrow(/bad arguments/)
  // H3 without duration: required by its branch
  await expect(
    tool.submit_video_generation.execute({ model: "MiniMax-H3", prompt: "p" }, {}),
  ).rejects.toThrow(/bad arguments/)
  // H3 duration out of range
  await expect(
    tool.submit_video_generation.execute({ model: "MiniMax-H3", prompt: "p", duration: 20 }, {}),
  ).rejects.toThrow(/bad arguments/)
  // a legal H3 call goes out
  const out = await tool.submit_video_generation.execute({ model: "MiniMax-H3", prompt: "p", duration: 6 }, {})
  expect(out).toEqual({ task_id: "t1" })
  const calls = t.sent.filter((r) => r.path === CALL)
  expect(calls).toHaveLength(1)
})

test("a malformed catalog entry or a duplicate name is an error", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image"), entry("generate_image")]),
  })
  const { tool } = createConnectorTools(t.request)
  await expect(tool.list_tools.execute({}, {})).rejects.toThrow(/duplicate tool/)

  const t2 = transport({
    [LIST]: catalog([{ provider: "matrix" }]), // missing names
  })
  const { tool: tool2 } = createConnectorTools(t2.request)
  await expect(tool2.list_tools.execute({}, {})).rejects.toThrow(/malformed tool entry/)
})

test("a provider failure for the tool's provider is reported as such", async () => {
  const t = transport({
    [LIST]: catalog([], {
      provider_failures: [{ provider: "matrix", code: "disconnected", message: "token revoked" }],
    }),
  })
  const { tool } = createConnectorTools(t.request)
  await expect(
    tool.call_tool.execute({ tool_name: "connector__matrix__generate_image", arguments: { prompt: "x" } }, {}),
  ).rejects.toThrow(/provider matrix is unavailable: disconnected/)
})

test("an abort mid-call propagates as the transport's own rejection", async () => {
  const ac = new AbortController()
  const t = transport({
    [LIST]: () => { ac.abort(); return catalog([entry("get_voice_list")]) },
    [CALL]: new DOMException("The operation was aborted", "AbortError"),
  })
  const { tool } = createConnectorTools(t.request)
  await expect(tool.get_voice_list.execute({}, { abort: ac.signal })).rejects.toThrow(/abort/i)
})

test("missing results and Matrix business failures never look like a successful generation", async () => {
  for (const response of [{}, { is_error: "false", result_json: "{}" }, { result_json: JSON.stringify({ code: 402, message: "insufficient credits" }) }]) {
    const t = transport({ [LIST]: catalog([entry("generate_image")]), [CALL]: response })
    const { tool } = createConnectorTools(t.request)
    await expect(tool.generate_image.execute({ requests: [{ prompt: "fixture" }] })).rejects.toThrow()
    expect(t.sent.filter(r => r.path === CALL)).toHaveLength(1)
  }
})

test("discovery stays scoped to Matrix and generic arguments are checked before catalog lookup", async () => {
  const email = { ...entry("hidden"), runtime_tool_name: "connector__email__hidden", provider: "email" }
  const t = transport({ [LIST]: catalog([entry("generate_image"), email]) })
  const { tool } = createConnectorTools(t.request)
  const result = await tool.list_tools.execute({})
  expect(result.tools.map(t => t.tool_name)).toEqual(["connector__matrix__generate_image"])
  await expect(tool.tool_schema.execute({ tool_name: "connector__email__hidden" })).rejects.toThrow("only describes")
  const before = t.sent.length
  await expect(tool.list_tools.execute({ keyword: 42 })).rejects.toThrow("must be a string")
  await expect(tool.get_voice_list.execute(null)).rejects.toThrow("object")
  expect(t.sent.length).toBe(before)
})

const advertised = (tool) => JSON.stringify(Object.fromEntries(
  Object.entries(tool).map(([name, t]) => [name, { description: t.description, args: t.args }]),
))

test("compactTools off leaves the advertised tool list byte-for-byte as today", () => {
  const request = async () => ({})
  const today = advertised(createConnectorTools(request).tool)
  expect(advertised(createConnectorTools(request, {}).tool)).toBe(today)
  expect(advertised(createConnectorTools(request, { compactTools: false }).tool)).toBe(today)
  for (const options of [undefined, { compactTools: 0 }, { compactTools: "true" }, { compactTools: null }]) {
    const tool = options === undefined ? createConnectorTools(request).tool : createConnectorTools(request, options).tool
    expect(advertised(tool)).toBe(today)
  }
  const names = Object.keys(createConnectorTools(request).tool)
  expect(names.slice(0, 16)).toEqual(Object.keys(_internal.MATRIX_TOOLS))
  expect(names.slice(16)).toEqual(["list_tools", "tool_schema", "call_tool"])
})

test("compactTools on advertises only list_tools, tool_schema and call_tool, unchanged", () => {
  const request = async () => ({})
  const full = createConnectorTools(request).tool
  const compact = createConnectorTools(request, { compactTools: true }).tool
  expect(Object.keys(compact)).toEqual(["list_tools", "tool_schema", "call_tool"])
  for (const name of Object.keys(compact)) {
    expect(compact[name].description).toBe(full[name].description)
    expect(JSON.stringify(compact[name].args)).toBe(JSON.stringify(full[name].args))
  }
  const kept = Object.fromEntries(Object.entries(full).filter(([name]) => name in compact).map(([name, t]) => [name, { description: t.description, args: t.args }]))
  expect(advertised(compact)).toBe(JSON.stringify(kept))
})

test("call_tool still refuses bad arguments against the live schema when compactTools is on", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image", {
      input_schema_json: JSON.stringify({ type: "object", properties: { requests: { type: "array" } }, required: ["requests"], additionalProperties: false }),
    })]),
  })
  const { tool } = createConnectorTools(t.request, { compactTools: true })
  expect(tool.generate_image).toBeUndefined()
  await expect(
    tool.call_tool.execute({ tool_name: "connector__matrix__generate_image", arguments: { prompt: "x" } }, {}),
  ).rejects.toThrow(/bad arguments/)
  expect(t.sent.map((r) => r.path)).toEqual([LIST])
  expect(t.sent.some((r) => r.path === CALL)).toBe(false)
})

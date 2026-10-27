import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin, _internal } from "./index.mjs"

noRealGrok()

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const home = mkdtempSync(join(tmpdir(), "grok-x-search-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const expires = Date.now() + 24 * 3600_000
writeFileSync(join(home, "auth.json"), JSON.stringify({
  test: { key: "test-token", email: "test@example.invalid", expires_at: new Date(expires).toISOString() },
}))
const auth = { type: "oauth", refresh: home, access: "test-token", expires, accountId: "test@example.invalid" }
const fn = { type: "function", name: "read_file", parameters: { type: "object", properties: {} } }
const rewrite = (body) => JSON.parse(_internal.rewrite(JSON.stringify(body), true))

test("native X search is an opt-in provider switch", async () => {
  const hooks = await GrokAuthPlugin({})
  expect(hooks.auth.provider).toBe("grok")
  const [option] = hooks.auth.options
  expect(option.key).toBe("x_search")
  expect(option.default).not.toBe(true)
  expect(option.label).toBe("Native X search")
  expect(option.description.length).toBeLessThanOrEqual(300)
})

for (const choice of [undefined, null, "auto"]) {
  test(`automatic tools gain X search, preserving function tools (${choice})`, () => {
    const body = { tools: [fn], input: "hello", ...(choice !== undefined && { tool_choice: choice }) }
    const sent = rewrite(body)
    expect(sent.tools).toEqual([fn, { type: "x_search" }])
    expect(sent.input).toBe(body.input)
    expect(sent.tool_choice).toBe(choice)
  })
}

for (const tools of [undefined, null, []]) {
  test(`explicit auto enables search with no declared tools (${JSON.stringify(tools)})`, () => {
    const sent = rewrite({ tool_choice: "auto", ...(tools !== undefined && { tools }) })
    expect(sent.tools).toEqual([{ type: "x_search" }])
    expect(sent.tool_choice).toBe("auto")
  })
}

test("an existing X search keeps every filter and is not duplicated", () => {
  const body = JSON.stringify({ tools: [fn, {
    type: "x_search", allowed_x_handles: ["OpenAI"], from_date: "2026-10-01",
    to_date: "2026-10-20", enable_image_understanding: true,
  }], tool_choice: "auto" })
  expect(_internal.rewrite(body, true)).toBe(body)
})

for (const choice of ["none", "required", { type: "function", name: "read_file" },
  { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_file" }] },
  { type: "x_search" }]) {
  test(`an explicit tool choice never gains X search (${JSON.stringify(choice)})`, () => {
    const sent = rewrite({ tools: [fn], tool_choice: choice })
    expect(sent.tools).toEqual([fn])
    // Existing Grok cleanup still removes unsupported choice types.
    if (choice !== null && typeof choice === "object" && choice.type === "allowed_tools") {
      expect(sent.tool_choice).toBeUndefined()
    } else expect(sent.tool_choice).toEqual(choice)
  })
}

test("none without tools never gains search and is removed before Grok", () => {
  for (const tools of [undefined, [], [{ type: "custom", name: "apply_patch" }]]) {
    const sent = rewrite({ tool_choice: "none", ...(tools !== undefined && { tools }) })
    expect(sent.tools ?? []).toEqual([])
    expect(sent.tool_choice).toBeUndefined()
    expect(JSON.stringify(sent)).not.toContain("__magpie")
  }
})

test("missing or null choice without usable tools stays conservative", () => {
  for (const body of [
    { input: "hi" }, { tools: [] }, { tools: null }, { tool_choice: null },
    { tools: [], tool_choice: null }, { tools: [{ type: "custom", name: "apply_patch" }] },
  ]) {
    expect(rewrite(body).tools ?? []).toEqual([])
  }
})

test("malformed bodies and non-array tools are not given search", () => {
  for (const body of ["not JSON", "null", "[]", "42", '{"tools":{}}', '{"tools":"invalid","tool_choice":"auto"}']) {
    expect(_internal.rewrite(body, true)).not.toContain('"x_search"')
  }
})

test("the default rewrite never adds search", () => {
  for (const body of [{ input: "hi" }, { tools: [fn] }, { tool_choice: "auto" }]) {
    expect(_internal.rewrite(JSON.stringify(body))).not.toContain('"x_search"')
  }
})

test("search injection keeps existing schema and reasoning cleanup", () => {
  const sent = rewrite({
    tools: [{ type: "custom", name: "apply_patch" }, {
      ...fn, parameters: { anyOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "string" }] },
    }],
    tool_choice: "auto", input: [{ type: "reasoning", encrypted_content: "fixture", content: null }],
  })
  expect(sent.tools.map((t) => t.type)).toEqual(["function", "x_search"])
  expect(sent.tools[0].parameters).toEqual({ type: "object", properties: { path: { type: "string" } } })
  expect(sent.input).toEqual([{ type: "reasoning", encrypted_content: "fixture" }])
})

test("the live switch is read on each fetch, only for Responses", async () => {
  let on = false
  const seen = [], asked = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) })
    return Response.json({ id: "test", output: [] })
  }
  const hooks = await GrokAuthPlugin({ client: {}, magpie: { option(provider, key) {
    asked.push([provider, key])
    return on
  } } })
  const opts = await hooks.auth.loader(async () => auth)
  const go = (path = "responses") => opts.fetch(`https://cli-chat-proxy.grok.com/v1/${path}`, {
    method: "POST", body: JSON.stringify({ model: "grok-4.7", tools: [fn] }),
  })
  await go()
  on = true
  await go()
  await go("other")
  on = false
  await go()
  expect(seen.map((r) => r.body.tools.some((t) => t.type === "x_search"))).toEqual([false, true, false, false])
  expect(asked).toEqual(Array(3).fill(["grok", "x_search"]))
  for (const r of seen) expect(r.headers.get("Authorization")).toBe("Bearer test-token")
})

test("an older host without option support keeps the original behavior", async () => {
  let sent
  globalThis.fetch = async (_, init) => {
    sent = JSON.parse(init.body)
    return Response.json({ output: [] })
  }
  const hooks = await GrokAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST", body: JSON.stringify({ tool_choice: "auto" }),
  })
  expect(sent.tools).toBeUndefined()
})

for (const stream of [false, true]) {
  test(`every listed Grok model uses the same search path; response is unchanged (stream=${stream})`, async () => {
    const models = ["grok-4.6", "grok-4.7", "grok-4.7@500k", "future-grok"]
    const text = stream ? 'data: {"type":"response.completed"}\n\n' : '{"output":[]}'
    let sent
    globalThis.fetch = async (_, init) => {
      sent = JSON.parse(init.body)
      return new Response(text, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } })
    }
    const hooks = await GrokAuthPlugin({ client: {}, magpie: { option: () => true } })
    const opts = await hooks.auth.loader(async () => auth)
    for (const model of models) {
      const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", {
        method: "POST", body: JSON.stringify({ model, stream, tool_choice: "auto" }),
      })
      expect(sent.tools).toEqual([{ type: "x_search" }])
      expect(sent.stream).toBe(stream)
      expect(sent.model).toBe(model.split("@")[0])
      expect(await res.text()).toBe(text)
    }
  })
}

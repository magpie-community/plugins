// Magpie-native search, image and video: the search hook, the media models
// Magpie lists, and the OpenAI-shaped images/videos routes the plugin's
// fetch answers by calling MiniMax Code's real Matrix and web_search APIs.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin, MiniMaxCodeToolsPlugin, _internal } from "./index.mjs"
import { callMatrixTool } from "./connector-tools.mjs"
import {
  pagesFrom, mediaPath, handleMediaFetch, encodeVideoId, decodeVideoId, videoStatus,
  createSearchHook, _native,
} from "./native.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

const LIST = "/minimax-cloud/api/v1/connectors/connected-tools/list"
const CALL = "/minimax-cloud/api/v1/connectors/tools/call"
const SEARCH = "/mavis/api/v1/mcp/web_search"

const entry = (name, over = {}) => ({
  provider: "matrix",
  provider_tool_name: "mcp_" + name,
  runtime_tool_name: "connector__matrix__" + name,
  description: name + " tool",
  input_schema_json: JSON.stringify({ type: "object" }),
  ...over,
})
const catalog = (tools, over = {}) => ({ tools, partial: false, provider_failures: [], ...over })

function transport(script) {
  const sent = []
  const request = async (site, path, body, opts = {}) => {
    sent.push({ site, path, body, signal: opts.signal, timeoutMs: opts.timeoutMs, account: opts.account })
    const h = script[path]
    if (!h) throw new Error("no fake for " + path)
    if (Array.isArray(h)) {
      const next = h.shift()
      if (!next) throw new Error("no more fakes for " + path)
      return typeof next === "function" ? next({ site, body }) : next
    }
    return typeof h === "function" ? h({ site, body }) : h
  }
  return { request, sent }
}

test("pagesFrom reads MiniMax Code's organic results as Magpie search pages", () => {
  expect(pagesFrom({ organic: [{ title: "Source", url: "https://example.com", snippet: "hi", date: "2026" }] })).toEqual([
    { title: "Source", url: "https://example.com", text: "hi", age: "2026" },
  ])
  expect(pagesFrom({
    news: [{ title: "N", url: "https://n.example" }],
    organic: [{ title: "N", url: "https://n.example" }],
  })).toEqual([{ title: "N", url: "https://n.example", text: "", age: "" }])
})

test("each MiniMax Code site offers a search hook signed in as itself", async () => {
  const cn = await MiniMaxCodeAuthPlugin({ client: {} })
  const global = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  expect(Object.keys(cn.search)).toEqual(["minimax-code"])
  expect(cn.search["minimax-code"]).toMatchObject({ name: "MiniMax Code", auth: "minimax-code" })
  expect(Object.keys(global.search)).toEqual(["minimax-code-global"])
  expect(global.search["minimax-code-global"].auth).toBe("minimax-code-global")
})

test("the search hook posts web_search with the signed-in account and returns pages", async () => {
  const calls = []
  const hook = createSearchHook({ id: "minimax-code", name: "MiniMax Code" }, async (access, path, body, opts) => {
    calls.push({ access, path, body, timeoutMs: opts.timeoutMs })
    return { base_resp: { status_code: 0 }, organic: [{ title: "T " + body.query, url: "https://example.com/" + body.count, content: "ok" }] }
  })
  const pages = await hook["minimax-code"].execute(
    { query: "  MiniMax  ", count: 3 },
    { getAuth: async () => ({ access: "tok-1", type: "oauth" }) },
  )
  expect(pages).toEqual([{ title: "T MiniMax", url: "https://example.com/3", text: "ok", age: "" }])
  expect(calls[0]).toEqual({ access: "tok-1", path: SEARCH, body: { query: "MiniMax", count: 3 }, timeoutMs: 120000 })
})

test("the search hook refuses an empty query and a missing sign-in", async () => {
  const hook = createSearchHook({ id: "minimax-code", name: "MiniMax Code" }, async () => { throw new Error("should not post") })
  expect(hook["minimax-code"].execute({ query: "  " }, { getAuth: async () => ({ access: "t" }) })).rejects.toThrow("query is required")
  expect(hook["minimax-code"].execute({ query: "q" }, { getAuth: async () => ({}) })).rejects.toThrow("not signed in")
})

test("mediaPath recognizes OpenAI images and videos routes under the chat base", () => {
  const base = "https://agent.minimax.cn/mavis/api/v1/llm/v1"
  expect(mediaPath(base + "/images/generations")).toEqual({ kind: "image.generations" })
  expect(mediaPath(base + "/images/edits")).toEqual({ kind: "image.edits" })
  expect(mediaPath(base + "/videos")).toEqual({ kind: "video.create" })
  expect(mediaPath(base + "/videos/" + encodeURIComponent("MiniMax-H3::t1"))).toEqual({ kind: "video.get", id: "MiniMax-H3::t1" })
  expect(mediaPath(base + "/videos/" + encodeURIComponent("MiniMax-H3::t1") + "/content")).toEqual({ kind: "video.content", id: "MiniMax-H3::t1" })
  expect(mediaPath(base + "/messages")).toBeNull()
  expect(mediaPath("https://example.com/videos-understand")).toBeNull()
})

test("handleMediaFetch leaves a chat request to the plugin's ordinary fetch", async () => {
  expect(await handleMediaFetch("https://agent.minimax.cn/mavis/api/v1/llm/v1/messages", { method: "POST", body: "{}" }, { request: async () => { throw new Error("no") }, siteId: "minimax-code" })).toBeNull()
})

test("an images/generations request calls generate_image then get_asset_url", async () => {
  const t = transport({
    [LIST]: catalog([entry("generate_image"), entry("get_asset_url")]),
    [CALL]: [
      { result_json: JSON.stringify({ success_items: [{ node_id: "n1", file_name: "a.png" }] }) },
      { result_json: JSON.stringify({ code: 0, download_url: "https://cdn.example/a.png" }) },
    ],
  })
  const res = await handleMediaFetch(
    "https://agent.minimax.cn/mavis/api/v1/llm/v1/images/generations",
    { method: "POST", body: JSON.stringify({ model: "MiniMax-Image", prompt: "a cat", n: 1, quality: "high" }) },
    { request: t.request, siteId: "minimax-code" },
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.data).toEqual([{ url: "https://cdn.example/a.png" }])
  const calls = t.sent.filter((s) => s.path === CALL)
  expect(JSON.parse(calls[0].body.arguments_json)).toEqual({ requests: [{ prompt: "a cat", n: 1, area: "4K" }] })
  expect(JSON.parse(calls[1].body.arguments_json)).toEqual({ node_id: "n1" })
  expect(calls[0].body.runtime_tool_name).toBe("connector__matrix__generate_image")
  expect(calls[1].body.runtime_tool_name).toBe("connector__matrix__get_asset_url")
})

test("image edits without an HTTPS reference are refused; a URL is sent on", async () => {
  const missing = await handleMediaFetch(
    "https://agent.minimax.cn/mavis/api/v1/llm/v1/images/edits",
    { method: "POST", body: JSON.stringify({ prompt: "edit" }) },
    { request: async () => { throw new Error("no") }, siteId: "minimax-code" },
  )
  expect(missing.status).toBe(400)
  expect((await missing.json()).error.message).toContain("reference image URL")

  const data = await handleMediaFetch(
    "https://agent.minimax.cn/mavis/api/v1/llm/v1/images/generations",
    { method: "POST", body: JSON.stringify({ prompt: "edit", image: "data:image/png;base64,xxx" }) },
    { request: async () => { throw new Error("no") }, siteId: "minimax-code" },
  )
  expect(data.status).toBe(400)
  expect((await data.json()).error.message).toContain("HTTPS URL")
})

test("POST /videos submits a Hailuo or H3 task and encodes model with the task id", async () => {
  const t = transport({
    [LIST]: catalog([entry("submit_video_generation")]),
    [CALL]: { result_json: JSON.stringify({ task_id: "task-9" }) },
  })
  const res = await handleMediaFetch(
    "https://agent.minimax.cn/mavis/api/v1/llm/v1/videos",
    { method: "POST", body: JSON.stringify({ model: "MiniMax-Hailuo-2.3", prompt: "a wave", seconds: "10" }) },
    { request: t.request, siteId: "minimax-code" },
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ id: "MiniMax-Hailuo-2.3::task-9", object: "video", status: "queued", model: "MiniMax-Hailuo-2.3", seconds: "10" })
  expect(JSON.parse(t.sent[1].body.arguments_json)).toEqual({
    model: "MiniMax-Hailuo-2.3", prompt: "a wave", duration: 10, resolution: "768P",
  })
})

test("GET /videos/{id} maps MiniMax query status to OpenAI's", async () => {
  const t = transport({
    [LIST]: catalog([entry("query_video_generation")]),
    [CALL]: { result_json: JSON.stringify({ status: "running", progress: 40 }) },
  })
  const res = await handleMediaFetch(
    "https://agent.minimax.cn/mavis/api/v1/llm/v1/videos/" + encodeURIComponent("MiniMax-H3::task-9"),
    { method: "GET" },
    { request: t.request, siteId: "minimax-code" },
  )
  expect(await res.json()).toMatchObject({ id: "MiniMax-H3::task-9", status: "in_progress", progress: 40, model: "MiniMax-H3" })
  expect(JSON.parse(t.sent[1].body.arguments_json)).toEqual({ model: "MiniMax-H3", task_id: "task-9" })
})

test("GET /videos/{id}/content downloads the asset URL after a succeeded query", async () => {
  const file = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() { return new Response("MP4", { headers: { "content-type": "video/mp4" } }) },
  })
  try {
    const t = transport({
      [LIST]: catalog([entry("query_video_generation"), entry("get_asset_url")]),
      [CALL]: [
        { result_json: JSON.stringify({ status: "succeeded", node_id: "n-v" }) },
        { result_json: JSON.stringify({ download_url: `http://127.0.0.1:${file.port}/v.mp4` }) },
      ],
    })
    const res = await handleMediaFetch(
      "https://agent.minimax.cn/mavis/api/v1/llm/v1/videos/" + encodeURIComponent("MiniMax-H3-Max::t") + "/content",
      { method: "GET" },
      { request: t.request, siteId: "minimax-code" },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("video/mp4")
    expect(await res.text()).toBe("MP4")
  } finally {
    file.stop(true)
  }
})

test("video id encoding keeps the model for a later query", () => {
  expect(decodeVideoId(encodeVideoId("MiniMax-H3", "abc-1"))).toEqual({ model: "MiniMax-H3", task: "abc-1" })
  expect(() => decodeVideoId("not-one")).toThrow("not a MiniMax Code video id")
})

test("videoStatus maps MiniMax's words to OpenAI's", () => {
  expect(videoStatus({ status: "succeeded" })).toEqual({ openai: "completed", progress: 100 })
  expect(videoStatus({ status: "queued" })).toEqual({ openai: "queued", progress: 0 })
  expect(videoStatus({ status: "failed", progress: 12 })).toEqual({ openai: "failed", progress: 12 })
})

test("the loader fetch answers /images/generations without calling the chat API", async () => {
  let f
  try {
    f = fakeMiniMax()
    f.route("POST " + LIST, () => json(catalog([entry("generate_image"), entry("get_asset_url")])))
    f.route("POST " + CALL, (r) => {
      const name = r.json.runtime_tool_name
      if (name.endsWith("generate_image")) return json({ result_json: JSON.stringify({ success_items: [{ node_id: "n2", file_name: "b.png" }] }) })
      if (name.endsWith("get_asset_url")) return json({ result_json: JSON.stringify({ download_url: "https://cdn.example/b.png" }) })
      return json({ error: "unexpected " + name }, 500)
    })
    const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
    const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 }
    const out = await hooks.auth.loader(async () => auth)
    const res = await out.fetch(f.origin + "/mavis/api/v1/llm/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a tree" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect(await res.json()).toMatchObject({ data: [{ url: "https://cdn.example/b.png" }] })
    expect(f.seen.some((s) => s.path === "/mavis/api/v1/llm/v1/messages")).toBe(false)
  } finally {
    f?.close()
  }
})

test("the named tools are still exported beside the native hooks", async () => {
  const tools = await MiniMaxCodeToolsPlugin({ client: {}, directory: "/tmp" })
  expect(tools.tool.web_search).toBeDefined()
  expect(tools.tool.generate_image).toBeDefined()
  expect(tools.tool.submit_video_generation).toBeDefined()
  expect(tools.tool.query_video_generation).toBeDefined()
})

test("callMatrixTool routes a short name through the live catalog", async () => {
  const t = transport({
    [LIST]: catalog([entry("get_asset_url")]),
    [CALL]: { result_json: JSON.stringify({ download_url: "https://cdn.example/x" }) },
  })
  const out = await callMatrixTool(t.request, "minimax-code", "get_asset_url", { node_id: "n" })
  expect(out).toEqual({ download_url: "https://cdn.example/x" })
})

test("duration and resolution follow each video model's limits", () => {
  expect(_native.durationOf("8", 6, "MiniMax-H3")).toBe(8)
  expect(_native.durationOf("2", 6, "MiniMax-H3")).toBe(4)
  expect(_native.durationOf("7", 6, "MiniMax-Hailuo-2.3")).toBe(6)
  expect(_native.durationOf("11", 6, "MiniMax-Hailuo-2.3")).toBe(10)
  expect(_native.resolutionOf("1920x1080", "768P", "MiniMax-Hailuo-2.3")).toBe("1080P")
  expect(_native.resolutionOf("1920x1080", "2K", "MiniMax-H3")).toBe("2K")
  expect(_native.aspectFromSize("1280x720")).toBe("16:9")
})

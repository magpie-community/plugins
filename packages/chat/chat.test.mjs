// The chat page's local service holds the user's magpie gateway key, their
// conversations and their MCP tools, so it answers only the chat page it
// served: a request needs the per-process token from that page's HTML and
// this service's own Host. Everything here runs against a fake gateway on a
// free port, with a temporary config folder; nothing reaches the network.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { runInNewContext } from "node:vm"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = import.meta.dir
const tmp = mkdtempSync(join(tmpdir(), "page-chat-"))
const cfg = join(tmp, "magpie")
mkdirSync(cfg, { recursive: true })
writeFileSync(join(cfg, "caller-keys.json"), JSON.stringify([{ name: "chat", secret: "mk-test-key" }]))
process.env.XDG_CONFIG_HOME = tmp
delete process.env.MAGPIE_API_KEY
delete process.env.MAGPIE_GATEWAY_KEY
delete process.env.MAGPIE_ADDR

const seen = []
let chatReply = null
// magpie's own MCP servers the fake gateway lists on /v1/magpie/mcp; null
// answers 404, as a magpie from before the list does
let ownList = null
let ownListReply = null
const ownAuth = []
const gateway = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/magpie/mcp") {
      if (ownListReply) return ownListReply();
      return ownList ? Response.json({ servers: ownList }) : new Response("no", { status: 404 })
    }
    if (url.pathname.startsWith("/mcp/magpie/")) {
      // one of magpie's own servers: its tool is named for its path
      ownAuth.push(req.headers.get("authorization"))
      const msg = await req.json()
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const tool = "own_" + url.pathname.slice("/mcp/magpie/".length).replace(/\W/g, "_")
      const result = msg.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } }
        : msg.method === "tools/list"
          ? { tools: [{ name: tool, description: "search " + tool, inputSchema: { type: "object", properties: {} } }] }
          : {}
      return Response.json({ jsonrpc: "2.0", id: msg.id, result })
    }
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake/model", owned_by: "fake" }] })
    if (url.pathname === "/v1/chat/completions") {
      seen.push({ auth: req.headers.get("authorization"), body: await req.json() })
      if (chatReply) return chatReply(seen.at(-1).body)
      const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`
      const body = chunk({ choices: [{ delta: { content: "hel" } }] })
        + chunk({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })
        + "data: [DONE]\n\n"
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("no", { status: 404 })
  },
})
process.env.MAGPIE_CHAT_GATEWAY = `http://127.0.0.1:${gateway.port}`

let svc, port, token
beforeAll(async () => {
  const { startServer } = await import("./lib/server.mjs")
  svc = await startServer({ configDir: cfg, options: { port: 0 } })
  port = svc.port
  const page = await raw("GET", "/")
  token = /name="magpie-chat-token" content="([0-9a-f]+)"/.exec(page.body)?.[1]
})
afterAll(async () => {
  await svc?.close()
  gateway.stop(true)
  rmSync(tmp, { recursive: true, force: true })
})

// node:http, so the test sets Host and Origin exactly as a hostile page would
function raw(method, path, headers = {}, body) {
  return rawOn(port, method, path, headers, body)
}
function rawOn(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ""
      res.setEncoding("utf8")
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body))
    req.end()
  })
}

const chatBody = { model: "fake/model", messages: [{ role: "user", content: "hi" }] }
const json = { "content-type": "application/json" }

test("the page's HTML carries the token and no CORS header", async () => {
  const res = await raw("GET", "/", { origin: "null" })
  expect(res.status).toBe(200)
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(res.headers["access-control-allow-origin"]).toBeUndefined()
})

test("a page without the token can't chat or read conversations (Origin null, as a sandboxed frame sends)", async () => {
  const before = seen.length
  const chat = await raw("POST", "/api/chat", { ...json, origin: "null" }, chatBody)
  expect(chat.status).toBe(403)
  expect(seen.length).toBe(before) // nothing went to the gateway
  for (const path of ["/api/conversations", "/api/settings", "/api/bootstrap", "/api/library", "/api/mcp/tools"]) {
    expect((await raw("GET", path, { origin: "null" })).status).toBe(403)
    expect((await raw("GET", path)).status).toBe(403) // no Origin at all
  }
  const wrong = await raw("GET", "/api/conversations", { origin: "null", "x-magpie-chat-token": "0".repeat(64) })
  expect(wrong.status).toBe(403)
  expect(JSON.parse(wrong.body).reload).toBe(true)
})

test("another site's Origin is refused even with the token", async () => {
  const res = await raw("GET", "/api/conversations", { origin: "https://evil.example", "x-magpie-chat-token": token })
  expect(res.status).toBe(403)
})

test("a DNS-rebound Host is refused, the page and the API both", async () => {
  for (const path of ["/", "/api/conversations", "/api/ping"]) {
    const res = await raw("GET", path, { host: `evil.example:${port}`, "x-magpie-chat-token": token })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain(token)
  }
  expect((await raw("GET", "/api/ping", { host: `localhost:${port}` })).status).toBe(200)
})

test("a preflight lets the token header through", async () => {
  const res = await raw("OPTIONS", "/api/chat", { origin: "null", "access-control-request-headers": "content-type, x-magpie-chat-token" })
  expect(res.status).toBe(204)
  expect(res.headers["access-control-allow-headers"]).toContain("x-magpie-chat-token")
})

test("with the token, a chat streams from the gateway with the caller key", async () => {
  const before = seen.length
  const res = await raw("POST", "/api/chat", { ...json, origin: "null", "x-magpie-chat-token": token }, chatBody)
  expect(res.status).toBe(200)
  const events = res.body.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: ")).slice(6)))
  expect(events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("hello")
  expect(events.at(-1).type).toBe("done")
  expect(seen.length).toBe(before + 1)
  const got = seen.at(-1)
  expect(got.auth).toBe("Bearer mk-test-key")
  expect(got.body.model).toBe("fake/model")
  expect(got.body.stream).toBe(true)
  expect(got.body.messages.at(-1)).toEqual({ role: "user", content: "hi" })
})

function chatPage(setup = "") {
  const page = {
    document: { readyState: "loading", querySelector: () => ({ getAttribute: () => token }), addEventListener() {} },
    TextDecoder, atob, AbortController,
    fetch: (path, init) => {
      if (!["api/chat", "api/upload", "api/conversations", "api/settings"].includes(path) && !path.startsWith("api/conversations/")) throw new Error("unexpected request: " + path)
      return fetch(`http://127.0.0.1:${port}/${path}`, init)
    },
    window: { addEventListener() {} }, location: { search: "" },
    MagpieEpub: { isEpub: f => f.name?.endsWith(".epub") },
  }
  runInNewContext(readFileSync(join(dir, "chat/app.js"), "utf8") + "\n" + setup, page)
  return page
}

function attachmentPage(setup = "") {
  const page = chatPage(`renderAttachments = renderMessages = renderSessions = scrollBottom = () => {};\n${setup}`)
  const nodes = new Map()
  page.document.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", getAttribute: () => token, setAttribute() {}, focus() {}, classList: { toggle() {} },
    })
    return nodes.get(selector)
  }
  return page
}

test.each(["", "application/octet-stream"])("an image with MIME type '%s' finishes loading before send and reaches the gateway", async type => {
  const page = attachmentPage(`
    readAsDataURL = () => globalThis.reading;
    toast = message => globalThis.warnings.push(message);
  `)
  page.warnings = []
  page.document.querySelector("#input").value = "请看图片"
  const reading = Promise.withResolvers()
  page.reading = reading.promise
  const job = page.addFiles([{ name: "scene.PNG", type, size: 12 }])
  expect(page.document.querySelector("#send").disabled).toBe(true)
  page.send()
  expect(page.warnings).toEqual(["附件还在读取，请稍候。"])
  const data = "data:application/octet-stream;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGDcAAAAASUVORK5CYII="
  reading.resolve(data)
  await job
  expect(page.document.querySelector("#send").disabled).toBe(false)
  expect(page.state.attachments).toHaveLength(1)
  expect(page.state.attachments[0].kind).toBe("image")
  const h = { ...json, "x-magpie-chat-token": token }
  const original = { name: "scene.PNG", type, kind: "file", data }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { messages: [
    { role: "user", content: "", files: [original] },
  ] })).body)
  const history = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body).messages
  for (const messages of [[{ role: "user", content: "", files: page.state.attachments }],
    [...history, { role: "assistant", content: "A picture." }, { role: "user", content: "What color?" }]]) {
    const before = seen.length
    await page.streamChat({ ...chatBody, messages }, () => {})
    expect(seen.length).toBe(before + 1)
    expect(seen.at(-1).body.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: data.replace("application/octet-stream", "image/png") } },
    ])
  }
  expect(history[0].files[0]).toEqual(original)
})

test("a rejected upload does not appear as an attached file", async () => {
  const page = attachmentPage(`
    readAsDataURL = async () => "data:image/png;base64,cG5n";
    api = async () => { throw new Error("图片太大"); };
    toast = message => globalThis.warnings.push(message);
  `)
  page.warnings = []
  await page.addFiles([{ name: "large.png", type: "image/png", size: 12 }])
  expect(page.state.attachments).toEqual([])
  expect(page.warnings).toEqual(["large.png：图片太大"])
  expect(page.document.querySelector("#send").disabled).toBe(true)
  page.document.querySelector("#input").value = "继续"
  page.updateSend()
  expect(page.document.querySelector("#send").disabled).toBe(false)
})

test("overlapping uploads wait for every batch and cannot leak across conversations", async () => {
  const page = attachmentPage(`
    readAsDataURL = file => globalThis.reads.get(file.name).promise;
    api = async (path, options) => path === "api/upload"
      ? { ...options.body, kind: "image" } : { id: "other", messages: [] };
    toast = message => globalThis.warnings.push(message);
  `)
  page.warnings = []
  page.reads = new Map(["first.png", "second.png", "old.png", "new.png"].map(name => [name, Promise.withResolvers()]))
  const add = name => page.addFiles([{ name, type: "image/png", size: 12 }])
  const first = add("first.png"), second = add("second.png")
  const button = page.document.querySelector("#send")
  expect(button.disabled).toBe(true)
  page.reads.get("second.png").resolve("data:image/png;base64,c2Vjb25k")
  await second
  expect(page.state.attachments.map(f => f.name)).toEqual(["second.png"])
  expect(button.disabled).toBe(true)
  page.send()
  expect(page.warnings).toEqual(["附件还在读取，请稍候。"])
  page.reads.get("first.png").resolve("data:image/png;base64,Zmlyc3Q=")
  await first
  expect(button.disabled).toBe(false)
  expect(page.state.attachments.map(f => f.name)).toEqual(["second.png", "first.png"])

  const old = add("old.png")
  await page.openConversation("other")
  expect(page.state.convId).toBe("other")
  expect(page.state.attachments).toEqual([])
  const fresh = add("new.png")
  page.reads.get("old.png").resolve("data:image/png;base64,b2xk")
  await old
  expect(page.state.attachments).toEqual([])
  expect(button.disabled).toBe(true)
  page.reads.get("new.png").resolve("data:image/png;base64,bmV3")
  await fresh
  expect(page.state.attachments.map(f => f.name)).toEqual(["new.png"])
  expect(button.disabled).toBe(false)
})

test.each([
  ["photo.jpg", "application/octet-stream"],
  ["photo.txt", "image/png"],
])("an image named %s keeps its data format through upload, send and a saved follow-up", async (name, type) => {
  const page = attachmentPage(`
    readAsDataURL = file => Promise.resolve(globalThis.dataByName[file.name]);
    buildTurn = msg => ({ msg, root: {}, err: {} });
    autoGrow = forageBegin = () => {};
    loadConversations = async () => {};
    renderMessages = () => globalThis.opened.resolve();
    handleEvent = (event, refs) => { if (event.type === "delta") refs.msg.content += event.text; };
    finish = refs => {
      state.busy = false;
      if (refs.msg.error) globalThis.finished.reject(new Error(refs.msg.error));
      else persistConversation().then(() => globalThis.finished.resolve());
    };
    toast = message => {
      globalThis.warnings.push(message);
      if (globalThis.opened) globalThis.opened.reject(new Error(message));
    };
  `)
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGDcAAAAASUVORK5CYII="
  const text = "# 场景\n灯亮了。"
  const doc = "data:text/markdown;base64," + Buffer.from(text).toString("base64")
  page.dataByName = { [name]: png, "scene.md": doc }
  page.warnings = []
  page.state.settings.model = chatBody.model
  Object.assign(page.document.querySelector("#stream"), { querySelector: () => null, appendChild() {} })
  await page.addFiles([{ name, type, size: 12 }, { name: "scene.md", type: "text/markdown", size: 12 }])
  const checkGateway = () => {
    const messages = seen.at(-1).body.messages
    expect(messages[0].content).toEqual([
      { type: "text", text: "【文档：scene.md】\n" + text + "\n【文档结束】" },
      { type: "image_url", image_url: { url: png } },
    ])
    expect(messages.every(m => !("userText" in m))).toBe(true)
  }
  const send = async () => {
    page.finished = Promise.withResolvers()
    const before = seen.length
    page.send()
    await page.finished.promise
    expect(seen.length).toBe(before + 1)
    checkGateway()
  }
  await send()
  expect(page.state.messages[0].files.map(f => f.data)).toEqual([png, doc])
  const legacyImage = { name, type, kind: "image", data: png }
  page.state.messages[0].files[0] = legacyImage
  await page.persistConversation()
  const savedId = page.state.convId
  expect(savedId).toBeTruthy()
  page.state.messages = []
  page.state.convId = null
  page.opened = Promise.withResolvers()
  page.openConversation(savedId)
  await page.opened.promise
  expect(page.state.messages[0].files.map(f => f.data)).toEqual([png, doc])
  page.document.querySelector("#input").value = "灯是什么颜色？"
  await send()
  expect(page.state.messages[0].files[0]).toEqual(legacyImage)
  expect(seen.at(-1).body.messages.at(-1).content).toBe("灯是什么颜色？")
  expect(page.warnings).toEqual([])
})

test.each(["new", "saved"])("a late save cannot move a %s conversation onto the old record", async destination => {
  const page = attachmentPage(`
    const originalFetch = fetch;
    fetch = async (path, init) => {
      const response = await originalFetch(path, init);
      if (path === "api/conversations" && init.method === "POST" && globalThis.delaySave) {
        globalThis.delaySave = false;
        globalThis.saved.resolve(await response.clone().json());
        await globalThis.release.promise;
      }
      return response;
    };
    renderMessages = () => globalThis.opened.resolve();
    toast = message => globalThis.warnings.push(message);
  `)
  page.warnings = []
  page.delaySave = true
  page.saved = Promise.withResolvers()
  page.release = Promise.withResolvers()
  const original = { role: "user", content: "original", files: [
    { name: "scene.md", type: "text/markdown", kind: "file", data: "data:text/markdown;base64,b3JpZ2luYWw=" },
  ] }
  page.state.messages = [original]
  page.state.title = "original"
  const saving = page.persistConversation()
  const saved = await page.saved.promise
  const h = { ...json, "x-magpie-chat-token": token }
  page.opened = Promise.withResolvers()
  let destinationId = null
  if (destination === "new") page.newChat()
  else {
    const other = JSON.parse((await raw("POST", "/api/conversations", h, {
      title: "other", messages: [{ role: "user", content: "other" }],
    })).body)
    destinationId = other.id
    page.openConversation(other.id)
  }
  await page.opened.promise
  expect(page.state.convId).toBe(destinationId)
  expect(page.state.title).toBe(destination === "new" ? "新对话" : "other")
  if (destination === "new") expect(page.state.draft).not.toBeNull()
  try {
    page.state.messages.push({ role: "user", content: "new scene" })
    await page.persistConversation()
    destinationId = page.state.convId
  } finally {
    page.release.resolve()
    await saving
  }
  expect(page.state.convId).toBe(destinationId)
  expect(page.state.convId).not.toBe(saved.id)
  const unchanged = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body)
  expect(unchanged.messages).toEqual(saved.messages)
  expect(page.warnings).toEqual([])
})

test.each(["saved", "lost"])("overlapping saves use one record in order after a %s response", async outcome => {
  const failed = outcome === "lost"
  const page = attachmentPage(`
    const originalFetch = fetch;
    fetch = async (path, init) => {
      if (path === "api/conversations" && init.method === "POST") globalThis.posts++;
      const response = await originalFetch(path, init);
      if (path === "api/conversations" && init.method === "POST" && globalThis.delaySave) {
        globalThis.delaySave = false;
        globalThis.saved.resolve(await response.clone().json());
        await globalThis.release.promise;
        if (globalThis.failed) throw new Error("save response lost");
      }
      return response;
    };
    toast = message => globalThis.warnings.push(message);
  `)
  page.failed = failed
  page.warnings = []
  page.posts = 0
  page.delaySave = true
  page.saved = Promise.withResolvers()
  page.release = Promise.withResolvers()
  page.state.messages = [{ role: "user", content: "first" }]
  const first = page.persistConversation()
  const stored = await page.saved.promise
  page.state.messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "second" })
  const second = page.persistConversation()
  try {
    await Promise.resolve()
    expect(page.posts).toBe(1)
  } finally {
    page.release.resolve()
    await Promise.all([first, second])
  }
  expect(page.posts).toBe(2)
  expect(page.state.convId).toBe(stored.id)
  const h = { ...json, "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("GET", "/api/conversations/" + stored.id, h)).body)
  expect(saved.messages.map(m => m.content)).toEqual(["first", "answer", "second"])
  expect(page.warnings).toEqual(failed ? ["对话保存失败：save response lost"] : [])
  expect(page.conversationWrites.size).toBe(0)
})

test.each(["new", "blank", "send", "other", "delete", "delete-target", "rename"])("a late conversation read cannot replace a newer %s action", async action => {
  const page = attachmentPage(`
    api = (path, options) => (path.endsWith("/late") || path.endsWith("/original")) && !options ? globalThis.loading.promise : globalThis.other.promise;
    el = () => globalThis.renameInput;
    buildTurn = msg => ({ msg, root: {}, err: {} });
    autoGrow = forageBegin = () => {};
    toast = () => {};
    streamChat = async () => { globalThis.entered.resolve(); await globalThis.streaming.promise; };
    finish = () => { state.busy = false; };
  `)
  page.loading = Promise.withResolvers()
  page.other = Promise.withResolvers()
  page.entered = Promise.withResolvers()
  page.streaming = Promise.withResolvers()
  page.state.convId = "original"
  page.state.title = "original"
  page.state.messages = [{ role: "user", content: "original" }]
  page.state.settings.model = chatBody.model
  Object.assign(page.document.querySelector("#stream"), { querySelector: () => null, appendChild() {} })
  if (action === "blank") page.newChat()
  const loading = page.openConversation(action === "rename" ? "original" : "late")
  await Promise.resolve()
  if (action === "new" || action === "blank") {
    page.newChat()
    page.state.attachments.push({ name: "new.md", data: "data:text/markdown;base64,bmV3" })
  } else if (action === "send") {
    page.document.querySelector("#input").value = "new question"
    page.send()
    await page.entered.promise
  } else if (action === "delete" || action === "delete-target") {
    const deleting = page.askDelete(action === "delete" ? "original" : "late", "to delete")
    page.other.resolve({ ok: true })
    await deleting
  } else if (action === "rename") {
    const handlers = {}
    const input = { value: "", focus() {}, select() {}, addEventListener: (event, fn) => { handlers[event] = fn } }
    page.renameInput = input
    page.startRename("original", { style: {}, parentNode: { insertBefore() {} } }, "original")
    input.value = "renamed"
    handlers.keydown({ key: "Enter", preventDefault() {} })
    page.other.resolve({ ok: true })
  } else {
    const opening = page.openConversation("other")
    page.other.resolve({ id: "other", title: "other", messages: [{ role: "user", content: "other" }] })
    await opening
  }
  const messages = page.state.messages
  const attachments = page.state.attachments
  page.loading.resolve({ id: action === "rename" ? "original" : "late", title: "late", messages: [{ role: "user", content: "late" }] })
  await loading
  try {
    expect(page.state.messages).toBe(messages)
    expect(page.state.attachments).toBe(attachments)
    expect(page.state.convId).toBe(["send", "delete-target", "rename"].includes(action) ? "original" : action === "other" ? "other" : null)
    if (action === "rename") expect(page.state.title).toBe("renamed")
  } finally {
    page.streaming.resolve()
  }
})

test.each(["open", "rename", "delete"])("%s waits for pending writes to the same conversation", async action => {
  const h = { ...json, "x-magpie-chat-token": token }
  const original = JSON.parse((await raw("POST", "/api/conversations", h, {
    title: "old", messages: [{ role: "user", content: "original" }],
  })).body)
  const page = attachmentPage(`
    const originalFetch = fetch;
    fetch = async (path, init) => {
      if (path === "api/conversations" && init.method === "POST" && globalThis.delaySave) {
        globalThis.delaySave = false;
        globalThis.entered.resolve();
        await globalThis.release.promise;
      }
      if (path === "api/conversations/" + globalThis.id && init.method === "GET") globalThis.reads++;
      const response = await originalFetch(path, init);
      if (init.method === "PATCH" || init.method === "DELETE") globalThis.mutated.resolve();
      return response;
    };
    toast = message => globalThis.warnings.push(message);
    el = () => globalThis.renameInput;
  `)
  page.state.convId = original.id
  page.id = original.id
  page.state.title = original.title
  page.state.messages = [...original.messages, { role: "user", content: "unsaved turn" }]
  page.warnings = []
  page.reads = 0
  page.delaySave = true
  page.entered = Promise.withResolvers()
  page.release = Promise.withResolvers()
  page.mutated = Promise.withResolvers()
  const first = page.persistConversation()
  await page.entered.promise
  let opening, second
  try {
    if (action === "open") {
      page.newChat()
      opening = page.openConversation(original.id)
      await Promise.resolve()
      expect(page.reads).toBe(0)
    } else {
      page.state.messages.push({ role: "assistant", content: "answer" })
      second = page.persistConversation()
      if (action === "delete") {
        page.askDelete(original.id, "old")
        page.state.messages.push({ role: "user", content: "while deleting" })
        second = Promise.all([second, page.persistConversation()])
      } else {
        const handlers = {}
        page.renameInput = { value: "", focus() {}, select() {}, addEventListener: (event, fn) => { handlers[event] = fn } }
        page.startRename(original.id, { style: {}, parentNode: { insertBefore() {} } }, "old")
        page.renameInput.value = "renamed"
        handlers.keydown({ key: "Enter", preventDefault() {} })
      }
    }
  } finally {
    page.release.resolve()
    await Promise.all([first, second, opening])
  }
  if (action !== "open") await page.mutated.promise
  const response = await raw("GET", "/api/conversations/" + original.id, h)
  if (action === "delete") expect(response.status).toBe(404)
  else {
    expect(JSON.parse(response.body).messages.map(m => m.content)).toEqual(action === "open"
      ? ["original", "unsaved turn"] : ["original", "unsaved turn", "answer"])
    expect(page.state.title).toBe(action === "rename" ? "renamed" : "old")
    if (action === "rename") expect(JSON.parse(response.body).title).toBe("renamed")
    else expect(page.state.messages.map(m => m.content)).toEqual(["original", "unsaved turn"])
  }
  expect(page.warnings).toEqual(action === "delete" ? ["已删除「old」"] : [])
})

test("connection errors stay visible after reopening but are not replayed as tool calls", async () => {
  const page = attachmentPage(`
    makeTalk = () => ({ root: {}, done() {} });
    updateMeta = () => {};
    renderMessages = () => globalThis.opened.resolve();
  `)
  const refs = { msg: { role: "assistant", content: "hello", toolCalls: [] }, talks: { appendChild() {} }, cards: {} }
  page.handleTool({ phase: "error", name: "offline", result: "connection refused" }, refs)
  page.handleTool({ phase: "call", id: "actual", name: "catalog_read_report", args: {} }, refs)
  page.handleTool({ phase: "result", id: "actual", result: "file missing", isError: true }, refs)
  page.state.messages = [{ role: "user", content: "read report" }, refs.msg]
  await page.persistConversation()
  const id = page.state.convId
  expect(id).toBeTruthy()
  page.state.convId = null
  page.state.messages = []
  page.opened = Promise.withResolvers()
  page.openConversation(id)
  await page.opened.promise
  expect(page.state.messages[1].toolCalls.map(c => c.result)).toEqual(["connection refused", "file missing"])
  const before = seen.length
  await page.streamChat({ ...chatBody, useTools: false, messages: [...page.state.messages, { role: "user", content: "What happened?" }] }, () => {})
  expect(seen.length).toBe(before + 1)
  const sent = seen.at(-1).body.messages
  const calls = sent.flatMap(m => m.tool_calls || [])
  expect(calls.map(c => c.function.name)).toEqual(["catalog_read_report"])
  expect(JSON.parse(calls[0].function.arguments)).toEqual({})
  expect(sent.filter(m => m.role === "tool").map(m => m.content)).toEqual(["file missing"])
})

test("Markdown and text attachments reach the gateway after upload, save and follow-up", async () => {
  const page = attachmentPage(`
    toast = message => globalThis.warnings.push(message);
    readAsDataURL = () => Promise.resolve(globalThis.fileData);
  `)
  page.warnings = []
  const text = "# 第一场\n\n阿青：灯还亮着。𠀀\n\n" + "窗外有雨。\n".repeat(10000) + "最后一行。"
  const data = "data:application/octet-stream;base64," + Buffer.from("\ufeff" + text).toString("base64")
  page.fileData = data
  const h = { ...json, "x-magpie-chat-token": token }
  const image = { name: "lamp.png", kind: "image", data: "data:image/png;base64,cG5n" }
  for (const [name, type] of [["剧本.MD", "application/octet-stream"], ["scene.markdown", ""],
    ["notes.txt", "text/plain"], ["draft", "text/markdown"], ["a".repeat(192) + ".markdown", ""]]) {
    page.state.attachments = []
    await page.addFiles([{ name, type, size: Buffer.byteLength(text) }])
    expect(page.state.attachments).toHaveLength(1)
    const file = page.state.attachments[0]
    const first = { role: "user", content: "读一下", files: [file] }
    const send = async messages => {
      const before = seen.length
      const events = []
      await page.streamChat({ ...chatBody, messages }, event => events.push(event))
      expect(events.at(-1).type).toBe("done")
      expect(seen.length).toBe(before + 1)
      const sent = seen.at(-1).body.messages
      expect(JSON.stringify(sent).split("最后一行。")).toHaveLength(2)
      expect(sent.find(message => message.role === "user").content).toContain(text)
      expect(JSON.stringify(sent)).not.toContain(data)
      expect(sent.every(message => !("userText" in message))).toBe(true)
      return sent
    }
    await send([first])
    first.content = ""
    await send([first])
    const saved = JSON.parse((await raw("POST", "/api/conversations", h, { messages: [first] })).body)
    const history = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body).messages
    history.push({ role: "assistant", content: "读到了。" },
      { role: "user", content: "最后一句是什么？", files: [{ ...file, name: "copy." + name }, image] })
    const sent = await send(history)
    expect(sent.at(-1).content[0].text).toContain("最后一句是什么？")
    expect(sent.at(-1).content[1]).toEqual({ type: "image_url", image_url: { url: image.data } })
    expect(history[0].content).toBe("")
    expect(history[0].files[0].data).toBe(data)
  }
  expect(page.warnings).toEqual([])
})

test("empty text attachments stay empty and unreadable text produces a warning", async () => {
  const page = chatPage("toast = message => globalThis.warnings.push(message);")
  page.warnings = []
  for (const bytes of ["", "%%%", "/w=="]) {
    const before = seen.length
    await page.streamChat({ ...chatBody, messages: [{ role: "user", content: "", files: [
      { name: "draft.md", kind: "file", data: "data:;base64," + bytes },
    ] }] }, () => {})
    expect(seen.length).toBe(before + 1)
    const content = seen.at(-1).body.messages.at(-1).content
    if (!bytes) {
      expect(content).toBe("【文档：draft.md】\n\n【文档结束】")
      expect(page.warnings).toEqual([])
    } else {
      expect(content).toContain("未附上这份文档的正文")
      expect(page.warnings.at(-1)).toStartWith("附件未发送。draft.md：")
      expect(content).not.toContain("\ufffd")
    }
  }
})

test("a saved EPUB reaches the gateway once, including on a follow-up", async () => {
  const page = chatPage("toast = message => globalThis.warnings.push(message);")
  page.warnings = []
  const chapters = "The lamp is blue.\n\nThe lamp goes out."
  const file = { name: "lamp.epub", kind: "file", data: "data:;base64,Ym9vaw==" }
  const image = { name: "lamp.png", kind: "image", data: "data:image/png;base64,cG5n" }
  const broken = { ...file, name: "broken.epub", data: "data:;base64,YmFk" }
  const h = { ...json, "x-magpie-chat-token": token }
  page.MagpieEpub.read = async data => {
    if (data === broken.data) throw new Error("damaged")
    expect(data).toBe(file.data)
    return { text: chapters, imagePages: 1 }
  }
  const past = [
    { role: "user", content: "", files: [file, image] },
    { role: "assistant", content: "A blue lamp." },
    { role: "user", content: "What changed?", files: [{ ...file, name: "copy.epub" }, broken] },
  ]
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { messages: past })).body)
  const history = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body).messages
  const events = []
  await page.streamChat({ ...chatBody, messages: history }, event => events.push(event))
  expect(events.at(-1).type).toBe("done")
  const sent = seen.at(-1).body.messages
  expect(sent.at(-3).content[0].text).toContain(chapters)
  expect(sent.at(-3).content[0].text).toContain("1 个章节仅含图片")
  expect(sent.at(-3).content[1]).toEqual({ type: "image_url", image_url: { url: image.data } })
  expect(sent.at(-1).content).toContain("What changed?")
  expect(sent.at(-1).content).toContain("broken.epub：damaged")
  expect(page.warnings).toEqual(["附件未发送。broken.epub：damaged"])
  expect(JSON.stringify(sent).match(/The lamp goes out/g)).toHaveLength(1)
  expect(JSON.stringify(sent)).not.toContain("Ym9vaw==")
  expect(history[0].content).toBe("")
  expect(history[0].files[0].data).toBe(file.data)
})

test("switching chats discards a book that is still being read", async () => {
  const page = chatPage(`
    updateSend = renderAttachments = renderMessages = renderSessions = scrollBottom = () => {};
    api = async () => ({ id: "other", messages: [] });
    readAsDataURL = () => globalThis.reading;
    globalThis.pending = () => pendingAttachments;
  `)
  const reading = Promise.withResolvers()
  page.reading = reading.promise
  page.MagpieEpub.read = async () => ({ text: "A page", characters: 5 })
  page.state.attachments.push({ name: "ready.epub" })
  const job = page.addFiles([{ name: "first.epub", type: "application/epub+zip", size: 12 }])
  expect(page.pending()).toBe(1)
  page.openConversation("other")
  await Promise.resolve()
  reading.resolve("data:;base64,Ym9vaw==")
  await job
  expect(page.state.convId).toBe("other")
  expect(page.state.attachments).toHaveLength(0)
  expect(page.pending()).toBe(0)
})

test.each(["epub", "md"])("MCP tools follow the typed question while the gateway receives the %s attachment", async ext => {
  const names = [...Array.from({ length: 12 }, (_, i) => "github_lookup_" + i),
    ...Array.from({ length: 3 }, (_, i) => "weather_forecast_" + i), "list_items"]
  const mcp = fakeMcp("catalog", names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })))
  const h = { ...json, "x-magpie-chat-token": token }
  writeFileSync(join(cfg, "library.json"), JSON.stringify({
    mcp: [{ name: "catalog", transport: "http", url: `http://127.0.0.1:${mcp.port}/mcp`, agents: [] }],
  }))
  const page = chatPage()
  const chapters = "github ".repeat(1000) + "The last page."
  const file = { name: "github." + ext, type: "text/plain", kind: "file", data: "data:;base64," + Buffer.from(chapters).toString("base64") }
  page.MagpieEpub.read = async () => ({ text: chapters })
  const weather = names.filter(name => name.startsWith("weather")).map(name => "catalog_" + name)
  const send = async history => {
    const before = seen.length
    await page.streamChat({ ...chatBody, messages: history }, () => {})
    expect(seen.length).toBe(before + 1)
    const body = seen.at(-1).body
    expect(JSON.stringify(body.messages).split("The last page.")).toHaveLength(2)
    expect(body.messages.find(message => message.role === "user").content).toContain(chapters)
    expect(body.messages.every(message => !("userText" in message))).toBe(true)
    return (body.tools || []).map(tool => tool.function.name)
  }
  try {
    await raw("POST", "/api/settings", h, { mcp: ["catalog"], mcpAll: false })
    const first = { role: "user", content: "weather", files: [file] }
    expect(await send([first])).toEqual(weather)
    expect(await send([{ ...first, content: "" }])).toEqual(["catalog_list_items"])
    expect(await send([{ ...first, content: "【电子书：例子】weather【电子书结束】" }])).toEqual(weather)
    for (const files of [[], [file]]) {
      expect(await send([first, { role: "assistant", content: "hello" },
        { role: "user", content: "weather", files }])).toEqual(weather)
    }
    expect(await send([first, { role: "assistant", content: "hello" },
      { role: "user", content: "github" }])).toEqual(
      names.filter(name => name.startsWith("github")).map(name => "catalog_" + name))
    const before = seen.length
    const response = await raw("POST", "/api/chat", h, {
      ...chatBody, messages: [{ role: "user", content: "weather" }],
    })
    expect(response.status).toBe(200)
    expect(seen.length).toBe(before + 1)
    expect(seen.at(-1).body.tools.map(tool => tool.function.name)).toEqual(weather)
  } finally {
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    rmSync(join(cfg, "library.json"), { force: true })
    mcp.stop(true)
  }
})

test.each(["continue", "stop", "stop during lookup"])("a tool round respects %s while a call is pending", async action => {
  const stopped = action !== "continue"
  const duringLookup = action === "stop during lookup"
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const called = []
  const names = ["probe_first", "probe_second"]
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const message = await req.json()
    if (message.id === undefined) return new Response(null, { status: 202 })
    let result = {}
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
    if (message.method === "tools/list") result = { tools: names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }
    if (message.method === "tools/call") {
      called.push(message.params.name)
      if (!duringLookup && called.length === 1) { entered.resolve(); await release.promise }
      result = { content: [{ type: "text", text: "completed" }] }
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  } })
  const h = { ...json, "x-magpie-chat-token": token }
  writeFileSync(join(cfg, "library.json"), JSON.stringify({
    mcp: [{ name: "probe", transport: "http", url: `http://127.0.0.1:${mcp.port}/mcp`, agents: [] }],
  }))
  chatReply = body => {
    if (duringLookup) ownListReply = async () => {
      entered.resolve();
      await release.promise;
      return new Response("no", { status: 404 });
    }
    const hasResult = body.messages.some(m => m.role === "tool")
    const choice = hasResult ? { delta: { content: "finished" }, finish_reason: "stop" } : {
      delta: { tool_calls: names.map((name, index) => ({ index, id: "call_" + index, type: "function", function: { name: "probe_" + name, arguments: "{}" } })) },
      finish_reason: "tool_calls",
    }
    return new Response("data: " + JSON.stringify({ choices: [choice] }) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  let chatting
  try {
    await raw("POST", "/api/settings", h, { mcp: ["probe"], mcpAll: false })
    chatting = raw("POST", "/api/chat", h, { ...chatBody, clientId: "tool-stop-probe", messages: [{ role: "user", content: "probe" }] })
    await entered.promise
    if (stopped) expect((await raw("POST", "/api/chat/stop", h, { clientId: "tool-stop-probe" })).status).toBe(200)
    release.resolve()
    const response = await chatting
    expect(called).toEqual(duringLookup ? [] : stopped ? [names[0]] : names)
    expect(response.body).toContain('"type":"done"')
    if (stopped) expect(response.body).toContain('"stopped":true')
  } finally {
    release.resolve()
    await chatting
    chatReply = null
    ownListReply = null
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    rmSync(join(cfg, "library.json"), { force: true })
    mcp.stop(true)
  }
})

test.each(["30000", "65000", "missing IDs", "repeated IDs"])("tool history preserves round order and result limits: %s", async scenario => {
  const size = scenario.endsWith("IDs") ? 30000 : Number(scenario)
  const result = "x".repeat(25000) + "TAIL_SENTINEL" + "y".repeat(size - 25013)
  const expectedResult = result.slice(0, 60000)
  const names = ["read_report", "read_empty", "read_detail"]
  const called = []
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const msg = await req.json()
    if (msg.id === undefined) return new Response(null, { status: 202 })
    let output = {}
    if (msg.method === "initialize") output = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "history", version: "1" } }
    if (msg.method === "tools/list") output = { tools: names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }
    if (msg.method === "tools/call") {
      called.push(msg.params.name)
      output = msg.params.name === names[0] ? { content: [{ type: "text", text: result }] }
        : msg.params.name === names[1] ? { content: [] }
        : { content: [{ type: "text", text: "detail unavailable" }], isError: true }
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, result: output })
  } })
  const h = { ...json, "x-magpie-chat-token": token }
  writeFileSync(join(cfg, "library.json"), JSON.stringify({ mcp: [
    { name: "history", transport: "http", url: `http://127.0.0.1:${mcp.port}/mcp`, agents: [] },
  ] }))
  const before = seen.length
  chatReply = () => {
    const round = seen.length - before - 1
    const content = round === 0 ? "Searching. " : round === 1 ? "Reading. " : "Final answer."
    const tools = round === 0 ? names.slice(0, 2) : round === 1 ? names.slice(2) : []
    const delta = { content }
    if (tools.length) delta.tool_calls = tools.map((name, index) => ({
      index, id: scenario === "missing IDs" ? undefined : scenario === "repeated IDs" ? "call_1_" + index : "round_" + round + "_" + index,
      type: "function", function: { name: "history_" + name, arguments: "{}" },
    }))
    return new Response("data: " + JSON.stringify({ choices: [{ delta, finish_reason: tools.length ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  try {
    await raw("POST", "/api/settings", h, { mcp: ["history"], mcpAll: false })
    const page = attachmentPage(`
      updateMeta = updateLabel = pumpKick = () => {};
      makeTalk = () => ({ root: {}, done() {} });
      toast = message => globalThis.warnings.push(message);
    `)
    page.warnings = []
    const assistant = { role: "assistant", content: "", reasoning: "", toolCalls: [] }
    const refs = { msg: assistant, cards: {}, talks: { appendChild() {} }, err: {} }
    page.state.messages = [{ role: "user", content: "read history" }, assistant]
    await page.streamChat({ ...chatBody, messages: page.state.messages.slice(0, -1) }, evt => page.handleEvent(evt, refs))
    page.pumpFlush(refs)
    expect(refs.err.hidden).not.toBe(false)
    expect(seen.length).toBe(before + 3)
    expect(called).toEqual(names)
    const live = seen.at(-1).body.messages
    expect(live.filter(m => m.role === "tool").map(m => m.content)).toEqual([expectedResult, '{"content":[]}', "detail unavailable"])
    for (let i = 0; i < live.length; i++) {
      for (const call of live[i].tool_calls || []) expect(live.slice(i + 1).some(m => m.role === "tool" && m.tool_call_id === call.id)).toBe(true)
    }
    expect(assistant.content).toBe("Searching. Reading. Final answer.")
    expect(assistant.toolCalls.map(c => c.result)).toEqual([expectedResult, '{"content":[]}', "detail unavailable"])
    expect(assistant.toolCalls.at(-1).isError).toBe(true)
    const followUp = { role: "user", content: "What was at the end?" }
    const expected = [...live.filter(m => m.role !== "system"), { role: "assistant", content: "Final answer." }, followUp]
    await page.streamChat({ ...chatBody, useTools: false, messages: [...page.state.messages, followUp] }, () => {})
    expect(seen.at(-1).body.messages).toEqual(expected)
    await page.persistConversation()
    const id = page.state.convId
    page.newChat()
    await page.openConversation(id)
    await page.streamChat({ ...chatBody, useTools: false, messages: [...page.state.messages, followUp] }, () => {})
    expect(seen.at(-1).body.messages).toEqual(expected)
    expect(called).toEqual(names)
    expect(page.warnings).toEqual([])
  } finally {
    chatReply = null
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    rmSync(join(cfg, "library.json"), { force: true })
    mcp.stop(true)
  }
})

test.each(["stopped", "error"])("an interrupted %s round keeps completed history beside legacy messages", async ending => {
  const page = attachmentPage(`
    updateMeta = updateLabel = pumpKick = () => {};
    makeTalk = () => ({ root: {}, done() {} });
    toast = message => globalThis.warnings.push(message);
  `)
  page.warnings = []
  const assistant = { role: "assistant", content: "", reasoning: "", toolCalls: [] }
  const refs = { msg: assistant, cards: {}, talks: { appendChild() {} }, err: {} }
  const user = { role: "user", content: "continue" }
  const legacy = { role: "assistant", content: "old answer", toolCalls: [
    { id: "old", name: "read_old", args: {}, result: "old result" },
  ] }
  page.state.messages = [{ role: "user", content: "old question" }, legacy, user, assistant]
  const events = [
    { type: "round" }, { type: "delta", text: "Looking. " },
    { type: "tool", phase: "call", id: "done", name: "read_first", args: {} },
    { type: "tool", phase: "result", id: "done", result: "first result" },
    { type: "round" },
  ]
  if (ending === "stopped") events.push(
    { type: "delta", text: "Partial answer." },
    { type: "tool", phase: "call", id: "pending", name: "read_next", args: {} },
    { type: "done", stopped: true },
  )
  else events.push({ type: "error", message: "upstream unavailable" })
  for (const event of events) page.handleEvent(event, refs)
  expect(assistant.content).toBe("")
  expect(assistant.rounds.map(r => r.content)).toEqual(["Looking. ", ending === "stopped" ? "Partial answer." : ""])
  page.pumpFlush(refs)
  await page.persistConversation()
  const id = page.state.convId
  page.newChat()
  await page.openConversation(id)
  expect(page.state.messages[1].rounds).toBeUndefined()
  const followUp = { role: "user", content: "What happened?" }
  const before = seen.length
  await page.streamChat({ ...chatBody, useTools: false, messages: [...page.state.messages, followUp] }, () => {})
  expect(seen.length).toBe(before + 1)
  const sent = seen.at(-1).body.messages
  expect(sent.map(m => m.role)).toEqual(ending === "stopped"
    ? ["user", "assistant", "tool", "user", "assistant", "tool", "assistant", "user"]
    : ["user", "assistant", "tool", "user", "assistant", "tool", "user"])
  expect(sent.flatMap(m => m.tool_calls || []).map(c => c.id)).toEqual(["old", "done"])
  expect(sent.filter(m => m.role === "assistant").map(m => m.content)).toEqual(ending === "stopped"
    ? ["old answer", "Looking. ", "Partial answer."] : ["old answer", "Looking. "])
  expect(sent.filter(m => m.role === "tool").map(m => m.content)).toEqual(["old result", "first result"])
  expect(page.warnings).toEqual([])
})

test("conversations save and list with the token", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "t", messages: [{ role: "user", content: "x" }] })).body)
  expect(saved.id).toBeTruthy()
  const list = JSON.parse((await raw("GET", "/api/conversations", h)).body)
  expect(list.items.some((c) => c.id === saved.id)).toBe(true)
})

test("a remote provider icon redirects with a Location", async () => {
  writeFileSync(join(cfg, "providers.json"), JSON.stringify([{ id: "remote", icon: "https://example.com/i.png" }]))
  const res = await raw("GET", "/api/icon/remote")
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe("https://example.com/i.png")
  const badge = await raw("GET", "/api/icon/nothing-here")
  expect(badge.status).toBe(200)
  expect(badge.headers["content-type"]).toContain("image/svg+xml")
})

test("the launcher page only navigates: no fetch, XHR or socket, scripts from files", () => {
  const boot = readFileSync(join(dir, "page", "boot.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")
  expect(boot).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  expect(boot).toContain("location.replace")
  const html = readFileSync(join(dir, "page", "index.html"), "utf8")
  expect(html).toContain('src="_magpie/bridge.js"')
  expect(html).toContain('src="boot.js"')
  expect(html).not.toMatch(/<script>(?!\s*src)/)
})

test("the launcher page explains the SSH tunnel instead of navigating when magpie web is opened from another machine", () => {
  const boot = readFileSync(join(dir, "page", "boot.js"), "utf8")
  const tail = boot.slice(boot.indexOf("function isLoopback"))
  const { isLoopback } = new Function(tail + "; return { isLoopback }")()
  for (const h of ["127.0.0.1", "localhost", "[::1]", "magpie.localhost", ""]) expect(isLoopback(h)).toBe(true)
  for (const h of ["192.168.1.20", "magpie.example.com", "[2001:db8::1]"]) expect(isLoopback(h)).toBe(false)
  expect(boot).toMatch(/if \(!isLoopback\(location\.hostname\)\)/)
  expect(boot).toContain("ssh -N -L ")
})

test("the chat UI sends the token on every API call", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  // two calls reach the service: api() with its init, and the chat stream
  const calls = [...app.matchAll(/fetch\(([^,)]+),\s*([^\n]*)/g)].map((m) => m[2])
  expect(calls.length).toBe(2)
  expect(calls[0]).toStartWith("init")
  expect(app).toMatch(/var init = \{[^\n]*headers: authHeaders\(\)/)
  expect(app).toMatch(/fetch\("api\/chat", \{\s*method: "POST",\s*headers: authHeaders\(/)
  expect(app).toContain('meta[name="magpie-chat-token"]')
  expect(app).not.toMatch(/XMLHttpRequest|new WebSocket|EventSource|sendBeacon/)
})

test("the plugin starts nothing on import and serves the option's port", async () => {
  const mod = await import("./index.mjs")
  expect(typeof mod.default.server).toBe("function")
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  expect(pkg.name).toBe("@magpie-community/page-chat")
  expect(pkg.magpie.page.file).toBe("page/index.html")
  expect(pkg.scripts?.postinstall).toBeUndefined()
  expect(pkg.scripts?.install).toBeUndefined()
  expect(pkg.scripts?.preinstall).toBeUndefined()
})

// aigcfree on Discord: `magpie web` on a server, opened from another
// computer's browser. There 127.0.0.1 is the viewer's own computer, so
// magpie web serves this service under a path of its own address
// (magpie.page.service), and the chat UI has to work from under that path.
test("the chat UI's addresses are relative, so it works under magpie web's path", async () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")
  expect(app).not.toMatch(/["'`]\/api\//)
  const html = readFileSync(join(dir, "chat", "index.html"), "utf8")
  expect(html).not.toMatch(/(href|src)="\//)
  expect(html).toContain('href="api/fonts.css"')
  // a provider's icon, as the bootstrap hands it to the UI
  writeFileSync(join(cfg, "providers.json"), JSON.stringify([{ id: "remote", icon: "https://example.com/i.png" }]))
  const { providerIcons } = await import("./lib/library.mjs")
  expect((await providerIcons(cfg)).get("remote")).toBe("api/icon/remote")
})

test("the plugin declares its service on the option's port", () => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  expect(pkg.magpie.page.service).toEqual({ port: pkg.magpie.options.port, option: "port" })
})

// boot.js run as the page's frame runs it: where it sends the frame
async function boot(magpie, hostname = "127.0.0.1") {
  const src = readFileSync(join(dir, "page", "boot.js"), "utf8")
  let went = ""
  const location = { hostname, replace: (u) => { went = u } }
  const document = { getElementById: () => null }
  await new Function("window", "location", "document", "return " + src.replace(/^\s*\/\/.*$/gm, "").trim().replace(/;\s*$/, ""))({ magpie }, location, document)
  return went
}

test("the launcher goes to magpie web's path when the bridge offers one, else to 127.0.0.1", async () => {
  const ready = Promise.resolve({ dark: true, tokens: { bg: "#000" } })
  const options = { get: async () => ({ port: 3999 }) }
  const svc = "http://server.lan:3430/_magpie/plugin/" + "a".repeat(32) + "/_magpie/service/"
  const remote = await boot({ ready, options, service: svc })
  expect(remote).toStartWith(svc + "?")
  expect(new URL(remote).searchParams.get("theme")).toBe("dark")
  // the desktop window, and a magpie from before magpie.service
  expect(await boot({ ready, options, service: "" })).toStartWith("http://127.0.0.1:3999/?theme=dark")
  expect(await boot({ ready, options })).toStartWith("http://127.0.0.1:3999/?")
  expect(await boot(undefined)).toBe("http://127.0.0.1:3477/?")
  // only an http(s) address is followed
  expect(await boot({ ready, service: "javascript:alert(1)" })).toStartWith("http://127.0.0.1:3477/?")
})

test("opened from another machine, the launcher takes magpie web's path, and explains the tunnel only without one", async () => {
  const ready = Promise.resolve({ dark: false })
  const svc = "http://server.lan:3430/_magpie/plugin/" + "b".repeat(32) + "/_magpie/service/"
  expect(await boot({ ready, service: svc }, "server.lan")).toStartWith(svc + "?")
  // a magpie from before magpie.service: no navigation to a refused 127.0.0.1
  expect(await boot({ ready }, "server.lan")).toBe("")
})


// ---------- added in 0.1.3: renaming / layout sync / empty configDir ----------

test("renaming a conversation via PATCH keeps its messages", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "before", messages: [{ role: "user", content: "hi" }] })).body)
  const renamed = await raw("PATCH", "/api/conversations/" + saved.id, h, { title: "after" })
  expect(renamed.status).toBe(200)
  expect(JSON.parse(renamed.body).title).toBe("after")
  // the rename must not wipe messages: POST overwrites the whole file, PATCH only touches the title
  const got = JSON.parse((await raw("GET", "/api/conversations/" + saved.id, h)).body)
  expect(got.title).toBe("after")
  expect(got.messages.length).toBe(1)
  expect(got.messages[0].content).toBe("hi")
})

test("renaming rejects an empty title, a missing conversation and a missing token", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/conversations", h, { title: "x", messages: [] })).body)
  expect((await raw("PATCH", "/api/conversations/" + saved.id, h, { title: "   " })).status).toBe(400)
  expect((await raw("PATCH", "/api/conversations/c_does_not_exist", h, { title: "x" })).status).toBe(404)
  expect((await raw("PATCH", "/api/conversations/" + saved.id, { ...json, origin: "null" }, { title: "x" })).status).toBe(403)
})

test("settings keep syncWidth and clamp composerWidth to 35", async () => {
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const saved = JSON.parse((await raw("POST", "/api/settings", h, { syncWidth: true, composerWidth: 10 })).body)
  expect(saved.syncWidth).toBe(true)
  expect(saved.composerWidth).toBe(35)
  const back = JSON.parse((await raw("GET", "/api/settings", h)).body)
  expect(back.syncWidth).toBe(true)
  expect(back.composerWidth).toBe(35)
})

test("an empty configDir reads the library from the real config folder", async () => {
  mkdirSync(join(cfg, "library", "instructions"), { recursive: true })
  writeFileSync(join(cfg, "library", "instructions", "probe.md"), "be brief")
  const { startServer } = await import("./lib/server.mjs")
  const other = await startServer({ configDir: "", options: { port: 0 } })
  try {
    const got = await new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: other.port,
        method: "GET",
        path: "/api/library",
        headers: { host: `127.0.0.1:${other.port}`, origin: "null", "x-magpie-chat-token": token }
      }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      })
      req.on("error", reject)
      req.end()
    })
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body).instructions.map((i) => i.name)).toContain("probe.md")
  } finally {
    await other?.close()
  }
})

// ---------- added in 0.1.4 ----------

test("composeSystem drops the user prompt when systemEnabled is false", async () => {
  const { composeSystem } = await import("./lib/library.mjs")
  const on = await composeSystem({ system: "PROBE_SYSTEM_TEXT_XYZ", systemEnabled: true })
  const off = await composeSystem({ system: "PROBE_SYSTEM_TEXT_XYZ", systemEnabled: false })
  expect(on).toContain("PROBE_SYSTEM_TEXT_XYZ")
  expect(off).not.toContain("PROBE_SYSTEM_TEXT_XYZ")
})

test("stdio MCP servers get a workspace of their own", async () => {
  const { workspaceDir } = await import("./lib/mcp.mjs")
  const dir = workspaceDir()
  expect(dir).toContain("magpie-chat")
  expect(dir).toContain("workspace")
  expect(existsSync(dir)).toBe(true)
})

test("the gateway candidates include the port from magpie settings.json", async () => {
  const { gatewayCandidates } = await import("./lib/gateway.mjs")
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ port: 18086 }))
  const list = gatewayCandidates({})
  expect(list.some((u) => u.includes(":18086"))).toBe(true)
})

// ---------- review feedback ----------

test("the chat UI never auto-loads a remote image", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  const start = app.indexOf("function safeImgSrc")
  const end = app.indexOf("function remoteImgLink")
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  // 把函数抽出来真跑一遍：只扫源码里的字面量，换个写法就能绕过去
  const safeImgSrc = new Function(app.slice(start, end) + "\nreturn safeImgSrc")()
  const png = "data:image/png;base64,iVBORw0KGgo="
  expect(safeImgSrc(png)).toBe(png)
  const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
  expect(safeImgSrc(svg)).toBe(svg)
  for (const bad of [
    "https://a.png",
    "HTTPS://a.png",
    "http://a.png",
    "//a.png",
    "blob:https://a.png",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    expect(safeImgSrc(bad)).toBe("")
  }
})

test("finish() renders a reply that arrived in one chunk", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  // 不能只判 .md-stable：整段一次到达时那个结构根本不存在
  expect(app).toMatch(/else if \(refs\.body && refs\.msg\.content\) renderMarkdown\(refs\.body, refs\.msg\.content\)/)
})

// ---------- 0.1.6: one switch for every MCP server in magpie's Library ----------

// a Streamable-HTTP MCP server on a free port
function fakeMcp(tool, tools) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const msg = await req.json()
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const result = msg.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } }
        : msg.method === "tools/list"
          ? { tools: tools || [{ name: tool, description: "search " + tool, inputSchema: { type: "object", properties: {} } }] }
          : {}
      return Response.json({ jsonrpc: "2.0", id: msg.id, result })
    },
  })
}

test("with mcpAll on, a chat gets every Library server's tools, one added later too, and none ticked", async () => {
  // a service of its own: the last one started owns the Host allow list, and
  // an earlier test started another
  const { startServer } = await import("./lib/server.mjs")
  const own = await startServer({ configDir: cfg, options: { port: 0 } })
  const raw = (...args) => rawOn(own.port, ...args)
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const a = fakeMcp("search_alpha"), b = fakeMcp("search_beta"), c = fakeMcp("search_gamma")
  const lib = (list) => writeFileSync(join(cfg, "library.json"), JSON.stringify({
    mcp: list.map(([name, srv]) => ({ name, transport: "http", url: `http://127.0.0.1:${srv.port}/mcp`, agents: [] })),
  }))
  const toolNames = async () => {
    const before = seen.length
    const res = await raw("POST", "/api/chat", h, { ...chatBody, messages: [{ role: "user", content: "search something" }] })
    expect(res.status).toBe(200)
    expect(seen.length).toBe(before + 1)
    return (seen.at(-1).body.tools || []).map((t) => t.function.name).sort()
  }
  try {
    lib([["a", a], ["b", b]])
    // off and nothing ticked: no tools, as before
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    expect(await toolNames()).toEqual([])
    // off with one ticked: only that one
    await raw("POST", "/api/settings", h, { mcp: ["a"] })
    expect(await toolNames()).toEqual(["a_search_alpha"])
    // on: every server, whatever is ticked; the setting is kept
    const saved = JSON.parse((await raw("POST", "/api/settings", h, { mcp: [], mcpAll: true })).body)
    expect(saved.mcpAll).toBe(true)
    expect(JSON.parse((await raw("GET", "/api/settings", h)).body).mcpAll).toBe(true)
    expect(await toolNames()).toEqual(["a_search_alpha", "b_search_beta"])
    // a server added to magpie's Library afterwards is in the next chat
    lib([["a", a], ["b", b], ["c", c]])
    expect(await toolNames()).toEqual(["a_search_alpha", "b_search_beta", "c_search_gamma"])
    // and "check connection" checks the same servers
    const check = JSON.parse((await raw("GET", "/api/mcp/tools", h)).body)
    expect(check.servers.map((s) => s.name).sort()).toEqual(["a", "b", "c"])
  } finally {
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    rmSync(join(cfg, "library.json"), { force: true })
    a.stop(true); b.stop(true); c.stop(true)
    await own.close()
  }
})

test("mcpAll defaults to off, so an existing user's settings keep ticking", async () => {
  const { pickServers } = await import("./lib/server.mjs")
  const servers = [{ name: "a" }, { name: "b" }]
  expect(pickServers(servers, { mcp: ["b"] }).map((s) => s.name)).toEqual(["b"])
  expect(pickServers(servers, { mcp: ["b"], mcpAll: true }).map((s) => s.name)).toEqual(["a", "b"])
  const { createStore } = await import("./lib/server.mjs")
  const fresh = mkdtempSync(join(tmp, "fresh-"))
  expect((await createStore(fresh).settings()).mcpAll).toBe(false)
  // a settings.json written by 0.1.5 has no mcpAll
  writeFileSync(join(createStore(fresh).dir, "settings.json"), JSON.stringify({ mcp: ["b"] }))
  const old = await createStore(fresh).settings()
  expect(old.mcpAll).toBe(false)
  expect(old.mcp).toEqual(["b"])
})

test("the chat UI asks for tools when mcpAll is on with nothing ticked, and flushes settings before it sends", () => {
  const app = readFileSync(join(dir, "chat", "app.js"), "utf8")
  const start = app.indexOf("function wantsTools")
  expect(start).toBeGreaterThan(0)
  const end = app.indexOf("\n}\n", start) + 3
  const wantsTools = new Function(app.slice(start, end) + "\nreturn wantsTools")()
  expect(wantsTools({ mcp: [], mcpAll: true })).toBe(true)
  expect(wantsTools({ mcp: ["a"], mcpAll: false })).toBe(true)
  expect(wantsTools({ mcp: [], mcpAll: false })).toBe(false)
  expect(app).toContain("useTools: wantsTools(state.settings)")
  // the server picks servers from the saved settings, so a switch flipped just before sending is saved first
  expect(app).toMatch(/var saved = saveTimer \? flushSettings\(\) : Promise\.resolve\(\);\s*saved\.then\(function \(\) \{ return streamChat\(/)
  const html = readFileSync(join(dir, "chat", "index.html"), "utf8")
  expect(html).toMatch(/id="mcpAll"[^>]*role="switch"/)
  expect(html).not.toContain("<select")
})

// ---------- 0.1.7: magpie's own MCP servers beside the Library's ----------

test("with mcpAll on, a chat gets magpie's own MCP servers that are on, beside the Library's", async () => {
  const { startServer } = await import("./lib/server.mjs")
  const own = await startServer({ configDir: cfg, options: { port: 0 } })
  const raw = (...args) => rawOn(own.port, ...args)
  const h = { ...json, origin: "null", "x-magpie-chat-token": token }
  const a = fakeMcp("search_alpha"), img = fakeMcp("search_library_image")
  writeFileSync(join(cfg, "library.json"), JSON.stringify({
    mcp: [
      { name: "a", transport: "http", url: `http://127.0.0.1:${a.port}/mcp`, agents: [] },
      // installed from the Library under the same name as magpie's own: the Library's is used
      { name: "magpie-image", transport: "http", url: `http://127.0.0.1:${img.port}/mcp`, agents: [] },
    ],
  }))
  const toolNames = async () => {
    const before = seen.length
    const res = await raw("POST", "/api/chat", h, { ...chatBody, messages: [{ role: "user", content: "search something" }] })
    expect(res.status).toBe(200)
    expect(seen.length).toBe(before + 1)
    return (seen.at(-1).body.tools || []).map((t) => t.function.name).sort()
  }
  try {
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: true })
    // a magpie without the list: the Library's alone, as before
    ownList = null
    expect(await toolNames()).toEqual(["a_search_alpha", "magpie-image_search_library_image"])
    // web search and image recognition on, image generation listed too
    ownList = [
      { name: "magpie-web-search", title: "Magpie Web Search", path: "/mcp/magpie/web-search" },
      { name: "magpie-vision", title: "Magpie Image Recognition", path: "/mcp/magpie/vision" },
      { name: "magpie-image", title: "Magpie Image", path: "/mcp/magpie/image" },
    ]
    ownAuth.length = 0
    expect(await toolNames()).toEqual([
      "a_search_alpha",
      "magpie-image_search_library_image",
      "magpie-vision_own_vision",
      "magpie-web-search_own_web_search",
    ])
    // they are asked with the same key as the gateway
    expect(ownAuth.length).toBeGreaterThan(0)
    expect(ownAuth.every((x) => x === "Bearer mk-test-key")).toBe(true)
    // the page's list and "check connection" show them too
    const lib = JSON.parse((await raw("GET", "/api/library", h)).body)
    expect(lib.mcp.map((m) => m.name)).toEqual(["a", "magpie-image", "magpie-web-search", "magpie-vision"])
    const check = JSON.parse((await raw("GET", "/api/mcp/tools", h)).body)
    expect(check.servers.map((s) => s.name).sort()).toEqual(["a", "magpie-image", "magpie-vision", "magpie-web-search"])
    // image recognition turned off in magpie: gone from the next chat
    ownList = ownList.filter((m) => m.name !== "magpie-vision")
    expect(await toolNames()).toEqual(["a_search_alpha", "magpie-image_search_library_image", "magpie-web-search_own_web_search"])
    // ticked by itself, with the switch off, one of magpie's own is used alone
    await raw("POST", "/api/settings", h, { mcp: ["magpie-web-search"], mcpAll: false })
    expect(await toolNames()).toEqual(["magpie-web-search_own_web_search"])
  } finally {
    ownList = null
    await raw("POST", "/api/settings", h, { mcp: [], mcpAll: false })
    rmSync(join(cfg, "library.json"), { force: true })
    a.stop(true); img.stop(true)
    await own.close()
  }
})

// magpie swaps hosts (a plugin updated, installed or set) while the old one
// still finishes a call, so the old host's service keeps the page's port
// for as long as that call runs. The new host's service used to give up
// after 6s, and once the old host left nothing listened there: every
// request of the page failed to fetch (ferock, page-chat 0.1.6 updated to
// 0.1.7 under a busy host).
test("a port held past the first wait is taken once its holder lets go", async () => {
  const { createServer } = await import("node:net")
  const holder = createServer()
  await new Promise((r) => holder.listen(0, "127.0.0.1", r))
  const port = holder.address().port
  const { startServer } = await import("./lib/server.mjs")
  const svc = await startServer({ configDir: cfg, options: { port }, bindTries: 1 })
  try {
    expect(svc.listening).toBe(false)
    expect(svc.port).toBe(port)
    await new Promise((r) => holder.close(r))
    expect(await svc.ready).toBe(port)
    const got = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/ping", headers: { host: `127.0.0.1:${port}`, origin: "null" } }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      })
      req.on("error", reject)
      req.end()
    })
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body).port).toBe(port)
  } finally {
    holder.listening && holder.close()
    await svc.close()
  }
})

test("a service closed while it waits for its port stops waiting", async () => {
  const { createServer } = await import("node:net")
  const holder = createServer()
  await new Promise((r) => holder.listen(0, "127.0.0.1", r))
  const port = holder.address().port
  const { startServer } = await import("./lib/server.mjs")
  const svc = await startServer({ configDir: cfg, options: { port }, bindTries: 1 })
  await svc.close()
  expect(await svc.ready).toBe(0)
  await new Promise((r) => holder.close(r))
})

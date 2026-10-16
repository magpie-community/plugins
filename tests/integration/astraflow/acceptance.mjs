// Installed Magpie + its real Bun host, with all AstraFlow traffic redirected
// by a test-only preload to a local fixture. Never sends a key to UCloud.
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { _internal } from "../../../packages/astraflow/index.mjs"

const { values } = parseArgs({ options: { magpie: { type: "string" } } })
if (!values.magpie) throw new Error("Pass --magpie /absolute/path/to/magpie")
const magpie = resolve(values.magpie)
const plugin = fileURLToPath(new URL("../../../packages/astraflow", import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), "magpie-astraflow-"))
const directory = join(sandbox, ".config/magpie")
const requests = []
let web, fixture, complete = false
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const until = async (check, label) => {
  const end = Date.now() + 30_000
  while (Date.now() < end) { if (await check()) return; await pause(100) }
  throw new Error(`Timed out waiting for ${label}; diagnostics: ${sandbox}`)
}
const freePort = () => {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listener.port
  listener.stop(true)
  return port
}
const hosts = [...Object.values(_internal.REGIONS).map((r) => r.host), "oauth2.ucloud.cn", "oauth2.ucloud-global.com", "api.ucloud.cn", "api.ucloud-global.com"]
let tokenCount = 0, createdCount = 0
let catalog = ["fixture-chat", "fixture-vision", "sora-fixture", "text-embedding-fixture"]
try {
  mkdirSync(directory, { recursive: true })
  mkdirSync(join(sandbox, ".cache/magpie"), { recursive: true })
  writeFileSync(join(sandbox, ".cache/magpie/models.json"), "{}")
  fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const host = request.headers.get("x-fixture-host")
    const authorization = request.headers.get("authorization")
    assert.ok(hosts.includes(host))
    if (host.startsWith("oauth2.")) {
      assert.equal(url.pathname, "/token")
      const params = new URLSearchParams(await request.text())
      tokenCount++
      requests.push({ host, path: url.pathname, grant: params.get("grant_type") })
      const idToken = "h." + Buffer.from(JSON.stringify({ sub: "fixture-user", email: "fixture@example.test" })).toString("base64url") + ".s"
      return Response.json({ access_token: `fixture-access-${tokenCount}`, refresh_token: `fixture-refresh-${tokenCount}`, expires_in: 3600, token_type: "Bearer", id_token: idToken })
    }
    if (["api.ucloud.cn", "api.ucloud-global.com"].includes(host)) {
      assert.ok(/^Bearer fixture-access-/.test(authorization ?? ""))
      const body = await request.json()
      requests.push({ host, authorization, action: body.Action, body })
      if (body.Action === "GetProjectList") return Response.json({ RetCode: 0, ProjectSet: [{ ProjectId: "project-fixture", ProjectName: "Fixture project", IsDefault: true }] })
      if (body.Action === "ListUMInferAPIKey") return Response.json({ RetCode: 0, Data: [{ KeyId: "key-fixture", Name: "Fixture existing key", Key: "fixture-key-oauth", Status: 1, GrantAllModels: true, DailyLimitAmount: 100, DailyUsedAmount: 25, MonthlyLimitAmount: 1000, MonthlyUsedAmount: 125, ChannelId: 126 }] })
      if (body.Action === "CreateUMInferAPIKey") {
        createdCount++
        assert.equal(body.ModelverseDisabled, 0)
        assert.equal(body.SandBoxDisabled, 1)
        assert.equal(body.GrantAllModels, true)
        return Response.json({ RetCode: 0, Data: { KeyId: "created-fixture", Name: body.Name, Key: "fixture-key-created", Status: 1 } })
      }
      if (body.Action === "ListUFSquareModel") return Response.json({ RetCode: 0, SquareModels: [{ Id: "fixture-chat", Name: "Fixture enriched chat", MaxModelLen: 65536 }] })
      if (body.Action === "GetBalance") return Response.json({ RetCode: 0, AccountInfo: { AmountAvailable: "42.50" } })
      throw new Error(`Unexpected control plane action ${body.Action}`)
    }
    assert.ok(/^Bearer fixture-key-/.test(authorization ?? ""))
    if (url.pathname === "/v1/models") {
      requests.push({ host, authorization, path: url.pathname })
      return Response.json({ object: "list", data: catalog.map((id) => ({ id, object: "model" })) })
    }
    if (url.pathname === "/v1beta/models") {
      requests.push({ host, authorization, path: url.pathname })
      return url.searchParams.has("pageToken")
        ? Response.json({ models: [{ name: "models/publishers/google/models/gemini-fixture", displayName: "Fixture Gemini", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 32000, outputTokenLimit: 8192 }] })
        : Response.json({ models: [{ name: "models/gemini-image", supportedActions: ["generateContent"] }], nextPageToken: "fixture-next-page" })
    }
    const body = await request.json()
    requests.push({ host, authorization, path: url.pathname, body })
    const events = (items) => new Response(items.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
    if (url.pathname.startsWith("/v1beta/models/")) {
      assert.equal(request.headers.get("x-goog-api-key"), authorization.slice(7))
      assert.ok(/\/publishers\/google\/models\/gemini-fixture:(?:streamGenerateContent|generateContent)$/.test(url.pathname))
      assert.ok(body.contents?.length)
      const reply = { candidates: [{ content: { role: "model", parts: [{ text: "AstraFlow native Gemini OK" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 }, modelVersion: "gemini-fixture" }
      return url.pathname.endsWith(":streamGenerateContent")
        ? new Response(`data: ${JSON.stringify(reply)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(reply)
    }
    if (url.pathname === "/v1/responses") {
      const part = { type: "output_text", text: "AstraFlow native Responses OK", annotations: [] }
      const item = { id: "msg-fixture", type: "message", role: "assistant", status: "completed", content: [part] }
      const response = { id: "resp-fixture", object: "response", created_at: 1, model: body.model, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }
      if (!body.stream) return Response.json(response)
      const indexed = { item_id: item.id, output_index: 0, content_index: 0 }
      return events([
        ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } }],
        ["response.content_part.added", { type: "response.content_part.added", ...indexed, part: { ...part, text: "" } }],
        ["response.output_text.delta", { type: "response.output_text.delta", ...indexed, delta: part.text }],
        ["response.output_text.done", { type: "response.output_text.done", ...indexed, text: part.text }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
        ["response.completed", { type: "response.completed", response }],
      ])
    }
    if (url.pathname === "/v1/messages") {
      assert.equal(request.headers.get("x-api-key"), authorization.slice(7))
      const message = { id: "msg-fixture", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "AstraFlow native Messages OK" }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }
      if (!body.stream) return Response.json(message)
      return events([
        ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: message.content[0].text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }],
      ])
    }
    assert.equal(url.pathname, "/v1/chat/completions")
    const content = body.messages.findLast((m) => m.role === "user")?.content
    if (content === "deny") return Response.json({ error: { message: "fixture model permission denied", type: "permission_error" } }, { status: 403 })
    const tool = body.tools?.[0]?.function?.name
    const delta = tool ? { tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: tool, arguments: '{"city":"Singapore"}' } }] } : { content: "AstraFlow fixture OK" }
    if (body.stream) {
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant" }) + chunk(delta)))
        setTimeout(() => { controller.enqueue(new TextEncoder().encode(chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")); controller.close() }, 30)
      } }), { headers: { "Content-Type": "text/event-stream" } })
    }
    return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
  } })
  const preload = join(sandbox, "preload.mjs")
  writeFileSync(preload, `const original = globalThis.fetch
const hosts = new Set(${JSON.stringify(hosts)})
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!hosts.has(url.hostname)) throw new Error("Acceptance blocked external fetch: " + url.origin)
  const headers = new Headers(request.headers)
  headers.set("x-fixture-host", url.hostname)
  return original(new Request("http://127.0.0.1:${fixture.port}" + url.pathname + url.search, { method: request.method, headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, signal: request.signal, redirect: "error" }))
}
`)
  const wrapper = join(sandbox, "bun-wrapper")
  // Shell paths are single-quoted, including any apostrophe in a temp path.
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "run" ]; then
  shift
  exec ${quote(process.execPath)} run --preload ${quote(preload)} "$@" 2>>${quote(join(sandbox, "bun.log"))}
fi
exec ${quote(process.execPath)} "$@"
`, { mode: 0o700 })
  const cliHome = join(sandbox, "astraflow")
  mkdirSync(join(cliHome, "configs"), { recursive: true, mode: 0o700 })
  writeFileSync(join(cliHome, "config.json"), JSON.stringify({ default_config: "fixture" }), { mode: 0o600 })
  const cliConfig = join(cliHome, "configs/fixture.json")
  const cliBytes = JSON.stringify({ version: 3, api_key: "fixture-key-cli", endpoint: "https://api.modelverse.cn", region: "china", protocol: "all", kind: "astraflow-key", oauth: { refresh_token: "must-not-copy", access_token: "must-not-copy" } })
  writeFileSync(cliConfig, cliBytes, { mode: 0o600 })
  const env = { PATH: process.env.PATH, HOME: sandbox, USERPROFILE: sandbox, ASTRAFLOW_HOME: cliHome,
    XDG_CONFIG_HOME: join(sandbox, ".config"), XDG_CACHE_HOME: join(sandbox, ".cache"), XDG_DATA_HOME: join(sandbox, ".local/share"),
    XDG_STATE_HOME: join(sandbox, ".local/state"), MAGPIE_BUN: wrapper, MAGPIE_TEST_SANDBOX: sandbox, MAGPIE_NO_STATS: "1",
    MAGPIE_WEB_KEY: "astraflow-acceptance-web-key", MAGPIE_ADDR: `127.0.0.1:${freePort()}` }
  const cli = async (...args) => {
    const child = Bun.spawn([magpie, ...args], { env, stdout: "pipe", stderr: Bun.file(join(sandbox, "cli.log")) })
    const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    assert.equal(status, 0, `Magpie command failed; diagnostics: ${sandbox}`)
    return output
  }
  await cli("plugin", "add", plugin)
  assert.ok((await cli("plugin", "list", "--json")).includes("astraflow"))
  console.log("PASS local package installation and provider discovery")
  let webURL, cookie
  const start = async () => {
    const port = freePort()
    webURL = `http://127.0.0.1:${port}`
    web = Bun.spawn([magpie, "web", "--addr", `127.0.0.1:${port}`, "--no-open", "--gateway"], {
      env, stdout: Bun.file(join(sandbox, "web.log")), stderr: Bun.file(join(sandbox, "web-errors.log")) })
    await until(async () => { try { return (await fetch(webURL + "/?k=" + env.MAGPIE_WEB_KEY, { redirect: "manual" })).status === 303 } catch { return false } }, "Magpie web")
    const signed = await fetch(webURL + "/?k=" + env.MAGPIE_WEB_KEY, { redirect: "manual" })
    cookie = signed.headers.get("set-cookie").split(";")[0]
    await until(async () => { try { return (await fetch(`http://${env.MAGPIE_ADDR}/v1/models`)).ok } catch { return false } }, "Magpie gateway")
  }
  const stop = async () => { if (web) { web.kill("SIGTERM"); await web.exited; web = undefined } }
  const api = async (path, body) => {
    const response = await fetch(webURL + path, { headers: { Cookie: cookie, Origin: webURL, "Content-Type": "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) })
    if (response.status === 204) return {}
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
    const data = await response.json()
    assert.ok(!data.error, `${path}: ${data.error}`)
    return data
  }
  const models = async () => (await (await fetch(`http://${env.MAGPIE_ADDR}/v1/models`)).json()).data.map((m) => m.id)
  const ask = async (body, path = "/v1/chat/completions") => fetch(`http://${env.MAGPIE_ADDR}${path}`, { method: "POST",
    headers: { Authorization: "Bearer magpie", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  await start()
  const question = await api("/api/plugin-signin/prompt", { provider: "astraflow", method: 0, inputs: {} })
  assert.equal(question.prompt.key, "region")
  assert.equal(question.prompt.options.length, 7)
  const answered = await api("/api/plugin-signin/prompt", { provider: "astraflow", method: 0, inputs: {}, key: "region", value: "singapore" })
  assert.equal(answered.prompt.key, "protocol")
  assert.deepEqual(answered.inputs, { region: "singapore" })
  const protocolAnswered = await api("/api/plugin-signin/prompt", { provider: "astraflow", method: 0, inputs: answered.inputs, key: "protocol", value: "chat" })
  assert.equal(protocolAnswered.prompt, null)
  const signed = await api("/api/plugin-signin", { provider: "astraflow", method: 0, inputs: protocolAnswered.inputs, key: "fixture-key-sg" })
  assert.equal(signed.state, "done")
  await until(async () => (await models()).some((id) => id.endsWith("/fixture-chat")), "discovered models")
  let listed = await models()
  const chatID = listed.find((id) => id.endsWith("/fixture-chat"))
  assert.ok(listed.some((id) => id.endsWith("/fixture-vision")))
  assert.ok(!listed.some((id) => /sora|embedding|deepseek/.test(id)))
  const auth = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8"))
  assert.ok(Object.values(auth).some((a) => a.key === "fixture-key-sg" && a.metadata.region === "singapore"))
  console.log("PASS real sign-in prompts, key/region persistence and filtered dynamic models")
  const streamed = await ask({ model: chatID, messages: [{ role: "user", content: "hello" }], stream: true })
  assert.equal(streamed.status, 200)
  assert.ok(streamed.headers.get("content-type").includes("text/event-stream"))
  const sse = await streamed.text()
  assert.ok(sse.includes("AstraFlow fixture OK") && sse.includes("[DONE]"))
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
  const toolResponse = await ask({ model: chatID, messages: [{ role: "user", content: "weather?" }], tools, stream: true })
  assert.equal(toolResponse.status, 200)
  assert.ok((await toolResponse.text()).includes("call-fixture"))
  const upstream = requests.findLast((r) => r.body?.tools)
  assert.equal(upstream.host, "api-sg.umodelverse.ai")
  assert.equal(upstream.authorization, "Bearer fixture-key-sg")
  assert.equal(upstream.body.model, "fixture-chat")
  assert.deepEqual(upstream.body.tools, tools)
  const denied = await ask({ model: chatID, messages: [{ role: "user", content: "deny" }] })
  assert.equal(denied.status, 403)
  assert.ok((await denied.text()).includes("fixture model permission denied"))
  console.log("PASS gateway Chat streaming, tools, selected host, key and upstream permission errors")
  const responses = await ask({ model: chatID, input: [{ role: "user", content: "hello from Responses" }] }, "/v1/responses")
  assert.equal(responses.status, 200)
  assert.ok((await responses.text()).includes("AstraFlow fixture OK"))
  const messages = await ask({ model: chatID, max_tokens: 100, messages: [{ role: "user", content: "hello from Messages" }] }, "/v1/messages")
  assert.equal(messages.status, 200)
  assert.ok((await messages.text()).includes("AstraFlow fixture OK"))
  console.log("PASS Magpie Responses and Anthropic Messages conversion to Chat Completions")
  // Restart the actual host, then discover an added model and drop a retired one.
  await stop()
  catalog = ["fixture-chat", "fixture-new", "sora-fixture", "ByteDance/doubao-seed-1.6"]
  await start()
  await until(async () => (await models()).some((id) => id.endsWith("/fixture-new")), "catalog after restart")
  listed = await models()
  assert.ok(!listed.some((id) => id.endsWith("/fixture-vision")))
  const restarted = await ask({ model: chatID, messages: [{ role: "user", content: "hello again" }] })
  assert.equal(restarted.status, 200)
  assert.ok((await restarted.text()).includes("AstraFlow fixture OK"))
  assert.equal(requests.findLast((r) => r.body).host, "api-sg.umodelverse.ai")
  console.log("PASS persisted account after restart; dynamic model additions/removals")
  const thinkingID = listed.find((id) => id.endsWith("/ByteDance/doubao-seed-1.6"))
  assert.ok(thinkingID)
  const thinkingResponse = await ask({ model: thinkingID, messages: [{ role: "user", content: "thinking switch" }], reasoning_effort: "none" })
  assert.equal(thinkingResponse.status, 200, await thinkingResponse.clone().text())
  const thinkingRequest = requests.findLast((r) => r.path === "/v1/chat/completions")
  assert.equal(thinkingRequest.body.model, "ByteDance/doubao-seed-1.6")
  assert.deepEqual(thinkingRequest.body.thinking, { type: "disabled" })
  assert.equal(thinkingRequest.body.reasoning_effort, undefined)
  console.log("PASS gateway thinking effort maps to AstraFlow's native parameter")
  const imported = await api("/api/plugin-signin", { provider: "astraflow", method: 3, inputs: { source: "auto" } })
  if (imported.state !== "done") await until(async () => (await api(`/api/signin/${imported.id}`)).state === "done", "CLI import")
  const importedAuth = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8"))
  const importedEntry = Object.values(importedAuth).find((a) => a.key === "fixture-key-cli")
  assert.ok(importedEntry?.metadata.cliImport)
  assert.equal(importedEntry.type, "api")
  assert.equal(importedEntry.metadata.region, "china")
  assert.ok(!JSON.stringify(importedEntry).includes("must-not-copy"))
  assert.equal(readFileSync(cliConfig, "utf8"), cliBytes)
  console.log("PASS actual CLI-config sign-in, API-only persistence and unchanged source credentials")
  const callbackURL = (flow) => {
    const url = new URL(flow.url)
    const callback = new URL(url.searchParams.get("redirect_uri"))
    callback.search = new URLSearchParams({ state: url.searchParams.get("state"), code: "fixture-code" }).toString()
    return callback
  }
  const done = async (flow) => until(async () => {
    const status = await api(`/api/signin/${flow.id}`)
    assert.notEqual(status.state, "failed", status.error)
    return status.state === "done"
  }, "OAuth sign-in completion")
  const browser = await api("/api/plugin-signin", { provider: "astraflow", method: 1, inputs: { region: "singapore", protocol: "chat", issuer: "ucloud" } })
  assert.equal(browser.state, "waiting")
  const callback = callbackURL(browser)
  const state = callback.searchParams.get("state")
  const projectPage = await (await fetch(callback)).text()
  assert.ok(projectPage.includes("Fixture project") && !projectPage.includes("fixture-access-"))
  const form = async (fields) => fetch(callback.origin + "/select", { method: "POST", headers: { Origin: callback.origin }, body: new URLSearchParams({ state, ...fields }) })
  const keyPage = await (await form({ project: "project-fixture" })).text()
  assert.ok(keyPage.includes("Fixture existing key") && !keyPage.includes("fixture-key-oauth"))
  assert.equal((await form({ mode: "existing", key: "key-fixture" })).status, 200)
  await done(browser)
  assert.equal(createdCount, 0)
  let persisted = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8"))
  const oauthEntry = Object.entries(persisted).find(([, a]) => a.type === "oauth" && a.inferenceKey === "fixture-key-oauth")
  assert.ok(oauthEntry)
  assert.equal(oauthEntry[1].issuer, "ucloud")
  assert.equal(oauthEntry[1].projectId, "project-fixture")
  assert.equal(oauthEntry[1].keyId, "key-fixture")
  assert.equal(oauthEntry[1].metadata.region, "singapore")
  assert.equal(oauthEntry[1].email, "fixture@example.test")
  console.log("PASS real browser OAuth callback, project/key selection, secret-free pages and credential persistence")
  const manualInputs = { region: "global", protocol: "responses", issuer: "ucloud-global", projectId: "project-fixture", keyMode: "create", keyName: "Fixture created key" }
  const keyPrompt = await api("/api/plugin-signin/prompt", { provider: "astraflow", method: 2, inputs: { ...manualInputs, keyName: undefined } })
  assert.equal(keyPrompt.prompt.key, "keyName")
  const manual = await api("/api/plugin-signin", { provider: "astraflow", method: 2, inputs: manualInputs })
  await api(`/api/signin/${manual.id}/callback`, { url: callbackURL(manual).href })
  await done(manual)
  assert.equal(createdCount, 1)
  persisted = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8"))
  assert.ok(Object.values(persisted).some((a) => a.type === "oauth" && a.issuer === "ucloud-global" && a.inferenceKey === "fixture-key-created" && a.metadata.protocol === "responses"))
  console.log("PASS real manual callback / international OAuth and explicitly requested key creation")
  // Magpie presents the primary account's catalog. Select the Responses
  // account through the actual GUI API while preserving the Chat accounts.
  const nativeAccount = Object.values(persisted).find((a) => a.inferenceKey === "fixture-key-created")
  await api("/api/login/switch", { agent: "plugin:astraflow", user: nativeAccount.accountId })
  await until(async () => (await models()).some((id) => id.endsWith("/fixture-chat@responses")), "mixed-account Responses model")
  const mixedId = (await models()).find((id) => id.endsWith("/fixture-chat@responses"))
  const mixedResponse = await ask({ model: mixedId, input: "mixed account native Responses" }, "/v1/responses")
  assert.equal(mixedResponse.status, 200, await mixedResponse.clone().text())
  assert.ok((await mixedResponse.text()).includes("AstraFlow native Responses OK"))
  const mixedRequest = requests.findLast((r) => r.path === "/v1/responses")
  assert.equal(mixedRequest.host, "api.umodelverse.ai")
  assert.equal(mixedRequest.authorization, "Bearer fixture-key-created")
  assert.equal(mixedRequest.body.model, "fixture-chat")
  console.log("PASS switching between mixed API/OAuth accounts preserves native protocol, key and region")
  // Isolate the selected fixture account, expire its control-plane token,
  // and restart to exercise Magpie's proactive refresh + persisted rotation.
  await stop()
  const authFile = join(directory, "plugin-auth.json")
  const old = { ...oauthEntry[1], expires: Date.now() - 1000 }
  writeFileSync(authFile, JSON.stringify({ [oauthEntry[0]]: old }))
  const before = tokenCount
  await start()
  await until(async () => Object.values(JSON.parse(readFileSync(authFile, "utf8"))).some((a) => a.access !== old.access && a.refresh !== old.refresh), "persisted OAuth refresh")
  assert.equal(tokenCount, before + 1)
  const refreshed = JSON.parse(readFileSync(authFile, "utf8"))[oauthEntry[0]]
  assert.equal(refreshed.inferenceKey, "fixture-key-oauth")
  assert.equal(refreshed.metadata.region, "singapore")
  const oauthChat = await ask({ model: chatID, messages: [{ role: "user", content: "OAuth inference" }] })
  assert.equal(oauthChat.status, 200)
  assert.equal(requests.findLast((r) => r.path === "/v1/chat/completions").authorization, "Bearer fixture-key-oauth")
  console.log("PASS real host token refresh, persisted rotation and inference/control-plane credential separation")
  const quotas = await api("/api/usage/quotas/refresh?provider=astraflow", {})
  assert.ok(JSON.stringify(quotas).includes("42.50 (UCloud account currency)"))
  assert.ok(JSON.stringify(quotas).includes("Daily key budget"))
  assert.ok(JSON.stringify(quotas).includes("settled; billing may be delayed"))
  assert.ok(JSON.stringify(quotas).includes('"used":25'))
  console.log("PASS UCloud balance and real settled Key budgets through Magpie usage")
  for (const [protocol, path, body, expected] of [
    ["responses", "/v1/responses", { input: "native input" }, "AstraFlow native Responses OK"],
    ["anthropic", "/v1/messages", { messages: [{ role: "user", content: "native messages" }], max_tokens: 100 }, "AstraFlow native Messages OK"],
  ]) {
    await stop()
    writeFileSync(authFile, JSON.stringify({ [oauthEntry[0]]: { ...refreshed, metadata: { ...refreshed.metadata, protocol } } }))
    await start()
    await until(async () => (await models()).some((id) => id.endsWith(`/fixture-chat@${protocol}`)), "native protocol model discovery")
    const nativeId = (await models()).find((id) => id.endsWith(`/fixture-chat@${protocol}`))
    const response = await ask({ model: nativeId, ...body }, path)
    assert.equal(response.status, 200, await response.clone().text())
    assert.ok((await response.text()).includes(expected))
    const upstream = requests.findLast((r) => r.path === path)
    assert.ok(upstream)
    assert.equal(upstream.authorization, "Bearer fixture-key-oauth")
    assert.equal(upstream.host, "api-sg.umodelverse.ai")
    assert.equal(upstream.body.model, "fixture-chat")
  }
  console.log("PASS real gateway native Responses and Anthropic Messages with OAuth-selected inference key")
  await stop()
  writeFileSync(authFile, JSON.stringify({ [oauthEntry[0]]: { ...refreshed, metadata: { ...refreshed.metadata, protocol: "gemini" } } }))
  await start()
  await until(async () => (await models()).some((id) => id.endsWith("/publishers/google/models/gemini-fixture@gemini")), "native Gemini discovery")
  const geminiID = (await models()).find((id) => id.endsWith("/publishers/google/models/gemini-fixture@gemini"))
  for (const stream of [false, true]) {
    const response = await ask({ model: geminiID, messages: [{ role: "user", content: "native Gemini" }], stream })
    assert.equal(response.status, 200, await response.clone().text())
    assert.ok((await response.text()).includes("AstraFlow native Gemini OK"))
    assert.equal(requests.findLast((r) => r.path?.startsWith("/v1beta/models/")).host, "api-sg.umodelverse.ai")
  }
  console.log("PASS paginated native Gemini discovery, namespaced model IDs and streaming/non-streaming through the real gateway")
  await stop()
  complete = true
} finally {
  if (web) { web.kill("SIGTERM"); await web.exited }
  fixture?.stop(true)
  if (complete) rmSync(sandbox, { recursive: true, force: true })
  else console.error(`Acceptance diagnostics retained at ${sandbox}`)
}

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { findBun, findMagpieHost, MagpieHost } from "./host-process.mjs"

const bun = findBun()
const magpieHost = findMagpieHost()
const skipReason = !magpieHost
  ? "Opt-in only: set MAGPIE_CHECKOUT or MAGPIE_HOST to an existing production host"
  : !bun
    ? "Bun is not installed or MAGPIE_BUN does not point to an executable"
    : false
const modelID = "fixture-chat-model_0123456789abcdef"

function sse(text, status = "completed") {
  const value = JSON.stringify({
    kind: "delta-batch",
    cid: "fixture-cid",
    chunks: [{ kind: "element-add", element: { id: "fixture-text", type: "TEXT", content: text } }],
  })
  return `data: ${value}\n\ndata: ${JSON.stringify({ type: "task_done", status, conversationId: "fixture-conversation", errorMessage: status === "completed" ? "" : "fixture task failed" })}\n\n`
}

function startServer(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  return once(server, "listening").then(() => server)
}

async function closeServer(server) {
  if (!server) return
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

function toolCallFromQuery(query) {
  const start = query.match(/<\|MAGPIE_TOOL_CALLS:([A-Za-z0-9_-]+)\|>/)
  assert.ok(start, "Comate query includes the request's tool marker")
  const end = `<|/MAGPIE_TOOL_CALLS:${start[1]}|>`
  return `${start[0]}[{"name":"echo","arguments":{"text":"from Comate"}}]${end}`
}

test("Comate runs through Magpie's production Bun host with standard tool calls", {
  skip: skipReason,
  timeout: 60_000,
}, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "comate-host-integration-"))
  t.after(() => rmSync(temp, { recursive: true, force: true }))

  let failNextTask = false
  let redirectNextTask = false
  let redirected = 0
  const payloads = []
  const receiver = await startServer((_req, res) => {
    redirected++
    res.writeHead(200, { "content-type": "text/event-stream" }).end(sse("redirected"))
  })
  t.after(() => closeServer(receiver))

  const zulu = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString("utf8")
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    if (req.url === "/list-model") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        code: 0,
        data: [{ modelId: modelID, displayName: "Fixture Model", modelType: "fixture-chat", thinking: true, supportImage: false, effortLevels: ["low", "high"] }],
      }))
      return
    }
    if (req.url !== "/api/v1/conversations/init") {
      res.writeHead(404).end(JSON.stringify({ error: "unexpected fixture path" }))
      return
    }
    const payload = JSON.parse(raw)
    payloads.push(payload)
    if (redirectNextTask) {
      redirectNextTask = false
      res.writeHead(302, { location: `http://127.0.0.1:${receiver.address().port}/redirected` }).end()
      return
    }
    if (failNextTask) {
      failNextTask = false
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse("partial text", "failed"))
      return
    }
    const answer = toolCallFromQuery(payload.query)
    res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(answer))
  })
  t.after(() => closeServer(zulu))

  const port = zulu.address().port
  const settingsPath = join(temp, "comate-settings.json")
  const pidPath = join(temp, "zulu-serve.pid")
  writeFileSync(settingsPath, JSON.stringify({ "baidu.comate.license": "fixture-license", "baidu.comate.username": "fixture-user" }))
  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port, host: "127.0.0.1" }))

  const env = {
    HOME: temp,
    USERPROFILE: temp,
    PATH: dirname(bun),
    MAGPIE_BUN: bun,
    COMATE_SETTINGS_PATH: settingsPath,
    COMATE_PID_PATH: pidPath,
    COMATE_PORT: String(port),
  }
  const host = new MagpieHost({ bun, host: magpieHost, cwd: temp, env })
  t.after(() => host.close())

  const pluginDir = fileURLToPath(new URL(".", import.meta.url))
  const initialized = await host.call("init", {
    authPath: join(temp, "plugin-auth.json"),
    directory: temp,
    config: {},
    plugins: [{
      spec: "comate-fixture",
      target: pluginDir,
      options: {
        discoveryOptions: {
          platform: process.platform,
          home: temp,
          env: { COMATE_SETTINGS_PATH: settingsPath, COMATE_PID_PATH: pidPath },
          settingsPath,
          pidPath,
          port,
        },
      },
    }],
  })
  assert.deepEqual(initialized.plugins, [{ spec: "comate-fixture", provides: ["comate"] }])

  const beforeSignIn = await host.call("providers")
  const comate = beforeSignIn.find((provider) => provider.id === "comate")
  assert.ok(comate, "Comate provider is registered")
  const apiMethod = comate.methods.findIndex((method) => method.type === "api")
  assert.notEqual(apiMethod, -1, "Comate exposes a pasted-license sign-in method")
  const desktopMethod = comate.methods.findIndex((method) => method.type === "oauth")
  assert.notEqual(desktopMethod, -1, "Comate exposes local desktop sign-in")
  const authorization = await host.call("authorize", {
    provider: "comate",
    method: desktopMethod,
    inputs: {},
  })
  assert.equal(authorization.method, "auto")
  const signedIn = await host.call("callback", { session: authorization.session })
  assert.equal(signedIn.ok, true)

  const afterSignIn = await host.call("providers")
  const model = afterSignIn.find((provider) => provider.id === "comate")?.models.find((candidate) => candidate.id === modelID)
  assert.equal(model?.name, "Fixture Model")
  assert.equal(model?.reasoning, true)
  assert.deepEqual(model?.variants, [], "Comate does not expose reasoning-effort selection through this adapter")
  assert.equal(payloads.length, 0, "model discovery only calls /list-model")

  const loaded = await host.call("load", { provider: "comate", account: signedIn.account })
  assert.equal(loaded.baseURL, `http://127.0.0.1:${port}/v1`)
  assert.equal(loaded.apiKey, "")
  assert.equal(loaded.fetch, true)

  const chat = {
    model: modelID,
    stream: false,
    messages: [
      { role: "system", content: "Use the offered tools." },
      { role: "user", content: "Echo this value." },
    ],
    tools: [{ type: "function", function: {
      name: "echo",
      description: "Echo a string.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    } }],
    tool_choice: "auto",
  }
  const request = async (body) => host.fetch({
    provider: "comate",
    account: signedIn.account,
    model: modelID,
    npm: "@ai-sdk/openai-compatible",
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
    session: "fixture-session",
  })

  const reply = await request(chat)
  assert.equal(reply.status, 200)
  const completion = JSON.parse(reply.body.toString("utf8"))
  const call = completion.choices?.[0]?.message?.tool_calls?.[0]
  assert.equal(call?.type, "function")
  assert.equal(call?.function?.name, "echo")
  assert.deepEqual(JSON.parse(call.function.arguments), { text: "from Comate" })
  assert.equal(completion.choices[0].finish_reason, "tool_calls")

  const payload = payloads.at(-1)
  assert.equal(payload.license, "fixture-license")
  assert.equal(payload.modelId, modelID)
  assert.equal(typeof payload.traceId, "string")
  assert.ok(payload.query.includes('"name":"echo"'))
  assert.ok(payload.query.includes("Echo a string."))
  assert.match(payload.query, /<\|MAGPIE_TOOL_CALLS:[A-Za-z0-9_-]+\|>/)
  assert.equal("conversationId" in payload, false)

  // A failed streamed task must remain a valid OpenAI-compatible error event.
  failNextTask = true
  const streamReply = await request({ ...chat, stream: true, messages: [{ role: "user", content: "trigger failure" }] })
  assert.equal(streamReply.status, 200)
  const streamText = streamReply.body.toString("utf8")
  const errorFrame = streamText.split(/\r?\n\r?\n/).find((frame) => frame.startsWith("data: {\"error\":"))
  assert.ok(errorFrame, `stream includes a JSON error event: ${streamText}`)
  assert.doesNotThrow(() => JSON.parse(errorFrame.slice("data: ".length)))
  assert.match(streamText, /data: \[DONE\]/)

  // A redirect from the local service must fail closed without following it.
  redirectNextTask = true
  const redirectReply = await request({ ...chat, messages: [{ role: "user", content: "redirect test" }] })
  assert.equal(redirectReply.status, 502)
  assert.equal(redirected, 0, "the request was not forwarded to the redirect destination")
})

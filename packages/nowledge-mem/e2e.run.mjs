// End-to-end checks against a real Nowledge Mem, configured by the
// repository's .env (NMEM_API_URL and NMEM_API_KEY) or the same variables in
// the environment. Run it directly, or through e2e.test.mjs, which spawns it
// in a process of its own: the offline tests replace globalThis.fetch, and a
// live check must not share that process.
//
//   bun packages/nowledge-mem/e2e.run.mjs
//   set -a; . ./.env; set +a; NMEM_E2E=1 bun test packages/nowledge-mem
//
// Everything written to Mem is deleted again: one Memory, and Threads whose
// ids begin with "magpie-e2e-".
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { onRequest, onResponse, reset } from "./nowledge-mem.hooks.mjs"

function loadEnv() {
  const path = fileURLToPath(new URL("../../.env", import.meta.url))
  const env = {}
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u)
      if (!match) continue
      let value = match[2]
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1)
      env[match[1]] = value
    }
  }
  // Bun and a developer's shell may carry other NMEM_* values; the repository
  // .env is the source this run is asked to test, so it wins when it has one.
  for (const name of ["NMEM_API_URL", "NMEM_API_KEY"])
    if (env[name] === undefined && process.env[name]) env[name] = process.env[name]
  return env
}

const env = loadEnv()
const url = env.NMEM_API_URL?.replace(/\/$/u, "")
const key = env.NMEM_API_KEY
if (!url || !key) {
  console.error("e2e: set NMEM_API_URL and NMEM_API_KEY in .env or the environment")
  process.exit(2)
}
process.env.NMEM_API_URL = url
process.env.NMEM_API_KEY = key

const created = { memories: [], threads: [] }

async function call(method, route, body) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = text }
  return { status: response.status, json }
}

const options = (extra = {}) => ({ serverUrl: url, apiKey: key, capture: false, ...extra })
const context = (extra = {}) => ({
  protocol: "chat", origin: "local", query: "e2e", cwd: "/tmp/nowledge-mem-e2e",
  session: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  signal: new AbortController().signal, options: options(), state: {},
  ...extra,
})

let failures = 0
async function check(name, fn) {
  const started = performance.now()
  try {
    await fn()
    console.log(`✓ ${name} (${Math.round(performance.now() - started)}ms)`)
  }
  catch (error) {
    failures++
    console.error(`✗ ${name}\n${error?.stack ?? error}`)
  }
  finally {
    reset()
  }
}

async function connectionReachesMem() {
  const token = `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const seeded = await call("POST", "/memories", {
    content: `The Magpie end-to-end probe token is ${token}.`,
    title: `${token} probe`,
    source: "magpie-e2e",
  })
  assert.equal(seeded.status, 200)
  const memoryId = seeded.json?.memory?.id
  assert.ok(memoryId, "Mem created no Memory")
  created.memories.push(memoryId)

  // No serverUrl or apiKey here: the hook reads NMEM_API_URL and NMEM_API_KEY.
  const body = { model: "e2e", messages: [{ role: "user", content: `Which token did the Magpie end-to-end probe use? ${token}` }] }
  const out = await onRequest(body, context({ query: token, options: { recall: true, contextBundle: false, maxMemories: 5 } }))
  assert.equal(out, body)
  const text = body.messages[0].content
  assert.ok(text.includes(token), "the seeded Memory was not recalled")
  assert.ok(text.includes(`nowledgemem://memory/${memoryId}`), "the recalled Memory's id was not cited")
  assert.ok(text.includes("<nowledge-mem-reference>"), "the context block was not added")
}

async function contextBundleArrives() {
  const bundle = await call("GET", "/context/bundle?source_app=magpie&include_working_memory=true")
  assert.equal(bundle.status, 200)
  const markdown = bundle.json?.rendered_markdown ?? ""
  const body = { model: "e2e", messages: [{ role: "user", content: "What are we working on this week?" }] }
  await onRequest(body, context({ query: "What are we working on this week?" }))
  const text = body.messages[0].content
  if (markdown.trim()) {
    assert.ok(text.includes("## Context bundle"), "no Context Bundle section")
    assert.ok(text.includes("# Nowledge Mem Context Bundle"), "the bundle's own text is missing")
  }
  else {
    assert.ok(!text.includes("## Context bundle"), "a bundle section appeared without a bundle")
  }
}

async function captureAppendsOneThread() {
  const session = `e2e-capture-${Date.now()}`
  const question = `E2E capture ${session}: what is the codename?`
  const first = { model: "e2e", messages: [{ role: "user", content: question }] }
  const captureOptions = options({ capture: true, recall: false, contextBundle: false })
  const firstContext = context({ session, agent: "e2e", options: captureOptions, query: question })
  const accepted = await onRequest(first, firstContext)
  const threadId = firstContext.state.nowledgeMem?.threadId
  assert.match(threadId ?? "", /^magpie-e2e-capture-/u)
  created.threads.push(threadId)
  const firstReply = { choices: [{ index: 0, message: { role: "assistant", content: "The codename is E2E-QUARTZ." }, finish_reason: "stop" }] }
  await onResponse(firstReply, { ...firstContext, success: true, request: accepted })

  const imported = await call("GET", `/threads/${encodeURIComponent(threadId)}`)
  assert.equal(imported.status, 200)
  assert.equal(imported.json.thread.source, "magpie")
  assert.ok(imported.json.thread.title.startsWith(`E2E capture ${session}`), "the Thread title is not the opening turn")
  assert.deepEqual(imported.json.messages.map((message) => [message.role, message.content]), [
    ["user", question],
    ["assistant", "The codename is E2E-QUARTZ."],
  ])

  // A later turn is imported into the same Thread, without a second copy of the first.
  const follow = {
    model: "e2e",
    messages: [
      { role: "user", content: question },
      { role: "assistant", content: "The codename is E2E-QUARTZ." },
      { role: "user", content: "And when is the release?" },
    ],
  }
  const followContext = context({ session, agent: "e2e", options: captureOptions, query: "And when is the release?" })
  const acceptedFollow = await onRequest(follow, followContext)
  assert.equal(followContext.state.nowledgeMem.threadId, threadId)
  const followReply = { choices: [{ index: 0, message: { role: "assistant", content: "Next week." }, finish_reason: "stop" }] }
  await onResponse(followReply, { ...followContext, success: true, request: acceptedFollow })
  await onResponse(followReply, { ...followContext, success: true, request: acceptedFollow })

  const appended = await call("GET", `/threads/${encodeURIComponent(threadId)}`)
  assert.equal(appended.status, 200)
  assert.deepEqual(appended.json.messages.map((message) => message.content), [
    question,
    "The codename is E2E-QUARTZ.",
    "And when is the release?",
    "Next week.",
  ])
  assert.equal(appended.json.thread.metadata.source_app, "magpie")
  // The gateway knows the harness behind the request and records it.
  assert.equal(appended.json.thread.metadata.agent, "e2e")
  assert.equal(appended.json.thread.metadata.host_agent_id, "magpie:e2e")
}

async function wrongKeyIsRefused() {
  const wrong = context({ options: options({ apiKey: "nmem_wrong_key", recall: true }) })
  const error = await onRequest({ messages: [{ role: "user", content: "hello" }] }, wrong).catch((e) => e)
  assert.equal(error.message, "Nowledge Mem unauthorized")
  assert.ok(!error.message.includes("nmem_wrong_key"))
}

async function unknownSpaceIsUnbound() {
  const unknown = context({ options: options({ spaceId: "no-such-space", recall: true }) })
  const reports = []
  unknown.report = (...args) => reports.push(args)
  await assert.rejects(onRequest({ messages: [{ role: "user", content: "hello" }] }, unknown), /unbound/u)
  assert.deepEqual(reports, [["unbound"]])
}

try {
  await check("the connection in .env reaches Mem and recall finds a seeded Memory", connectionReachesMem)
  await check("a session's first turn receives Mem's Context Bundle", contextBundleArrives)
  await check("capture imports a Thread, appends a later turn, and is idempotent", captureAppendsOneThread)
  await check("a wrong key is refused with a fixed code and no service text", wrongKeyIsRefused)
  await check("an unknown Space is reported as unbound", unknownSpaceIsUnbound)
}
finally {
  // Whatever happened above, this run's Memory and Threads do not stay in Mem.
  for (const id of created.threads)
    await call("DELETE", `/threads/${encodeURIComponent(id)}`).catch(() => {})
  for (const id of created.memories)
    await call("DELETE", `/memories/${encodeURIComponent(id)}`).catch(() => {})
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")

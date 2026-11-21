// Run against an installed Pi SDK; all model traffic stays on a loopback fixture.
// node scripts/cursor-pi-retry.integration.mjs <pi-coding-agent root> packages/cursor [exhausted]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , sdkRoot, pluginRoot, mode] = process.argv
if (!sdkRoot || !pluginRoot) throw new Error('Pass the Pi SDK root and Cursor package directory')
const exhausted = mode === 'exhausted'
const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(resolve(sdkRoot, 'dist/index.js')))
const { Quiet, NATIVE_LIMITS } = await import(pathToFileURL(resolve(pluginRoot, 'native-session.mjs')))
const quiet = new Quiet(NATIVE_LIMITS, () => {})
quiet.since = Date.now() - 60_000
quiet.last = 'blob request'
quiet.fire()
const errorMessage = quiet.why
const tmp = mkdtempSync(join(tmpdir(), 'cursor-pi-retry-'))
const requests = []
let executions = 0
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  try {
    requests.push(JSON.parse(body))
  } catch {
    res.writeHead(400)
    res.end('Invalid fixture request JSON')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n')
  const chunk = (delta, finish_reason = null) => send({
    id: 'synthetic-' + requests.length,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [{ index: 0, delta, finish_reason }],
  })
  chunk({ role: 'assistant' })
  if (requests.length === 1) {
    chunk({ tool_calls: [{
      index: 0, id: 'call_once', type: 'function',
      function: { name: 'diagnostic_once', arguments: '{}' },
    }] })
    chunk({}, 'tool_calls')
    res.end('data: [DONE]\n\n')
  } else if (requests.length === 2 || exhausted) {
    chunk({ content: 'INCOMPLETE_DRAFT_SHOULD_BE_OMITTED' })
    send({ error: { status: 502, message: errorMessage } })
    res.end()
  } else {
    chunk({ content: 'RECOVERED' })
    chunk({}, 'stop')
    res.end('data: [DONE]\n\n')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
writeFileSync(join(tmp, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl, apiKey: 'synthetic',
  models: [{
    id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
    contextWindow: 32000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }))
const modelRuntime = await ModelRuntime.create({
  authPath: join(tmp, 'auth.json'), modelsPath: join(tmp, 'models.json'),
})
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'Synthetic retry integration test.',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
}
let session
try {
  ;({ session } = await createAgentSession({
    cwd: tmp, agentDir: tmp, modelRuntime,
    model: modelRuntime.getModel('fixture', 'fixture'), thinkingLevel: 'off',
    resourceLoader, sessionManager: SessionManager.inMemory(tmp),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
    }),
    tools: ['diagnostic_once'],
    customTools: [{
      name: 'diagnostic_once', label: 'Diagnostic', description: 'Synthetic effect counter',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'ALREADY_EXECUTED_ONCE' }], details: {} }
      },
    }],
  }))
  const retries = []
  session.subscribe((event) => {
    if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end') {
      retries.push({ type: event.type, success: event.success, attempt: event.attempt })
    }
  })
  await session.prompt('Call diagnostic_once, then finish.')
  const result = {
    requests: requests.length, executions, answer: session.getLastAssistantText(), retries, errorMessage,
  }
  console.log(JSON.stringify(result, null, 2))
  assert.equal(requests.length, exhausted ? 4 : 3, 'Retry count must follow the configured budget')
  assert.equal(executions, 1, 'A completed tool must not execute again')
  for (const request of requests.slice(2)) {
    const history = JSON.stringify(request.messages)
    assert.equal(history.includes('INCOMPLETE_DRAFT_SHOULD_BE_OMITTED'), false,
      'Failed partial output must be omitted from retry context')
    assert.equal(history.includes('ALREADY_EXECUTED_ONCE'), true,
      'Completed tool result must remain in retry context')
  }
  if (exhausted) {
    assert.equal(session.messages.at(-1).stopReason, 'error')
    assert.equal(retries.filter((event) => event.type === 'auto_retry_start').length, 2)
    assert.equal(retries.at(-1).success, false)
  } else {
    assert.equal(result.answer, 'RECOVERED')
    assert.equal(retries.at(-1).success, true)
  }
  console.log(`PASS: real Pi SDK ${exhausted ? 'exhausts its bounded retry budget' : 'recovers after a Cursor timeout'} without repeating the tool.`)
} finally {
  session?.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
}

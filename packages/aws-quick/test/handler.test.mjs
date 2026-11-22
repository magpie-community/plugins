import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.mjs'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/sessions.mjs'
import { byteLen } from '../lib/translate.mjs'
import { OutpostError } from '../lib/outpost.mjs'

let fake
let outpostMgr

before(async () => {
  fake = await startFakeQuick({})
  const outpost = {
    outpostId: async () => 'outpost-test-1',
    session: async () => ({
      ws_host: fake.wsHost,
      id_token: 'test-token',
      actor_arn: 'arn:test',
      provider: 'social',
      aws_account_id: '123456789012',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  outpostMgr = { ensure: async () => outpost }
})

after(async () => { await fake?.close() })

function req(body, extra = {}) {
  return handleChatCompletions({
    body,
    outpostMgr,
    sessions: extra.sessions,
    options: { identity: 'test-acct', log: () => {} },
    signal: extra.signal,
  })
}

async function readSse(res) {
  const text = await res.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const data = line.slice(6)
    if (data === '[DONE]') { events.push({ done: true }); continue }
    try { events.push(JSON.parse(data)) } catch {}
  }
  return events
}

test('models endpoint returns the four agent modes', async () => {
  const res = handleModels()
  const data = await res.json()
  assert.equal(data.object, 'list')
  assert.deepEqual(data.data.map((m) => m.id).sort(), ['advanced', 'balanced', 'fast', 'smart'])
})

test('non-stream chat completion returns assembled text + usage', async () => {
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'capital of France?' }] })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.model, 'fast')
  const msg = json.choices[0].message
  assert.equal(msg.role, 'assistant')
  assert.ok(msg.content.startsWith('echo:'))
  assert.equal(json.choices[0].finish_reason, 'stop')
  assert.equal(json.usage.prompt_tokens, 14) // 11 + 3 cached
  assert.equal(json.usage.completion_tokens, 7)
  assert.equal(json.usage.total_tokens, 21)
})

test('stream chat completion emits role/content chunks then stop + DONE', async () => {
  const res = await req({ model: 'smart', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'say hi' }] })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = await readSse(res)
  const chunks = events.filter((e) => e.choices?.length)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
  assert.ok(text.startsWith('echo:'))
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  const usageChunk = events.find((e) => e.choices?.length === 0 && e.usage)
  assert.ok(usageChunk, 'expected a usage-only chunk')
  assert.equal(usageChunk.usage.total_tokens, 21)
  assert.equal(events.at(-1).done, true)
})

test('agent_mode is sent per request model; unknown models default to smart', async () => {
  await req({ model: 'balanced', messages: [{ role: 'user', content: 'm1' }] })
  await req({ model: 'gpt-5', messages: [{ role: 'user', content: 'm2' }] })
  const msgs = fake.state.userMessages
  assert.equal(msgs.at(-2).payload.agent_mode, 'balanced')
  assert.equal(msgs.at(-1).payload.agent_mode, 'smart')
  assert.ok(msgs.at(-1).payload.message_id)
  assert.ok(msgs.at(-1).payload.thread_id)
})

test('system prompt rides the custom_prompt field; history renders into text', async () => {
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.equal(p.custom_prompt, 'be terse')
  assert.equal(p.system_prompt, undefined)
  assert.ok(!p.text.includes('[system instructions]'))
  assert.ok(p.text.includes('user: q1'))
  assert.ok(p.text.includes('assistant: a1'))
  assert.ok(p.text.endsWith('\n\nq2'))
})

test('no custom_prompt field when the request has no system messages', async () => {
  await req({ model: 'fast', messages: [{ role: 'user', content: 'plain' }] })
  const p = fake.state.userMessages.at(-1).payload
  assert.equal(p.custom_prompt, undefined)
  assert.equal(p.system_prompt, undefined)
})

test('custom_prompt shares the 64KB frame budget with text without duplication', async () => {
  const bigSys = 'S'.repeat(40 * 1024) // over the 32KB instruction cap
  const bigUser = 'U'.repeat(35 * 1024)
  const res = await req({
    model: 'fast',
    messages: [
      { role: 'system', content: bigSys },
      { role: 'user', content: bigUser },
    ],
  })
  const json = await res.json()
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(byteLen(p.custom_prompt) <= 32 * 1024 + 64)
  assert.ok(p.custom_prompt.endsWith('…[truncated]'))
  assert.equal(p.system_prompt, undefined)
  assert.ok(byteLen(p.text) + byteLen(p.custom_prompt) <= 60 * 1024)
  assert.match(json.choices[0].message.content, /64KB/)
})

test('huge system prompt + large toolset degrades to compact typed signatures and keeps user question', async () => {
  // Regression: a preamble exceeding the frame budget used to be tail-cut or
  // strip all parameter names. Compact signatures keep parameter names + question.
  const tools = Array.from({ length: 25 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `does thing ${i} `.padEnd(800, 'd'),
      parameters: {
        type: 'object',
        properties: { arg: { type: 'string', description: 'x'.repeat(400) } },
        required: ['arg'],
      },
    },
  }))
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'S'.repeat(40 * 1024) },
      { role: 'user', content: 'FINAL_QUESTION_MARKER what is 2+2' },
    ],
    tools,
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.text.includes('FINAL_QUESTION_MARKER'), 'user question must survive the frame cap')
  assert.ok(p.text.includes('[Client tool calling]'), 'tool convention must survive too')
  assert.ok(p.text.includes('tool_0(arg!: string)'), 'compact typed signature preserves parameter names')
  assert.ok(byteLen(p.custom_prompt) + byteLen(p.text) <= 62 * 1024)
})

test('thread reuse: extended conversation continues the same thread with delta only', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'remember teal' }
  // turn 1
  const r1 = await req({ model: 'fast', messages: [u1] }, { sessions })
  assert.equal(r1.status, 200)
  const j1 = await r1.json()
  const reply = j1.choices[0].message.content

  // turn 2 extends the conversation
  const r2 = await req({
    model: 'fast',
    messages: [u1, { role: 'assistant', content: reply }, { role: 'user', content: 'what color?' }],
  }, { sessions })
  assert.equal(r2.status, 200)
  await r2.json()

  const msgs = fake.state.userMessages
  const t1 = msgs.at(-2)
  const t2 = msgs.at(-1)
  assert.equal(t2.threadId, t1.threadId, 'second turn must reuse the Quick thread')
  assert.equal(t2.payload.text, 'what color?')
  assert.ok(!t2.payload.text.includes('remember teal'))
})

test('edited history starts a fresh thread', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'alpha' }
  await req({ model: 'fast', messages: [u1] }, { sessions }).then((r) => r.json())
  // same shape but different content → no continuation
  await req({
    model: 'fast',
    messages: [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'WRONG reply' },
      { role: 'user', content: 'beta' },
    ],
  }, { sessions }).then((r) => r.json())
  const msgs = fake.state.userMessages
  assert.notEqual(msgs.at(-1).threadId, msgs.at(-2).threadId)
})

test('session_connect carries surface/outpost/appVersion; ping gets pong', async () => {
  await req({ model: 'fast', messages: [{ role: 'user', content: 'ping test' }] })
  // wait a beat for the ping interval? No — ping is on a 45s timer; just assert connect frame.
  const sc = fake.state.sessionConnects.at(-1)
  assert.equal(sc.surfaceType, 'QUICK_WORK_DESKTOP_WINDOWS')
  assert.equal(sc.outpostId, 'outpost-test-1')
  assert.equal(sc.appVersion, '1.2.4660')
  assert.equal(sc.acp_first_text, 1)
  assert.equal(sc.user_notification, 1)
  assert.equal(sc.subtask_progress, 1)
  assert.equal(sc.external_agent_sign_in, 1)
  assert.equal(sc.recents_promotion, 1)
  assert.equal(fake.state.federate, 1)
  const url = new URL(fake.state.urls.at(-1), 'ws://127.0.0.1')
  assert.equal(url.pathname, '/streaming/quickwork-chat-bidirectional-stream')
  assert.equal(url.searchParams.get('surfaceType'), 'QUICK_WORK_DESKTOP_WINDOWS')
  assert.equal(url.searchParams.get('outpostId'), 'outpost-test-1')
  assert.equal(url.searchParams.get('channel'), 'prod')
  assert.ok(url.searchParams.get('workingSessionId'))
  assert.ok(url.searchParams.get('token'))
  const msg = fake.state.userMessages.at(-1).payload
  assert.equal(msg.surfaceType, 'QUICK_WORK_DESKTOP_WINDOWS')
  assert.equal(msg.appVersion, '1.2.4660')
  assert.equal(msg.send_origin, 'composer')
  assert.equal(msg.auto_routing, false)
  assert.equal(msg.web_search_enabled, true)
  assert.equal(msg.acp_first_text, 1)
})

test('outpost failure surfaces as a real HTTP error, not a dead stream', async () => {
  const badMgr = { ensure: async () => { throw new OutpostError('no agent binary', { kind: 'spawn' }) } }
  const res = await handleChatCompletions({
    body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] },
    outpostMgr: badMgr,
    options: {},
  })
  assert.equal(res.status, 503)
  const j = await res.json()
  assert.match(j.error.message, /no agent binary/)
})

test('missing messages → 400', async () => {
  const res = await req({ model: 'fast' })
  assert.equal(res.status, 400)
})

test('tool_call convention: <tool_call> text becomes OpenAI tool_calls', async () => {
  const toolFake = await startFakeQuick({
    script: (p) => {
      const mid = p.message_id || 'm1'
      const tid = p.thread_id
      return [
        { type: 'message_start', payload: { message_id: mid } },
        { type: 'text_delta', payload: { delta: 'Checking. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>' } },
        { type: 'message_complete', payload: { text: 'Checking. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>', message_id: mid } },
      ]
    },
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o3',
        session: async () => ({ ws_host: toolFake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const sessions = createSessionStore()
    const res = await handleChatCompletions({
      body: {
        model: 'smart',
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
      },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'tool-acct' },
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    const msg = j.choices[0].message
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    assert.equal(msg.tool_calls.length, 1)
    assert.equal(msg.tool_calls[0].function.name, 'get_weather')
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' })
    // the <tool_call> block must not leak into visible content
    assert.ok(!msg.content.includes('<tool_call>'))
    assert.ok(msg.content.includes('Checking.'))
    // upstream text carried the tool preamble
    const sent = toolFake.state.userMessages.at(-1).payload.text
    assert.ok(sent.includes('Client tool calling'))
    assert.ok(sent.includes('get_weather'))

    // turn 2: client echoes assistant tool_calls + tool result → same thread, delta only
    const callId = msg.tool_calls[0].id
    const res2 = await handleChatCompletions({
      body: {
        model: 'smart',
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
        messages: [
          { role: 'user', content: 'weather in Paris?' },
          { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls },
          { role: 'tool', tool_call_id: callId, content: '{"temp_c":18}' },
        ],
      },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'tool-acct' },
    })
    assert.equal(res2.status, 200)
    await res2.json()
    const msgs = toolFake.state.userMessages
    assert.equal(msgs.at(-1).threadId, msgs.at(-2).threadId, 'tool-result turn reuses thread')
    const deltaText = msgs.at(-1).payload.text
    assert.ok(deltaText.includes('[tool_result'), 'tool result rendered into delta')
    assert.ok(deltaText.includes(callId))
    assert.ok(!deltaText.includes('weather in Paris?') || deltaText.includes('[tool_result'))
  } finally {
    await toolFake.close()
  }
})

test('streaming tool_call emits tool_calls deltas then tool_calls finish', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'Let me check. <tool_call>{"name":"f","arguments":{"a":1}}</tool_call>' } },
      { type: 'message_complete', payload: { text: 'x', tool_calls: [] } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o5',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: {
        model: 'fast', stream: true,
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      outpostMgr: mgr,
      options: { identity: 'stream-tool-acct' },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(text.includes('"tool_calls"'))
    assert.ok(text.includes('"name":"f"'))
    assert.ok(text.includes('"finish_reason":"tool_calls"'))
    assert.ok(!text.includes('<tool_call>')) // markup never leaks into SSE
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
  } finally {
    await f.close()
  }
})

test('tool_choice none suppresses preamble', async () => {
  const f2 = await startFakeQuick({})
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o4',
        session: async () => ({ ws_host: f2.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    await handleChatCompletions({
      body: {
        model: 'fast',
        tool_choice: 'none',
        tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      outpostMgr: mgr,
      options: { identity: 'none-acct' },
    }).then((r) => r.json())
    assert.ok(!f2.state.userMessages.at(-1).payload.text.includes('Client tool calling'))
  } finally {
    await f2.close()
  }
})

test('mid-stream error emits an error chunk then DONE', async () => {
  const errFake = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'partial' } },
      { type: 'error', payload: { message: 'boom' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o2',
        session: async () => ({ ws_host: errFake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: mgr,
      options: { identity: 'err-acct' },
    })
    assert.equal(res.status, 200)
    const events = await readSse(res)
    const err = events.find((e) => e.error)
    assert.ok(err, 'expected an error event in the stream')
    assert.match(err.error.message, /boom/)
    assert.equal(events.at(-1).done, true)
  } finally {
    await errFake.close()
  }
})

test('Quick terminal tool is handed to the client shell and the result is returned upstream', async () => {
  const local = await startFakeQuick({
    script: (payload, meta = {}) => {
      if (meta.type === 'tool_result') {
        return [
          { type: 'text_delta', payload: { delta: `ran:${String(payload.result).slice(0, 20)}` } },
          { type: 'message_complete', payload: { text: 'ran' } },
        ]
      }
      return [{
        type: 'tool_start',
        payload: { tool_name: 'run_terminal_command', tool_id: 'qt-1', arguments: { command: 'ls' } },
      }]
    },
  })
  try {
    const sessions = createSessionStore()
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'shell-1',
        session: async () => ({ ws_host: local.wsHost, id_token: 't', actor_arn: 'arn:t', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const tools = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }]
    const first = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'list files' }], tools },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'shell-acct', log: () => {} },
    })
    assert.equal(first.status, 200)
    const j1 = await first.json()
    assert.equal(j1.choices[0].finish_reason, 'tool_calls')
    const call = j1.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'Bash')
    assert.equal(JSON.parse(call.function.arguments).command, 'ls')
    const second = await handleChatCompletions({
      body: {
        model: 'fast',
        tools,
        messages: [
          { role: 'user', content: 'list files' },
          j1.choices[0].message,
          { role: 'tool', tool_call_id: call.id, content: 'a.txt' },
        ],
      },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'shell-acct', log: () => {} },
    })
    assert.equal(second.status, 200)
    const j2 = await second.json()
    assert.match(j2.choices[0].message.content, /ran:a\.txt/)
    assert.equal(local.state.toolResults[0].tool_call_id, 'qt-1')
    assert.equal(local.state.toolResults[0].result, 'a.txt')
  } finally {
    await local.close()
  }
})

test('a silent upstream fails instead of hanging the request', async () => {
  const quiet = await startFakeQuick({ script: () => new Promise(() => {}) })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'quiet-1',
        session: async () => ({ ws_host: quiet.wsHost, id_token: 't', actor_arn: 'arn:t', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'hello' }] },
      outpostMgr: mgr,
      options: { identity: 'quiet', idleMs: 400, log: () => {} },
    })
    assert.equal(res.status, 503)
    const json = await res.json()
    assert.match(json.error.message, /没有下行/)
  } finally {
    await quiet.close()
  }
})

test('missing_thread error retries once on a fresh thread with full transcript', async () => {
  let seen = 0
  const retryFake = await startFakeQuick({
    script: (payload) => {
      seen++
      if (seen === 2) {
        return [{ type: 'error', payload: { code: 'ThreadNotFoundException', message: 'thread not found' } }]
      }
      return defaultScript(payload)
    },
  })
  try {
    const sessions = createSessionStore()
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'retry-1',
        session: async () => ({ ws_host: retryFake.wsHost, id_token: 't', actor_arn: 'arn:r', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const r1 = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'remember cobalt' }] },
      outpostMgr: mgr, sessions, options: { identity: 'retry-acct', log: () => {} },
    })
    const j1 = await r1.json()
    const r2 = await handleChatCompletions({
      body: {
        model: 'fast',
        messages: [
          { role: 'user', content: 'remember cobalt' },
          { role: 'assistant', content: j1.choices[0].message.content },
          { role: 'user', content: 'what color?' },
        ],
      },
      outpostMgr: mgr, sessions, options: { identity: 'retry-acct', log: () => {} },
    })
    assert.equal(r2.status, 200)
    await r2.json()
    const sent = retryFake.state.userMessages
    assert.equal(sent.length, 3)
    assert.equal(sent[1].threadId, sent[0].threadId) // tried cached thread
    assert.notEqual(sent[2].threadId, sent[0].threadId) // retried on fresh thread
    assert.ok(sent[2].payload.text.includes('remember cobalt')) // full transcript resent
  } finally {
    await retryFake.close()
  }
})

test('Quick tool_start with JSON string arguments maps to client shell tool', async () => {
  const strFake = await startFakeQuick({
    script: () => [
      { type: 'tool_start', payload: { tool_name: 'run_terminal_command', tool_id: 'qt-str' } },
      { type: 'tool_arguments', payload: { tool_id: 'qt-str', arguments: '{"command":"pwd"}' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'str-1',
        session: async () => ({ ws_host: strFake.wsHost, id_token: 't', actor_arn: 'arn:s', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const tools = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'where am i' }], tools },
      outpostMgr: mgr, options: { identity: 'str-acct', log: () => {} },
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    assert.equal(j.choices[0].message.tool_calls[0].function.name, 'Bash')
    assert.equal(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).command, 'pwd')
  } finally {
    await strFake.close()
  }
})

test('thread reuse survives token refresh when session has email but no actor_arn', async () => {
  let tok = 'tok-v1'
  const sessions = createSessionStore()
  const mgr = {
    ensure: async () => ({
      outpostId: async () => 'cred-1',
      session: async () => ({ ws_host: fake.wsHost, id_token: tok, actor_arn: '', email: 'u@x.com', aws_account_id: '123', usable_until: Math.floor(Date.now() / 1000) + 600 }),
    }),
  }
  const r1 = await handleChatCompletions({
    body: { model: 'fast', messages: [{ role: 'user', content: 'turn one' }] },
    outpostMgr: mgr, sessions, options: { identity: 'cred-acct', log: () => {} },
  })
  const j1 = await r1.json()
  tok = 'tok-v2'
  const r2 = await handleChatCompletions({
    body: {
      model: 'fast',
      messages: [
        { role: 'user', content: 'turn one' },
        { role: 'assistant', content: j1.choices[0].message.content },
        { role: 'user', content: 'turn two' },
      ],
    },
    outpostMgr: mgr, sessions, options: { identity: 'cred-acct', log: () => {} },
  })
  assert.equal(r2.status, 200)
  await r2.json()
  const msgs = fake.state.userMessages
  assert.equal(msgs.at(-1).threadId, msgs.at(-2).threadId)
  assert.equal(msgs.at(-1).payload.text, 'turn two')
})

test('enormous tool descriptions fall back to names-only preamble instead of dropping tools', async () => {
  const tools = Array.from({ length: 180 }, (_, i) => ({
    type: 'function',
    function: {
      name: `mega_tool_${i}`,
      description: 'D'.repeat(600),
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    },
  }))
  const res = await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'S'.repeat(30 * 1024) },
      { role: 'user', content: 'USER_PROMPT_SURVIVES' },
    ],
    tools,
  })
  assert.equal(res.status, 200)
  await res.json()
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.text.includes('USER_PROMPT_SURVIVES'))
  assert.ok(p.text.includes('Tools provided by the client (names only):'))
  assert.ok(p.text.includes('mega_tool_0'))
  assert.ok(p.text.includes('mega_tool_179'))
})

test('transport status events (e.g. unknown_message_type) are logged instead of polluting content', async () => {
  const statusFake = await startFakeQuick({
    script: () => [
      { type: 'status', payload: { status: 'unknown_message_type' } },
      { type: 'text_delta', payload: { delta: '{"ok":true}' } },
      { type: 'message_complete', payload: { text: '{"ok":true}' } },
    ],
  })
  try {
    const logs = []
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'st-1',
        session: async () => ({ ws_host: statusFake.wsHost, id_token: 't', actor_arn: 'arn:st', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'json' }] },
      outpostMgr: mgr,
      options: { identity: 'st-acct', log: (l) => logs.push(l) },
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.choices[0].message.content, '{"ok":true}')
    assert.ok(logs.some((l) => l.includes('unknown_message_type')))
  } finally {
    await statusFake.close()
  }
})

test('reused thread keeps custom_prompt when small, omits it when a 36KB tool_result needs the frame', async () => {
  const sessions = createSessionStore()
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
  const sys = { role: 'system', content: 'A'.repeat(28 * 1024) }
  const r1 = await req({ model: 'fast', tools, messages: [sys, { role: 'user', content: 'read big file' }] }, { sessions })
  const j1 = await r1.json()
  // Small follow-up keeps custom_prompt for salience + cache warmth, while still using short tool reminder.
  const r2 = await req({
    model: 'fast',
    tools,
    messages: [
      sys,
      { role: 'user', content: 'read big file' },
      { role: 'assistant', content: j1.choices[0].message.content },
      { role: 'user', content: 'short follow-up' },
    ],
  }, { sessions })
  const j2 = await r2.json()
  const p2 = fake.state.userMessages.at(-1).payload
  assert.ok(p2.custom_prompt.includes('A'.repeat(100)))
  assert.ok(p2.text.includes('still active'))

  // Huge 52KB single tool_result on turn 3 triggers omitting custom_prompt and uses full ~59KB frame.
  const bigBody = 'Z'.repeat(52 * 1024)
  const r3 = await req({
    model: 'fast',
    tools,
    messages: [
      sys,
      { role: 'user', content: 'read big file' },
      { role: 'assistant', content: j1.choices[0].message.content },
      { role: 'user', content: 'short follow-up' },
      { role: 'assistant', content: j2.choices[0].message.content },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: bigBody },
    ],
  }, { sessions })
  assert.equal(r3.status, 200)
  const j3 = await r3.json()
  const p3 = fake.state.userMessages.at(-1).payload
  assert.equal(p3.custom_prompt, undefined) // yielded frame room to the 52KB tool_result
  assert.ok(p3.text.includes('still active'))
  assert.ok(p3.text.includes(bigBody), '52KB single tool_result fits untruncated on reused thread')
  assert.ok(!j3.choices[0].message.content.includes('64KB'))

  // Parallel tool_results (2 × 25KB) on turn 4 also fit untruncated via water-filling instead of 16KB cap.
  const fileA = 'M'.repeat(25 * 1024)
  const fileB = 'N'.repeat(25 * 1024)
  const r4 = await req({
    model: 'fast',
    tools,
    messages: [
      sys,
      { role: 'user', content: 'read big file' },
      { role: 'assistant', content: j1.choices[0].message.content },
      { role: 'user', content: 'short follow-up' },
      { role: 'assistant', content: j2.choices[0].message.content },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: bigBody },
      { role: 'assistant', content: j3.choices[0].message.content },
      { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: fileA },
      { role: 'tool', tool_call_id: 'c3', name: 'read_file', content: fileB },
    ],
  }, { sessions })
  assert.equal(r4.status, 200)
  const j4 = await r4.json()
  const p4 = fake.state.userMessages.at(-1).payload
  assert.equal(p4.custom_prompt, undefined)
  assert.ok(p4.text.includes(fileA), 'first 25KB parallel tool_result fits untruncated')
  assert.ok(p4.text.includes(fileB), 'second 25KB parallel tool_result fits untruncated')
  assert.ok(!j4.choices[0].message.content.includes('64KB'))
})

test('internal tool preamble downgrade to compact signatures surfaces 64KB truncation note', async () => {
  // 50 tools with 18 properties each exceed PREAMBLE_CAP (36KB) in full JSON
  // schema (~52KB) while compact signatures stay ~18KB (well under textCap - 8KB),
  // so only buildToolPreamble's internal downgrade triggers stats.truncated.
  const tools = Array.from({ length: 50 }, (_, i) => ({
    type: 'function',
    function: {
      name: `verbose_tool_${i}`,
      description: `does work ${i}`,
      parameters: {
        type: 'object',
        required: ['param_0'],
        properties: Object.fromEntries(Array.from({ length: 18 }, (_, j) => [`param_${j}`, { type: 'string', minLength: 1, maxLength: 100 }])),
      },
    },
  }))
  const res = await req({
    model: 'fast',
    messages: [{ role: 'user', content: 'use a tool' }],
    tools,
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  const sent = fake.state.userMessages.at(-1).payload.text
  assert.ok(sent.includes('compact signatures'))
  assert.match(j.choices[0].message.content, /64KB/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick } from './helpers/fake-quick.mjs'
import { QuickSocket, QuickWsError, classifyErrorKind } from '../lib/quickws.mjs'

test('classifyErrorKind maps auth, quota, and missing_thread errors', () => {
  assert.equal(classifyErrorKind('UnauthorizedException', 'nope'), 'auth')
  assert.equal(classifyErrorKind('', 'expired token'), 'auth')
  assert.equal(classifyErrorKind('ThrottlingException', 'slow down'), 'quota')
  assert.equal(classifyErrorKind('', 'Rate limit exceeded'), 'quota')
  assert.equal(classifyErrorKind('ThreadNotFoundException', ''), 'missing_thread')
  assert.equal(classifyErrorKind('', 'Thread does not exist'), 'missing_thread')
  assert.equal(classifyErrorKind('Other', 'boom', 'stream'), 'stream')
})

test('QuickSocket keeps active concurrent turn alive when a second turn arrives with a rotated token', async () => {
  let releaseFirst
  const firstReady = new Promise((r) => { releaseFirst = r })
  const fake = await startFakeQuick({
    script: async (payload) => {
      if (payload.text === 'first') {
        await firstReady
        return [
          { type: 'text_delta', payload: { delta: 'ans-1' } },
          { type: 'message_complete', payload: { text: 'ans-1' } },
        ]
      }
      return [
        { type: 'text_delta', payload: { delta: 'ans-2' } },
        { type: 'message_complete', payload: { text: 'ans-2' } },
      ]
    },
  })
  const sock = new QuickSocket({
    getSession: async () => ({ ws_host: fake.wsHost, id_token: 'tok-1' }),
    outpostId: 'dev-1',
    log: () => {},
  })
  try {
    const collect = async (threadId, text, session) => {
      let out = ''
      for await (const evt of sock.turn(threadId, { text, agent_mode: 'fast' }, { session })) {
        if (evt.type === 'text_delta') out += evt.payload.delta
      }
      return out
    }
    const p1 = collect('t1', 'first', { ws_host: fake.wsHost, id_token: 'tok-1' })
    // Wait briefly until first turn is registered and in-flight.
    await new Promise((r) => setTimeout(r, 30))
    const p2 = collect('t2', 'second', { ws_host: fake.wsHost, id_token: 'tok-2' })
    assert.equal(await p2, 'ans-2')
    releaseFirst()
    assert.equal(await p1, 'ans-1')
    // Must not have torn down the socket mid-turn.
    assert.equal(fake.state.connections, 1)

    // Once idle, a new turn with tok-2 rotates the connection cleanly.
    const ans3 = await collect('t3', 'third', { ws_host: fake.wsHost, id_token: 'tok-2' })
    assert.equal(ans3, 'ans-2')
    assert.equal(fake.state.connections, 2)
  } finally {
    await sock.close()
    await fake.close()
  }
})

test('QuickSocket disconnects zombie socket on silent idle timeout and reconnects on next turn', async () => {
  let count = 0
  const fake = await startFakeQuick({
    script: (payload) => {
      count++
      if (count === 1) return new Promise(() => {}) // simulate silent stall
      return [
        { type: 'text_delta', payload: { delta: `ok:${payload.text}` } },
        { type: 'message_complete', payload: { text: `ok:${payload.text}` } },
      ]
    },
  })
  const sock = new QuickSocket({
    getSession: async () => ({ ws_host: fake.wsHost, id_token: 'tok-1' }),
    outpostId: 'dev-2',
    extra: { idleMs: 150 },
    log: () => {},
  })
  try {
    await assert.rejects(async () => {
      for await (const _evt of sock.turn('t1', { text: 'stall', agent_mode: 'fast' })) {}
    }, (err) => err instanceof QuickWsError && err.kind === 'timeout')

    let text = ''
    for await (const evt of sock.turn('t2', { text: 'recovered', agent_mode: 'fast' })) {
      if (evt.type === 'text_delta') text += evt.payload.delta
    }
    assert.equal(text, 'ok:recovered')
    assert.equal(fake.state.connections, 2) // zombie socket was torn down and reconnected
  } finally {
    await sock.close()
    await fake.close()
  }
})

test('QuickSocket classifies handshake and stream error frames with code + kind', async () => {
  const sock = new QuickSocket({
    getSession: async () => ({ ws_host: 'ws://127.0.0.1:1', id_token: 't' }),
    outpostId: 'dev-3',
    log: () => {},
  })
  let caught
  sock._sessionFail = (e) => { caught = e }
  sock._dispatch({ type: 'error', code: 'UnauthorizedException', message: 'expired token' })
  assert.ok(caught instanceof QuickWsError)
  assert.equal(caught.kind, 'auth')
  assert.equal(caught.code, 'UnauthorizedException')
  assert.match(caught.message, /expired token/)
})

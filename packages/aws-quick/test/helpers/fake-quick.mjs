// Minimal dependency-free Quick bidi-WS fake for tests.
//
// Speaks just enough of the wire protocol for lib/quickws.mjs:
//   - HTTP Upgrade handshake + RFC6455 frame codec (masked client frames in,
//     unmasked binary frames out; replies to ping, honors close)
//   - server→client AWS event-stream messages (:event-type=rawOutputEvent,
//     JSON body {payload: base64(inner event)})
//   - client→server rawInputEvent binary frames ({payload:{payload:b64(inner)}})
//
// Behavior: on session_connect → session_established + connected; on
// user_message → runs `script(userPayload)` which returns an array of inner
// events ({type, payload, thread_id?}) emitted in order, then closes the turn.
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const te = new TextEncoder()
const td = new TextDecoder()
const b64e = (s) => Buffer.from(s, 'utf8').toString('base64')
const b64d = (s) => Buffer.from(s, 'base64').toString('utf8')

// ---------- event-stream encoder (server→client) ----------
function esHeader(name, value) {
  const nb = te.encode(name)
  const vb = te.encode(value)
  const out = new Uint8Array(1 + nb.length + 1 + 2 + vb.length)
  out[0] = nb.length
  out.set(nb, 1)
  out[1 + nb.length] = 7 // STRING
  out[2 + nb.length] = (vb.length >> 8) & 0xff
  out[3 + nb.length] = vb.length & 0xff
  out.set(vb, 4 + nb.length)
  return out
}

export function esEncode(innerEventJson, { threadId, messageId } = {}) {
  const inner = { ...JSON.parse(innerEventJson) }
  if (threadId && inner.thread_id === undefined) inner.thread_id = threadId
  if (messageId && inner.message_id === undefined) inner.message_id = messageId
  const body = te.encode(JSON.stringify({ payload: b64e(JSON.stringify(inner)) }))
  const headers = [
    esHeader(':message-type', 'event'),
    esHeader(':event-type', 'rawOutputEvent'),
    esHeader(':content-type', 'application/json'),
  ]
  const headersLen = headers.reduce((n, h) => n + h.length, 0)
  const total = 12 + headersLen + body.length + 4
  const msg = new Uint8Array(total)
  const dv = new DataView(msg.buffer)
  dv.setUint32(0, total, false)
  dv.setUint32(4, headersLen, false)
  // bytes 8..12 = prelude CRC, last 4 = message CRC — decoder ignores them
  let off = 12
  for (const h of headers) { msg.set(h, off); off += h.length }
  msg.set(body, off)
  return msg
}

// ---------- WS frame codec ----------
function wsEncode(payload, opcode = 2) {
  const data = typeof payload === 'string' ? te.encode(payload) : payload
  const len = data.length
  let header
  if (len < 126) {
    header = new Uint8Array(2)
    header[1] = len
  } else if (len < 65536) {
    header = new Uint8Array(4)
    header[1] = 126
    new DataView(header.buffer).setUint16(2, len)
  } else {
    header = new Uint8Array(10)
    header[1] = 127
    new DataView(header.buffer).setUint32(2, Math.floor(len / 2 ** 32))
    new DataView(header.buffer).setUint32(6, len >>> 0)
  }
  header[0] = 0x80 | opcode
  const out = new Uint8Array(header.length + len)
  out.set(header)
  out.set(data, header.length)
  return out
}

/**
 * Start a fake Quick bidi endpoint.
 * @param {object} opts
 * @param {(payload:object, meta:{threadId:string}) => Array<object>|Promise<Array<object>>} opts.script
 *        maps a user_message payload → inner events to emit (may be async)
 * @param {object} [opts.session] overrides for the sncs-session fields the WS layer sees
 */
export async function startFakeQuick({ script, session } = {}) {
  const state = {
    connections: 0,
    urls: [],
    userMessages: [],   // decoded user_message payloads, in order
    sessionConnects: [],
    federate: 0,
    toolResults: [],
    pings: 0,
  }
  const sockets = new Set()

  const server = createServer((socket) => {
    sockets.add(socket)
    let reqBuf = Buffer.alloc(0)
    let upgraded = false
    let buf = Buffer.alloc(0)
    const sendEs = (inner, threadId) => {
      try { socket.write(wsEncode(esEncode(JSON.stringify(inner), { threadId }))) } catch {}
    }
    socket.on('data', (chunk) => {
      if (!upgraded) {
        reqBuf = Buffer.concat([reqBuf, chunk])
        const end = reqBuf.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = reqBuf.subarray(0, end).toString('latin1')
        const url = /^GET\s+(\S+)\s+HTTP\/1\.1/i.exec(head)?.[1] || ''
        const key = /^sec-websocket-key:\s*(.+)$/im.exec(head)?.[1]?.trim()
        if (!key) { socket.destroy(); return }
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
        socket.setNoDelay(true)
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        upgraded = true
        state.connections++
        state.urls.push(url)
        const extra = reqBuf.subarray(end + 4)
        reqBuf = Buffer.alloc(0)
        if (!extra.length) return
        chunk = extra
      }
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = takeFrames(buf)
      buf = rest
      for (const f of frames) handleFrame(f)
    })
    function takeFrames(b) {
      const frames = []
      let pos = 0
      while (pos + 2 <= b.length) {
        const head = b[pos]
        const op = head & 0x0f
        const masked = (b[pos + 1] & 0x80) !== 0
        let len = b[pos + 1] & 0x7f
        let off = pos + 2
        if (len === 126) { if (off + 2 > b.length) break; len = (b[off] << 8) | b[off + 1]; off += 2 }
        else if (len === 127) { if (off + 8 > b.length) break; len = Number(new DataView(b.buffer, b.byteOffset + off).getBigUint64(0)); off += 8 }
        let mask = null
        if (masked) { if (off + 4 > b.length) break; mask = b.slice(off, off + 4); off += 4 }
        if (off + len > b.length) break
        let payload = b.slice(off, off + len)
        if (mask) {
          const un = Buffer.alloc(len)
          for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3]
          payload = un
        }
        frames.push({ op, payload })
        pos = off + len
      }
      return { frames, rest: b.slice(pos) }
    }
    function handleFrame({ op, payload }) {
        if (op === 0x9) { try { socket.write(wsEncode(payload, 0xa)) } catch {} return } // ping→pong
        if (op === 0x8) { try { socket.write(wsEncode(Buffer.alloc(0), 0x8)) } catch {} socket.end(); return }
        if (op !== 0x1 && op !== 0x2) return
        let msg
        try { msg = JSON.parse(td.decode(payload)) } catch { return }
        const innerB64 = msg?.payload?.payload
        if (!innerB64) return
        let inner
        try { inner = JSON.parse(b64d(innerB64)) } catch { return }
        const t = inner.type
        if (t === 'session_connect') {
          state.sessionConnects.push(inner.payload || {})
          sendEs({ type: 'session_established', payload: {} })
          sendEs({ type: 'connected', payload: {} })
          return
        }
        if (t === 'federate_status') { state.federate++; return }
        if (t === 'ping') {
          state.pings++
          sendEs({ type: 'status', payload: { status: 'pong', timestamp: Date.now() } })
          return
        }
        if (t === 'tool_result') {
          const p = inner.payload || {}
          state.toolResults.push(p)
          const reply = script
            ? script(p, { type: 'tool_result' })
            : [{ type: 'text_delta', payload: { delta: 'done' } }, { type: 'message_complete', payload: { text: 'done' } }]
          Promise.resolve(reply).then((events) => {
            const list = Array.isArray(events) ? events : []
            for (const ev of list) sendEs(ev, ev.thread_id)
          }).catch(() => {})
          return
        }
        if (t === 'user_message') {
          const p = inner.payload || {}
          const threadId = p.thread_id || ''
          state.userMessages.push({ threadId, payload: p })
          Promise.resolve(script ? script(p, { threadId }) : defaultScript(p)).then((events) => {
            const list = Array.isArray(events) ? events : []
            for (const ev of list) sendEs(ev, threadId || ev.thread_id)
          }).catch(() => {})
        }
    }
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    wsHost: `ws://127.0.0.1:${port}`,
    state,
    /** inner events for a plain user_message: deltas → complete → turn_completed */
    async close() {
      for (const s of sockets) { try { s.destroy() } catch {} }
      await new Promise((r) => server.close(r))
    },
  }
}

/** Default canned reply: echoes a marker, emits usage + completion. */
export function defaultScript(payload) {
  const reply = `echo:${String(payload?.text ?? '').slice(0, 40)}`
  const mid = payload?.message_id || randomUUID()
  const tid = payload?.thread_id
  return [
    { type: 'message_start', payload: { message_id: mid } },
    { type: 'text_delta', payload: { delta: reply.slice(0, Math.ceil(reply.length / 2)), kernel_thread_id: 'home' } },
    { type: 'text_delta', payload: { delta: reply.slice(Math.ceil(reply.length / 2)), kernel_thread_id: 'home' } },
    { type: 'turn_usage', payload: { input_tokens: 11, output_tokens: 7, cache_read_tokens: 3, total_tokens: 21, model: 'fake-model', resolved_model_id: 'fake-resolved' } },
    { type: 'text_complete', payload: { text: reply, message_id: mid } },
    { type: 'message_complete', payload: { text: reply, message_id: mid, tool_calls: [], kernel_thread_id: 'home', initiator: 'user' } },
    // real transport sends no turn_completed; runs_updated/task_list_update noise may follow
    { type: 'runs_updated', payload: { thread_id: tid, affects_needs_input: false }, thread_id: '' },
  ]
}

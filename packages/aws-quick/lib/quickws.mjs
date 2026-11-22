// Amazon Quick chat bidi WebSocket client (social/AIDP transport).
//
// Wire protocol (reverse-engineered from the desktop renderer, v1.2.4660):
//   URL: wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
//        ?surfaceType=<surface>&token=<id_token>&outpostId=<id>
//        &workingSessionId=<uuid>&channel=<beta|prod>
//   out: binary frame = UTF8 JSON {"eventType":"rawInputEvent",
//        "payload":{"payload":base64(utf8({"type":…,"payload":{…}}))}}
//   in:  AWS event-stream frames; :event-type=rawOutputEvent,
//        body = JSON {"payload":base64(utf8({"type":…,"thread_id":…,"payload":{…}}))}
//
// Events observed: session_established, connected, status, message_start,
// text_delta, thinking_delta, turn_usage, text_complete, message_complete,
// task_list_update, runs_updated, title_generated, keepalive.
import { APP_VERSION, PING_MS, SURFACE, clientFields } from './desktop.mjs'

const te = new TextEncoder()
const td = new TextDecoder()

// ---- AWS event-stream framing (port of the app's esDrain) ----
const HV = { BOOL_TRUE: 0, BOOL_FALSE: 1, BYTE: 2, SHORT: 3, INT: 4, LONG: 5, BYTES: 6, STRING: 7, TIMESTAMP: 8, UUID: 9 }

// Events with no thread id are session-wide. Content events are not fanned
// out across concurrent turns — that mixes two answers together.
const SESSION_EVENTS = new Set([
  'session_established', 'connected', 'keepalive', 'status', 'error',
  'federate_status', 'ping', 'pong',
])

function esDrain(buffer) {
  const messages = []
  const n = buffer.length
  let pos = 0
  while (pos + 16 <= n) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos)
    const totalLen = view.getUint32(0, false)
    if (totalLen < 16 || totalLen > 16 * 1024 * 1024) { pos += 1; continue }
    if (pos + totalLen > n) break
    const headersLen = view.getUint32(4, false)
    if (headersLen > totalLen - 16) { pos += totalLen; continue }
    const hstart = pos + 12
    const hend = hstart + headersLen
    const headers = {}
    let j = hstart
    try {
      while (j < hend) {
        const nl = buffer[j++]
        if (j + nl + 1 > hend) break
        const name = td.decode(buffer.subarray(j, j + nl)); j += nl
        const vt = buffer[j++]
        if (vt === HV.BOOL_TRUE) headers[name] = true
        else if (vt === HV.BOOL_FALSE) headers[name] = false
        else if (vt === HV.BYTE) { if (j + 1 > hend) break; headers[name] = buffer[j]; j += 1 }
        else if (vt === HV.SHORT) { if (j + 2 > hend) break; headers[name] = (buffer[j] << 8) | buffer[j + 1]; j += 2 }
        else if (vt === HV.INT) { if (j + 4 > hend) break; headers[name] = new DataView(buffer.buffer, buffer.byteOffset + j).getUint32(0, false); j += 4 }
        else if (vt === HV.LONG || vt === HV.TIMESTAMP) {
          if (j + 8 > hend) break
          let v = 0; for (let k = 0; k < 8; k++) v = v * 256 + buffer[j + k]
          headers[name] = v; j += 8
        } else if (vt === HV.BYTES || vt === HV.STRING) {
          if (j + 2 > hend) break
          const l = (buffer[j] << 8) | buffer[j + 1]; j += 2
          if (j + l > hend) break
          const raw = buffer.subarray(j, j + l); j += l
          headers[name] = vt === HV.STRING ? td.decode(raw) : raw.slice()
        } else if (vt === HV.UUID) { if (j + 16 > hend) break; headers[name] = buffer.slice(j, j + 16); j += 16 }
        else break
      }
      const payload = buffer.slice(hend, pos + totalLen - 4)
      messages.push({ headers, payload })
    } catch { /* malformed — skip */ }
    pos += totalLen
  }
  return { messages, consumed: pos }
}

const b64e = (s) => Buffer.from(s, 'utf8').toString('base64')
const b64d = (s) => Buffer.from(s, 'base64').toString('utf8')

function wrapEvent(innerJson) {
  return te.encode(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: b64e(innerJson) } }))
}

export class QuickWsError extends Error {
  constructor(message, { code, kind } = {}) {
    super(message)
    this.name = 'QuickWsError'
    this.code = code
    this.kind = kind || 'ws'
  }
}

/** Map Quick error codes / messages onto handler HTTP error kinds. */
export function classifyErrorKind(code, detail, fallback = 'stream') {
  const c = String(code ?? '')
  const d = String(detail ?? '')
  if (/^(ThreadNotFound(Exception)?|thread_not_found)$/i.test(c) || /^thread (not found|does not exist)\b/i.test(d)) return 'missing_thread'
  if (/^(Throttling(Exception)?|TooManyRequests(Exception)?|RateLimit(Exceeded)?|429)$/i.test(c) || /\b(throttl|too many requests|rate limit)/i.test(d)) return 'quota'
  if (/^(Unauthorized(Exception)?|Unauthenticated(Exception)?|AccessDenied(Exception)?|401)$/i.test(c) || /\b(unauthorized|unauthenticated|expired token|invalid token)\b/i.test(d)) return 'auth'
  return fallback
}

const aborted = () => new QuickWsError('aborted', { kind: 'abort' })

// A caller may cancel its wait while other turns still need the shared startup.
export function withAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const CONNECT_TIMEOUT_MS = 30_000
const ACK_TIMEOUT_MS = 20_000
const IDLE_TIMEOUT_MS = 90_000

/**
 * One bidi socket, multiplexed across threads by thread_id.
 * Events are dispatched to per-thread waiters registered via turn().
 */
export class QuickSocket {
  /**
   * @param {object} opts
   * @param {Function} opts.getSession async () => sncs-session object (fresh token)
   * @param {string} opts.outpostId device/outpost id
   * @param {object} [opts.extra] surfaceType/appVersion/channel overrides
   * @param {Function} [opts.log]
   */
  constructor({ getSession, outpostId, extra = {}, log = () => {} }) {
    this.getSession = getSession
    this.outpostId = outpostId || ''
    this.extra = extra
    this.log = log
    // Desktop rl() is one UUID for the life of the renderer, including reconnects.
    this.workingSessionId = extra.workingSessionId || crypto.randomUUID()
    this.ws = null
    this.buf = new Uint8Array(0)
    this.waiters = new Map() // threadId -> {resolve events queue}
    this.connecting = null
    this.closed = false
    this.lastActivity = 0
    this._rxCount = 0
  }

  async connect(session) {
    const sess = session ?? await this.getSession()
    while (this.connecting) await this.connecting
    if (this.closed) throw new QuickWsError('socket closed')
    if (this.ws?.readyState === 1) {
      if (sess?.id_token === this._token && sess?.ws_host === this._host) return this.ws
      // Do not tear down an already-authenticated socket while concurrent turns
      // are streaming on the same tenant; rotated tokens take effect once idle.
      if (sess?.ws_host === this._host && this.waiters.size > 0) return this.ws
    }
    if (this.ws) this._disconnect(4001, 'session changed')
    this.connecting = this._connect(sess).finally(() => { this.connecting = null })
    return this.connecting
  }

  async _connect(sess) {
    if (!sess?.ws_host || !sess?.id_token) throw new QuickWsError('sncs-session 缺少 ws_host/id_token', { kind: 'auth' })
    // ws_host is normally a bare hostname (→ wss); tests/local gateways may hand
    // us a full ws:// or wss:// base already.
    const base = /^wss?:\/\//.test(sess.ws_host) ? sess.ws_host.replace(/\/+$/, '') : `wss://${sess.ws_host}`
    const surface = this.extra.surfaceType || SURFACE
    // Desktop appends channel only for the literal values beta and prod.
    const channel = this.extra.channel ?? 'prod'
    const channelQs = channel === 'beta' || channel === 'prod' ? `&channel=${encodeURIComponent(channel)}` : ''
    const url =
      `${base}/streaming/quickwork-chat-bidirectional-stream` +
      `?surfaceType=${encodeURIComponent(surface)}` +
      `&token=${encodeURIComponent(sess.id_token)}` +
      `&outpostId=${encodeURIComponent(this.outpostId || '')}` +
      `&workingSessionId=${encodeURIComponent(this.workingSessionId)}` +
      channelQs +
      (this.extra.agentRuntimeArnOverride ? `&agentRuntimeArnOverride=${encodeURIComponent(this.extra.agentRuntimeArnOverride)}` : '')
    this.log(`[ws] connecting ${base}/…`)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.buf = new Uint8Array(0)

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new QuickWsError('WebSocket 连接超时', { kind: 'timeout' })), CONNECT_TIMEOUT_MS)
        timer.unref?.()
        ws.onopen = () => { clearTimeout(timer); this.lastActivity = Date.now(); resolve() }
        ws.onerror = () => { clearTimeout(timer); reject(new QuickWsError('WebSocket 连接失败', { kind: 'ws' })) }
        ws.onclose = (e) => {
          clearTimeout(timer)
          const err = new QuickWsError(`socket closed ${e.code}`, { code: e.code })
          if (this.ws === ws) {
            this.ws = null
            this._stopPing()
            this._sessionFail?.(err)
            this._failAll(err)
          }
          reject(err)
        }
        ws.onmessage = (ev) => { if (this.ws === ws) this._onFrame(ev) }
      })
      if (this.ws !== ws) throw new QuickWsError('socket closed during handshake')
    const fields = clientFields({
      surfaceType: surface,
      appVersion: this.extra.appVersion || APP_VERSION,
      outpostId: this.outpostId || '',
    })
    this._clientFields = fields
    // Desktop order: session_connect, then federate_status, then the ping timer.
    this._token = sess.id_token
    this._host = sess.ws_host
    this._sendRaw({ type: 'session_connect', payload: { actor_id: sess.actor_arn || '', ...fields } })
    this._sendRaw({ type: 'federate_status', payload: {} })
    // user_message sent before session_established is dropped, and the turn
    // would then wait forever. Fail the connect instead of sending blind.
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          this._sessionAck = null
          this._sessionFail = null
          reject(new QuickWsError('会话没有在时限内建立', { kind: 'timeout' }))
        }, this.extra.ackMs || ACK_TIMEOUT_MS)
        t.unref?.()
        this._sessionAck = () => { clearTimeout(t); this._sessionAck = null; this._sessionFail = null; resolve() }
        this._sessionFail = (err) => { clearTimeout(t); this._sessionAck = null; this._sessionFail = null; reject(err) }
      })
    } catch (e) {
      if (this.ws === ws) this._disconnect(4000, 'handshake failed')
      throw e
    }
    this._startPing()
    this.log('[ws] open')
    return ws
  }

  _startPing() {
    this._stopPing()
    this._pingTimer = setInterval(() => {
      try { this._sendRaw({ type: 'ping', payload: { timestamp: Date.now() } }) } catch {}
    }, PING_MS)
    this._pingTimer.unref?.()
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null }
  }

  _sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new QuickWsError('socket not open', { kind: 'ws' })
    this.ws.send(wrapEvent(JSON.stringify(obj)))
  }

  send(obj) { this._sendRaw(obj) }

  _onFrame(ev) {
    this.lastActivity = Date.now()
    try {
      const data = typeof ev.data === 'string'
        ? te.encode(ev.data)
        : ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : ArrayBuffer.isView(ev.data)
            ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
            : new Uint8Array(ev.data?.buffer ?? ev.data)
      let merged = data
      if (this.buf.length) {
        merged = new Uint8Array(this.buf.length + data.length)
        merged.set(this.buf)
        merged.set(data, this.buf.length)
      }
      const { messages, consumed } = esDrain(merged)
      this.buf = merged.slice(consumed)
      for (const m of messages) this._onEsMessage(m)
    } catch (e) {
      this.log(`[ws] frame decode error: ${e.message}`)
    }
  }

  _onEsMessage(m) {
    const mt = m.headers[':message-type']
    if (mt === 'error' || mt === 'exception') {
      const code = m.headers[':error-code'] || m.headers[':exception-type'] || 'error'
      const msg = m.headers[':error-message'] || td.decode(m.payload).slice(0, 300)
      this.log(`[ws] error frame ${code}: ${msg}`)
      this._dispatch({ type: 'error', code: String(code), message: String(msg).slice(0, 500) })
      return
    }
    if (m.headers[':event-type'] !== 'rawOutputEvent' || m.payload.length === 0) return
    let outer
    try { outer = JSON.parse(td.decode(m.payload)) } catch { return }
    const inner = outer?.payload ? b64d(outer.payload) : null
    if (!inner) return
    let evt
    try { evt = JSON.parse(inner) } catch { return }
    this._dispatch(evt)
  }

  _dispatch(evt) {
    if (evt?.type !== 'session_established' && evt?.type !== 'connected') this._rxCount++
    if (evt?.type === 'error' && this._sessionFail) {
      const detail = String(evt.payload?.message || evt.payload?.error || evt.message || 'session rejected')
      const code = String(evt.payload?.code || evt.code || '')
      this._sessionFail(new QuickWsError(detail, { code, kind: classifyErrorKind(code, detail, 'ws') }))
      return
    }
    if ((evt.type === 'session_established' || evt.type === 'connected') && this._sessionAck) {
      this._sessionAck()
    }
    const tid = evt.thread_id || evt.payload?.thread_id || ''
    if (tid) {
      this.waiters.get(tid)?.push(evt)
      return
    }
    // One in-flight turn can take unscoped events. Several turns must not
    // share a text_delta that forgot its thread id.
    if (this.waiters.size === 1) {
      this.waiters.values().next().value.push(evt)
      return
    }
    if (SESSION_EVENTS.has(evt.type)) {
      for (const w of this.waiters.values()) w.push(evt)
    }
  }

  _failAll(err) {
    for (const w of this.waiters.values()) w.fail(err)
    this.waiters.clear()
  }

  /**
   * Run one chat turn on threadId; sends {type:'user_message'} then yields every
   * decoded event routed to that thread until a terminal event
   * (message_complete / text_complete / error) or failure.
   * @param {string} threadId
   * @param {object} payload user_message payload fields (text, agent_mode, …)
   * @param {object} [opts] {signal, onEvent, frame}
   *        frame replaces the user_message (used to return a tool_result).
   */
  async *turn(threadId, payload, { signal, onEvent, frame, session } = {}) {
    if (signal?.aborted) throw aborted()
    const ws = await withAbort(this.connect(session), signal)
    if (signal?.aborted) throw aborted()
    if (this.ws !== ws) throw new QuickWsError('socket changed before turn')
    if (this.waiters.has(threadId)) throw new QuickWsError(`thread ${threadId} already has an active turn`, { kind: 'busy' })
    const q = []
    let failed = null
    let notify = null
    const waiter = {
      push: (evt) => { q.push(evt); const n = notify; notify = null; n?.() },
      fail: (err) => { if (!failed) failed = err; const n = notify; notify = null; n?.() },
    }
    this.waiters.set(threadId, waiter)
    const idleMs = this.extra.idleMs || IDLE_TIMEOUT_MS
    let idle
    const armIdle = () => {
      clearTimeout(idle)
      const armedRx = this._rxCount
      idle = setTimeout(() => {
        const err = new QuickWsError(`Quick 超过 ${Math.round(idleMs / 1000)} 秒没有下行，连接可能已中断`, { kind: 'timeout' })
        waiter.fail(err)
        // If zero frames arrived across the whole socket while waiting (not
        // even keepalive/pong), tear down the zombie socket so the next turn
        // reconnects cleanly instead of hanging again.
        if (this.ws === ws && this._rxCount === armedRx) {
          if (this.waiters.get(threadId) === waiter) this.waiters.delete(threadId)
          this._disconnect(4002, 'idle timeout')
        }
      }, idleMs)
      idle.unref?.()
    }
    const onAbort = () => waiter.fail(new QuickWsError('aborted', { kind: 'abort' }))
    signal?.addEventListener('abort', onAbort, { once: true })
    const push = waiter.push
    waiter.push = (evt) => { if (!SESSION_EVENTS.has(evt.type)) armIdle(); push(evt) }
    try {
      this.send(frame || {
        type: 'user_message',
        payload: { ...(this._clientFields || {}), ...payload, thread_id: threadId },
      })
      armIdle()
      for (;;) {
        while (q.length) {
          if (signal?.aborted) throw aborted()
          const evt = q.shift()
          onEvent?.(evt)
          yield evt
          const t = evt.type
          const p = evt.payload || {}
          // Turn terminators on this transport (verified against live traffic):
          //  - message_complete WITHOUT payload.continuation_expected===true is
          //    the last assistant message of the turn (the desktop renderer
          //    finalizes on exactly this condition); agentic turns emit one
          //    message_start…message_complete cycle per step and set the flag
          //    on all but the last.
          //  - stream_ended / turn_aborted end the stream/turn outright.
          //  - error / guardrail_blocked / stream_truncated are failures.
          if (t === 'message_complete' && p.continuation_expected !== true) return
          if (t === 'stream_ended') return
          if (t === 'turn_aborted') throw new QuickWsError(p.reason || 'Quick aborted the turn', { kind: 'stream' })
          if (t === 'error' || t === 'guardrail_blocked' || t === 'stream_truncated') {
            const detail = p.message || p.error || p.reason || evt.message || evt.error || evt.reason || evt.code || `stream ${t}`
            const code = String(p.code || evt.code || '')
            throw new QuickWsError(String(detail), { code, kind: t === 'error' ? classifyErrorKind(code, detail, 'stream') : 'stream' })
          }
        }
        if (signal?.aborted) throw new QuickWsError('aborted', { kind: 'abort' })
        if (failed) throw failed
        await new Promise((r) => { notify = r })
      }
    } finally {
      clearTimeout(idle)
      signal?.removeEventListener('abort', onAbort)
      if (this.waiters.get(threadId) === waiter) this.waiters.delete(threadId)
    }
  }

  /** Force a reconnect (e.g. after token refresh). */
  _disconnect(code, reason) {
    this._stopPing()
    const err = new QuickWsError(reason)
    this._sessionFail?.(err)
    this._failAll(err)
    try { this.ws?.close(code, reason) } catch {}
    this.ws = null
  }

  async reconnect() {
    this._disconnect(4001, 'reconnect')
    await this.connecting?.catch(() => {})
    await this.connect()
  }

  async close() {
    this.closed = true
    this._disconnect(1000, 'closed')
  }
}

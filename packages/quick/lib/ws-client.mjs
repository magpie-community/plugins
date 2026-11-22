// The Quick chat WebSocket: the URL, the handshake, the ping, and the
// per-request message stream, all as the web client runs them (captured
// in test/fixtures-*.json).
//
//   wss://quick.aws.com/sn/account/{acct}/wsproxy/service/
//     SpaceNeedleConversationService/operation/ChatBidirectionalStream
//     ?wsproxy-protocol=rpc-v2-cbor&awsAccountId={acct}
//     &surfaceType=WEB_EXPERIENCE&agentServiceType=UNIFIED_QUICK
//     &outpostId=web0&workingSessionId={uuid}&mbtc={csrf}
//
// Cookie auth rides on the browser-level session the account was imported
// with; mbtc is the CSRF token the page gets from quickwork.getMbtc().
//
// Handshake (SEND): session_connect (session_id "") → the server answers
// session_established, then connected. Afterwards every user_message goes
// out with a dock_state_sync companion frame (the web client sends one
// with each message; leaving it off risks being read as a protocol
// anomaly). Pings keep the connection alive.

import crypto from "node:crypto"
import { parseFrame, readFrames, buildMessage } from "./frame.mjs"

const WS_BASE = "wss://quick.aws.com/sn/account"
const PING_MS = 25_000
const OPEN_TIMEOUT_MS = 20_000
const TURN_TIMEOUT_MS = 10 * 60_000

const uuid = () => crypto.randomUUID()

// capabilities declared on session_connect, as the web client lists them
const CAPABILITIES = {
  acp_first_text: 1,
  user_notification: 1,
  subtask_progress: 1,
  external_agent_sign_in: 1,
  recents_promotion: 1,
  self_registering_connectors: 1,
}

export class QuickSocket {
  // account: { accountId, cookie, mbtc, appVersion? }
  constructor(account, opts = {}) {
    this.account = account
    this.pingMs = opts.pingMs ?? PING_MS
    this.openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS
    this.ws = null
    this.pinger = null
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.events = [] // events seen before a waiter takes them
    this.closed = false
    this.workingSessionId = null
  }

  url() {
    const a = this.account
    const q = new URLSearchParams({
      "wsproxy-protocol": "rpc-v2-cbor",
      awsAccountId: a.accountId,
      surfaceType: "WEB_EXPERIENCE",
      agentServiceType: "UNIFIED_QUICK",
      outpostId: "web0",
      workingSessionId: uuid(),
      mbtc: a.mbtc,
    })
    return `${WS_BASE}/${a.accountId}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream?${q}`
  }

  // connect opens the socket and runs the handshake. Rejected on auth
  // failure (the caller marks the account expired) or a dead socket.
  // sessionId re-attaches to an existing server-side conversation (the
  // web client resumes one the same way); without it the handshake opens
  // a fresh conversation.
  async connect(sessionId) {
    const headers = { Cookie: this.account.cookie, Origin: "https://quick.aws.com", "User-Agent": "Mozilla/5.0 (QuickBridge)" }
    const ws = new WebSocket(this.url(), { headers })
    this.ws = ws
    ws.binaryType = "nodebuffer"
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Quick: the chat socket timed out opening")), this.openTimeoutMs)
      ws.once("open", () => { clearTimeout(t); resolve() })
      ws.once("error", (e) => { clearTimeout(t); reject(new Error(`Quick: the chat socket failed: ${e.message}`)) })
      ws.once("close", (code) => { clearTimeout(t); reject(new Error(`Quick: the chat socket closed on connect (code ${code})`)) })
    })
    ws.on("message", (data) => this.#feed(Buffer.from(data)))
    ws.on("close", () => this.#closed())
    ws.on("error", () => this.#closed())
    // the handshake: session_connect, with the caller's session id to
    // resume that conversation or an empty one for a fresh one
    this.send({ type: "session_connect", payload: { session_id: sessionId ?? "", ...CAPABILITIES } })
    const established = await this.#next("session_established", this.openTimeoutMs)
    this.workingSessionId = established?.workingSessionId ?? null
    await this.#next("connected", this.openTimeoutMs)
    this.pinger = setInterval(() => this.send({ type: "ping", payload: { timestamp: Date.now() } }), this.pingMs)
    return this
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("Quick: the chat socket is not open")
    this.ws.send(buildMessage(message.type, message.payload ?? {}))
  }

  // chat runs one turn: it opens a thread id (reusing the caller's for a
  // same-thread continuation), sends the user_message with its
  // dock_state_sync companion, and returns an async iterator of the stream's
  // events (message_start, text_delta, turn_usage, …) up to and including
  // message_complete. The iterator ends when the turn does. An AbortSignal
  // ends it early: the client stops reading and asks the server to stop.
  // incognito mirrors the web client's 无痕模式 (verified on the live
  // page 2026-11-22: the flag rides the user_message payload; the
  // conversation then stays out of the sidebar's recents list).
  async *chat(payload, { signal } = {}) {
    const thread = payload.thread_id ?? uuid()
    const messageId = payload.message_id ?? `msg-${crypto.randomBytes(4).toString("hex")}`
    const traceId = payload.traceId ?? uuid()
    const base = {
      traceId,
      send_origin: "composer",
      had_physical_input: true,
      ...CAPABILITIES,
      message_id: messageId,
      thread_id: thread,
      user_timezone: this.account.timezone ?? "Asia/Shanghai",
      user_locale: this.account.locale ?? "zh-CN",
      custom_prompt: null,
      incognito: payload.incognito ?? true,
      direct_chat: false,
      voice_mode: false,
      voice_id: "matthew",
      tts_speed: 1.1,
      ...payload,
    }
    this.send({ type: "user_message", payload: base })
    this.send({ type: "dock_state_sync", payload: { session_id: thread, files: [], focused_file: "", sidebar_open: false, surfaceType: "WEB_EXPERIENCE" } })
    for await (const e of this.#streamTurn(messageId)) {
      if (signal?.aborted) {
        this.stop(thread)
        return
      }
      yield e
    }
  }

  // stop asks the server to halt the current turn. stop_generation is the
  // control name the web app's own code traces (its RUM metric is
  // "STOP_GENERATION"); whether the server stops metering the turn is
  // unverified. The thread id names the turn to stop.
  stop(threadId) {
    try {
      this.send({ type: "stop_generation", payload: { session_id: threadId ?? "", thread_id: threadId ?? "" } })
    } catch {}
  }

  close() {
    this.closed = true
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
    try { this.ws?.close() } catch {}
    this.#closed()
  }

  // ---- internals -------------------------------------------------------------------------

  #feed(buf) {
    this.buffer = Buffer.concat([this.buffer, buf])
    const { frames, rest } = readFrames(this.buffer)
    this.buffer = Buffer.from(rest)
    for (const f of frames) {
      let body
      try {
        body = parseFrame(f).body
      } catch {
        continue // a bad CRC is dropped, as the client's decoder does
      }
      this.#deliver(body)
    }
  }

  #deliver(body) {
    if (!body || typeof body !== "object") return
    // stream events carry their fields under `payload` (the record's
    // {type, payload:{…}, message_id, …}); flatten them for the relay
    if (typeof body.type === "string" && body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
      body = { ...body.payload, type: body.type, message_id: body.message_id, thread_id: body.thread_id, timestamp: body.timestamp }
    }
    const w = this.waiters.find((x) => x.types === null || x.types.includes(body.type))
    if (w) {
      this.waiters.splice(this.waiters.indexOf(w), 1)
      w.resolve(body)
    } else {
      this.events.push(body)
      if (this.events.length > 500) this.events.shift()
    }
  }

  #next(types, timeoutMs = TURN_TIMEOUT_MS) {
    const list = types === null ? null : Array.isArray(types) ? types : [types]
    const i = this.events.findIndex((e) => list === null || list.includes(e.type))
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { types: list, resolve }
      this.waiters.push(w)
      setTimeout(() => {
        const j = this.waiters.indexOf(w)
        if (j >= 0) {
          this.waiters.splice(j, 1)
          reject(new Error(`Quick: timed out waiting for ${list?.join("/") ?? "the next event"}`))
        }
      }, timeoutMs)
    })
  }

  // the events of one turn, in the captured order, ending at
  // message_complete (the turn's last event)
  async *#streamTurn() {
    const skip = new Set(["keepalive", "status", "ping", "session_established", "connected", "migrationStatus", "selected_spaces_list", "profile_spaces_list", "session_sync", "approval_list", "session_list"])
    for (;;) {
      const e = await this.#next(null)
      if (skip.has(e.type)) continue
      yield e
      if (e.type === "message_complete") return
      if (e.type === "error" || e.type === "usage_limit" || e.type === "turn_duration_exceeded") return
    }
  }

  #closed() {
    if (this.closed) return
    this.closed = true
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
    for (const w of this.waiters.splice(0)) w.reject(new Error("Quick: the chat socket closed"))
  }
}

export { uuid as quickUuid }

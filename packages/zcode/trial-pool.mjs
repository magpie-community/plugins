import { createHash } from "node:crypto"

const abortReason = (signal) => signal?.reason ?? new DOMException("Aborted", "AbortError")

export function trialAccountKey(auth, state) {
  let claims = {}
  try { claims = JSON.parse(Buffer.from(state.jwt.split(".")[1], "base64url").toString()) } catch {}
  const uid = [auth?.uid, state.uid, claims.user_id, claims.userId, claims.sub]
    .find((v) => (typeof v === "string" && v.trim()) || typeof v === "number")
  // A session renewal and a different Trial model must share the same slots.
  const name = typeof auth?.accountId === "string" ? auth.accountId.trim() : ""
  const identity = uid != null ? ["uid", String(uid)] : name ? ["account", name]
    : state.key ? ["key", state.key] : ["anonymous"]
  return createHash("sha256").update(JSON.stringify([state.site, ...identity])).digest("hex")
}

export function waitForTrial(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(abortReason(signal))
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export class TrialPool {
  constructor(limit = 2) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid Trial concurrency")
    this.limit = limit
    this.accounts = new Map()
  }

  setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid Trial concurrency")
    if (limit === this.limit) return
    this.limit = limit
    for (const [key, lane] of this.accounts) this.drain(key, lane)
  }

  acquire(key, signal) {
    signal?.throwIfAborted()
    let lane = this.accounts.get(key)
    if (!lane) this.accounts.set(key, lane = { active: 0, queue: [] })
    return new Promise((resolve, reject) => {
      const ticket = { signal, resolve, reject }
      ticket.abort = () => {
        const i = lane.queue.indexOf(ticket)
        if (i >= 0) lane.queue.splice(i, 1)
        signal?.removeEventListener("abort", ticket.abort)
        this.drain(key, lane)
        reject(abortReason(signal))
      }
      signal?.addEventListener("abort", ticket.abort, { once: true })
      lane.queue.push(ticket)
      if (signal?.aborted) return ticket.abort()
      this.drain(key, lane)
    })
  }

  drain(key, lane) {
    while (lane.active < this.limit && lane.queue.length) {
      const ticket = lane.queue.shift()
      ticket.signal?.removeEventListener("abort", ticket.abort)
      if (ticket.signal?.aborted) {
        ticket.reject(abortReason(ticket.signal))
        continue
      }
      lane.active++
      let freed = false
      ticket.resolve(() => {
        if (freed) return
        freed = true
        lane.active--
        this.drain(key, lane)
      })
    }
    if (!lane.active && !lane.queue.length) this.accounts.delete(key)
  }

  async run(key, signal, forward) {
    const release = await this.acquire(key, signal)
    try {
      signal?.throwIfAborted()
      const response = await forward()
      if (!response.body) {
        release()
        return response
      }
      const held = holdTrialResponse(response, release, signal)
      // A whole JSON reply finishes upstream before the caller reads it.
      // SSE remains streamed, with its slot held until EOF or cancellation.
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const body = await held.arrayBuffer()
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return held
    } catch (error) {
      release()
      throw error
    }
  }
}

function holdTrialResponse(response, release, signal) {
  const reader = response.body.getReader()
  let controller, finished = false
  const finish = () => {
    if (finished) return
    finished = true
    signal?.removeEventListener("abort", abort)
    release()
  }
  const abort = () => {
    const reason = abortReason(signal)
    void reader.cancel(reason).catch(() => {})
    try { controller.error(reason) } catch {}
    finish()
  }
  const body = new ReadableStream({
    start(value) { controller = value },
    async pull(value) {
      try {
        const part = await reader.read()
        if (finished) return
        if (part.done) {
          value.close()
          finish()
        } else value.enqueue(part.value)
      } catch (error) {
        try { value.error(error) } finally { finish() }
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { finish() }
    },
  }, { highWaterMark: 0 })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

// Cookie keep-alive: Google rotates the __Secure-1PSIDTS cookie on its
// own schedule, and a stale one quietly degrades the relay. The
// rotator calls the same endpoint the web app uses (accounts.google.com
// /RotateCookies) from inside the page — the app's own cookies, its own
// origin — on a jittered timer. Best-effort: any failure is reported
// through onError (logged upstream) and never breaks a chat turn.
//
// The endpoint takes the literal body [000,"-0000000000000000000"] —
// leading zeros included, sent as-is — and answers Set-Cookie headers
// the page's fetch cannot read; the fresh jar is read back over
// Storage.getCookies through the browser layer instead.

export const ROTATE_URL = "https://accounts.google.com/RotateCookies"
export const ROTATE_BODY = '[000,"-0000000000000000000"]'

const PAGE_ROTATE = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(ROTATE_URL)}, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://accounts.google.com" },
      body: ${JSON.stringify(ROTATE_BODY)},
      credentials: "include",
    })
    return { status: r.status }
  } catch (e) { return { status: 0, err: String(e && e.message || e) } }
})()`

export class CookieRotator {
  constructor({ page, cookies, intervalMs = 600_000, jitterMs = 15_000, minGapMs = 60_000, onError } = {}) {
    this.page = page // the relay page the in-page fetch runs on
    this.cookies = cookies // () => the browser's cookie jar, for the 1PSIDTS check
    this.intervalMs = intervalMs
    this.jitterMs = jitterMs
    this.minGapMs = minGapMs // two rotations never fire closer than this
    this.onError = onError
    this.timer = null
    this.lastRun = 0
    this.stopped = false
  }

  start() {
    if (this.timer || this.stopped) return
    this.schedule()
  }

  schedule() {
    const delay = Math.max(1, this.intervalMs + Math.floor(Math.random() * this.jitterMs * 2 - this.jitterMs))
    this.timer = setTimeout(async () => {
      this.timer = null
      if (this.stopped) return
      await this.rotateOnce().catch(() => {})
      if (!this.stopped) this.schedule()
    }, delay)
    this.timer.unref?.()
  }

  async stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // rotateOnce hits the endpoint once. Runs inside a 60s guard so a busy
  // timer overlap cannot double-fire. The set-cookie headers are not
  // readable from a page fetch, so success is judged by the status and,
  // when a cookie reader is wired, by the 1PSIDTS value actually moving.
  async rotateOnce() {
    if (Date.now() - this.lastRun < this.minGapMs) return null
    this.lastRun = Date.now()
    const before = await this.readSidts()
    const r = await this.page.eval(PAGE_ROTATE).catch((e) => ({ status: 0, err: String(e?.message ?? e) }))
    if (r.status === 401) {
      this.onError?.(new Error("RotateCookies 返回 401，会话可能已失效"))
      return r
    }
    if (r.status !== 200 && r.status !== 0) {
      this.onError?.(new Error(`RotateCookies 返回 ${r.status}`))
      return r
    }
    const after = await this.readSidts()
    if (before && after && before === after)
      this.onError?.(new Error("RotateCookies 后 __Secure-1PSIDTS 未变化"))
    return r
  }

  async readSidts() {
    try {
      const jar = await this.cookies?.()
      return jar?.["__Secure-1PSIDTS"] ?? ""
    } catch {
      return ""
    }
  }
}

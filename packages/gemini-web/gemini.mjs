// The Gemini web app's own endpoints, called the way gemini.google.com
// calls them: GET /app for the page's tokens, then one POST to
// StreamGenerate per request, read as it streams. No other process sits in
// between, and no file is uploaded: the whole prompt goes inline.

export const APP = "https://gemini.google.com"
const GENERATE = APP + "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
const BATCH = APP + "/_/BardChatUi/data/batchexecute"
const ROTATE = "https://accounts.google.com/RotateCookies"

// what Chrome sends; Google answers a bare client with the same page, but
// the request should look like the browser the cookies came from
const CHROME = "146.0.0.0"
export function userAgent(platform = process.platform) {
  const os =
    platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`
}

// The prompt is sent inline. Measured on 2026-11-19: 315K characters were
// answered in full, 900K came back but the reply ignored the request, and
// 1.8M was refused with error [3]. Past this the plugin says so itself.
export const MAX_PROMPT = 600_000

export class GeminiError extends Error {
  constructor(message, { code = "gemini_error", status = 502, signIn = false } = {}) {
    super(message)
    this.name = "GeminiError"
    this.code = code
    this.status = status
    this.signIn = signIn
  }
}

// The models Gemini's picker can name. hex is the id the picker sends in
// the x-goog-ext-525001261-jspb header, mode the slot beside it. auto
// sends no header: Google picks, as the app does for a new chat. The
// list an account really has comes from otAQ7b (parseModels); this is
// what's offered before it has been read.
export const MODELS = {
  "gemini-auto": { name: "Auto", hex: "" },
  "gemini-3.6-flash": { name: "3.6 Flash", hex: "fbb127bbb056c959", mode: 1 },
  "gemini-3.1-pro": { name: "3.1 Pro", hex: "9d8ca3786ebdfbea", mode: 3 },
}

// 4 Carbon (a paid plan's) is refused unless the request carries these
// slots too, as the app sends them for it
const CARBON = "95a4c0abcba24364"
const CARBON_SLOTS = { 6: [1], 30: [], 49: 40, 68: 2, 83: 1, 91: 1, 96: 1, 98: 1 }

export const slug = (name) =>
  "gemini-" +
  String(name)
    .toLowerCase()
    .replace(/^gemini\s*/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")

const uuid = () => crypto.randomUUID().toUpperCase()

// innerRequest is the StreamGenerate request as the app builds it for a
// temporary chat (slot 45): it is not kept in the account's history.
export function innerRequest(prompt, model = {}) {
  const inner = new Array(99).fill(null)
  inner[0] = [prompt, 0, null, null, null, null, 0]
  inner[1] = ["en"]
  inner[2] = ["", "", "", null, null, null, null, null, null, ""]
  inner[6] = [0]
  inner[7] = 1
  inner[10] = 1
  inner[11] = 0
  inner[17] = [[0]]
  inner[18] = 0
  inner[27] = 1
  inner[30] = [4]
  inner[41] = [1]
  inner[45] = 1
  inner[53] = 0
  inner[59] = uuid()
  inner[61] = []
  inner[68] = 1
  if (model.hex === CARBON) for (const [k, v] of Object.entries(CARBON_SLOTS)) inner[k] = v
  return inner
}

export function modelHeader(model = {}) {
  if (!model.hex) return null
  return JSON.stringify([1, null, null, null, model.hex, null, null, 0, [4, 5, 6, 8], null, null, 1, null, null, model.mode ?? 1, 1, uuid()])
}

// Replies drop code-run artifacts into the text (a fenced block naming
// code_reference or code_stdout); they are not what the model wrote.
const ARTIFACT = /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g
export const clean = (t) => t.replace(ARTIFACT, "")

// Frames reads StreamGenerate's reply as it arrives: `)]}'`, then lines of
// a length and a JSON array of ["wrb.fr", null, "<json>"] entries. Every
// content entry carries the reply so far, not what is new; the longest is
// kept. An entry with no payload and a code in slot 5 is a refusal.
export class Frames {
  constructor() {
    this.buf = ""
    this.text = ""
    this.reasoning = ""
    this.model = ""
    this.frames = 0
    this.content = false
    this.refusal = null
    this.done = false
  }

  push(chunk) {
    this.buf += chunk
    let i
    let changed = false
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      changed = this.line(line) || changed
    }
    return changed
  }

  end() {
    const changed = this.buf ? this.line(this.buf) : false
    this.buf = ""
    return changed
  }

  line(line) {
    line = line.trim()
    if (!line.startsWith("[")) return false
    let rows
    try {
      rows = JSON.parse(line)
    } catch {
      return false
    }
    let changed = false
    for (const e of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(e) || e[0] !== "wrb.fr") continue
      this.frames++
      if (typeof e[2] !== "string") {
        if (Array.isArray(e[5])) this.refusal = e[5][0] ?? "unknown"
        continue
      }
      let b
      try {
        b = JSON.parse(e[2])
      } catch {
        continue
      }
      if (typeof b?.[42] === "string" && b[42]) this.model = b[42]
      const r = b?.[2]
      if (r && typeof r === "object" && !Array.isArray(r) && r["46"]) this.done = true
      const c = b?.[4]?.[0]
      if (!Array.isArray(c)) continue
      const t = c[1]?.[0]
      if (typeof t === "string") {
        this.content = true
        const ct = clean(t)
        if (ct.length >= this.text.length && ct !== this.text) {
          this.text = ct
          changed = true
        }
      }
      const th = c[37]?.[0]?.[0]
      if (typeof th === "string" && th.length > this.reasoning.length) {
        this.reasoning = th
        changed = true
      }
    }
    return changed
  }
}

// tokens reads what a request needs from the /app page: SNlM0e (the XSRF
// token, only when signed in), cfb2h (the build) and FdrFJe (the session).
export function pageTokens(html) {
  const g = (k) => html.match(new RegExp(`"${k}":"([^"]*)"`))?.[1] ?? ""
  return { at: g("SNlM0e"), bl: g("cfb2h"), sid: g("FdrFJe"), email: g("oPEP7c") }
}

export const cookieHeader = (cookies) =>
  Object.entries(cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")

// mergeSetCookie takes the cookies a reply set (Google renews them on its
// replies) into the jar, and says whether anything changed
export function mergeSetCookie(cookies, setCookies = []) {
  let changed = false
  for (const sc of setCookies) {
    const first = String(sc).split(";")[0]
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    const attrs = String(sc).toLowerCase()
    // only what the app's requests carry: google.com's own cookies
    if (/domain=/.test(attrs) && !/domain=\.?(gemini\.)?google\.com(;|$)/.test(attrs)) continue
    if (/max-age=0|expires=thu, 01 jan 1970/.test(attrs) || value === "EXPIRED") continue
    if (cookies[name] !== value) {
      cookies[name] = value
      changed = true
    }
  }
  return changed
}

const setCookiesOf = (res) => (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])

const TOKENS_FOR = 15 * 60_000
const ROTATE_AFTER = 10 * 60_000

// Session is one account (or no account: cookies null). It keeps the page
// tokens for a while instead of fetching /app before every request, keeps
// the cookies current from what Google sets, and when they stop working
// renews them: first the way the app's own page does (RotateCookies), then
// through renew(), which reopens the account's browser profile.
export class Session {
  constructor({ cookies = null, fetchImpl = globalThis.fetch, renew = null, onCookies = null, now = Date.now, platform = process.platform } = {}) {
    this.cookies = cookies ? { ...cookies } : null
    this.fetch = fetchImpl
    this.renewProfile = renew
    this.onCookies = onCookies
    this.now = now
    this.ua = userAgent(platform)
    this.tok = null
    this.tokAt = 0
    this.rotatedAt = now()
    this.renewing = null
  }

  get signedIn() {
    return !!this.cookies
  }

  headers(extra = {}) {
    const h = { "user-agent": this.ua, "accept-language": "en-US,en;q=0.9", accept: "*/*", ...extra }
    if (this.cookies) h.cookie = cookieHeader(this.cookies)
    return h
  }

  took(res) {
    if (this.cookies && mergeSetCookie(this.cookies, setCookiesOf(res))) this.saved()
  }

  saved() {
    try {
      this.onCookies?.({ ...this.cookies })
    } catch {}
  }

  async page(signal) {
    const res = await this.fetch(APP + "/app", { headers: this.headers({ accept: "text/html" }), redirect: "manual", signal })
    this.took(res)
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location") ?? ""
      if (/\/sorry\//.test(to)) throw new GeminiError("Google 把这个网络出口当成了自动流量（/sorry）。换个网络或代理再试。", { code: "gemini_blocked", status: 503 })
      return { at: "", bl: "", sid: "", email: "", moved: to }
    }
    if (!res.ok) throw new GeminiError(`gemini.google.com/app 回复 HTTP ${res.status}`, { status: 502 })
    return pageTokens(await res.text())
  }

  // tokens answers the page's tokens; signed in, a page with no SNlM0e
  // means the cookies were taken as signed out, so they are renewed once
  async tokens({ signal, force = false } = {}) {
    if (!force && this.tok && this.now() - this.tokAt < TOKENS_FOR) return this.tok
    let t = await this.page(signal)
    if (this.cookies && !t.at) {
      await this.renew(signal)
      t = await this.page(signal)
      if (!t.at) throw new GeminiError("Google 账号的登录已失效，请在 magpie 里重新登录 Gemini 网页版。", { code: "gemini_signed_out", status: 401, signIn: true })
    }
    if (!t.bl) throw new GeminiError("gemini.google.com/app 的页面里没有 cfb2h，Gemini 网页版可能改版了。", { code: "gemini_page_changed" })
    this.tok = t
    this.tokAt = this.now()
    return t
  }

  // rotate is the page's own keep-alive: a POST that renews
  // __Secure-1PSIDTS. It fails for a session Chrome bound to its device;
  // renew then takes fresh cookies from the profile itself.
  async rotate(signal) {
    if (!this.cookies?.["__Secure-1PSID"]) return false
    const pair = { "__Secure-1PSID": this.cookies["__Secure-1PSID"] }
    if (this.cookies["__Secure-1PSIDTS"]) pair["__Secure-1PSIDTS"] = this.cookies["__Secure-1PSIDTS"]
    try {
      const res = await this.fetch(ROTATE, {
        method: "POST",
        headers: { "user-agent": this.ua, "content-type": "application/json", origin: "https://accounts.google.com", cookie: cookieHeader(pair) },
        body: '[000,"-0000000000000000000"]',
        signal,
      })
      if (!res.ok) return false
      this.rotatedAt = this.now()
      this.took(res)
      return true
    } catch {
      return false
    }
  }

  async renew(signal) {
    if (this.renewing) return this.renewing
    this.renewing = (async () => {
      if (await this.rotate(signal)) {
        const t = await this.page(signal).catch(() => null)
        if (t?.at) return
      }
      if (!this.renewProfile) return
      const fresh = await this.renewProfile()
      if (fresh && typeof fresh === "object") {
        this.cookies = { ...this.cookies, ...fresh }
        this.rotatedAt = this.now()
        this.saved()
      }
    })().finally(() => (this.renewing = null))
    return this.renewing
  }

  // keepAlive renews the short-lived cookie in the background once it is
  // ten minutes old, as the app's page does while it is open
  keepAlive() {
    if (this.cookies && !this.renewing && this.now() - this.rotatedAt > ROTATE_AFTER) {
      this.rotatedAt = this.now()
      this.rotate().catch(() => {})
    }
  }

  // ask sends prompt and calls onUpdate({text, reasoning}) as the reply
  // grows. It answers the whole reply once Gemini ends it.
  async ask(prompt, { model = {}, signal, onUpdate } = {}) {
    if (prompt.length > MAX_PROMPT)
      throw new GeminiError(
        `请求有 ${prompt.length} 个字符，超过 Gemini 网页版能可靠读完的 ${MAX_PROMPT}。请压缩上下文（如 /compact）后再试。`,
        { code: "context_length_exceeded", status: 413 },
      )
    this.keepAlive()
    for (let attempt = 0; ; attempt++) {
      const t = await this.tokens({ signal, force: attempt > 0 })
      const res = await this.post(prompt, model, t, signal)
      if (res.ok) return await this.read(res, onUpdate)
      const body = await res.text().catch(() => "")
      // a stale XSRF token or session: fetch the page again, once
      if (attempt === 0 && (res.status === 400 || res.status === 401 || res.status === 403)) {
        if (this.cookies && res.status !== 400) await this.renew(signal)
        continue
      }
      if (res.status === 429)
        throw new GeminiError("Gemini 网页版说请求太多（HTTP 429），过一会儿再试。", { code: "rate_limited", status: 429 })
      throw new GeminiError(`StreamGenerate 回复 HTTP ${res.status}：${body.slice(0, 200)}`, { status: 502 })
    }
  }

  post(prompt, model, t, signal) {
    const q = new URLSearchParams({ bl: t.bl, "f.sid": t.sid, hl: "en", _reqid: String(10000 + Math.floor(Math.random() * 90000)), rt: "c" })
    const form = { "f.req": JSON.stringify([null, JSON.stringify(innerRequest(prompt, model))]) }
    if (t.at) form.at = t.at
    const h = this.headers({
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-same-domain": "1",
      origin: APP,
      referer: APP + "/",
      "x-goog-ext-525005358-jspb": JSON.stringify([uuid(), 1]),
    })
    const mh = modelHeader(model)
    if (mh) h["x-goog-ext-525001261-jspb"] = mh
    return this.fetch(GENERATE + "?" + q, { method: "POST", headers: h, body: new URLSearchParams(form), signal })
  }

  async read(res, onUpdate) {
    this.took(res)
    const f = new Frames()
    const dec = new TextDecoder()
    const update = () => onUpdate?.({ text: f.text, reasoning: f.reasoning })
    for await (const chunk of res.body) if (f.push(dec.decode(chunk, { stream: true }))) update()
    const tail = f.push(dec.decode())
    if (f.end() || tail) update()
    return outcome(f)
  }

  // models lists what the account's model picker shows (otAQ7b)
  async models({ signal } = {}) {
    const t = await this.tokens({ signal })
    const form = { "f.req": JSON.stringify([[["otAQ7b", "[]", null, "generic"]]]) }
    if (t.at) form.at = t.at
    const q = new URLSearchParams({ rpcids: "otAQ7b", "source-path": "/app", bl: t.bl, "f.sid": t.sid, hl: "en", _reqid: String(10000 + Math.floor(Math.random() * 90000)), rt: "c" })
    const res = await this.fetch(BATCH + "?" + q, {
      method: "POST",
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1", origin: APP, referer: APP + "/" }),
      body: new URLSearchParams(form),
      signal,
    })
    if (!res.ok) throw new GeminiError(`otAQ7b 回复 HTTP ${res.status}`)
    return parseModels(await res.text())
  }
}

// outcome is what a finished reply says: its text, or why there is none
export function outcome(f) {
  if (!f.content) {
    if (f.refusal != null)
      throw new GeminiError(
        `Gemini 网页版拒绝了这个请求（错误 ${JSON.stringify(f.refusal)}）。常见原因：上下文太长、账号的套餐没有所选模型，或请求太频繁。`,
        { code: "gemini_refused", status: 502 },
      )
    throw new GeminiError(`Gemini 网页版的回复里没有内容（${f.frames} 帧）。`, { code: "no_content" })
  }
  return { text: f.text, reasoning: f.reasoning, model: f.model }
}

// parseModels reads otAQ7b's reply: slot 15 of its payload lists the
// picker's entries as [hex, name, description, …, mode at 17].
export function parseModels(raw) {
  const out = {}
  for (const line of raw.split("\n")) {
    if (!line.startsWith("[")) continue
    let rows
    try {
      rows = JSON.parse(line)
    } catch {
      continue
    }
    for (const e of rows) {
      if (!Array.isArray(e) || e[0] !== "wrb.fr" || e[1] !== "otAQ7b" || typeof e[2] !== "string") continue
      let b
      try {
        b = JSON.parse(e[2])
      } catch {
        continue
      }
      for (const m of Array.isArray(b?.[15]) ? b[15] : []) {
        const [hex, name] = m ?? []
        if (typeof hex !== "string" || !/^[0-9a-f]{16}$/.test(hex) || typeof name !== "string" || !name) continue
        const mode = Number.isInteger(m[17]) ? m[17] : 1
        out[slug(name)] = { name, hex, mode }
      }
    }
  }
  return out
}

// Says outside the computer what lib/alerts.mjs decided: a markdown card
// to a WeCom (企业微信) group bot's webhook — the one push channel a
// personal WeChat has that is official, stable and free; a group bot's
// key is all it takes. Nothing but the card leaves: no key, no header, no
// conversation — and what lib/alerts.mjs hands over is what the snapshot
// already kept fail-closed, so with text off no prompt, reply, error or
// tool argument can leave even with notifyIncludeText on; a tool step
// keeps its name only.
//
// Patient by necessity: WeCom takes 20 messages a minute from a bot, so
// one card is sent at a time (every few seconds at most, into a token
// bucket with margin) and what piles up is merged into it; a send that
// fails — the network, or errcode 45009, the limit itself — is retried
// with longer waits and then dropped to the console, never thrown: the
// office must not stop because a card didn't leave.

const BYTE_MAX = 4096
const PER_MIN = 18
const MINUTE = 60e3
const RETRIES = [2e3, 8e3, 30e3]
const CLIP_TEXT = 160
const CLIP_STEP = 80

const WORDS = {
  zh: {
    c: "：",
    waitApproval: "等你批准", waitAsk: "在问你", done: "完成了一轮", error: "出错了", recover: "又动起来了",
    stuck: (n) => `${n} 分钟没有动静`,
    project: "项目", action: "动作", said: "它说", wrong: "错误",
    took: "这一轮用了", waited: "已等", session: "会话", resume: "续接", min: "分钟", sec: "秒", turns: "轮",
    dropped: "另有 {n} 条更早的告警没来得及发出",
  },
  en: {
    c: ": ",
    waitApproval: "waits for your approval", waitAsk: "asks you something", done: "finished a turn", error: "failed", recover: "is moving again",
    stuck: (n) => `no word for ${n} min`,
    project: "Project", action: "Action", said: "It says", wrong: "Error",
    took: "This turn took", waited: "Waiting", session: "Session", resume: "Resume", min: "min", sec: "s", turns: "turns",
    dropped: "{n} earlier alerts were dropped unsent",
  },
}

function words(lang) { return String(lang || "").toLowerCase().startsWith("zh") ? WORDS.zh : WORDS.en }

function clip(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s
}

// WeCom caps a markdown card at 4096 bytes of UTF-8, not characters
function clipBytes(s, max) {
  const b = Buffer.from(String(s ?? ""))
  if (b.length <= max) return b.toString()
  let n = max
  while (n > 0 && (b[n - 1] & 0xc0) === 0x80) n--
  return b.subarray(0, n).toString() + "…"
}

function agentName(id) {
  const s = String(id || "agent")
  return s[0].toUpperCase() + s.slice(1)
}

function hhmm(t) {
  const d = new Date(t || 0)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// one alert as a card a person reads in a second
export function card(a, lang = "zh", includeText = false) {
  const w = words(lang)
  // the roster's name first, the agent's own otherwise
  const name = a.name || agentName(a.agent)
  const mins = (ms) => Math.max(1, Math.round((ms || 0) / 60e3))
  // a stretch under a minute is said in seconds, not rounded up to one
  const span = (ms) => {
    const s = Math.max(1, Math.round((ms || 0) / 1000))
    return s < 60 ? `${s} ${w.sec}` : `${Math.max(1, Math.round(s / 60))} ${w.min}`
  }
  // a tool step keeps its name only unless the text was asked for: a
  // command line can hold a secret the same way a prompt can
  const step = includeText ? a.step : String(a.step || "").split(" · ")[0]
  const text = includeText ? clip(a.reply, CLIP_TEXT) : ""
  const wrong = includeText ? clip(a.error, CLIP_TEXT) : ""
  // the person's own line, as the roster wrote it
  const role = clip([a.direction, a.skills].filter(Boolean).join(" · "), 60)
  const head =
    a.type === "waiting" ? `**${a.sub === "ask" ? "❓" : "⏸"} ${name} ${a.sub === "ask" ? w.waitAsk : w.waitApproval}**`
    : a.type === "done" ? `**✅ ${name} ${w.done}**`
    : a.type === "error" ? `**❌ ${name} ${w.error}**`
    : a.type === "stuck" ? `**⚠️ ${name} ${w.stuck(mins(a.since))}**`
    : `**↩️ ${name} ${w.recover}**`
  const body = []
  if (role) body.push(role)
  if (a.project) body.push(`${w.project}${w.c}${clip(a.project, 60)}`)
  if (step) body.push(`${w.action}${w.c}${clip(step, CLIP_STEP)}`)
  if (a.type === "done" && a.since) body.push(`${w.took} ${span(a.since)}${a.turns ? ` · ${a.turns} ${w.turns}` : ""}`)
  if (a.type === "waiting" && a.since) body.push(`${w.waited} ${span(a.since)}`)
  if (wrong && a.type === "error") body.push(`${w.wrong}${w.c}${wrong}`)
  else if (text && (a.type === "done" || a.type === "waiting")) body.push(`${w.said}${w.c}${text}`)
  body.push(`${hhmm(a.now || a.at)}${a.session ? ` · ${w.session} ${clip(String(a.session), 12)}` : ""}`)
  if (includeText && a.resume) body.push(`${w.resume}${w.c}\`${clip(a.resume, 120)}\``)
  return clipBytes(`${head}\n${body.map((l) => `> ${l}`).join("\n")}`, BYTE_MAX)
}

export function createNotifier(opts = {}) {
  const o = {
    webhook: "", every: 2500, lang: "zh", includeText: false,
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...opts,
  }
  const queue = []
  const stamps = []
  let timer = null
  let sending = false
  let dropped = 0

  function start() {
    if (timer || !o.webhook) return
    timer = setInterval(() => { void flush() }, o.every)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  async function send(text) {
    for (let i = 0; i <= RETRIES.length; i++) {
      try {
        const r = await o.fetch(o.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
          signal: AbortSignal.timeout?.(8000),
        })
        const j = typeof r?.json === "function" ? await r.json().catch(() => null) : null
        if (r?.ok && j?.errcode === 0) return true
        // a card the webhook refuses on its merits is not sent better by
        // trying again; 45009 (the minute's limit) and a network trouble are
        if (j && j.errcode !== 45009) break
      } catch {}
      if (i < RETRIES.length) await o.sleep(RETRIES[i])
    }
    console.error("[agent-office] a notification card didn't leave; it was dropped")
    return false
  }

  async function flush() {
    if (sending || !o.webhook || !queue.length) return
    sending = true
    try {
      while (queue.length) {
        const now = Date.now()
        while (stamps.length && now - stamps[0] >= MINUTE) stamps.shift()
        if (stamps.length >= PER_MIN) return
        // one card a send: what waits is merged into it, up to the byte cap
        let text = ""
        while (queue.length) {
          const c = card(queue[0], o.lang, o.includeText)
          if (text && Buffer.byteLength(text + "\n\n" + c) > BYTE_MAX) break
          text += (text ? "\n\n" : "") + c
          queue.shift()
        }
        if (dropped) {
          text += `\n\n> ${words(o.lang).dropped.replace("{n}", dropped)}`
          dropped = 0
        }
        await send(text)
        stamps.push(Date.now())
      }
    } finally {
      sending = false
    }
  }

  function push(list) {
    for (const a of Array.isArray(list) ? list : []) {
      if (queue.length >= 200) dropped++
      else queue.push(a)
    }
    // the queue is drained by the timer alone: a tick decides, the timer
    // sends, and the two never race
    start()
  }

  return { push, start, stop, flush, send, options: o, pending: () => queue.length, stamps }
}

// Many bots, one team: each roster person may carry their own group bot's
// webhook, and a card goes out on its own person's bot — 小明's cards come
// from 小明. Alerts without a person's webhook fall to the default one; an
// alert with nowhere to go is held back (fail-closed, as ever).
export function createRouter(opts = {}) {
  const o = {
    defaultWebhook: "", lang: "zh", includeText: false, every: 2500,
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...opts,
  }
  const map = new Map() // webhook -> notifier

  function notifierFor(url) {
    if (!map.has(url)) {
      map.set(url, createNotifier({
        webhook: url, every: o.every, lang: o.lang, includeText: o.includeText,
        fetch: o.fetch, sleep: o.sleep,
      }))
    }
    return map.get(url)
  }

  return {
    push(list) {
      for (const a of Array.isArray(list) ? list : []) {
        const url = String(a.webhook || "") || o.defaultWebhook
        if (!url) continue // nowhere to go: held back, not half-sent
        notifierFor(url).push([a])
      }
    },
    targets: () => [...map.keys()],
    pending: () => { let n = 0; for (const x of map.values()) n += x.pending(); return n },
    flush: async () => { for (const n of map.values()) await n.flush() },
    stop() { for (const n of map.values()) n.stop(); map.clear() },
    options: o,
  }
}

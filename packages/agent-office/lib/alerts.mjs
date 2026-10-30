// What deserves a word outside the office: a session that waits for its
// user — an approval to give, a question to answer — one that finished its
// turn, one that failed, one that went quiet mid-turn. Decided here from
// the same snapshot the page draws (office.hooks.mjs builds it every
// tick), against the page's own states, so a card sent away and the person
// in the office never disagree. The states are page/model.js's state(); a
// copy lives here because the page is a classic script the host doesn't
// load — keep the two in step.
//
// Pure deciding: tick() takes the sessions and the time and returns what
// there is to say; lib/notify.mjs does the saying. What was last said is
// remembered per session, so a wait that stands is repeated only after a
// cooldown and a finished turn is said once. It never throws: a
// notification is a courtesy of the office, not a duty of it.

const STUCK_MS = 10 * 60e3

// a threshold an option carries: 0 is a choice ("no minimum"), not a
// missing value
function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

// a session as the page reads it — page/model.js state(), kept in step
// with it; "replying" is the page's finer cut of at-work, the same to a
// card. A session from an agent's own files says its phase outright; one
// only the gateway saw is worked out from its requests.
export function stateOf(s, now, opts = {}) {
  if (s.source === "files" || s.phase) {
    const quiet = now - (s.touched || s.updated || now)
    const stuckMs = num(opts.stuckMin, 10) * 60e3 || STUCK_MS
    switch (s.phase) {
      case "approval": return { status: "waiting", sub: "approval" }
      case "ask": return { status: "waiting", sub: "ask" }
      case "error": return { status: "error", sub: "" }
      case "aborted": return { status: "done", sub: "stopped" }
      case "done": return { status: "done", sub: "" }
      case "tool": return quiet > stuckMs ? { status: "error", sub: "stuck" } : { status: "executing", sub: "" }
      case "thinking": default:
        if (quiet > stuckMs) return { status: "error", sub: "stuck" }
        return { status: "thinking", sub: "" }
    }
  }
  if (s.inflight > 0) return { status: "thinking", sub: "" }
  const l = s.last
  if (!l) return { status: "thinking", sub: "" }
  if (l.outcome === "error") return { status: "error", sub: "" }
  if (l.outcome === "ask") return { status: "waiting", sub: "ask" }
  if (l.outcome === "tools") {
    const approvalMs = num(opts.approvalSec, 90) * 1000
    return now - l.at > approvalMs ? { status: "waiting", sub: "approval" } : { status: "executing", sub: "" }
  }
  return { status: "done", sub: "" }
}

// "23:00-08:00" in the machine's own time; an empty string is no quiet
function quietHours(spec, now) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec || ""))
  if (!m) return false
  const d = new Date(now)
  const t = d.getHours() * 60 + d.getMinutes()
  const a = Number(m[1]) * 60 + Number(m[2])
  const b = Number(m[3]) * 60 + Number(m[4])
  return a <= b ? t >= a && t < b : t >= a || t < b
}

function shellQuote(s) {
  return /^[A-Za-z0-9._:@%+=/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
}

// the command that picks the session up again, where the agent has one —
// page/model.js resume(), kept in step with it
function resumeOf(s) {
  const id0 = String(s.session || "")
  if (!id0 || id0.startsWith("cwd:") || id0.startsWith("model:")) return ""
  const id = shellQuote(id0)
  const cd = s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ""
  switch (s.agent) {
    case "claude": return `${cd}claude --resume ${id}`
    case "codex": return `${cd}codex resume ${id}`
    case "opencode": return `${cd}opencode --session ${id}`
    case "gemini": return `${cd}gemini --resume ${id}`
    case "qwen": return `${cd}qwen --resume ${id}`
    case "pi": return `${cd}pi --session ${id}`
    case "dsh": return `${cd}dsh --resume ${shellQuote(id0.replace(/^session-/, ""))}`
    case "zcode": return `${cd}zcode --resume ${id}`
    default: return ""
  }
}

export function createAlerter(opts = {}) {
  const o = {
    // which cards to say: waiting, error, stuck, done; recover is opt-in
    events: "waiting,error,stuck,done",
    cooldownMin: 15, errorMin: 5, stuckMin: 10, approvalSec: 90, minWorkSec: 60,
    agents: "", quietHours: "",
    ...opts,
  }
  const wanted = () => new Set(String(o.events).split(/[,\s]+/).filter(Boolean))
  const allow = () => new Set(String(o.agents || "").split(/[,\s]+/).filter(Boolean))
  // key -> { status, sub, workSince, said: Map(card type -> when sent) }
  const known = new Map()

  function tick(sessions, now = Date.now(), people = {}) {
    const out = []
    if (!Array.isArray(sessions)) return out
    const quiet = quietHours(o.quietHours, now)
    const here = new Set()
    for (const s of sessions) {
      if (!s || typeof s.key !== "string") continue
      here.add(s.key)
      if (allow().size && !allow().has(s.agent)) continue
      const was = known.get(s.key)
      const st = stateOf(s, now, o)
      const at = Math.max(s.updated || 0, s.touched || 0, s.last?.at || 0)
      const working = st.status === "thinking" || st.status === "executing" || st.status === "replying"
      const workSince = working ? was?.workSince || now : 0
      const said = was?.said || new Map()
      known.set(s.key, { status: st.status, sub: st.sub, workSince, said, seen: now })

      const type =
        st.status === "waiting" ? "waiting" :
        st.status === "error" ? (st.sub === "stuck" ? "stuck" : "error") :
        st.status === "done" && st.sub !== "stopped" ? "done" :
        was && was.status === "error" && working ? "recover" : ""
      if (!type || !wanted().has(type)) continue
      // a quiet hour holds everything but an error: what waited still
      // waits, and is said when the quiet is over
      if (quiet && type !== "error") continue

      // a finished turn is said when a stretch of work it ended was long
      // enough to have been worth watching; a first sighting, with no
      // stretch known, is not said
      const fresh =
        type === "done" ? !!(was && was.status !== "done" && was.workSince && now - was.workSince >= num(o.minWorkSec, 60) * 1000)
        : type === "recover" ? true
        : !was || was.status !== st.status || was.sub !== st.sub
      // a wait or a failure that stands is said again after its cooldown;
      // a finished turn or a recovery, once
      const again = (type === "error" ? num(o.errorMin, 5) : num(o.cooldownMin, 15)) * 60e3
      const last = said.get(type) || 0
      if (!fresh && !(type !== "done" && type !== "recover" && now - last >= again)) continue

      // who this is, from the user's own roster (lib/roster.mjs): a card
      // says 小明, and the direction and craft the user gave them — and it
      // goes out on that person's own group bot when the roster binds one
      const person = people?.[s.agent] || null
      said.set(type, now)
      out.push({
        type, sub: st.sub, agent: s.agent, session: s.session || "", project: s.project || "",
        cwd: s.cwd || "", model: s.model || "", turns: s.turns || 0,
        name: person?.name || "", direction: person?.direction || "", skills: person?.skills || "",
        webhook: person?.webhook || "",
        step: s.step || s.last?.step || "", reply: s.reply || s.last?.text || "",
        error: s.error || s.last?.error || "", resume: resumeOf(s),
        since: type === "stuck" ? now - at : type === "done" ? now - (was?.workSince || now) : type === "waiting" ? now - at : 0,
        at, now,
      })
    }
    // what the snapshot stopped carrying — an old session aged out of it —
    // is forgotten with it, so the memory of what was said stays bounded
    for (const [k, e] of known) {
      if (here.has(k)) continue
      e.gone = (e.gone || 0) + 1
      if (e.gone > 10) known.delete(k)
    }
    return out
  }

  return { tick, set(opts) { Object.assign(o, opts) }, options: o }
}

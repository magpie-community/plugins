// Work on the 做任务 领额度 tasks of the Doubao `pc/agent-explore` activity by
// driving the desktop client's own chat UI over CDP.
//
// Why this exists at all: `checkin()` claims credit the account has *already*
// earned (daily sign-in + reached milestone tiers) and that part is fully
// automatic. The remaining +100 tasks are different — the campaign only counts
// them after the product is really used, so there is nothing to "claim". This
// module is the opt-in helper that opens the right surface, drops Doubao's own
// recommended prompt into the composer, and — if you ask it to — sends the turn
// and stops the generation the moment the task registers, so the quota spent
// stays as small as the campaign allows.
//
// It is deliberately NOT wired into checkin(): every run of these tasks spends
// quota (a task pays +100 but the generation behind it can cost more), so it
// must be a deliberate act by the user, not a side effect of a daily job.
//
// The campaign decides each task by a server-side `campaign_type`, i.e. by
// whether the matching product feature was really exercised (read live from
// /alice/ug/campaign/v3/detail, 2026-11-02):
//
//   GenWord / GenExcel / GenPPT   → a real file was generated
//   skill_use                     → a real browser task ran
//   SkillUsed                     → a real *skill* was invoked (skill_name)
//   WorkTaskMode                  → the 新工作任务 flow produced an artifact
//   PCUsed                        → 本地电脑 actually touched the machine
//   ScheduleSkill                 → a 定时任务 actually fired
//
// On this account GenWord, GenExcel, GenPPT and skill_use are already 已领取,
// which proves the "just hold a conversation" path does credit — as long as the
// turn really produces the artifact. The earlier failures all had the same
// shape: the turn was cut short. So `sendTask` now waits for the generation to
// finish on its own and only stops early if the campaign flips to 可领取 first.

import { CdpSession, listTargets } from "./client-checkin.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Which surface each campaign task is credited on, and the composer toggles it
// needs switched on first. Measured against the live client (2026-11-02):
//
//   新工作任务 (⌘N) is the work-task composer; its toolbar carries
//   本地电脑 / 项目 / 按需确认 / 技能 / 插件 toggles, which is where three of
//   the four tasks are actually exercised.
//   插件 · 技能 (⇧⌘S) is *not* the built-in skill runner — it opens
//   chrome://doubao-chat/chat/skills, a marketplace of enterprise connectors
//   (Wind / 同花顺 / Moka …), so the skill task goes through the composer's
//   技能 toggle instead.
//   定时任务 (⇧⌘T) is a list page with a 新建 dialog; it has no composer of its
//   own, but the same work conversation can create one ("每天 8 点提醒我…"), so
//   it is driven through the work surface as well.
export const TASK_SURFACE = {
  pc_task_complete_work_task_v2: { surface: "work", toggles: [] },
  // These two act on the user's machine, so they never use Doubao's own
  // recommendation: 本地电脑 is pinned to creating one throwaway file and 定时任务
  // to a job that fires once. See `ownPrompt` in lib/sweep.mjs.
  pc_task_complete_computer_task_v2: { surface: "work", toggles: ["本地电脑"], ownPrompt: true },
  pc_task_use_skill_v2: { surface: "work", toggles: ["技能"] },
  // The campaign credits this one only once the created job actually runs
  // (verified: "任务创建成功" with task_status still 1), so its prompt asks for a
  // job that fires once shortly from now instead of the dialog's default
  // 每小时 — otherwise it leaves a job behind that keeps spending quota.
  pc_task_create_schedule_v2: { surface: "work", toggles: [], schedule: true, ownPrompt: true },
}

// Fallback for activity tasks not yet in TASK_SURFACE. They are driven exactly
// like a work-task: open the work surface, drop the task's own recommended
// prompt, send. The sweep routes them through the activity chip when a prompt
// is present, so Doubao selects the correct surface/toggles itself.
const GENERIC_PLAN = { surface: "work", toggles: [], ownPrompt: false, schedule: false }

const SIDEBAR_LABEL = {
  work: "新工作任务",
  chat: "新对话",
  schedule: "定时任务",
  skill: "插件 · 技能",
}

/** The chat window, which is where every surface above lives. */
export async function findChatTarget(port = 9333) {
  const all = await listTargets(port).catch(() => [])
  return (Array.isArray(all) ? all : []).find(
    // Both shapes occur: `doubao://doubao-chat/chat` on a fresh window and
    // `doubao://doubao-chat/chat/<id>` once a conversation is open.
    (t) => /doubao-chat\/chat(\/|$|\?)/.test(t.url ?? "") && t.webSocketDebuggerUrl,
  ) ?? null
}

/** The activity page — the entry point Doubao's own buttons live on. */
export async function findActivityTarget(port = 9333) {
  const all = await listTargets(port).catch(() => [])
  return (Array.isArray(all) ? all : []).find((t) => /agent-explore/.test(t.url ?? "") && t.webSocketDebuggerUrl) ?? null
}

async function connect(port) {
  // The chat target disappears for a beat whenever the app swaps surfaces
  // (新工作任务 → work composer), so a single lookup right after prepareTask
  // used to fail as "no-chat-target" while the window was perfectly alive.
  for (let i = 0; i < 3; i++) {
    const target = await findChatTarget(port).catch(() => null)
    if (target) {
      const session = new CdpSession(target.webSocketDebuggerUrl)
      await session.opened
      await session.send("Runtime.enable").catch(() => {})
      return session
    }
    await sleep(700)
  }
  return null
}

/* c8 ignore start -- the helpers below run inside the client's renderer */

// Left-hand navigation entries. Matched by their label so a layout change does
// not silently click empty space; the shortcut suffix ("⌘ N") is tolerated.
function sidebarPoint(label) {
  for (const el of document.querySelectorAll("button, a, [role=button], div")) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim()
    if (!t.startsWith(label)) continue
    if (t.length > label.length + 8) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.x > 320) continue // sidebar only; the content pane repeats some labels
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  return null
}

// The composer is the last *visible* tiptap editor on the page (the side panel
// and dialogs can contribute others).
function composerPoint() {
  const eds = [...document.querySelectorAll("div.tiptap.ProseMirror")]
    .filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  const ed = eds[eds.length - 1]
  if (!ed) return null
  const r = ed.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (ed.innerText || "").trim() }
}

// The send control is icon-only (no text, no aria-label), so it is located
// structurally: the right-most button inside the composer's container.
function sendPoint() {
  const eds = [...document.querySelectorAll("div.tiptap.ProseMirror")]
    .filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  const ed = eds[eds.length - 1]
  if (!ed) return null
  let box = ed
  for (let i = 0; i < 7 && box.parentElement; i++) box = box.parentElement
  const pts = [...box.querySelectorAll("button")]
    .map((b) => {
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) }
    })
    .filter((p) => p.w > 0)
    .sort((a, b) => b.x - a.x)
  return pts[0] ?? null
}

function stopPoint() {
  for (const b of document.querySelectorAll("button, [role=button]")) {
    const t = `${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`
    if (!/停止|暂停生成/.test(t)) continue
    const r = b.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  return null
}

// What the client is doing right now. Three states matter:
//
//   asking — the work-task flow stopped to ask a clarifying question and
//            rendered numbered choices instead of the composer. This is where
//            every earlier attempt died: the turn was sent, Doubao replied
//            "正在询问用户", nobody picked an option, and the task sat at 未完成
//            forever while the caller timed out and called it a miss.
//   busy   — streaming: no composer, no question, answer growing.
//   idle   — composer back, waiting for the next message.
//
// `hasTiptap` is the load-bearing signal: the composer element is *removed*
// while a turn runs and while a question is open, so its presence means the
// client is genuinely done, which a text-based "停止" probe can never tell
// (the stop control carries no text at all).
function pageState() {
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const editors = [...document.querySelectorAll("div.tiptap.ProseMirror")].filter(shown)
  const asking = /正在询问用户/.test(norm(document.body.innerText))
  // Inlined rather than calling stopPoint(): CDP only ships this function's own
  // body into the renderer, so a reference to another module-scope helper would
  // throw ReferenceError — and since the caller catches, every state read would
  // silently come back null and the loop would spin until timeout.
  let stop = false
  for (const b of document.querySelectorAll("button, [role=button]")) {
    const t = `${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`
    if (!/停止|暂停生成/.test(t)) continue
    if (shown(b)) { stop = true; break }
  }
  // The work composer stays mounted while a turn runs, so `idle` alone cannot
  // tell "finished" from "still working" there. These two marks only appear
  // once a turn is over ("共用时 35 秒" / "已处理 32 秒").
  const doneMark = /共用时|已处理/.test(norm(document.body.innerText))
  const composerText = editors.length ? norm(editors[editors.length - 1].innerText) : ""
  return {
    asking,
    editors: editors.length,
    idle: editors.length > 0 && !asking,
    stop,
    doneMark,
    empty: composerText.length === 0,
  }
}

// Centre of the choice card to click while a question is open. `keys` are plain
// strings (a RegExp cannot survive the CDP round-trip): the first option whose
// text contains one of them wins, else the topmost option — Doubao's own
// recommended answer is always the first one.
function optionPoint(keys) {
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const cands = []
  for (const e of document.querySelectorAll("div, button, li, [role=option], [role=button]")) {
    if (!shown(e)) continue
    const r = e.getBoundingClientRect()
    // Conversation pane only (the sidebar is < 300px), and cards are wide,
    // short blocks — that filters out the bubble wrapping them.
    if (r.x < 300 || r.width < 140 || r.width > 620 || r.height < 28 || r.height > 140) continue
    const text = norm(e.innerText)
    if (!text || text.length > 120) continue
    cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: r.width * r.height, text })
  }
  if (!cands.length) return null
  const words = Array.isArray(keys) ? keys : []
  const hit = cands
    .filter((c) => words.some((k) => c.text.includes(k)))
    .sort((a, b) => a.area - b.area)[0]
  const pick = hit ?? [...cands].sort((a, b) => a.y - b.y)[0]
  return { x: pick.x, y: pick.y, text: pick.text }
}

// The CTA on one activity card. Cards are keyed by `data-reward-code`, which is
// byte-identical to the campaign_code (verified 2026-11-02), so this lands on
// the right card instead of the first "去完成" on the page.
function cardCtaPoint(code) {
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const card = document.querySelector(`[data-reward-code="${code}"]`)
  if (!card) return null
  // Scroll first: clicking an offscreen card dispatches at stale coordinates.
  card.scrollIntoView({ block: "center" })
  const btns = [...card.querySelectorAll("button, [role=button]")].filter(shown)
  const btn = btns.find((b) => /去完成|立即领|立即领取/.test(norm(b.textContent))) ?? btns[0]
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: norm(btn.textContent) }
}

// One of the prompt chips in the "试试这些灵感，快速上手" popover. This popover
// is the whole trick: picking a chip makes Doubao itself open the right surface
// with the full prompt already in the composer, which is far more reliable than
// guessing a sidebar entry and injecting text by hand.
function chipPoint(title) {
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const needle = String(title || "").replace(/\s+/g, "")
  if (needle.length < 2) return null
  let best = null
  for (const e of document.querySelectorAll("button, [role=button], div, span")) {
    if (!shown(e)) continue
    const text = norm(e.textContent)
    if (!text) continue
    const flat = text.replace(/\s+/g, "")
    if (!flat.includes(needle)) continue
    const r = e.getBoundingClientRect()
    // Chips are small pills; the popover wrapping them is not.
    if (r.width < 60 || r.width > 420 || r.height < 24 || r.height > 80) continue
    const area = r.width * r.height
    if (!best || area < best.area) {
      best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area, text }
    }
  }
  return best ? { x: best.x, y: best.y, text: best.text } : null
}

function togglePoint(label) {
  for (const b of document.querySelectorAll("button, [role=button]")) {
    if ((b.textContent || "").trim() !== label) continue
    const r = b.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  return null
}

// The 插件 · 技能 page is a catalogue, not a composer: the chat only exists
// after a skill card is opened. Cards carry the skill's name (and a short
// description), so match on the longest distinctive fragment we were given.
function skillCardPoint(hint) {
  if (!hint) return null
  const needle = String(hint).replace(/\s+/g, "")
  if (needle.length < 4) return null
  let best = null
  for (const el of document.querySelectorAll("button, a, [role=button], div, li")) {
    const t = (el.textContent || "").replace(/\s+/g, "")
    if (!t.includes(needle)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.width > 600 || r.height > 220) continue // skip the page-level container
    const area = r.width * r.height
    if (!best || area < best.area) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area }
  }
  return best
}
// Put the caret in the composer and select everything already in it, so the
// next insert *replaces* rather than appends (a chip may have filled Doubao's
// own prompt first). Focus has to be set from inside the page: a synthetic
// click can land on the composer's padding and leave the tiptap editor
// unfocused, which is exactly how a typed prompt used to arrive nowhere
// (composed=false, no error).
function focusComposer() {
  const eds = [...document.querySelectorAll("div.tiptap.ProseMirror")].filter((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  const ed = eds[eds.length - 1]
  if (!ed) return false
  ed.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(ed)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

// Fallback when Input.insertText lands nothing: execCommand fires the same
// beforeinput/input events tiptap listens to, so the controlled editor updates.
function insertViaDom(text) {
  const eds = [...document.querySelectorAll("div.tiptap.ProseMirror")].filter((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  const ed = eds[eds.length - 1]
  if (!ed) return ""
  ed.focus()
  document.execCommand("insertText", false, text)
  return (ed.innerText || "").trim()
}
/* c8 ignore stop */

// Focus, type, verify — and fall back to the DOM path if the CDP insert went
// nowhere. Returns what the composer actually holds, so "composed" is never a
// guess.
async function typeInto(session, text) {
  const focused = await session.evaluate(focusComposer).catch(() => false)
  if (!focused) return ""
  await session.send("Input.insertText", { text }).catch(() => {})
  await sleep(500)
  let got = (await session.evaluate(composerPoint).catch(() => null))?.text ?? ""
  if (got.trim()) return got
  got = await session.evaluate(insertViaDom, text).catch(() => "")
  await sleep(500)
  return got || (await session.evaluate(composerPoint).catch(() => null))?.text || ""
}

// Same, on a fresh connection to the chat window (the activity page session is
// a different target and cannot type).
async function typeIntoChat(port, text) {
  let session = null
  try {
    session = await connect(port)
    if (!session) return ""
    return await typeInto(session, text)
  } catch {
    return ""
  } finally {
    try { await session?.close() } catch {}
  }
}

async function tap(session, point) {
  if (!point) return false
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
  return true
}

/**
 * Wait for the composer to hold text after a chip is picked.
 *
 * The chip makes the app navigate on its own — and on this build that means the
 * whole chat webview reloads: `/json` goes empty for 10–20 s, so "no target"
 * must not be read as "composer stayed empty". Only a live target with an empty
 * composer counts as a miss.
 */
async function waitForComposer(port, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    let s = null
    try {
      s = await connect(port)
      if (s) {
        const box = await s.evaluate(composerPoint).catch(() => null)
        if (box?.text) return { ok: true, text: box.text }
      }
    } finally {
      try { await s?.close() } catch {}
    }
    await sleep(s ? 700 : 1200)
  }
  return { ok: false, text: "" }
}

/**
 * Use the activity page the way a person does: click the card's CTA, then pick
 * one of the prompt chips in the "试试这些灵感，快速上手" popover.
 *
 * This is the route Doubao expects, and it is much sturdier than driving the
 * sidebar by hand: the app itself decides which surface to open and writes the
 * full prompt into the composer, so no layout guess can put the text in the
 * wrong box. Verified live 2026-11-02 — picking 「生成完整的旅游攻略 PDF」 opened
 * the work-task composer already containing the whole prompt.
 *
 * @param {object} opts
 * @param {string} opts.taskCode   campaign_code / data-reward-code
 * @param {string} [opts.chipTitle] which prompt chip to pick (show_prompt)
 * @param {number} [opts.port]
 * @returns {Promise<{ok:boolean, via?:string, chip?:string, prefilled?:string,
 *                    composed?:boolean, clicked?:string[], error?:string}>}
 */
export async function openViaActivity({ taskCode, chipTitle, port = 9333 } = {}) {
  let session = null
  try {
    const act = await findActivityTarget(port)
    if (!act) return { ok: false, error: "no-activity-target" }
    session = new CdpSession(act.webSocketDebuggerUrl)
    await session.opened
    await session.send("Runtime.enable").catch(() => {})

    const cta = await session.evaluate(cardCtaPoint, taskCode).catch(() => null)
    if (!cta) return { ok: false, error: "no-card-cta" }
    await tap(session, cta)
    // The popover animates in; 600ms is not enough on this machine.
    await sleep(1500)

    const chip = chipTitle ? await session.evaluate(chipPoint, chipTitle).catch(() => null) : null
    if (!chip) return { ok: false, clicked: [cta.label], error: "no-prompt-chip" }
    await tap(session, chip)
    await sleep(2500)

    const landed = await waitForComposer(port)
    if (!landed.ok) return { ok: false, clicked: [cta.label], chip: chip.text, error: "composer-stayed-empty" }
    return { ok: true, via: "activity-chip", clicked: [cta.label], chip: chip.text, prefilled: landed.text, composed: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch {}
  }
}

/**
 * Open the surface a task is credited on and leave the official prompt sitting
 * in the composer, unsent.
 *
 * Two routes, in order of reliability:
 *
 *   1. `chipTitle` — go through the activity card and its prompt chip, so
 *      Doubao picks the surface and fills the prompt itself;
 *   2. otherwise — click the sidebar entry, switch the composer toggles on, and
 *      type the prompt into the last visible tiptap editor.
 *
 * @param {object} opts
 * @param {string} opts.taskCode  campaign_code, e.g. pc_task_use_skill_v2
 * @param {string} opts.prompt    the prompt to prefill (Doubao's own)
 * @param {string} [opts.skillHint] skill card to open first (插件 · 技能 page)
 * @param {string} [opts.chipTitle] pick this prompt chip on the activity page
 * @param {number} [opts.port]
 * @returns {Promise<{ok:boolean, surface?:string, via?:string, toggled?:string[], prefilled?:string,
 *                    composed?:boolean, openedSkill?:string, error?:string}>}
 */
export async function prepareTask({ taskCode, prompt, skillHint, chipTitle, port = 9333 } = {}) {
  // Known codes use their tuned plan (surface + toggles + schedule/ownPrompt).
  // Unknown pc_task_* codes fall back to the generic work-surface plan so any new
  // task the activity page exposes is still attempted with its own prompt.
  const plan = TASK_SURFACE[taskCode] ?? (/^pc_task_/.test(taskCode) ? GENERIC_PLAN : null)
  if (!plan) return { ok: false, error: `unknown task: ${taskCode}` }
  if (plan.manual) return { ok: false, manual: true, surface: plan.surface, hint: "这个任务需要在客户端手动完成", error: "manual" }
  if (!prompt) return { ok: false, error: "no prompt" }

  // Route 1: let the activity page do the routing.
  if (chipTitle) {
    const via = await openViaActivity({ taskCode, chipTitle, port })
    if (via.ok) {
      // A pinned prompt (本地电脑 / 定时任务) still uses the chip to reach the
      // right surface and toggles, but the text itself must be ours: Doubao's
      // own recommendation there is "整理一下我的桌面" / "每小时提醒我". Replace
      // it — and if the replacement does not take, refuse to send rather than
      // let the dangerous text through.
      if (prompt.trim() !== (via.prefilled ?? "").trim()) {
        const got = await typeIntoChat(port, prompt)
        // A composer still holding the chip's longer text means the replace
        // appended instead of overwriting — never send that.
        const polluted = got.trim().length > prompt.trim().length * 1.5
        if (!got.trim() || polluted) return { ok: false, via: "activity-chip", chip: via.chip, error: "override-failed" }
        return { ...via, via: "activity-chip+override", surface: "activity", toggled: [], prefilled: got, composed: true }
      }
      return { ...via, surface: "activity", toggled: [] }
    }
    // Fall through to the hand-driven path rather than failing outright.
    if (via.error && via.error !== "no-activity-target" && via.error !== "no-prompt-chip") {
      return { ok: false, error: via.error, clicked: via.clicked }
    }
  }

  let session = null
  try {
    session = await connect(port)
    if (!session) return { ok: false, error: "no-chat-target" }

    const nav = await session.evaluate(sidebarPoint, SIDEBAR_LABEL[plan.surface]).catch(() => null)
    if (!nav) return { ok: false, error: `surface not reachable: ${plan.surface}` }
    await tap(session, nav)
    await sleep(2500)

    const toggled = []
    for (const label of plan.toggles) {
      const p = await session.evaluate(togglePoint, label).catch(() => null)
      if (p && (await tap(session, p))) toggled.push(label)
      await sleep(600)
    }

    let comp = await session.evaluate(composerPoint).catch(() => null)
    let openedSkill = ""
    if (!comp && skillHint) {
      // 插件 · 技能 has no composer until a skill is opened.
      const card = await session.evaluate(skillCardPoint, skillHint).catch(() => null)
      if (card) {
        await tap(session, card)
        openedSkill = skillHint
        await sleep(2500)
        comp = await session.evaluate(composerPoint).catch(() => null)
      }
    }
    if (!comp) return { ok: false, surface: plan.surface, toggled, openedSkill, error: "no-composer" }

    await tap(session, { x: comp.x, y: comp.y })
    await sleep(400)
    const prefilled = await typeInto(session, prompt)
    return { ok: true, surface: plan.surface, toggled, openedSkill, composed: prefilled.length > 0, prefilled }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch {}
  }
}

/** Is the client still streaming an answer? The stop control is the signal. */
async function generating(session) {
  return Boolean(await session.evaluate(stopPoint).catch(() => null))
}

async function halt(session) {
  const p = await session.evaluate(stopPoint).catch(() => null)
  return p ? tap(session, p) : false
}

/**
 * End the conversation a task was driven in.
 *
 * The campaign does not need the answer to finish — the moment the task flips
 * to 可领取 the credit is in, and every further token is quota spent for
 * nothing. So: stop the stream if it is still running, then start a fresh
 * chat so the client is left clean instead of sitting on a half-written answer.
 * Best effort by design — a failure here must never affect the claim.
 *
 * @param {{port?:number}} [opts]
 * @returns {Promise<{ok:boolean, stopped:boolean, error?:string}>}
 */
export async function endTurn({ port = 9333 } = {}) {
  let session = null
  try {
    session = await connect(port)
    if (!session) return { ok: false, stopped: false, error: "no-chat-target" }
    const stopped = await halt(session)
    await sleep(700)
    const fresh = await session.evaluate(sidebarPoint, SIDEBAR_LABEL.chat).catch(() => null)
    if (!fresh) return { ok: false, stopped, error: "no-new-chat-entry" }
    await tap(session, fresh)
    await sleep(800)
    return { ok: true, stopped }
  } catch (e) {
    return { ok: false, stopped: false, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch {}
  }
}

/**
 * Send the prefilled turn, let it run to completion, and stop early only if the
 * campaign flips to 可领取 while it is still streaming.
 *
 * This is the shape the activity actually rewards. Its `campaign_type` is a
 * server-side feature-usage check (GenWord / GenPPT / SkillUsed / WorkTaskMode /
 * PCUsed / ScheduleSkill — see the header), so the credit lands when the turn
 * really produces the artifact, not when the request is sent. Cutting the
 * answer short therefore saves quota but earns nothing, which is exactly what
 * five earlier attempts did.
 *
 * So: wait for the generation to finish on its own (`timeoutMs` is a guard, not
 * a target), poll the campaign meanwhile, stop the moment it says 可领取, then
 * keep watching through a short settle window because the credit event lands a
 * few seconds after the last token.
 *
 * `readStatus` is injected (it needs the account cookie, which lives in
 * index.mjs). It returns the task's numeric task_status, or null when unknown.
 *
 * @param {object} opts
 * @param {string} opts.taskCode
 * @param {(code:string)=>Promise<number|null>} opts.readStatus
 * @param {number} [opts.port]
 * @param {number} [opts.timeoutMs]   guard against a stuck generation
 * @param {number} [opts.pollMs]      campaign read interval while streaming
 * @param {number} [opts.settleMs]    how long to keep watching after it ends
 * @param {boolean}[opts.stopOnClaim] stop a live generation once credit appears
 * @returns {Promise<{ok:boolean, sent:boolean, started:boolean, finished:boolean,
 *                    earned:boolean, stopped:boolean, settledBy:string,
 *                    statusBefore:number|null, statusAfter:number|null,
 *                    generationMs:number, elapsedMs:number, error?:string}>}
 */
export async function sendTask({
  taskCode,
  readStatus,
  port = 9333,
  timeoutMs = 240000,
  pollMs = 5000,
  // The credit lands a few seconds after the last token, and for 定时任务 not
  // until the job actually fires — so the settle window has to be generous.
  settleMs = 90000,
  stopOnClaim = true,
} = {}) {
  const out = {
    ok: false,
    sent: false,
    started: false,
    finished: false,
    earned: false,
    stopped: false,
    settledBy: "",
    answers: [],
    statusBefore: null,
    statusAfter: null,
    generationMs: 0,
    elapsedMs: 0,
  }
  let session = null
  const t0 = Date.now()
  try {
    out.statusBefore = (await readStatus?.(taskCode)) ?? null
    // Already claimable (or claimed) — sending again would be quota spent for
    // credit that is already there. Happens when two callers race, or when the
    // sweep's list is a few seconds stale.
    if (out.statusBefore === 2 || out.statusBefore === 3) {
      return {
        ...out,
        ok: true,
        earned: true,
        settledBy: "already-claimable",
        statusAfter: out.statusBefore,
        elapsedMs: Date.now() - t0,
      }
    }
    session = await connect(port)
    if (!session) return { ...out, error: "no-chat-target" }

    const send = await session.evaluate(sendPoint).catch(() => null)
    if (!send) return { ...out, error: "no-send-button" }
    const before = await session.evaluate(pageState).catch(() => null)
    await tap(session, send)
    out.sent = true
    await sleep(1500)
    // A send that emptied the composer (or started a stream) actually left. In
    // the work surface the composer stays mounted, so this — not "composer
    // present" — is the honest "the turn is running" signal.
    const after = await session.evaluate(pageState).catch(() => null)
    if (after && (after.stop || (before?.empty === false && after.empty))) out.started = true

    // The turn often opens with a clarifying question ("数据在哪里？" plus
    // numbered choices). That counts as started, and the question must be
    // answered or the task never runs at all — this is exactly where every
    // earlier attempt stalled.
    // The answer does not have to finish: as soon as the campaign says
    // 可领取 the credit is already banked, so the first minutes are polled
    // tightly and only a long turn falls back to the slow rhythm (a full
    // campaign read is one request — 2.5 s for the first 90 s is ~36 of them,
    // well inside what the endpoint tolerated).
    const fastWindowMs = 90000
    const interval = () => (Date.now() - t0 < fastWindowMs ? Math.min(pollMs, 2500) : pollMs)
    const platform = TASK_SURFACE[taskCode] ?? {}
    const workSurface = platform.surface === "work" || platform.surface === "schedule"
    let idleStreak = 0
    let quietSince = 0

    const ANSWER_KEYS = ["生成示例", "示例数据", "模拟", "自拟", "随机", "继续", "确认"]

    while (Date.now() - t0 < timeoutMs) {
      const status = (await readStatus?.(taskCode)) ?? null
      if (status != null) out.statusAfter = status
      if (status === 2 || status === 3) {
        out.earned = true
        out.settledBy = "while-running"
        // Credit is already in: stop a live stream rather than burning the rest
        // of the answer. Nothing to stop when it already finished.
        if (stopOnClaim) {
          const p = await session.evaluate(stopPoint).catch(() => null)
          if (p) out.stopped = await tap(session, p)
        }
        break
      }

      const state = await session.evaluate(pageState).catch(() => null)
      if (!state) {
        await sleep(interval())
        continue
      }

      if (state.asking) {
        out.started = true
        idleStreak = 0
        quietSince = 0
        // Cap the answers: a question loop means the prompt is wrong, and each
        // extra round costs quota.
        const opt = out.answers.length < 6
          ? await session.evaluate(optionPoint, ANSWER_KEYS).catch(() => null)
          : null
        if (opt) {
          await tap(session, opt)
          out.answers.push(String(opt.text).slice(0, 40))
          await sleep(2500)
          continue
        }
        // No pickable option: keep watching rather than declaring failure.
      } else if (state.stop) {
        out.started = true
        quietSince = 0
        if (!state.idle) idleStreak = 0
      } else {
        if (!quietSince) quietSince = Date.now()
        const quietMs = Date.now() - quietSince
        // Work/schedule turns keep the composer mounted for the whole run, so
        // "composer back" proves nothing there; the end-of-turn caption does.
        // A long silence with no stop control is the fallback for both shapes.
        const ended = workSurface
          ? state.doneMark || quietMs > 45000
          : (state.empty && quietMs > 4000) || quietMs > 45000
        if (ended && Date.now() - t0 > 8000) {
          out.finished = true
          out.generationMs = Date.now() - t0
          break
        }
      }
      await sleep(interval())
    }

    if (!out.earned) {
      // The credit event lands a few seconds after the last token, so a single
      // read right at the end reads stale. Watch through the settle window
      // before reporting a miss.
      const until = Date.now() + settleMs
      while (Date.now() < until) {
        await sleep(3000)
        const status = (await readStatus?.(taskCode)) ?? null
        if (status != null) out.statusAfter = status
        if (status === 2 || status === 3) {
          out.earned = true
          out.settledBy = "after-finish"
          break
        }
      }
    }

    out.ok = true
    return { ...out, elapsedMs: Date.now() - t0 }
  } catch (e) {
    return { ...out, elapsedMs: Date.now() - t0, error: String(e?.message ?? e) }
  } finally {
    try { await session?.close() } catch {}
  }
}

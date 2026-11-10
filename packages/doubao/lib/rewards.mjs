// Claim every reward that is *already earned* on the Doubao
// `pc/agent-explore` activity page, by driving the real desktop client's
// webview over CDP.
//
// Why this lives here rather than in the plugin: the activity
// (`pc_incentive_task_mvp_v3`) is front-end locked to the desktop client's
// webview. Raw `POST /landing/checkin` answers 710010702 for every external
// caller and a plain browser only renders the "去下载" placeholder, so a
// trusted click inside the client is the only working surface (verified
// 2026-11-02).
//
// Mapping to the real tasks (verified live 2026-11-02): every reward card in
// the page carries `data-reward-code`, and that value is byte-identical to the
// campaign detail API's `campaign_code`:
//
//   data-reward-code="daily_signin"   ←→ tasks[].campaign_code "daily_signin"
//   data-reward-code="points_milestone_500" ←→ milestones[].campaign_code same
//   data-reward-code="pc_task_use_skill_v2"  ←→ tasks[].campaign_code same
//
// So a caller that already knows the server-side status (2 = 已完成待领取) can
// pass those codes straight in and we click *that card's own button*, instead
// of guessing from page-wide text. The button label still has to be a
// claim-shaped one, which is the second gate:
//
//   ✅ 立即签到            daily sign-in (+200)
//   ✅ 额外领 N 点额度      milestone already reached (e.g. 累计 500 点 → +200)
//   ✅ 领取奖励 / 领取 N 额度
//
// It never clicks 去完成 / 立即参与 / 立即领 (团队版) / 用豆包试试看 / 复制链接.
// Those either need the user's real product usage (and spend model quota) or
// open an unrelated flow, so they stay manual. Automation that quietly spends
// the user's credits to win credits is a net loss, and it is not what "claim
// my rewards" means.

import { connectSession, isCdpUp, isDoubaoRunning, launchClient } from "./client-checkin.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Reward-ready labels. Anchored so that e.g. "立即领" (the 7-day team trial,
// which needs enterprise verification) cannot match "立即领取".
// `立即领取` is intentionally absent: on this page it is the hero banner CTA,
// not an earned-reward claim.
//
// `领奖励` is the label a +100 task flips to once the campaign credits it
// (verified live 2026-11-02: 豆包可以帮你完成复杂任务 showed 领奖励 with
// task_status 2). Without it a finished task would look unclaimable forever.
export const REWARD_LABELS =
  "^(?:立即签到|签到|领取奖励|领奖励|领取\\s*[\\d,]+\\s*额度|额外领\\s*[\\d,]+\\s*点额度)$"

// The daily sign-in alone — used by nativeCheckin to keep its old meaning.
export const DAILY_SIGNIN_LABELS = "^(?:立即签到|签到)$"

// Labels that mean "you must go do the work first". Kept as an explicit deny
// list so a future rename cannot slip through the claim whitelist by accident.
export const NEVER_LABELS = /^(?:去完成|立即参与|立即领|用豆包试试看|复制链接|去下载)$/

// The endpoints a successful claim hits. `landing/checkin` is the daily sign
// in write; the others cover milestone/task reward claims.
const CLAIM_WRITE = /\/(?:landing\/checkin|campaign\/[^/]*(?:claim|reward|task))/i

// ---------------------------------------------------------------------------
// Page-side helpers. Serialised into the webview, so they must be standalone.
// ---------------------------------------------------------------------------

/**
 * Every reward card currently rendered, with its own button and state.
 * @returns {Array<{code:string, text:string, button:string|null, disabled:boolean, rewarded:boolean}>}
 */
/* c8 ignore start -- runs in the page */
function scanCards() {
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const out = []
  for (const el of document.querySelectorAll("[data-reward-code]")) {
    const code = el.getAttribute("data-reward-code")
    if (!code) continue
    const btn = el.querySelector("button, [role=button]")
    const text = norm(el.textContent)
    const r = el.getBoundingClientRect()
    out.push({
      code,
      text: text.slice(0, 90),
      button: btn ? norm(btn.textContent) : null,
      disabled: btn ? (btn.disabled || btn.getAttribute("aria-disabled") === "true") : false,
      // The signed-in / claimed state replaces the action button with a check
      // mark ("rewarded" element) and keeps a 已领取 style caption.
      rewarded: Boolean(el.querySelector('[class*="rewarded"]')) || /已领取|已签到|已完成/.test(text),
      visible: r.width > 2 && r.height > 2,
    })
  }
  return out
}

/**
 * Where to click for one campaign code, after deciding whether we may click at
 * all. Returns a verdict rather than a point so the caller can report why a
 * card was skipped.
 */
async function clickTargetFor(arg) {
  const { code, labelsSrc } = arg
  const re = new RegExp(labelsSrc)
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim()
  const card = document.querySelector(`[data-reward-code="${code}"]`)
  if (!card) return { ok: false, reason: "card-missing" }
  const btn = card.querySelector("button, [role=button]")
  if (!btn) return { ok: false, reason: "no-button" }
  const label = norm(btn.textContent)
  if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { ok: false, reason: "disabled", label }
  if (!re.test(label)) return { ok: false, reason: "not-claimable", label }
  const cs = getComputedStyle(btn)
  if (cs.pointerEvents === "none" || parseFloat(cs.opacity) < 0.6) return { ok: false, reason: "inert", label }
  try { btn.scrollIntoView({ block: "center", inline: "center" }) } catch {}
  // This page scrolls smoothly: the rect read straight after scrollIntoView is
  // still the pre-scroll one, and a click there lands on empty space.
  await new Promise((r) => setTimeout(r, 420))
  const rect = btn.getBoundingClientRect()
  if (rect.width <= 2 || rect.height <= 2) return { ok: false, reason: "offscreen", label }
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  // A synthesised mouse event goes to whatever is topmost at (x, y), not to the
  // element we measured. A toast, an overlay or a sticky header sitting over
  // the card would therefore make us click something else entirely — verified
  // 2026-11-02 with two stacked probe cards, where the click landed on the
  // upper one. Refuse instead of clicking blind.
  const hit = document.elementFromPoint(x, y)
  if (!hit || !card.contains(hit)) return { ok: false, reason: "occluded", label }
  return { ok: true, label, x, y }
}

/** Is the campaign UI itself rendered (as opposed to the 去下载 placeholder)? */
function activityRendered() {
  return /每日签到|做任务 领额度/.test(document.body ? document.body.textContent : "")
}
/* c8 ignore stop */

// Plain-JS mirrors of the two page predicates above, so the *labels* logic can
// be unit-tested without a browser.
export function mayClick(label, labelsSrc = REWARD_LABELS) {
  const t = String(label ?? "").replace(/\s+/g, " ").trim()
  if (!t) return false
  if (NEVER_LABELS.test(t)) return false
  return new RegExp(labelsSrc).test(t)
}

/**
 * @param {object} [opts]
 * @param {number}  [opts.port]         CDP port (default 9333)
 * @param {string}  [opts.activity]     activity URL to make sure is open
 * @param {string[]}[opts.codes]        campaign codes known to be claimable;
 *                                      omitted → every claim-shaped button
 * @param {string}  [opts.labels]       reward-label regex source
 * @param {number}  [opts.timeoutMs]    how long to wait for the page to render
 * @param {number}  [opts.maxClicks]    hard cap on clicks per run
 * @param {number}  [opts.clickGapMs]   settle time between clicks
 * @param {boolean} [opts.autoLaunch]   start the client if it isn't running
 * @returns {Promise<{clientFound:boolean, launched:boolean, clicked:string[],
 *   clickedCodes:string[], skipped:Array<{code:string,reason:string,label?:string}>,
 *   requests:string[], alreadyClaimed:boolean, cards:number, error:string|null,
 *   lastError:string|null}>}
 */
export async function claimRewards(opts = {}) {
  const port = Number(opts.port ?? process.env.DOUBAO_CDP_PORT ?? 9333)
  const activity = opts.activity ?? "https://www.doubao.com/pc/agent-explore"
  const labels = opts.labels ?? REWARD_LABELS
  const timeoutMs = opts.timeoutMs ?? 30000
  const maxClicks = opts.maxClicks ?? 8
  const clickGapMs = opts.clickGapMs ?? 2400
  const autoLaunch = opts.autoLaunch ?? false
  const codes = Array.isArray(opts.codes) ? [...new Set(opts.codes.filter(Boolean))] : null

  const result = {
    clientFound: false,
    launched: false,
    clicked: [],
    clickedCodes: [],
    skipped: [],
    requests: [],
    alreadyClaimed: false,
    cards: 0,
    error: null,
    lastError: null,
  }

  try {
    if (!(await isCdpUp(port, 1500))) {
      if (!autoLaunch) { result.error = "cdp-not-reachable"; return result }
      if (isDoubaoRunning()) { result.error = "client-running-without-debug"; return result }
      const launched = await launchClient({ port })
      if (!launched.ok) { result.error = launched.error ?? "launch-failed"; return result }
      result.launched = true
    }
    result.clientFound = true

    let session = null
    try {
      session = await connectSession({ port, activity, checkinTimeoutMs: timeoutMs })
      session.on("Network.requestWillBeSent", (p) => {
        const u = p?.request?.url ?? ""
        if (!CLAIM_WRITE.test(u)) return
        const short = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0]
        if (!result.requests.includes(short)) result.requests.push(short)
      })

      // Always reload before claiming. The page keeps a client-side snapshot of
      // the campaign, and a claim clicked against a stale snapshot fails with
      // 「奖励领取失败，请稍后重试」 *without issuing any request at all* — the
      // exact failure that made a finished +100 task look unclaimable
      // (verified live 2026-11-02). Reloading first is what turned that
      // failure into a confirmed 900 → 1000.
      if (opts.refresh !== false) {
        await session.navigate(activity).catch(() => {})
        await sleep(3200)
      } else {
        const cur = await session.evaluate("location.href").catch(() => "")
        if (!String(cur).includes("agent-explore")) {
          await session.navigate(activity).catch(() => {})
          await sleep(3000)
        }
      }

      // Wait (best effort) for the reward cards to render.
      let cards = []
      const deadline = Date.now() + timeoutMs
      for (;;) {
        cards = (await session
          .evaluate(scanCards, undefined, { awaitPromise: true })
          .catch((e) => { result.lastError = String(e?.message ?? e); return [] })) ?? []
        if (Array.isArray(cards) && cards.length) break
        if (Date.now() + 800 > deadline) break
        await sleep(900)
      }
      result.cards = Array.isArray(cards) ? cards.length : 0

      if (!result.cards) {
        // Distinguish "nothing left to claim" from "page not ready": the page
        // rendering the campaign at all means the client is signed in and the
        // panel is genuinely empty of cards.
        const ready = await session.evaluate(activityRendered).catch(() => false)
        result.alreadyClaimed = ready === true
        return result
      }

      // Which cards to go for. With server-known codes we target exactly those
      // tasks; without, we fall back to every card whose button reads like a
      // claim (still gated by mayClick below).
      const targets = codes ?? cards
        .filter((c) => c.button && !c.disabled && mayClick(c.button, labels))
        .map((c) => c.code)

      // Nothing known-claimable: report the state honestly (all claimed vs
      // waiting on real usage) instead of clicking around.
      if (!targets.length) {
        result.alreadyClaimed = cards.some((c) => c.rewarded) || cards.length > 0
        return result
      }

      for (const code of targets) {
        if (result.clicked.length >= maxClicks) break
        const verdict = await session
          .evaluate(clickTargetFor, { code, labelsSrc: labels })
          .catch((e) => { result.lastError = String(e?.message ?? e); return { ok: false, reason: "threw" } })
        if (!verdict?.ok) {
          result.skipped.push({ code, reason: verdict?.reason ?? "unknown", label: verdict?.label })
          continue
        }
        await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: verdict.x, y: verdict.y, button: "left", clickCount: 1 })
        await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: verdict.x, y: verdict.y, button: "left", clickCount: 1 })
        result.clicked.push(verdict.label)
        result.clickedCodes.push(code)
        await sleep(clickGapMs)
      }

      // Every card we aimed at was already in the claimed state (no button, or
      // a check mark instead of one). That is a success report, not a failure.
      if (!result.clicked.length) {
        const exhausted = result.skipped.length > 0
          && result.skipped.every((x) => x.reason === "no-button" || x.reason === "card-missing")
        result.alreadyClaimed = exhausted && cards.some((c) => c.rewarded)
      }

      // Let a trailing claim request surface before we report.
      if (result.clicked.length) await sleep(1200)
      return result
    } finally {
      try { await session?.close() } catch {}
    }
  } catch (e) {
    result.error = String(e?.message ?? e)
    return result
  }
}

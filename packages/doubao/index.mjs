// Doubao (doubao.com): web sign-in, daily check-in, the campaign panel's
// experience-credit reading, and chat through the web account.
//
// Chat goes to `/samantha/chat/completion` — the endpoint Doubao's own page
// calls — with the session cookie the account already has. The agents speak
// Anthropic's Messages shape; lib/chat.mjs folds that into the one turn this
// endpoint takes and turns its SSE back into the Anthropic events, so a
// request the vendor never sees as Anthropic still answers as one.
//
// Check-in contract: Magpie understands claimed / done / ineligible /
// inactive / captcha / failed, and re-asks every 30 minutes on failed (and on
// any provisional answer before Beijing noon). So every settled answer carries
// `until` (the next Beijing midnight, plus a per-account jitter) and a dead
// session is remembered for the rest of the day instead of being re-asked
// ~48 times.
//
// Usage contract (auth.usage): Magpie draws a provider's card on its 观测 /
// 用量 page only when the plugin has this hook. It reads /alice/ug/campaign/
// v3/detail/ — the call check-in already makes, through fetchWithCooldown, so
// a cooldown sends nothing — and answers { plan, windows, signIn } with one
// 体验额度 window. Failures are answered, never thrown: { error, signIn }.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

import {
  DOUBAO_UA,
  RISK_CODES,
  anthropicSSE,
  buildPayload,
  chatHeaders,
  chatURL,
  foldHistory,
  textOf,
} from "./lib/chat.mjs"

import { isClientDebuggable, harvestClientCookies, attemptClientInstall, openDownloadPage } from "./lib/client-checkin.mjs"
import { claimRewards } from "./lib/rewards.mjs"
import { claimableCredit, diffClaims } from "./lib/campaign.mjs"
import { sweepRewards, summarizeSweep, TASK_MODES } from "./lib/sweep.mjs"
import { diagnoseClient, stageLabel } from "./lib/client-status.mjs"
import { launchBrowserLogin, findBrowserBinary } from "./lib/browser-login.mjs"

// Whether the plugin should drive the desktop client to claim the daily
// credit itself (built-in auto-check-in). Set by the provider config UI
// (default on) and overridable off with DOUBAO_AUTO_CHECKIN=0. The plugin
// only *attaches* to an already-running, debug-enabled client — it never
// spawns the GUI — so this stays safe in headless/CI and unit tests.
let autoCheckinEnabled = process.env.DOUBAO_AUTO_CHECKIN !== "0"

// Whether check-in may also *launch* the client when it is installed but not
// running. On by default for real users — "installed but closed" is the single
// most common reason a claim silently does nothing. A client that is running
// without the debug port is never killed: that needs the user's explicit
// --force, since killing a live session mid-work is rude.
let autoLaunchClient = process.env.DOUBAO_CLIENT_AUTOLAUNCH !== "0"

// How hard the *first* sweep tries to actually earn the +100 tasks:
//   off   — claim only
//   probe — run one task to learn whether this path credits at all, then stop
//   full  — run every drivable task (capped by DOUBAO_MAX_TASK_TURNS, spends
//           quota on each)
// Later sweeps never run tasks; the setting only shapes the install-time pass.
// Default `full`: "installed it, it found the claimable tasks and went and did
// them" is the whole promise. Each turn is cut the moment its task flips to
// 可领取, so the bill is one short answer per task, not a full document.
let firstRunTaskMode = TASK_MODES.includes(process.env.DOUBAO_FIRST_RUN_TASKS)
// How hard EVERY check-in (not just the first) tries to earn the +100 tasks.
// Default `full` so a drained campaign isn't the only thing that gets attention:
// the sweep only ever drives tasks still at status 1, so a spent campaign is
// free. Overridden by the `autoTasksDaily` setting (see the plugin's config).
let dailyTaskMode = "full"

const DETAIL_URL = "https://www.doubao.com/alice/ug/campaign/v3/detail/"
const CHECKIN_URL = "https://www.doubao.com/alice/ug/campaign/landing/checkin"
const ACTIVITY_URL = "https://www.doubao.com/pc/agent-explore"
const CAMPAIGN_GROUP = "pc_incentive_task_mvp_v3"
// The check-in endpoint's answer to every external caller since the campaign
// moved into the desktop app. Not a session problem: re-signing in changes
// nothing, which is why it settles the day rather than retrying.
const SIGNIN_UNAVAILABLE = 710010702
const LOGIN_INVALID = 710012001

// The web bundle's own header constants; the chat endpoint reads the same
// ones as the campaign endpoints, so one table serves both.
const CLIENT_UA = DOUBAO_UA
const COMMON_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "web",
  aid: "497858",
  real_aid: "497858",
  pkg_type: "release_version",
  pc_version: "2.32.6",
  doubao_pc_version: "5.72.66",
  samantha_web: "1",
  web_platform: "desktop",
  "use-olympus-account": "1",
  web_tab_id: "0",
}

// How much of one account the vendor serves at a time. Declared, not
// enforced by the plugin: magpie queues each agent's requests by it, so the
// vendor sees the shape of its own client rather than five sessions at once —
// which is what actually gets an account marked.
const MAX_CONCURRENCY = 1

// The real consumer model lineup, reverse-engineered from the Doubao desktop
// client's own control-plane traffic (`mode_switch/report` and
// `thinkmode_memory_report`). Findings:
//
//   * `bot_id` is CONSTANT across every model (`7338286299411103781`). It does
//     NOT select the model — the earlier "one bot_id per model" idea was wrong.
//   * a model is identified by `model_item_key` (+ numeric `item_id`):
//         自动              -> "9"            (item_id "9")
//         豆包 2.1 Lite     -> "seed-lite-7b" (item_id "10001")
//         豆包 2.1 Pro 升级  -> upgrade-only: the client fires `升级`/`订阅`
//                              instead of switching, i.e. it needs a paid plan.
//                              This account is on 体验套餐, so it cannot switch
//                              to Pro yet.
//   * `mode_id: "3"` is the chat *mode* (constant); `agent_mode: 1` and
//     `model_reasoning_effort: 4` (中) ride along with the model.
//   * deep-thinking rides on `completion_option.use_deep_think` plus
//     `need_deep_think` / `cot_switch` = 10001 (captured earlier); normal = 9.
//
// `switch` keeps the captured `model_item_key`/`item_id` per model as a
// reference (auto "9", Lite "seed-lite-7b"). It is NOT wired into the request:
// the web `/samantha/chat/completion` endpoint demonstrably ignores per-message
// model selection (a bogus key still returns 200 with the constant `bot_id`),
// so the model is the account / conversation default. `reasoning` is real and
// does drive `completion_option.use_deep_think`.
const DOUBAO_BOT_ID = "7338286299411103781" // constant across every consumer model
const MODELS = {
  "doubao-auto": {
    id: "doubao-auto",
    name: "豆包 (自动)",
    reasoning: false,
    switch: { modelItemKey: "9", itemId: "9", modeId: "3", agentMode: 1, reasoningEffort: 4 },
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 256000, output: 8192 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  "doubao-2.1-lite": {
    id: "doubao-2.1-lite",
    name: "豆包 2.1 Lite",
    reasoning: false,
    switch: { modelItemKey: "seed-lite-7b", itemId: "10001", modeId: "3", agentMode: 1, reasoningEffort: 4 },
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 256000, output: 8192 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  "doubao-2.1-pro": {
    id: "doubao-2.1-pro",
    name: "豆包 2.1 Pro (升级)",
    reasoning: false,
    // Upgrade/subscription-gated on this account — key unknown, so this falls
    // back to the account default until a paid plan is active and a key is
    // captured with lib/capture-models.mjs --live.
    switch: { modelItemKey: "", itemId: "", modeId: "3", agentMode: 1, reasoningEffort: 4, upgradeOnly: true },
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 256000, output: 32768 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  "doubao-2.1-pro-deep": {
    id: "doubao-2.1-pro-deep",
    name: "豆包 2.1 Pro (深度思考)",
    reasoning: true,
    switch: { modelItemKey: "", itemId: "", modeId: "3", agentMode: 1, reasoningEffort: 4, deepThink: true },
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 256000, output: 32768 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
}

// ---------------------------------------------------------------------------
// Local ledger. Only timestamps and enums, never a cookie or a token.
// ~/.config/magpie/<provider>-state.json, deliberately NOT the host's
// plugin-auth.json (credentials) nor plugin-checkin.json.
// ---------------------------------------------------------------------------

const STATE_VERSION = 1
const STATE_TTL_MS = 30 * 86_400_000

function statePath(provider) {
  const override = process.env[`MAGPIE_${provider.toUpperCase()}_STATE`]
  if (override) return override
  const dir = process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/magpie` : `${homedir()}/.config/magpie`
  return `${dir}/${provider}-state.json`
}

// Reads on every call: the GUI and the CLI may be two processes, an in-memory
// cache would overwrite the other side's writes.
function stateRead(provider) {
  try {
    const v = JSON.parse(readFileSync(statePath(provider), "utf8"))
    if (v && typeof v === "object" && typeof v.accts === "object") return v
  } catch {}
  return { v: STATE_VERSION, accts: {} }
}

// Temp file + rename so a concurrent write never leaves half a file; 0600 to
// match the other magpie files. Entries unseen for 30 days are dropped.
function stateWrite(provider, st) {
  try {
    const now = Date.now()
    for (const [k, v] of Object.entries(st.accts)) {
      const t = Date.parse(v?.seenAt ?? "")
      if (Number.isFinite(t) && now - t > STATE_TTL_MS) delete st.accts[k]
    }
    const p = statePath(provider)
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: STATE_VERSION, accts: st.accts }), { mode: 0o600 })
    renameSync(tmp, p)
  } catch {}
  return st
}

function stateUpdate(provider, fn) {
  const st = stateRead(provider)
  try {
    fn(st.accts)
  } catch {
    return st
  }
  return stateWrite(provider, st)
}

// Sign-in results are keyed by sign-in key, never by display name (magpie
// plugins#254: with duplicate names only the first account gets signed in).
function accountKeyOf(provider, auth) {
  const uid = String(auth?.uid ?? "").trim()
  if (uid) return `uid:${uid}`
  const secret = String(auth?.key ?? auth?.refresh ?? "")
  return `${provider}:${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`
}

// Doubao's web session is a cookie, not a bearer token. A full cookie string
// (`name=value; name=value; …`, what `document.cookie` gives) is sent as it
// is. A bare JWT is sent as `sessionid=`, but Doubao answers 710012000 "user
// invalid" for it: the session lives in a set of cookies, and one alone is
// not one.
function cookieOf(auth) {
  const full = String(auth?.metadata?.cookie ?? auth?.cookie ?? "").trim()
  if (full.includes("=")) return full
  const key = String(auth?.key ?? full ?? "").trim()
  if (!key) return ""
  return key.includes("=") ? key : `sessionid=${key}`
}

// The csrf header Doubao's page sends beside the cookie. Taken from the jar
// when the user pasted one that has it; empty otherwise, which the endpoint
// accepts.
function csrfOf(cookie) {
  const m = /(?:^|;\s*)(?:passport_csrf_token|passport_csrf_token_default)=([^;]+)/.exec(cookie ?? "")
  return m ? m[1].trim() : ""
}

// ---------------------------------------------------------------------------
// 429 / Retry-After / full-jitter backoff
// ---------------------------------------------------------------------------

const RETRY_AFTER_CAP_MS = 10 * 60_000

// Upstream Retry-After is not passed through to the agent (magpie writes that
// header itself), so the plugin has to read and honour it.
function retryAfterMs(res) {
  const h = res.headers.get("retry-after")
  if (!h) return 0
  const n = Number(h)
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, RETRY_AFTER_CAP_MS)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.min(Math.max(0, t - Date.now()), RETRY_AFTER_CAP_MS) : 0
}

// Full jitter: 0..min(cap, base*2^attempt). Un-jittered backoff only turns
// "everyone retries at once" into "everyone retries at once, later".
function backoffMs(attempt, base = 800, cap = 8000) {
  return Math.round(Math.random() * Math.min(cap, base * 2 ** attempt))
}

// 3 tries, at most 2s of sleeping: when the vendor says "come back in 2
// minutes" we record a cooldown instead of hanging the hook for 2 minutes.
async function fetchWithCooldown(provider, accountKey, doFetch, { tries = 3, maxWaitMs = 2000 } = {}) {
  const until = Date.parse(stateRead(provider).accts[accountKey]?.cooldownUntil ?? "")
  if (Number.isFinite(until) && Date.now() < until) return { skipped: true, retryAt: new Date(until).toISOString() }
  let res
  for (let attempt = 0; attempt < tries; attempt++) {
    res = await doFetch()
    if (res.status !== 429 && res.status < 500) return { res }
    const wait = retryAfterMs(res) || backoffMs(attempt)
    if (attempt === tries - 1 || wait > maxWaitMs) {
      stateUpdate(provider, (accts) => {
        accts[accountKey] = { ...(accts[accountKey] ?? {}), cooldownUntil: new Date(Date.now() + wait).toISOString(), seenAt: new Date().toISOString() }
      })
      return { res, cooled: true }
    }
    await new Promise((r) => setTimeout(r, wait))
  }
  return { res }
}

// ---------------------------------------------------------------------------
// Day boundary and per-account jitter
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const JITTER_MAX_MS = 15 * 60_000

// Doubao's day rolls over at Beijing midnight (the campaign is per natural
// day). `until` is the host's supported scheduling knob: "done for today, ask
// again after this instant".
function nextBeijingMidnight(now = Date.now()) {
  const dayStart = Math.floor((now + 8 * 3600_000) / DAY_MS) * DAY_MS
  return dayStart + DAY_MS - 8 * 3600_000
}

// Per-account fixed offset: the same account always lands on the same minute,
// so a restart does not reshuffle it. 15 minutes of spread keeps multiple
// accounts from waking in the same second.
function jitterOf(accountKey) {
  return createHash("sha256").update(`doubao-jitter:${accountKey}`).digest().readUInt32BE(0) % JITTER_MAX_MS
}

// Only for claimed / done / ineligible / inactive. Never for failed: that
// would swallow the "retry in 30 minutes" the host does for real errors.
function settled(accountKey) {
  return { until: new Date(nextBeijingMidnight() + jitterOf(accountKey)).toISOString() }
}

function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Login pages, verification challenges and risk-control walls come back as
// HTML (or a JSON error) rather than the campaign payload.
const AUTH_FAIL_TEXT =
  /(请(重新)?登录|登录(已)?失效|登录状态|未登录|请完成验证|安全验证|人机验证|验证码|captcha|unusual activity|account restricted|风控|账号异常|会话已失效)/i

function deviceIdsFor(deviceSeed) {
  const seed = createHash("sha256").update(`doubao-dev:${deviceSeed || "anonymous"}`).digest()
  const webId = "76" + [...seed.subarray(0, 8)].map((b) => b % 10).join("")
  const teaUuid = [...seed.subarray(8, 16)].map((b) => b % 10).join("").padEnd(16, "7")
  return { web_id: webId, tea_uuid: teaUuid }
}

function apiUrl(base, deviceSeed) {
  const params = new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(deviceSeed), device_id: "", region: "", sys_region: "" })
  return base + "?" + params.toString()
}

async function postJson(url, cookie, body, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: String(cookie || ""),
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.doubao.com/pc/agent-explore",
        Origin: "https://www.doubao.com",
        "User-Agent": CLIENT_UA,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return res
  } finally {
    clearTimeout(t)
  }
}

// Never throw on a non-JSON body: a 429 or a login page is HTML.
async function readJson(res) {
  const text = await res.text()
  try {
    const v = JSON.parse(text)
    return { text, body: v && typeof v === "object" ? v : null }
  } catch {
    return { text, body: null }
  }
}

// A dead session, not a transient error: 401/403, the login business code, or
// the login/verification wording. Anything else (502 HTML, empty body) stays
// retryable after 30 minutes.
function blockedSignal(http, body, text) {
  if (http === 401 || http === 403) return true
  if (body && Number(body.code) === LOGIN_INVALID) return true
  if (body && Number(body.code) === 0) return false
  const hay = body ? `${body.msg ?? ""} ${body.message ?? ""}` : String(text ?? "").slice(0, 4000)
  return AUTH_FAIL_TEXT.test(hay)
}

function fuseAuthExpired(accountKey) {
  stateUpdate("doubao", (accts) => {
    accts[accountKey] = { ...(accts[accountKey] ?? {}), authExpiredOn: beijingDay(), seenAt: new Date().toISOString() }
  })
}

// ---------------------------------------------------------------------------
// Install-time sweep bookkeeping
// ---------------------------------------------------------------------------

// A completed first sweep is recorded so it never runs again for this account
// (the +100 tasks cost quota; re-running them daily would be a slow leak).
function markFirstRun(accountKey, report) {
  stateUpdate("doubao", (accts) => {
    const prev = accts[accountKey] ?? {}
    accts[accountKey] = {
      ...prev,
      firstRunAt: report.at,
      firstRunCredit: report.credit || 0,
      firstRunTasks: (report.tasks ?? []).map((t) => ({ code: t.code, action: t.action, earned: Boolean(t.earned) })),
      lastSweepAt: report.at,
      lastSweepSummary: summarizeSweep(report),
      seenAt: new Date().toISOString(),
    }
  })
}

// A sweep that never reached the client is retried — but only a few times a
// day. Without the cap, a machine that simply has no client (or has it closed
// all day) would be re-asked, and would try to launch one, every 30 minutes.
function bumpClientTry(accountKey) {
  stateUpdate("doubao", (accts) => {
    const prev = accts[accountKey] ?? {}
    const sameDay = prev.triesDay === beijingDay()
    accts[accountKey] = {
      ...prev,
      triesDay: beijingDay(),
      tries: sameDay ? (Number(prev.tries) || 0) + 1 : 1,
      seenAt: new Date().toISOString(),
    }
  })
}

// Every later sweep leaves a one-line trace for the account panel.
function rememberSweep(accountKey, report) {
  stateUpdate("doubao", (accts) => {
    const prev = accts[accountKey] ?? {}
    accts[accountKey] = {
      ...prev,
      lastSweepAt: report.at,
      lastSweepSummary: summarizeSweep(report),
      seenAt: new Date().toISOString(),
    }
  })
}

// The chat endpoint's own ids: one conversation per account, kept so a second
// turn continues rather than starting over. The host has no field for it, so
// it lives in the ledger beside the cooldowns.
function conversationOf(accountKey) {
  return String(stateRead("doubao").accts[accountKey]?.conversationId ?? "")
}

function rememberConversation(accountKey, id) {
  if (!id) return
  stateUpdate("doubao", (accts) => {
    accts[accountKey] = { ...(accts[accountKey] ?? {}), conversationId: id, seenAt: new Date().toISOString() }
  })
}

function findCheckinTask(body) {
  const tasks = body?.data?.tasks
  if (!Array.isArray(tasks)) return null
  return tasks.find((t) => t && t.task_kind === "daily_signin") || null
}

// compact is a count as the card's display says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// `recommend_prompts` arrives as an array of *JSON strings* (double-encoded),
// each one { skill_name, show_prompt, prompt }. Tolerate plain objects too and
// never throw: one malformed entry must not blank out the whole panel.
function recommendPromptsOf(task) {
  const raw = Array.isArray(task?.recommend_prompts) ? task.recommend_prompts : []
  const out = []
  for (const item of raw) {
    let p = item
    if (typeof item === "string") {
      try {
        p = JSON.parse(item)
      } catch {
        p = { prompt: item }
      }
    }
    if (!p || typeof p !== "object") continue
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : ""
    if (!prompt) continue
    out.push({
      prompt,
      title: typeof p.show_prompt === "string" ? p.show_prompt : "",
      // The concrete skill the campaign expects to see invoked. Empty means the
      // task is judged on the artifact alone (GenWord / GenPPT / …).
      skill: typeof p.skill_name === "string" ? p.skill_name : "",
    })
  }
  return out
}

async function fetchDoubaoStatus(cookie, accountKey, deviceSeed) {
  const r = await fetchWithCooldown("doubao", accountKey, () => postJson(apiUrl(DETAIL_URL, deviceSeed), cookie, { campaign_group_code: CAMPAIGN_GROUP }))
  if (r.skipped) return { cooling: true, retryAt: r.retryAt, checkin: null, totalAmount: 0 }
  const res = r.res
  const http = res.status
  const { text, body } = await readJson(res)
  if (blockedSignal(http, body, text)) return { http, loginInvalid: true, checkin: null, totalAmount: 0 }
  // Rate limited or upstream broken: say so. An empty/odd body must never be
  // read as "this account has no check-in task".
  if (http === 429) return { http, cooling: true, checkin: null, totalAmount: 0 }
  if (http >= 500) return { http, unexpected: true, code: `HTTP ${http}`, checkin: null, totalAmount: 0 }
  if (!body) return { http, unexpected: true, code: `HTTP ${http}`, checkin: null, totalAmount: 0 }
  if (Number(body.code) !== 0) return { http, unexpected: true, code: `code ${body.code}`, checkin: null, totalAmount: 0 }
  const task = findCheckinTask(body)
  const c = task?.daily_checkin || {}
  const daily = Number(c.reward?.reward_amount) || 0
  return {
    http,
    auth: true,
    code: Number(body.code),
    checkin: task
      ? {
          checkedIn: c.checked_in_today === true,
          continuousDays: Number(c.continuous_days) || 0,
          totalDays: Number(c.total_days) || 0,
          lastDate: typeof c.last_checkin_date === "string" ? c.last_checkin_date : null,
          rewardAmount: daily,
        }
      : null,
    totalAmount: Number(body.data?.progress?.total_amount) || 0,
    // Everything else the activity page can pay out. task_status semantics as
    // observed on a live account (2026-11-02): 0 = 未开放（如需企业认证的团队版）,
    // 1 = 未完成（去完成）, 2 = 已完成待领取, 3 = 已领取. Only 2 is money on the
    // table, which is exactly what the claim engine targets.
    milestones: (Array.isArray(body.data?.milestones) ? body.data.milestones : [])
      .filter((m) => m && m.task_kind === "points_milestone")
      .map((m) => ({
        // campaign_code matches the page card's data-reward-code byte for byte
        // (verified 2026-11-02), which is what lets the claim engine click the
        // exact card this tier belongs to instead of guessing from page text.
        code: String(m.campaign_code ?? ""),
        threshold: Number(m.milestone_threshold) || 0,
        status: Number(m.task_status),
        reward: Number(m.reward_summaries?.[0]?.reward_amount) || 0,
        title: typeof m.title === "string" ? m.title : "",
      })),
    tasks: (Array.isArray(body.data?.tasks) ? body.data.tasks : [])
      .map((t) => ({
        code: String(t.campaign_code ?? ""),
        kind: String(t.task_kind ?? ""),
        status: Number(t.task_status),
        reward: Number(t.reward_summaries?.[0]?.reward_amount) || 0,
        title: typeof t.title === "string" ? t.title : "",
        // How the campaign decides this task: a server-side feature-usage flag
        // (GenWord / GenExcel / GenPPT / skill_use / SkillUsed / WorkTaskMode /
        // PCUsed / ScheduleSkill). It is the single best hint for what the
        // plugin has to actually make Doubao do — see lib/task-runner.mjs.
        type: String(t.campaign_type ?? ""),
        // Doubao's own suggested prompts. Using them beats inventing one: the
        // campaign's credit check is tied to the feature they exercise, and a
        // self-written prompt can miss it entirely (that is how the earlier
        // skill attempts earned nothing).
        prompts: recommendPromptsOf(t),
      })),
  }
}

// Credit already earned but not yet collected (claimable milestone tiers plus
// an unclaimed daily sign-in) and the server-side proof of what landed both
// live in lib/campaign.mjs — one implementation shared with the first-run
// sweep, so "已签到" and "还有待领" can never disagree between the two paths.
// The re-read-after-click loop lives in lib/sweep.mjs, beside the clicks it
// verifies.

async function checkinDoubao(cookie, accountKey, deviceSeed) {
  const seen = stateRead("doubao").accts[accountKey] ?? {}

  // Already known dead today: do not touch the endpoint again. The host would
  // otherwise re-ask with the same dead cookie every 30 minutes (~48/day).
  // A re-captured cookie changes accountKey, so this self-heals.
  if (seen.authExpiredOn === beijingDay()) {
    return { outcome: "failed", message: "豆包会话已失效（今日不再重试），请重新登录后重新捕获 Cookie" }
  }
  const coolingUntil = Date.parse(seen.cooldownUntil ?? "")
  if (Number.isFinite(coolingUntil) && Date.now() < coolingUntil) {
    return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  }

  const st = await fetchDoubaoStatus(cookie, accountKey, deviceSeed)
  if (st.loginInvalid) {
    fuseAuthExpired(accountKey)
    return { outcome: "failed", message: "豆包会话已失效，请重新登录后重新捕获 Cookie" }
  }
  if (st.cooling) return { outcome: "failed", message: "豆包暂时限流（本地冷却中），稍后自动重试" }
  if (st.unexpected) return { outcome: "failed", message: `豆包接口异常（${st.code}）` }
  if (!st.checkin) return { outcome: "ineligible", message: "当前账号无签到任务（活动未开放或企业账号不支持）", ...settled(accountKey) }
  const enabled = autoCheckinEnabled && process.env.DOUBAO_AUTO_CHECKIN !== "0"
  // The install-time pass. A brand-new account has never been swept, so the
  // first check-in after install does more than sign in: it claims everything
  // already earned *and* tries the +100 tasks once (see lib/sweep.mjs). That is
  // what "install it and it does the work" means in practice.
  const firstRun = enabled && !seen.firstRunAt
  // How many times today we already tried to reach the client. Capped, so a
  // machine without one is not retried every 30 minutes all day (and does not
  // try to launch one each time).
  const triesToday = seen.triesDay === beijingDay() ? Number(seen.tries) || 0 : 0
  const maxTries = 4
  const triesExhausted = triesToday >= maxTries

  // Already signed and nothing else is collectable → settle the day. When a
  // milestone tier has been reached but never collected we still go into the
  // client: that is credit already earned, and "已签到" must not hide it. Same
  // for the first run: an account that signed in by hand still needs its
  // install-time sweep.
  if (st.checkin.checkedIn && claimableCredit(st) === 0 && !firstRun) {
    return { outcome: "done", streak: st.checkin.continuousDays, message: "今天已签到", ...settled(accountKey) }
  }
  if (triesExhausted && claimableCredit(st) > 0) {
    const diag = await diagnoseClient().catch(() => null)
    return {
      outcome: "ineligible",
      message: `今天已尝试 ${triesToday} 次仍无法连接豆包客户端（${stageLabel(diag?.stage)}），待领取的奖励留到明天。装好并登录客户端后，插件会自动完成签到与领取。`,
      url: ACTIVITY_URL,
      client: diag ? { stage: diag.stage, port: diag.port, version: diag.version, fix: diag.fix } : undefined,
      ...settled(accountKey),
    }
  }

  // 实测结论（2026-11-02）：用 Playwright 自带 chromium 注入真实登录 cookie 打开
  // agent-explore，页面只渲染「该活动仅支持在豆包电脑版参与 / 去下载」占位页，
  // 不渲染任何签到卡片，也不请求 detail 接口。即豆包把该签到活动
  // (pc_incentive_task_mvp_v3) 前端硬锁在「豆包电脑客户端（桌面版）webview」环境，
  // 纯网页浏览器（任何 UA、任何 cookie）都进不去。因此：
  //   - 读状态 / 对话：仅需登录 cookie（plugin-auth.json），无需客户端；
  //   - 签到领取：必须在已安装的豆包电脑客户端内完成——插件经 CDP 控制客户端
  //     webview 真实点击「立即领取」。纯接口 POST 与纯网页点击均被拒
  //     (710010702 / 占位页)。绝不从此处裸 POST，只展示实时状态并导向客户端。
  // The write endpoint refuses every external caller (710010702) and the web
  // page only shows "该活动仅支持在豆包电脑版参与", so the claim has to be
  // driven inside the real desktop client. When built-in auto-check-in is on
  // we do exactly that: attach to an already-running, debug-enabled client and
  // click "立即领取". Anything that is not "the client successfully claimed
  // it" falls through to the guidance below. (Verified 2026-11-02: a Playwright
  // chromium with the real cookie still only sees the "去下载" placeholder, so
  // the client's own webview is the only working surface.)
  //
  // Confirmation is done server-side, NOT in-page: the embedded webview's JS
  // cannot see its own HttpOnly session cookies (document.cookie carries no
  // sessionid — verified 2026-11-02), so an in-page fetch reads as anonymous
  // and always reports checked_in_today:false. After the click we re-read the
  // campaign with the real auth cookie the plugin already holds; that reflects
  // the claim authoritatively.
  if (enabled) {
    // The env switch is read here, not only in config(): a host (or a test)
    // that never calls config() must still be able to forbid launching a GUI.
    const allowClient = autoLaunchClient && process.env.DOUBAO_CLIENT_AUTOLAUNCH !== "0"
    // One sweep, shared with the install-time pass: bring the client to an
    // attachable state (launch it, or restart it with the debug port), claim
    // every earned reward, and — on the first run only — try the +100 tasks
    // once. lib/sweep.mjs owns the order and the guards; this function only
    // decides what the outcome means for the host's retry schedule.
    const report = await sweepRewards({
      port: Number(process.env.DOUBAO_CDP_PORT ?? 9333),
      allowRestart: allowClient,
      allowLaunch: allowClient,
      taskMode: enabled ? (firstRun ? firstRunTaskMode : dailyTaskMode) : "off",
      readStatus: () => fetchDoubaoStatus(cookie, accountKey, deviceSeed),
      readTaskStatus: async (code) => {
        const s = await fetchDoubaoStatus(cookie, accountKey, deviceSeed)
        return (s?.tasks ?? []).find((t) => t.code === code)?.status ?? null
      },
    }).catch((e) => ({
      ok: false,
      clientReady: false,
      credit: 0,
      claimed: [],
      clicked: [],
      tasks: [],
      notes: [`清扫失败：${e?.message ?? e}`],
      at: new Date().toISOString(),
    }))

    // A first run only *completes* when the client was actually reachable;
    // otherwise it stays open and the next check-in tries again.
    if (firstRun && report.ok) markFirstRun(accountKey, report)
    else if (!firstRun) rememberSweep(accountKey, report)

    const tail = report.notes?.length ? `（${report.notes.join("；")}）` : ""

    if (report.credit > 0) {
      const detail = report.claimed.map((g) => `${g.label} +${g.credit}`).join("、")
      return {
        outcome: "claimed",
        credit: report.credit,
        message: `${firstRun ? "首次安装扫描完成" : "已自动领取"}：${detail} ✅（合计 +${report.credit}）${tail}`,
        ...settled(accountKey),
      }
    }
    if (report.ok && report.clicked.length) {
      // Clicked, but the server has not acknowledged yet. Stay retryable:
      // settling here would silently skip the grant for the whole day.
      return {
        outcome: "failed",
        message: `已点击「${report.clicked.join("」「")}」但豆包接口未确认，30 分钟后自动重试（也可在客户端手动补点）`,
      }
    }
    if (report.ok && report.targets?.length) {
      // Client was reachable but the page never rendered the card we needed
      // (still loading, or the client is not signed in to this account).
      return {
        outcome: "failed",
        message:
          "豆包客户端已连接，但活动页暂未出现可点击的签到/领取按钮，30 分钟后自动重试" +
          (report.notes?.length ? `（${report.notes.join("；")}）` : "（也可在客户端手动补点）"),
      }
    }
    if (report.ok) {
      return {
        outcome: "done",
        streak: st.checkin.continuousDays,
        // The first run gets the full picture; an ordinary day only needs the
        // two facts the user cares about.
        message: firstRun
          ? `首次安装扫描完成：${summarizeSweep(report)}${tail}`
          : `今天已签到 · 累计 ${report.total ?? st.totalAmount} 点`,
        ...settled(accountKey),
      }
    }
    // report.ok === false → the client is not attachable.
    if (st.checkin.checkedIn && claimableCredit(st) === 0) {
      // Nothing is waiting to be collected, so a retry buys nothing: settle as
      // signed and leave the first-run sweep pending, to be finished on a day
      // when the client happens to be up.
      return {
        outcome: "done",
        streak: st.checkin.continuousDays,
        message: firstRun ? "今天已签到 · 首次福利扫描会在豆包客户端可用时自动补做" : "今天已签到",
        ...settled(accountKey),
      }
    }
    // There IS credit waiting, so this has to stay retryable (the host comes
    // back in 30 minutes) — but only until the daily cap, after which the
    // guidance below settles the day instead of asking forever.
    bumpClientTry(accountKey)
    if (triesToday + 1 < maxTries) {
      const stage = report.client?.stage && report.client.stage !== "unknown"
        ? stageLabel(report.client.stage)
        : "客户端不可用"
      return {
        outcome: "failed",
        message: `豆包客户端尚不可用（${stage}），30 分钟后自动重试。${report.notes?.length ? report.notes.join("；") : ""}`,
      }
    }
  }

  // Stage-aware guidance: "installed but closed", "running without the debug
  // port" and "not installed" need three different actions, and a single
  // generic line makes all three feel like the plugin is broken.
  const diag = enabled ? await diagnoseClient().catch(() => null) : null
  let why
  if (!enabled) {
    why = "豆包签到活动仅支持在豆包电脑版客户端内参与（网页端只显示「去下载」）。请在豆包客户端进入活动页点击「立即领取」领取额度；或在插件设置开启「自动签到」由插件代签。"
  } else if (!diag || diag.stage === "not-installed") {
    why = "豆包电脑客户端未安装，而签到活动只在客户端内开放（网页端只显示「去下载」）。装好客户端并登录后，插件会自动代签并领取累计奖励。"
  } else if (diag.stage === "running-no-debug") {
    why = `豆包客户端在运行，但没有开启远程调试端口 ${diag.port}，插件无法附着。运行 \`node packages/doubao/ensure-doubao.mjs --force\` 重启客户端即可（之后的签到会自动完成）。`
  } else if (diag.stage === "not-running") {
    why = `豆包客户端已安装但没能启动（${diag.hint}）。手动打开豆包并登录后，插件会自动代签。`
  } else {
    why = `豆包客户端${stageLabel(diag.stage)}，插件未能完成签到。运行 \`${diag.fix ?? "node packages/doubao/ensure-doubao.mjs"}\` 后会自动重试。`
  }
  return {
    outcome: "ineligible",
    message: why,
    url: ACTIVITY_URL,
    client: diag ? { stage: diag.stage, port: diag.port, version: diag.version, fix: diag.fix } : undefined,
    ...settled(accountKey),
  }
}

// ---------------------------------------------------------------------------
// Chat: Anthropic Messages in, Doubao's stream out
// ---------------------------------------------------------------------------

// The agent's request, as one Doubao turn. `model` picks the mode; everything
// else is folded by lib/chat.mjs.
function chatRequest(body, { cookie, csrfToken, accountKey, deviceSeed, model }) {
  const ids = deviceIdsFor(deviceSeed)
  // The web endpoint ignores per-message model selection (see lib/chat.mjs
  // buildPayload note), so a model only contributes its reasoning flag; the
  // actual model is the account / conversation default.
  const m = MODELS[String(model ?? "")] ?? {}
  const deepThink = m.reasoning ? 1 : 0
  const text = foldHistory({
    system: body.system,
    messages: body.messages ?? [],
    tools: body.tools ?? [],
  })
  const payload = buildPayload({
    text,
    deepThink,
    conversationId: conversationOf(accountKey),
  })
  return {
    url: chatURL({ deviceId: ids.tea_uuid, webId: ids.web_id }),
    headers: chatHeaders({ cookie, csrfToken }),
    payload,
  }
}

async function chatFetch(input, init, { getAuth, provider }) {
  const auth = await getAuth()
  const cookie = cookieOf(auth)
  if (!cookie) throw new Error("not signed in to Doubao: no cookie captured")
  const accountKey = accountKeyOf("doubao", auth)
  const seen = stateRead("doubao").accts[accountKey] ?? {}
  if (seen.authExpiredOn === beijingDay()) {
    throw new Error("doubao session expired earlier today; sign in again with a fresh cookie")
  }

  const req = input instanceof Request ? input : new Request(String(input), init)
  let body = {}
  try {
    body = JSON.parse(await req.text() || "{}")
  } catch {
    body = {}
  }

  // Only the chat endpoint is served here; a models read is answered from the
  // static table rather than sent upstream, which has no such endpoint.
  const path = new URL(req.url, "https://www.doubao.com").pathname
  if (path.endsWith("/models")) {
    return Response.json({ object: "list", data: Object.values(MODELS) })
  }

  const model = body.model ?? provider?.id ?? "doubao"
  const { url, headers, payload } = chatRequest(body, {
    cookie,
    csrfToken: csrfOf(cookie),
    accountKey,
    deviceSeed: String(auth?.uid ?? ""),
    model,
  })

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (res.status === 401 || res.status === 403) {
    fuseAuthExpired(accountKey)
    throw new Error(`doubao refused the session (HTTP ${res.status}); sign in again with a fresh cookie`)
  }
  if (res.status === 429) {
    stateUpdate("doubao", (accts) => {
      accts[accountKey] = { ...(accts[accountKey] ?? {}), cooldownUntil: new Date(Date.now() + RETRY_AFTER_CAP_MS).toISOString(), seenAt: new Date().toISOString() }
    })
    throw new Error("doubao is rate-limiting this account; backing off")
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`doubao answered HTTP ${res.status}: ${t.slice(0, 200)}`)
  }

  // A JSON error instead of a stream: the session died between the reads.
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("text/event-stream")) {
    const t = await res.text().catch(() => "")
    let code = 0
    try { code = Number(JSON.parse(t)?.code) || 0 } catch {}
    if (RISK_CODES.has(code)) fuseAuthExpired(accountKey)
    throw new Error(`doubao answered no stream (HTTP ${res.status}, code ${code}): ${t.slice(0, 200)}`)
  }

  return new Response(anthropicSSE(res.body, {
    model,
    onConversation: (id) => rememberConversation(accountKey, id),
  }), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

export const DoubaoAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.doubao ??= {}
    const p = config.provider.doubao
    p.name ??= "Doubao"
    p.npm ??= "@ai-sdk/anthropic"
    p.api ??= "https://www.doubao.com/samantha"
    p.models = { ...MODELS, ...(p.models ?? {}) }
    // Built-in auto-check-in: when on, checkin() drives the desktop client to
    // claim the daily credit. The user toggles this in the provider settings.
    p.autoCheckin ??= true
    autoCheckinEnabled = p.autoCheckin !== false
    // Launch the client when it is installed but closed. Off means "only ever
    // attach to a client I started myself".
    p.autoLaunchClient ??= true
    // DOUBAO_CLIENT_AUTOLAUNCH=0 is a hard off switch — it also stops the
    // restart-with-debug-port path. Tests and headless hosts use it so a probe
    // never spawns or kills a GUI.
    autoLaunchClient = p.autoLaunchClient !== false && process.env.DOUBAO_CLIENT_AUTOLAUNCH !== "0"
    // How hard the install-time sweep tries to earn the +100 tasks:
    //   "off"   claim only
    //   "probe" run one task to see whether the path credits at all, then stop
    //   "full"  run every drivable task on the activity page, every check-in
    // First-run and daily use separate knobs so a cautious install can still
    // probe once while daily runs stay aggressive (or vice-versa).
    p.autoTasks ??= firstRunTaskMode
    firstRunTaskMode = TASK_MODES.includes(p.autoTasks) ? p.autoTasks : "full"
    // How hard EVERY check-in (not just the first) tries to earn the +100 tasks.
    // "off" claim only; "probe" one task; "full" run every doable task. Defaults
    // to full so the activity page is always drained of claimable credit.
    p.autoTasksDaily ??= "full"
    dailyTaskMode = TASK_MODES.includes(p.autoTasksDaily) ? p.autoTasksDaily : "full"
  },
  provider: {
    id: "doubao",
    // Static: the web account has one model and a deep-think switch, both
    // known here. There is no endpoint to ask, so a made-up "dynamic" list
    // would only ever be this table with extra failure modes.
    models: MODELS,
  },
  auth: {
    provider: "doubao",
    maxConcurrency: MAX_CONCURRENCY,
    async loader(getAuth, provider) {
      const auth = await getAuth()
      const cookie = cookieOf(auth)
      if (!cookie) return {}
      return {
        baseURL: "https://www.doubao.com/samantha",
        apiKey: "doubao",
        async fetch(input, init) {
          return chatFetch(input, init, { getAuth, provider })
        },
      }
    },
    async checkin(getAuth) {
      const auth = await getAuth()
      const cookie = cookieOf(auth)
      if (!cookie) return { outcome: "failed", message: "未提供豆包会话 Cookie" }
      const accountKey = accountKeyOf("doubao", auth)
      // The device seed is NOT the ledger key: it must stay stable across a
      // cookie recapture, otherwise every re-capture looks like a new device.
      const deviceSeed = String(auth.uid ?? "")
      try {
        return await checkinDoubao(String(cookie), accountKey, deviceSeed)
      } catch (e) {
        // Network error / timeout: keep `failed` (a 30-minute retry is right
        // here) but say it was not the credential.
        return { outcome: "failed", message: `签到请求失败：${e?.message ?? e}` }
      }
    },
    // The account's experience credits, as the campaign panel reads them.
    // detail's progress.total_amount is the only count Doubao tells: a
    // running credit total with no denominator, so it is sent as magpie's
    // wallet-shaped window (balance, no share) rather than a made-up limit.
    async usage(getAuth) {
      const auth = await getAuth()
      const cookie = cookieOf(auth)
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("doubao", auth)
      const seen = stateRead("doubao").accts[accountKey] ?? {}
      // A fused day is answered from the ledger: a card is no reason to
      // spend a request on a session already known dead (0 requests today).
      if (seen.authExpiredOn === beijingDay()) {
        return { plan: "Web 体验额度", windows: [], error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
      }
      const cooling = Date.parse(seen.cooldownUntil ?? "")
      if (Number.isFinite(cooling) && Date.now() < cooling) {
        return { plan: "Web 体验额度", windows: [], error: "豆包暂时限流（本地冷却中），稍后再查", signIn: "kept" }
      }
      try {
        const st = await fetchDoubaoStatus(String(cookie), accountKey, String(auth?.uid ?? ""))
        if (st.loginInvalid) {
          fuseAuthExpired(accountKey)
          return { plan: "Web 体验额度", windows: [], error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
        }
        if (st.cooling) return { plan: "Web 体验额度", windows: [], error: "豆包暂时限流（已进入本地冷却），稍后再查", signIn: "kept" }
        if (st.unexpected) return { plan: "Web 体验额度", windows: [], error: `豆包接口异常（${st.code}）`, signIn: "kept" }
        const credits = Number(st.totalAmount) || 0
        const windows = [
          { name: "体验额度", balance: credits, display: `${compact(credits)} credits`, unit: "credits" },
        ]
        if (st.checkin) {
          const c = st.checkin
          const reward = c.rewardAmount || 0
          windows.push({
            name: "今日签到",
            used: c.checkedIn ? 100 : 0,
            display: c.checkedIn
              ? `已签（连续 ${c.continuousDays} 天 · 累计 ${c.totalDays} 天 · 本次 +${reward}）`
              : `未签（待领 +${reward}）`,
            unit: "%",
            resetsAt: new Date(nextBeijingMidnight()).toISOString(),
            // 结构化字段，便于卡片/看板进一步消费「多少签到」
            streak: c.continuousDays,
            total: c.totalDays,
            rewardAmount: reward,
          })
        }
        return {
          plan: "Web 体验额度",
          windows,
          until: new Date(nextBeijingMidnight()).toISOString(),
          signIn: "kept",
        }
      } catch (e) {
        return { plan: "Web 体验额度", windows: [], error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    async getInfo(auth) {
      const cookie = cookieOf(auth)
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      const accountKey = accountKeyOf("doubao", auth)
      const seen = stateRead("doubao").accts[accountKey] ?? {}
      if (seen.authExpiredOn === beijingDay()) return { error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
      try {
        const st = await fetchDoubaoStatus(String(cookie), accountKey, String(auth?.uid ?? ""))
        if (st.loginInvalid) {
          fuseAuthExpired(accountKey)
          return { error: "会话已失效，请重新登录后重新捕获 Cookie", signIn: "expired" }
        }
        if (st.cooling) {
          return { plan: "Web 体验额度", windows: [], warning: "豆包暂时限流（已进入本地冷却），稍后再查", signIn: "kept" }
        }
        if (st.unexpected) return { error: `豆包接口异常（${st.code}）`, signIn: "kept" }
        const claimable = claimableCredit(st)
        // Tasks at status 1 still need real product usage (生成文档/PPT/表格…
        // 或客户端专属模式), so they are reported, never auto-run: each one costs
        // quota to produce, and paying quota to win quota is the user's call.
        const todo = (st.tasks ?? []).filter((t) => t.status === 1 && t.kind !== "daily_signin")
        const nextMilestone = (st.milestones ?? [])
          .filter((m) => m.status === 1)
          .sort((a, b) => a.threshold - b.threshold)[0]
        const gap = nextMilestone ? Math.max(0, nextMilestone.threshold - st.totalAmount) : 0
        // Where the desktop client stands. The claim path can only run inside
        // it, so "signed in but the panel says nothing" is usually this row.
        const diag = await diagnoseClient().catch(() => null)
        const windows = st.checkin
          ? [
              {
                name: "今日签到",
                total: 100,
                used: st.checkin.checkedIn ? 100 : 0,
                remaining: st.checkin.checkedIn ? 0 : 100,
                unit: "%",
                recurring: true,
                streak: st.checkin.continuousDays,
                totalDays: st.checkin.totalDays,
                rewardAmount: st.checkin.rewardAmount,
                display: st.checkin.checkedIn
                  ? `已签（连续 ${st.checkin.continuousDays} 天 · 累计 ${st.checkin.totalDays} 天 · 本次 +${st.checkin.rewardAmount}）`
                  : `未签（待领 +${st.checkin.rewardAmount}）`,
              },
              {
                name: "任务与奖励",
                total: 100,
                used: claimable > 0 ? 0 : 100,
                remaining: claimable > 0 ? 100 : 0,
                unit: "%",
                recurring: true,
                totalAmount: st.totalAmount,
                claimable,
                display: [
                  `累计 ${st.totalAmount} 点`,
                  claimable > 0 ? `待领 ${claimable} 点（插件会自动领取）` : "无待领奖励",
                  todo.length ? `${todo.length} 个任务可做（各 +100，插件可代做并自动领取）` : null,
                  gap > 0 && nextMilestone ? `再积累 ${gap} 点解锁 +${nextMilestone.reward}` : null,
                ].filter(Boolean).join(" · "),
              },
            ]
          : []
        if (diag) {
          windows.push({
            name: "豆包客户端",
            total: 100,
            used: diag.stage === "ready" ? 100 : 0,
            remaining: diag.stage === "ready" ? 0 : 100,
            unit: "%",
            stage: diag.stage,
            // `display` is the one line the panel shows; keep the fix out of it
            // and in `fix`, which the card can render as a copyable command.
            display: `${stageLabel(diag.stage)}${diag.version ? ` · v${diag.version}` : ""}`,
            fix: diag.fix,
          })
        }
        // Install-time sweep: what the plugin found and did the first time this
        // account was checked. Without this row, "did installing it actually do
        // anything?" is only answerable by reading logs.
        const found = Array.isArray(seen.firstRunTasks) ? seen.firstRunTasks.length : 0
        const attempted = found ? seen.firstRunTasks.filter((t) => t.action !== "listed").length : 0
        const earned = found ? seen.firstRunTasks.filter((t) => t.earned).length : 0
        windows.push({
          name: "首装扫描",
          total: 100,
          used: seen.firstRunAt ? 100 : 0,
          remaining: seen.firstRunAt ? 0 : 100,
          unit: "%",
          stage: seen.firstRunAt ? "done" : "pending",
          display: seen.firstRunAt
            ? `${new Date(seen.firstRunAt).toLocaleDateString("zh-CN")} 完成 · 领取 ${Number(seen.firstRunCredit) || 0} 点` +
              (found ? ` · 发现 ${found} 个可做任务` : "") +
              (attempted ? `（已尝试 ${attempted}，计分 ${earned}）` : "")
            : "待首次扫描（首次签到会自动扫描并领取全部福利）",
        })
        return {
          plan: "Web 体验额度",
          windows,
          signIn: "kept",
        }
      } catch (e) {
        return { error: e?.message ?? String(e), signIn: "kept" }
      }
    },
    methods: [
      {
        // Recommended: read the signed-in session straight from the local
        // Doubao desktop client over CDP. No manual paste, no browser
        // round-trip. Mirrors kimi-work's "use the local desktop app to sign
        // in" pattern. Requires the client to be running with remote debugging
        // enabled (default port 9333); ensure-doubao.mjs brings that up.
        //
        // The client must exist for this path at all, so the instructions are
        // built from a live diagnosis instead of one paragraph that assumes a
        // debug-enabled client is already there.
        type: "oauth",
        label: "从本机豆包客户端获取凭证（推荐）",
        async authorize() {
          const diag = await diagnoseClient().catch(() => null)
          const harvest = async () => {
            const r = await harvestClientCookies()
            if (!r.ok) return { type: "failed", error: r.error }
            return { type: "success", cookie: r.cookie, uid: r.uid, source: "doubao-desktop" }
          }
          if (diag?.stage === "not-installed") {
            // Open the official macOS download page up front so it is ready,
            // then let the user click download; the callback auto-installs the
            // .dmg from ~/Downloads and relaunches with the debug port.
            openDownloadPage()
            return {
              url: "",
              method: "auto",
              instructions:
                "未检测到豆包电脑客户端（/Applications/Doubao.app）。签到活动只在客户端内开放，所以本插件不再走网页端取号。已为你打开官方下载页：请点「下载 macOS 版」，下载完成后点此重试，插件会自动安装并读取凭证。",
              callback: async () => {
                const r = await attemptClientInstall({ port: diag.port, openPage: false })
                if (!r.ok) {
                  if (r.needDownload) return { type: "failed", error: r.error }
                  return { type: "failed", error: r.error }
                }
                const h = await harvestClientCookies().catch(() => null)
                if (!h?.ok) return { type: "failed", error: h?.error ?? "安装成功但未读到登录凭证，请在客户端登录后重试" }
                return { type: "success", cookie: h.cookie, uid: h.uid, source: "doubao-desktop" }
              },
            }
          }
          if (diag?.stage === "running-no-debug") {
            return {
              url: "",
              method: "auto",
              instructions:
                `豆包客户端在运行，但没有开启远程调试端口 ${diag.port}，插件读不到会话。请运行 \`${diag.fix}\`（会重启客户端），或退出豆包后用 \`open -a Doubao --args --remote-debugging-port=${diag.port}\` 重新打开，然后点此重试。`,
              callback: harvest,
            }
          }
          if (diag?.stage === "not-running") {
            return {
              url: "",
              method: "auto",
              instructions:
                `豆包客户端已安装（v${diag.version || "?"}）但当前未运行。插件会尝试以调试端口 ${diag.port} 启动它；若没有反应，可手动运行 \`${diag.fix}\`。客户端登录后会自动读取凭证。`,
              callback: harvest,
            }
          }
          return {
            url: "",
            method: "auto",
            instructions:
              `已连上豆包客户端（v${diag?.version || "?"}，端口 ${diag?.port ?? 9333}），正在直接读取登录凭证，无需任何粘贴。`,
            callback: harvest,
          }
        },
      },
      {
        // Web path: launch a real browser (Chrome/Edge) with remote debugging,
        // open doubao.com, let the user sign in through Doubao's own login UI,
        // then harvest the session cookie over CDP — fully automatic, no paste.
        type: "oauth",
        label: "自动打开浏览器登录（免粘贴，推荐）",
        async authorize() {
          const bin = findBrowserBinary()
          if (!bin) {
            return {
              url: "",
              method: "auto",
              instructions:
                "未检测到Chrome/Edge，无法自动打开浏览器。请改用「从本机豆包客户端获取凭证」，或在下方用「手动粘贴网页 Cookie」添加。",
              callback: async () => ({ type: "failed", error: "未找到可用浏览器" }),
            }
          }
          return {
            url: "",
            method: "auto",
            instructions:
              "插件已为你打开浏览器并进入豆包官网。请在浏览器中完成登录（手机号 / 扫码均可），登录成功后插件会自动读取会话并保存，无需复制任何内容。若 5 分钟内未登录，本次会超时。",
            async callback() {
              const r = await launchBrowserLogin()
              if (!r.ok) return { type: "failed", error: r.error }
              return { type: "success", cookie: r.cookie, uid: r.uid, source: "doubao-web" }
            },
          }
        },
      },
      {
        // Fallback only: for environments with no browser binary or no desktop
        // client. The user pastes the whole cookie string manually.
        type: "api",
        label: "手动粘贴网页 Cookie（兜底）",
        prompts: [
          {
            type: "text",
            key: "cookie",
            message:
              "粘贴 doubao.com 的完整 Cookie（浏览器 F12 → Network → 任一请求 → Request Headers 里的 Cookie 整行，形如 `sessionid=…; sessionid_ss=…; sid_tt=…; passport_csrf_token=…`）。只贴一串 JWT 会被豆包当成未登录（710012000 user invalid）。",
          },
        ],
      },
    ],
  },
})

export const _internal = {
  MODELS,
  MAX_CONCURRENCY,
  foldHistory,
  textOf,
  matchRisk: (c) => RISK_CODES.has(Number(c)),
  // Exported for tests: the campaign reader that maps the detail API onto the
  // page's campaign codes, and the two pure helpers around it.
  fetchDoubaoStatus,
  claimableCredit,
  diffClaims,
}

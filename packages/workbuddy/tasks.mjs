// WorkBuddy's daily chores beyond the check-in: the growth centre's tasks,
// its streaks, the Buddy's travel and its blind boxes. magpie has one daily
// hook per account (auth.checkin), so these run inside it, in this order:
//
//   growth tasks -> streak keeper -> Buddy travel -> Buddy blind box
//
// The account's daily credit is claimed by index.mjs's checkinOf, before
// this module is asked anything.
//
// Everything here is the China build's: the growth centre lives on
// copilot.tencent.com and the AI build has none of it. An enterprise
// (team) account has no growth centre at all, and an API key reads none.
//
// What this module will not do: the vendor counts some tasks only on the
// desktop app's real behaviour (a `workbuddy://` deep link opened by hand,
// a WeChat follow, a donation). Those are listed in DESKTOP_ONLY and
// UNFORGEABLE and are skipped, as the reference implementation skips them:
// a faked report is ignored, the progress stays 0 and the claim answers
// "task not completed".
//
// Two things are this module's own, not the reference's, because a plugin
// hook may be asked twice in one day (a manual "Check in now" after the
// daily run):
//   * `ranToday` keeps the Beijing day each account was last served, so a
//     second ask does nothing;
//   * a report is only sent for a task whose day has not been served, since
//     /v2/report carries no idempotency key of its own.

const BEIJING_OFFSET_MS = 8 * 3600_000

// ---- the growth centre's task table -----------------------------------------
//
// kind picks the report event built for a task; target is how many events
// it takes when the vendor does not say. Codes the vendor sends but this
// table does not name are left alone: no event is built for them, so no
// progress is claimed for a task whose event is unknown.

const TASK_SPECS = {
  create_canvas: { kind: "canvas", target: 1, reward: 300 },
  template_5: { kind: "template", target: 5, reward: 200 },
  expert_5: { kind: "expert", target: 5, reward: 200 },
  Expert_team_use_3: { kind: "team", target: 3, reward: 150 },
  skill_1: { kind: "skill", target: 1, reward: 100 },
  automation_1: { kind: "automation", target: 1, reward: 100 },
  playbook_prompt: { kind: "playbook", target: 1, reward: 100 },
  Expert_lighthouse: { kind: "expert", target: 1, reward: 100 },
  // the two Buddy apps are desktop-only (see DESKTOP_ONLY)
  Buddy_App: { kind: "buddy5", target: 1, reward: 100 },
  Buddy_App_QQ: { kind: "buddy5", target: 1, reward: 100 },
  Hp_Appearance: { kind: "skin", target: 1, reward: 100 },
  chat_5: { kind: "chat", target: 5, reward: 100 },
  "Model_chat_GLM5.2": { kind: "glmchat", target: 1, reward: 100 },
  black_cat: { kind: "cat", target: 3, reward: 100 },
  RichMeow_Chat: { kind: "richmeow", target: 1, reward: 100 },
  Library_read: { kind: "library", target: 1, reward: 100 },
  // auto: the vendor takes no acceptance for it, and its reward is the
  // Buddy instance every single task and the travel need first
  first_buddy: { kind: "chat", target: 1, reward: 300 },
  WorkBuddy_Valorant: { kind: "expert", target: 1, reward: 100, expert: ["ex_xQHHD1u5Jkua", "无畏契约拼豆专家"] },
  workstation_expert: { kind: "expert", target: 1, reward: 100, expert: ["WorkspaceBuilder", "工作台搭建师"] },
  expert_use_maidehao: { kind: "expert", target: 1, reward: 100, expert: ["ex_GDl31WahyIH0", "中国电商运营专家"] },
  expert_use_douyinyin: { kind: "expert", target: 1, reward: 100, expert: ["ex_FbY5nlWTqDod", "抖音策略师"] },
  expert_use_shangjia_xuanchuan: { kind: "expert", target: 1, reward: 100, expert: ["ex_Weo3x2EZuSDm", "商家宣传页与海报设计师"] },
  expert_use_bowangwang: { kind: "expert", target: 1, reward: 100, expert: ["ex_WZY136wV5aMt", "直播电商教练"] },
  Sequential_Tasks_7: { kind: "playbook", target: 1, reward: 100 },
  wb_wechat_oa_subscribe_task: { unforgeable: true, reward: 100, reason: "needs the WeChat account to follow WorkBuddy's official account for 24 hours" },
  Expert_Philanthropy: { unforgeable: true, reward: 0, reason: "a real donation" },
}

// The vendor counts these two only on the desktop app's own deep link, so a
// report sent here changes nothing. Kept for the wording of the skip line.
const DESKTOP_ONLY = {
  Buddy_App: "在桌面端左上角「发现应用」进入任意一个 Buddy 应用",
  Buddy_App_QQ: "在桌面端「发现应用」进入「企鹅教师助手」",
}

// black_cat counts only in this window, once a night, for three nights.
const NIGHT_CODES = new Set(["black_cat"])

// Expert and team events are deduplicated by (eventCode, id) upstream: the
// same id twice moves nothing. Sending `need` events therefore has to walk
// a pool, starting where the task's own progress left off.
const EXPERT_ID_POOL = [
  ["ex_PZw8Gu81HfN4", "运维工程师"], ["ex_ROsDtJbzADFV", "产品经理"],
  ["ex_SMUnl0nJbPix", "UI设计师"], ["ex_ZTR062oVBOCW", "数据分析师"],
  ["ex_a3sSSFBy8qaC", "后端架构师"], ["ex_aG1kvKbq8lPx", "文案策划"],
  ["ex_al1vxtUOYQ10", "测试专家"], ["ex_cZfiyuET9UQP", "安全顾问"],
  ["ex_eggOvQuVP0hq", "算法工程师"], ["ex_hSwsQjkSKnkX", "前端工程师"],
  ["ex_mMbwwmFA9n9P", "项目管理专家"], ["ex_uAQE5POfk7Zh", "增长运营专家"],
  ["ex_uZzSAScSy7FZ", "行业研究员"], ["ex_LHywGrZOtG7G", "数据分析师"],
  ["ex_NX5C8GBciVed", "测试架构师"], ["ex_DdCsaoq4AtcO", "云端运维专家"],
  ["ex_KzqKQguubrNQ", "内容创作专家"], ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"],
]
const TEAM_ID_POOL = [
  ["CloudOpsTeam", "运维专家团队"], ["CloudContentTeam", "内容专家团队"],
  ["CloudDevTeam", "研发专家团队"], ["ProductStrategyTeam", "产品战略团队"],
  ["MarketingCampaignTeam", "营销活动团队"], ["SalesBattleTeam", "销售作战团队"],
  ["DesignEngineTeam", "设计引擎团队"], ["HrOperationsTeam", "人力运营团队"],
]
const LIB_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm"
const SKILL_ID = "skill_2096525080079265792"

// model ids the reference implementation reports with; the vendor only
// reads that a conversation happened
const MODEL_FLASH = ["deepseek-v4-flash", "DeepSeek V4 Flash"]
const MODEL_GLM = ["glm-5.2", "GLM-5.2"]

// ---- state ------------------------------------------------------------------

// each account's last served Beijing day, and the codes reported that day
const ran = new Map()
const reported = new Map()

const dayKey = (siteId, uid) => siteId + "|" + uid

// beijingDay is the vendor's own day: a fixed +08:00, no DST, so the same
// instant names the same day whoever runs this.
function beijingDay(now = Date.now()) {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

// localHour is the machine's own hour, which is what the night window is
// measured on in the reference implementation.
const localHour = () => new Date().getHours()
const isNight = () => localHour() >= 23 || localHour() < 8

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- one request ------------------------------------------------------------
//
// The growth centre is asked as WorkBuddy's own client asks it: the chat
// identity, on copilot.tencent.com. The billing API's headers are not this
// (index.mjs's meterAsked builds those); a growth request without the
// agent's own lines is counted under no client.

function growthHeaders(site, a) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN",
    "X-Requested-With": "XMLHttpRequest",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    "X-CodeBuddy-Request": "1",
    "User-Agent": `WorkBuddy/${site.app} ${site.appName}/${site.app} CLI/${site.cli}`,
    Authorization: "Bearer " + a.access,
    "X-User-Id": a.uid ?? "",
    "X-Domain": a.domain || new URL(site.endpoint).host,
    "X-Product": "SaaS",
    "X-IDE-Name": site.name,
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": site.app,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-Private-Data": "true",
  }
  if (a.enterpriseId) {
    h["X-Enterprise-Id"] = a.enterpriseId
    h["X-Tenant-Id"] = a.enterpriseId
  }
  return h
}

// ask is one growth-centre call: `data` when WorkBuddy answers 0, a throw
// carrying the vendor's own words otherwise. A non-JSON body on a 2xx is
// unreadable, never an empty success.
async function ask(site, a, path, { method = "GET", body, timeout = 15000 } = {}) {
  const init = { method, headers: growthHeaders(site, a), signal: AbortSignal.timeout(timeout) }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(site.endpoint + path, init)
  const raw = await res.text()
  let env = null
  try {
    env = JSON.parse(raw)
  } catch {
    env = null
  }
  if (env === null) {
    const err = new Error(`unreadable reply ${raw.trim().slice(0, 120) || "(empty)"}`)
    err.status = res.status
    err.unreadable = true
    throw err
  }
  const code = Number.parseInt(env?.code, 10) || 0
  if (code) throw Object.assign(new Error(env.msg || `error ${code}`), { status: res.status, code })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return env.data ?? null
}

// ---- the tasks --------------------------------------------------------------

async function fetchTasks(site, a) {
  const data = await ask(site, a, "/v2/activity/growth/tasks")
  const rows = Array.isArray(data?.tasks) ? data.tasks : []
  return rows.map((t) => {
    const code = String(t.task_code ?? "")
    const spec = TASK_SPECS[code] ?? {}
    const prog = t.progress ?? {}
    const target = Number(prog.target ?? spec.target ?? 1) || 1
    return {
      code,
      name: t.title || code,
      description: t.description || t.task_desc || "",
      jump: t.jump_url || "",
      status: t.accept_status || "not_accepted",
      type: t.task_type || "",
      current: Number(prog.current ?? 0) || 0,
      target,
      credit: Number(t.reward_credit ?? spec.reward ?? 0) || 0,
      spec,
    }
  })
}

const claimable = (t) => t.status === "completed" || t.current >= t.target
const ineligible = (t) =>
  t.spec.unforgeable === true || DESKTOP_ONLY[t.code] !== undefined || TASK_SPECS[t.code] === undefined

async function accept(site, a, tasks) {
  const want = tasks.filter((t) => t.status === "not_accepted" && t.type !== "auto" && !ineligible(t))
  const accepted = []
  for (let i = 0; i < want.length; i += 20) {
    const batch = want.slice(i, i + 20).map((t) => t.code)
    let data
    try {
      data = await ask(site, a, "/v2/activity/growth/tasks/accept", { method: "POST", body: { task_codes: batch } })
    } catch {
      continue
    }
    for (const r of Array.isArray(data?.results) ? data.results : []) {
      if (r.status === "accepted" || r.status === "already_accepted") accepted.push(String(r.task_code))
    }
  }
  return accepted
}

async function claim(site, a, t) {
  let data
  try {
    data = await ask(site, a, `/activity/growth/tasks/${encodeURIComponent(t.code)}/claim`, { method: "POST", body: {} })
  } catch (e) {
    // 400 means the progress the vendor holds is short of the target: the
    // task stays for another day rather than being reported again here
    return 0
  }
  const credit = Number(data?.credit ?? 0) || 0
  t.status = "claimed"
  return credit
}

// ---- report events ----------------------------------------------------------
//
// One event per unit of progress. A task's kind picks its body; the ids and
// timestamps are the client's own (`wb-task-<ms>-<i>`), which the vendor
// reads as one send.

function buildEvents(t, uid, nick, i) {
  const now = Date.now()
  const cid = `wb-task-${now}-${i}`
  const rid = cid + "-req"
  const base = { timestamp: now, reportDelay: 0, conversationId: cid, requestId: rid, userId: uid }
  const expertAt = (pool, offset) => pool[(offset + i) % pool.length]
  const chat = (mode, model) => ({
    eventCode: "chat_request_send", timestamp: now, reportDelay: 0, mode,
    conversationId: cid, requestId: rid, inputLength: 12,
    requestModelId: model[0], requestModelName: model[1],
    isPlan: false, agentName: "default", agentType: "conversation", userId: uid,
  })
  switch (t.spec.kind) {
    case "canvas":
      return [{ eventCode: "wbx_design_canvas_task_create", ...base, source: "summon_keyword", isCustomModel: false, name: "", inputLength: 12, id: `wbx-canvas-${now}`, cost: 0, isSuccessful: true }]
    case "template":
      return [{ eventCode: "agent_task_created_with_template", timestamp: now, reportDelay: 0, isCustomModel: true, id: String(i), name: "幻灯片", requestId: rid, conversationId: cid, userId: uid }]
    case "skill":
      return [{ eventCode: "skill_info", timestamp: now, reportDelay: 0, skillId: SKILL_ID, name: "pptx", userId: uid }]
    case "automation":
      return [{
        eventCode: "automated_task_create_suc", timestamp: now, reportDelay: 0, name: "每周工作整理",
        type: "cron", source: "manually", modelId: MODEL_FLASH[0], modelIsThinking: false,
        conversationId: cid, requestId: rid,
        schedule: { type: "recurring", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" },
        prompt: "每周五自动整理本周工作", userId: uid,
      }]
    case "library":
      return [{ eventCode: "web_element_click", timestamp: now, reportDelay: 0, pageURL: LIB_DOC_URL, elementId: "library_doc_intro_click", elementName: "WorkBuddy资料库介绍", os: "Win32", arch: "", osVersion: "10.0", userAgent: "Mozilla/5.0", userId: uid }]
    case "playbook":
      return [
        { eventCode: "playbook_cta_click", timestamp: now, reportDelay: 0, id: "worker-ledger-freedom-dashboard", name: "打工人小账本", type: "document", categoryId: "", categoryName: "", source: "discover", position: 0, conversationId: cid, requestId: rid, messageId: rid, userId: uid },
        { eventCode: "playbook_prompt_send", timestamp: now + 50, reportDelay: 0, id: "worker-ledger-freedom-dashboard", requestId: rid, promptLength: 30, isOfficial: 1, skills: "", skillNames: "", conversationId: cid, messageId: rid, userId: uid },
      ]
    case "skin":
      return [{ eventCode: "appearance_skin_apply", timestamp: now, reportDelay: 0, action: "apply", source: "settings_close", id: "theme-tkmw7j", vipLevel: "free", series: "craft", type: "unknown", name: "和平精英激战金秋", userId: uid }]
    case "glmchat":
      return [chat("craft", MODEL_GLM)]
    case "cat":
      return [chat("night", MODEL_FLASH)]
    case "expert":
    case "team": {
      const pool = t.spec.kind === "team" ? TEAM_ID_POOL : EXPERT_ID_POOL
      const [id, name] = t.spec.expert ?? expertAt(pool, t.current)
      return [{
        eventCode: "expert_actual_use", timestamp: now, reportDelay: 0, mode: "CLOUD",
        id, name, expertTitle: name, type: "02-Engineering",
        expertType: t.spec.kind === "team" ? "team" : "agent",
        source: "builtin", version: "1.0.2", cost: 0, characterCount: 12,
        conversationId: cid, requestId: rid, messageId: rid,
        requestModelId: MODEL_FLASH[0], requestModelName: MODEL_FLASH[1], userId: uid,
      }]
    }
    case "richmeow": {
      // a conversation's whole shape, as the desktop app reports one
      const mid = `msg-${now}-${i}`
      const at = (d) => now + d
      const common = { userId: uid, userNickname: nick ?? "" }
      return [
        {
          eventCode: "agent_task_created_suc", timestamp: at(0), requesterUserId: uid,
          source: "LOCAL", name: "working", task_target: "local", mode: "craft",
          requestModelId: MODEL_FLASH[0], requestModelName: MODEL_FLASH[1],
          has_repo: false, repo_type: "none", workspace_type: "empty", has_connector: false,
          connector_types: [], has_mention: false, mention_types: [], has_template: false,
          action: "", template_name: "", has_expert: false, expert_id: "", expert_name: "",
          expert_industry_id: "", has_skill: false, skill_names: [],
          conversationId: cid, messageId: mid, buddyId: "", buddyName: "", ...common,
        },
        { eventCode: "chat_message_send", timestamp: at(20), messageId: mid + "-ast", historyCount: 0, isContextTruncated: false, currentStepCount: 1, traceId: rid, rootRequestId: rid, parentConversationId: cid, agentName: "cli", agentType: "main", ...common },
        {
          eventCode: "chat_request_send", timestamp: at(40), inputLength: 24, isPlan: false,
          isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false, maxToken: 0,
          maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [], knowledgeId: [],
          knowledgeName: [], codebaseId: "", mentionContextCount: 0, command: "", recommendId: "",
          skillId: "", skillCount: 0, totalCount: 0, traceId: rid, rootRequestId: rid,
          parentConversationId: cid, conversationId: cid, messageId: mid, agentName: "cli",
          agentType: "main", ...common,
        },
        { eventCode: "chat_message_response", timestamp: at(60), messageId: mid + "-resp", conversationId: cid, requestId: rid, agentName: "cli", ...common },
        {
          eventCode: "chat_request_response", timestamp: at(80), conversationId: cid, requestId: rid,
          requestModelId: MODEL_FLASH[0], requestModelName: MODEL_FLASH[1], toolCallCount: 0,
          inputToken: 6, outputToken: 12, duration: 50, agentName: "cli", ...common,
        },
        { eventCode: "agent_task_completed", timestamp: at(100), conversationId: cid, messageId: mid, status: "success", ...common },
      ]
    }
    default:
      return [chat("craft", MODEL_FLASH)]
  }
}

async function report(site, a, events) {
  if (!events.length) return false
  try {
    await ask(site, a, "/v2/report", { method: "POST", body: events })
    return true
  } catch {
    return false
  }
}

// progressOne moves one task as far as this run takes it and returns the
// credit the claim gave (0 when nothing was claimed). The rule the vendor
// holds is that a task's progress moves only after it is accepted, and that
// a reported unit is counted once: so the task is re-read after the
// reports before any claim is asked.
async function progressOne(site, a, t, { gap = 1000, nick } = {}) {
  if (t.status === "claimed") return 0
  if (claimable(t)) return await claim(site, a, t)
  if (ineligible(t)) return 0
  if (NIGHT_CODES.has(t.code) && !isNight()) return 0
  if (t.status === "not_accepted" && t.type !== "auto") return 0

  const need = Math.max(1, t.target - t.current)
  for (let i = 0; i < need; i++) {
    await report(site, a, buildEvents(t, a.uid, nick, i))
    if (i < need - 1) await sleep(gap)
  }
  await sleep(1500)

  // the vendor's own count, read back: a report the vendor ignored leaves
  // the progress where it was, and a claim then answers 400
  let best = t.current
  for (let attempt = 0; attempt < 6; attempt++) {
    let fresh
    try {
      fresh = (await fetchTasks(site, a)).find((x) => x.code === t.code)
    } catch {
      break
    }
    if (!fresh) break
    if (fresh.status === "claimed") return 0
    if (claimable(fresh)) {
      t.status = fresh.status
      t.current = fresh.current
      return await claim(site, a, t)
    }
    if (fresh.current > best) {
      best = fresh.current
      await sleep(2500)
      continue
    }
    if (attempt < 2) await sleep(1500)
    else break
  }
  return 0
}

// ---- the four chores --------------------------------------------------------

// growthTasks runs the growth centre: the auto tasks first (first_buddy's
// reward is the Buddy instance the rest need), then acceptance, then every
// other task. It returns the credit earned and one line per thing done.
async function growthTasks(site, a, opts = {}) {
  const logs = []
  let credit = 0
  const tasks = await fetchTasks(site, a)
  if (!tasks.length) return { credit, logs }

  for (const t of tasks.filter((x) => x.type === "auto")) credit += await progressOne(site, a, t, opts)

  await accept(site, a, await fetchTasks(site, a))

  const known = reported.get(dayKey(site.id, a.uid)) ?? new Set()
  for (const t of await fetchTasks(site, a)) {
    if (known.has(t.code)) continue
    const got = await progressOne(site, a, t, opts)
    known.add(t.code)
    if (got > 0) {
      credit += got
      logs.push(`${t.name} +${got}`)
    } else if (DESKTOP_ONLY[t.code]) {
      logs.push(`${t.name}: 需桌面端操作（${DESKTOP_ONLY[t.code]}）`)
    } else if (t.spec.unforgeable) {
      logs.push(`${t.name}: 需真实操作（${t.spec.reason}）`)
    }
  }
  reported.set(dayKey(site.id, a.uid), known)
  return { credit, logs }
}

// streakBonus keeps the streak: a missed yesterday is made up with a card,
// the first-run gift and any compensation are claimed, an unlocked 7/14/28
// day tier is redeemed, and every lottery chance is drawn.
async function streakBonus(site, a, opts = {}) {
  const logs = []
  let credit = 0
  const pause = opts.gap ?? 0

  // 1. yesterday, made up with a card when one is held
  try {
    const hm = await ask(site, a, "/activity/growth/heatmap")
    const cells = Array.isArray(hm?.cells) ? hm.cells : []
    const yesterday = beijingDay(Date.now() - 86400_000)
    const cell = cells.find((c) => c.date === yesterday)
    if (cell && Number(cell.score ?? 0) === 0) {
      const st = await ask(site, a, "/activity/growth/streak")
      const cards = Number(st?.makeup_cards?.balance ?? 0) || 0
      if (cards > 0) {
        await ask(site, a, "/activity/growth/makeup-cards/use", { method: "POST", body: { target_date: yesterday } })
        logs.push(`补签 ${yesterday}`)
      }
    }
  } catch {
    // a heatmap the vendor does not answer leaves the streak alone
  }

  // 2. the one-off gift and any compensation; already taken answers a code
  for (const [path, name] of [["/billing/meter/claim-gift", "新手礼包"], ["/billing/meter/claim-compensation", "活动补偿"]]) {
    try {
      const d = await ask(site, a, path, { method: "POST", body: {} })
      const got = Number(d?.credit ?? 0) || 0
      credit += got
      logs.push(`${name} +${got}`)
    } catch {
      // taken already, or not offered: neither is a failure of the run
    }
    if (pause) await sleep(pause)
  }

  // 3. the 7/14/28 day tiers, redeemed when unlocked and not yet taken
  try {
    const st = await ask(site, a, "/activity/growth/streak")
    const red = st?.redemption_status ?? {}
    const tiers = Array.isArray(red.tiers) ? red.tiers : []
    const status = { "7d": red.tier_7d_status, "14d": red.tier_14d_status, "28d": red.tier_28d_status }
    for (const entry of tiers) {
      const tier = String(entry?.tier ?? "")
      if (!tier) continue
      const state = status[tier]
      if (state === "locked" || state === "claimed") continue
      try {
        await ask(site, a, "/activity/growth/redeem", { method: "POST", body: { tier, client_token: crypto.randomUUID() } })
        logs.push(`兑换连登 ${tier}`)
      } catch {
        // a tier refused stays for the next run
      }
      if (pause) await sleep(pause)
    }
  } catch {
    // no streak detail: nothing to redeem
  }

  // 4. every lottery chance
  try {
    const lot = await ask(site, a, "/activity/growth/lottery/summary")
    const chances = Math.max(0, Number(lot?.chances ?? 0) || 0)
    let drawn = 0
    for (let i = 0; i < chances; i++) {
      try {
        await ask(site, a, "/activity/growth/lottery/draw", { method: "POST", body: { client_token: crypto.randomUUID() } })
        drawn++
      } catch {
        break
      }
      await sleep(opts.drawGap ?? 1000)
    }
    if (drawn > 0) logs.push(`抽奖 ${drawn} 次`)
  } catch {
    // no lottery: nothing drawn
  }

  return { credit, logs }
}

// catTravel runs the Buddy's day: a claim when it is back, a departure when
// it is home. `no active buddy` means the instance was never claimed, which
// is first_buddy's reward. A departure needs a destination id: an empty
// body is answered 400 "invalid request".
async function catTravel(site, a, opts = {}) {
  const logs = []
  let credit = 0
  let st
  try {
    st = await ask(site, a, "/activity/growth/buddy/travel/status")
  } catch {
    return { credit, logs }
  }
  const state = st?.state
  if (state === "arrived") {
    try {
      const d = await ask(site, a, "/activity/growth/buddy/travel/claim", { method: "POST", body: {} })
      const got = Number(d?.reward_credit ?? 0) || 0
      credit += got
      logs.push(`猫猫旅行归来 +${got}`)
    } catch {
      logs.push("猫猫旅行领奖失败")
    }
    return { credit, logs }
  }
  if (state === "traveling") return { credit, logs }
  if (state !== "idle") return { credit, logs }
  if (st?.daily_limit_reached) return { credit, logs }

  let lid = 1
  try {
    const cfg = await ask(site, a, "/activity/growth/buddy/travel/config")
    const locs = Array.isArray(cfg?.locations) ? cfg.locations : []
    if (locs.length) lid = locs[0].id ?? 1
  } catch {
    // keep the reference implementation's fallback destination
  }

  const depart = async () => {
    try {
      const d = await ask(site, a, "/activity/growth/buddy/travel/depart", { method: "POST", body: { location_id: lid } })
      const where = d?.location?.name ?? ""
      logs.push(where ? `猫猫出发去「${where}」` : "猫猫已出发")
      return true
    } catch (e) {
      return e
    }
  }
  let out = await depart()
  if (out === true) return { credit, logs }
  if (String(out?.message ?? "").toLowerCase().includes("no active buddy")) {
    // the instance is first_buddy's reward: claim it, then try once more
    const fb = (await fetchTasks(site, a)).find((t) => t.code === "first_buddy")
    if (fb && fb.status !== "claimed") {
      credit += await progressOne(site, a, fb, opts)
      out = await depart()
      if (out === true) return { credit, logs }
    }
    logs.push("还没有 Buddy：需先完成「领取一只 Buddy」")
  } else if (typeof out !== "boolean") {
    logs.push(`猫猫旅行派出失败：${out?.message ?? "unknown"}`)
  }
  return { credit, logs }
}

// buddyOpen spends the energy the chores earned: a blind box, when one is
// affordable. It spends a resource, so it asks the quota first and never
// opens more than the account can pay for.
async function buddyOpen(site, a, opts = {}) {
  const logs = []
  try {
    const q = await ask(site, a, "/v2/activity/growth/buddy/quota")
    const affordable = Number(q?.affordable ?? 0) || 0
    const maxOpen = Number(q?.max_open_count ?? 1) || 1
    if (affordable <= 0) return { logs }
    const count = Math.min(affordable, Math.max(1, maxOpen))
    const d = await ask(site, a, "/v2/activity/growth/buddy/open", { method: "POST", body: { count, client_token: crypto.randomUUID() } })
    const names = [d?.name, ...(Array.isArray(d?.buddies) ? d.buddies.map((b) => b?.name) : [])].filter(Boolean)
    logs.push(names.length ? `盲盒开出 ${names.join("、")}` : `盲盒开出 ${count} 个`)
  } catch {
    // no quota, or nothing affordable
  }
  return { logs }
}

// runDaily is the whole day's chores for one account, in the order the
// vendor's own client does them. It is safe to ask twice: the second ask in
// the same Beijing day does nothing.
async function runDaily(site, a, opts = {}) {
  const none = { credit: 0, logs: [], ran: false }
  if (site.ai) return none
  if (!a?.uid || !a?.access) return none
  if (a.source === "key" || a.enterpriseId) return none

  const key = dayKey(site.id, a.uid)
  const today = beijingDay()
  if (ran.get(key) === today) return { ...none, done: true }
  ran.set(key, today)

  const logs = []
  let credit = 0
  const steps = [
    ["任务", () => growthTasks(site, a, opts)],
    ["连登", () => streakBonus(site, a, opts)],
    ["猫猫旅行", () => catTravel(site, a, opts)],
    ["盲盒", () => buddyOpen(site, a, opts)],
  ]
  for (const [name, step] of steps) {
    try {
      const out = await step()
      credit += out.credit ?? 0
      for (const line of out.logs ?? []) logs.push(line)
    } catch (e) {
      logs.push(`${name}失败：${e?.message ?? e}`)
    }
    if (opts.gap) await sleep(opts.gap)
  }
  return { credit, logs, ran: true }
}

// forgotten is what a test (and a process that has run for days) needs: the
// per-account day marks, dropped so the next ask runs again.
function forget() {
  ran.clear()
  reported.clear()
}

export { runDaily, growthTasks, streakBonus, catTravel, buddyOpen, forget }

export const _internal = {
  runDaily, growthTasks, streakBonus, catTravel, buddyOpen, forget,
  beijingDay, buildEvents, growthHeaders, TASK_SPECS, DESKTOP_ONLY, NIGHT_CODES,
  EXPERT_ID_POOL, TEAM_ID_POOL, ran, reported,
}

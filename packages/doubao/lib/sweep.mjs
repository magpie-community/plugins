// The first-run sweep: the one pass that runs when the plugin is installed
// against an account for the first time.
//
// What "install and it just works" has to mean here, in order:
//
//   1. get the desktop client to an attachable state (launch it if closed,
//      restart it with the debug port if it is running without one);
//   2. read the campaign and claim every reward that is already earned —
//      daily sign-in + every milestone tier sitting at 已完成待领取;
//   3. look at what is left, and *execute* the tasks that can be driven from
//      the client itself, reporting honestly whether the campaign credited
//      them.
//
// Step 3 is the one with a bill attached: each of those tasks pays +100 but the
// generation behind it spends real quota. The shape that avoids paying twice is
// the one a person uses — send the turn, watch the campaign, and the moment the
// card flips to 可领取 stop the answer, refresh the activity page, claim it and
// leave the conversation. The answer does not have to finish; the credit lands
// when the feature is actually used, which is a few seconds in. So it runs in
// one of three modes:
//
//   off    — claim only, never spend (the safest default for daily runs)
//   probe  — execute *one* task, learn whether this path credits at all, and
//            stop as soon as it does not. Worst case: one generation spent.
//   full   — run every drivable task (capped by MAX_TURNS), in the order most
//            likely to register.
//
// `full` is what a first install uses: it satisfies "check what is claimable
// and go do it" — including the 本地电脑 and 定时任务 tasks, both of which are
// driven through the same work conversation.

import { claimRewards } from "./rewards.mjs"
import { ensureClientReady } from "./client-status.mjs"
import { prepareTask, sendTask, endTurn, TASK_SURFACE } from "./task-runner.mjs"
import { claimTargets, todoTasks, diffClaims } from "./campaign.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const TASK_MODES = ["off", "probe", "full"]

// One sweep never fires more turns than this, even in full mode. Set
// DOUBAO_MAX_TASK_TURNS to raise it; it defaults high so every doable task on
// the activity page is attempted, not just the first few. (The sweep only ever
// drives tasks still at status 1, so a drained campaign costs nothing.)
export const MAX_TURNS = Number(process.env.DOUBAO_MAX_TASK_TURNS) || 99

// Which drivable task to try first. 完成复杂任务 comes first: its campaign
// type is `WorkTaskMode` and its own recommended prompts ask for a real
// artifact, the same shape as the GenPPT / GenWord tasks this account has
// already been credited for — and it is the one confirmed to pay (+100,
// 900 → 1000, 2026-11-02). 技能 is next because it only needs a skill invoked.
// 本地电脑 then, and 定时任务 last: it is the only one that leaves something
// running behind, so it only happens after everything cheaper has paid.
export const PROBE_ORDER = [
  "pc_task_complete_work_task_v2",
  "pc_task_use_skill_v2",
  "pc_task_complete_computer_task_v2",
  "pc_task_create_schedule_v2",
]

// Self-contained prompts, because Doubao's own recommendations usually ask the
// user to paste their material ("把下面的论文润色…") and a task with no material
// cannot run at all — which is exactly how the first attempts earned nothing.
const DEFAULT_PROMPT = {
  pc_task_use_skill_v2:
    "帮我用「文档写作」的能力，把下面这段内容整理成一份结构清晰的一页纸周报，包含：本周进展、关键数据、风险、下周计划。内容：缓存一致性协议在 32 节点集群下把一致性维护流量降低了 37%，平均响应延迟从 18.4ms 降到 12.1ms；下一步要验证 128 节点下的可扩展性。",
  pc_task_complete_work_task_v2:
    "帮我做一份《缓存一致性协议优化》的工作任务拆解：目标、里程碑、风险、验收标准，输出成一张表。",
  // Deliberately the smallest possible side effect: one throwaway file on the
  // Desktop, named so it can be deleted by name, nothing read and nothing else
  // touched.
  pc_task_complete_computer_task_v2:
    "帮我在本地桌面上新建一个名为 doubao-task-check.txt 的文本文件，里面只写一行：任务功能验证完成。不要读取或修改其他任何文件。",
  // A job that fires once, ~2 minutes out, and then never again — the campaign
  // credits ScheduleSkill only once the job actually runs, and 每小时 (the
  // dialog default) would keep spending quota long after the +100 landed.
  pc_task_create_schedule_v2:
    "帮我创建一个定时任务：从现在起 2 分钟后执行一次，内容是提醒我「今天只剩一件事：把缓存一致性协议的压测结论补进周报」。只执行这一次，不要重复，不要按小时循环，执行完就结束。",
}

export function defaultPromptFor(code) {
  return DEFAULT_PROMPT[code] ?? ""
}

/** Todo tasks in the order the probe should try them. */
export function orderTasks(tasks) {
  const rank = (code) => {
    const i = PROBE_ORDER.indexOf(code)
    return i < 0 ? PROBE_ORDER.length : i
  }
  return [...tasks].sort((a, b) => rank(a.code) - rank(b.code))
}

// Codes that are not in TASK_SURFACE but still look like client-drivable
// activity tasks. Anything the activity page lists as a doable pc_task_* is
// attempted through the generic work-surface path — it carries its own
// recommended prompt, which the sweep routes through the activity chip, so the
// client itself picks the right surface and toggles.
const GENERIC_TASK_RE = /^pc_task_/

/** Tasks the plugin is allowed to drive end to end. */
export function drivableTasks(tasks) {
  return orderTasks(tasks).filter((t) => {
    const plan = TASK_SURFACE[t.code]
    if (plan) return !plan.manual
    return GENERIC_TASK_RE.test(t.code || "")
  })
}

// Poll a few times after a click: the write lands, the campaign read lags.
async function reread(readStatus, before, tries = 4) {
  let after = before
  let got = []
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(1600)
    const next = await readStatus().catch(() => null)
    if (!next || next.unexpected || next.cooling) continue
    after = next
    got = diffClaims(before, next)
    if (got.length) break
  }
  return { after, got }
}

/**
 * One full sweep of the activity.
 *
 * @param {object} opts
 * @param {() => Promise<object>} opts.readStatus   campaign read (index's fetchDoubaoStatus shape)
 * @param {(code:string) => Promise<number|null>} [opts.readTaskStatus]
 *        single-task status read; required before anything is *sent*, since a
 *        send we cannot verify is just quota burned blind
 * @param {(codes:string[]) => Promise<object>} [opts.claim]  claim engine (injectable for tests)
 * @param {(task:object) => {prompt?:string, skillHint?:string}} [opts.planTask]
 * @param {number}  [opts.port]
 * @param {boolean} [opts.allowRestart]   restart a client running without the port
 * @param {"off"|"probe"|"full"} [opts.taskMode]
 * @param {number}  [opts.claimTimeoutMs]
 * @param {number}  [opts.taskTimeoutMs]
 * @returns {Promise<object>} report — see the shape built below
 */
export async function sweepRewards(opts = {}) {
  if (typeof opts.readStatus !== "function") throw new Error("sweepRewards needs readStatus()")

  const port = Number(opts.port ?? process.env.DOUBAO_CDP_PORT ?? 9333)
  const taskMode = TASK_MODES.includes(opts.taskMode) ? opts.taskMode : "probe"
  const report = {
    at: new Date().toISOString(),
    ok: false,
    taskMode,
    port,
    client: { stage: "unknown", action: "none", version: "", error: null },
    clientReady: false,
    total: 0,
    checkedIn: false,
    targets: [],
    clicked: [],
    clickedCodes: [],
    claimed: [],
    credit: 0,
    tasks: [],
    chatEnded: false,
    turnBudget: MAX_TURNS,
    notes: [],
    error: null,
  }

  // 1. Client first — everything below needs it. Injectable so tests never
  // launch (or restart) a real GUI.
  const ensure = opts.ensureClient ?? ensureClientReady
  const client = await ensure({
    port,
    allowRestart: opts.allowRestart !== false,
    allowLaunch: opts.allowLaunch !== false,
  }).catch((e) => ({ ok: false, stage: "unknown", action: "none", error: String(e?.message ?? e) }))
  report.client = {
    stage: client.stage ?? "unknown",
    action: client.action ?? "none",
    version: client.version ?? "",
    error: client.error ?? null,
  }
  report.clientReady = Boolean(client.ok)
  if (client.action === "launched") report.notes.push("已自动启动豆包客户端")
  if (client.action === "restarted") report.notes.push("客户端原先没开调试端口，已自动重启一次")

  // 2. Read the campaign with the real cookie (the webview cannot read its own
  // HttpOnly session, so this is the only honest source of truth).
  const before = await opts.readStatus().catch((e) => ({ error: String(e?.message ?? e) }))
  if (!before || before.loginInvalid) {
    report.error = "login-invalid"
    report.notes.push("豆包会话已失效，无法读取活动状态")
    return report
  }
  if (before.unexpected || before.cooling) {
    report.error = before.cooling ? "cooling" : `unexpected:${before.code ?? ""}`
    report.notes.push("活动接口暂时不可用（限流或异常），稍后重试")
    return report
  }
  report.total = Number(before.totalAmount) || 0
  report.checkedIn = Boolean(before.checkin?.checkedIn)
  report.targets = claimTargets(before)

  // 3. Claim everything already earned, in one pass.
  if (report.clientReady && report.targets.length) {
    const claim = opts.claim ?? claimRewards
    const r = await claim({
      port,
      codes: report.targets.map((t) => t.code),
      timeoutMs: opts.claimTimeoutMs ?? 30000,
      // The client is already up (step 1); autoLaunch here would race it.
      autoLaunch: false,
    }).catch((e) => ({ clicked: [], clickedCodes: [], error: String(e?.message ?? e) }))
    report.clicked = r.clicked ?? []
    report.clickedCodes = r.clickedCodes ?? []
    if (r.error) report.notes.push(`领取时客户端不可用：${r.error}`)
    // A reachable client whose activity page renders zero cards is almost
    // always "the client is not signed in to this account" — the page then
    // shows the 去下载 / login placeholder instead of the reward grid.
    if (!report.clicked.length && Number(r.cards) === 0) {
      report.notes.push("客户端活动页没有渲染出奖励卡片，可能需要在豆包客户端登录同一个账号")
    }

    if (report.clicked.length) {
      const { got } = await reread(opts.readStatus, before)
      report.claimed = got
      report.credit = got.reduce((s, g) => s + (g.credit || 0), 0)
      if (!got.length) report.notes.push("已点击但豆包接口暂未确认，稍后自动重试")
    }
  }
  // Nothing earned → nothing said: the caller's message and the panel already
  // describe the state, and a duplicate note only makes the check-in text long.

  // 4. What is left to do.
  const todo = todoTasks(before)
  report.todos = todo.map((t) => ({ code: t.code, title: t.title }))
  report.tasks = todo.map((t) => ({
    code: t.code,
    title: t.title,
    action: "listed",
    sent: false,
    earned: false,
    statusAfter: t.status,
  }))

  if (taskMode === "off") {
    // Nothing to add: report.tasks already lists them with action "listed".
  } else if (!report.clientReady) {
    // Same — the caller is about to explain the client stage instead.
  } else if (!opts.readTaskStatus) {
    // Without a way to verify, sending is pure loss. Refuse loudly.
    report.notes.push("缺少任务状态读接口，未执行任务（避免白花额度）")
  } else {
    const budget = opts.maxTurns != null ? Number(opts.maxTurns) : MAX_TURNS
    const queue = drivableTasks(todo)
    const wanted = taskMode === "probe" ? queue.slice(0, 1) : queue
    const runnable = wanted.slice(0, budget)
    for (const t of wanted.slice(budget)) {
      const row = report.tasks.find((x) => x.code === t.code)
      if (row) row.action = "over-budget"
    }
    report.turnBudget = budget
    const prepare = opts.prepareTask ?? prepareTask
    const send = opts.sendTask ?? sendTask
    for (const t of runnable) {
      const row = report.tasks.find((x) => x.code === t.code)
      const plan = (typeof opts.planTask === "function" ? opts.planTask(t) : null) ?? {}
      // Doubao's own recommended prompt wins: the campaign's credit check is
      // tied to the feature that prompt exercises, so the shipped text is the
      // safest thing to send. The hand-written fallback only fills the gaps
      // (offline tests, or a task whose recommendations did not parse).
      //
      // The two tasks that act on the user's machine are the exception — their
      // own prompt is pinned (`ownPrompt`), because Doubao's recommendation
      // for 本地电脑 may well be "整理一下我的桌面" and for 定时任务 "每小时提醒我",
      // and neither is something an unattended sweep may do.
      const official = (before.tasks ?? []).find((x) => x.code === t.code)?.prompts?.[0]
      const pinned = Boolean(TASK_SURFACE[t.code]?.ownPrompt)
      const prompt = plan.prompt || (pinned ? "" : official?.prompt) || defaultPromptFor(t.code)
      const skillHint = plan.skillHint || official?.skill || ""
      // Only ride the activity chip when the activity page actually has that
      // prompt — the chip inserts its own text, which prepareTask then replaces
      // with ours for pinned tasks. A caller-supplied prompt has no chip.
      const chipTitle = plan.prompt ? "" : official?.title || ""
      if (!prompt) {
        row.action = "no-prompt"
        continue
      }

      const prep = await prepare({ taskCode: t.code, prompt, skillHint, chipTitle, port }).catch((e) => ({
        ok: false,
        error: String(e?.message ?? e),
      }))
      if (prep?.manual) {
        row.action = "manual"
        row.hint = prep.hint ?? ""
        continue
      }
      if (!prep?.ok) {
        row.action = "prepare-failed"
        row.error = prep?.error ?? "unknown"
        continue
      }

      const r = await send({
        taskCode: t.code,
        port,
        readStatus: opts.readTaskStatus,
        // A real artifact takes minutes, not seconds. The old 90 s ceiling
        // killed every attempt mid-answer, which is why nothing ever registered.
        timeoutMs: opts.taskTimeoutMs ?? 240000,
        // A full campaign read is ~1 request; polling it every 2.5 s for 4 min
        // would be ~96 of them, which is how an account gets rate-limited.
        pollMs: opts.taskPollMs ?? 5000,
        // 定时任务 only credits once the job fires, and our job is 2 minutes out
        // — so it gets the longest settle window of the four.
        settleMs: opts.taskSettleMs ?? (TASK_SURFACE[t.code]?.schedule ? 180000 : 90000),
      }).catch((e) => ({ ok: false, sent: false, earned: false, error: String(e?.message ?? e) }))

      row.sent = Boolean(r.sent)
      row.started = Boolean(r.started)
      row.finished = Boolean(r.finished)
      row.earned = Boolean(r.earned)
      row.statusAfter = r.statusAfter ?? row.statusAfter
      row.generationMs = r.generationMs ?? 0
      row.action = r.earned ? "earned" : r.sent ? "no-credit" : "send-failed"
      if (r.error) row.error = r.error

      if (r.earned) {
        // 提前停止 is the point: the campaign credits on the artifact, not on
        // the last token, so a stream stopped the moment 可领取 appears saves
        // the rest of the answer for free.
        const saved = r.stopped ? "，已立即停止生成" : ""
        report.notes.push(`「${t.title || t.code}」已计入任务${saved}，插件领取后可得 +100`)
        if (TASK_SURFACE[t.code]?.schedule) {
          report.notes.push("定时任务已创建：它是「2 分钟后执行一次」的一次性任务，执行完就不会再跑；可在侧栏「定时任务」里核对或删除")
        }
      } else if (r.sent && !r.started) {
        report.notes.push("提示词已填入，但对话没有开始生成——可能被输入框拦住了")
        if (taskMode === "probe") break
      } else if (taskMode === "probe") {
        report.notes.push(
          `这条任务已经完整跑完（${Math.round((r.generationMs || 0) / 1000)}s）仍未计分，说明它要的不只是对话，已停止，不再继续花额度`,
        )
        break
      }
      await sleep(opts.taskGapMs ?? 1500)
    }

    // A task that registered turns into credit waiting to be collected. Claim
    // it in the same pass — otherwise the +100 would sit there until tomorrow's
    // check-in, which is exactly the kind of half-done automation this sweep
    // exists to avoid.
    if (report.tasks.some((t) => t.earned)) {
      const after = await opts.readStatus().catch(() => null)
      const targets = after ? claimTargets(after) : []
      if (targets.length) {
        const claim = opts.claim ?? claimRewards
        const r2 = await claim({
          port,
          codes: targets.map((t) => t.code),
          timeoutMs: opts.claimTimeoutMs ?? 30000,
          autoLaunch: false,
        }).catch(() => ({ clicked: [] }))
        if (r2.clicked?.length) {
          report.clicked.push(...r2.clicked)
          report.clickedCodes.push(...(r2.clickedCodes ?? []))
          const { got } = await reread(opts.readStatus, after)
          for (const g of got) {
            if (!report.claimed.some((x) => x.label === g.label)) report.claimed.push(g)
          }
          report.credit = report.claimed.reduce((s, g) => s + (g.credit || 0), 0)
        }
      }
    }

    // Nothing left to say in that conversation: the credit is banked and the
    // client should not be left sitting on a half-written answer. Stop the
    // stream and start a fresh chat. Best-effort — a failure here must never
    // affect the claim above, which is the part that actually matters.
    if (report.tasks.some((t) => t.sent)) {
      const end = opts.endTurn ?? endTurn
      const e = await end({ port }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      report.chatEnded = Boolean(e?.ok)
      if (!e?.ok) report.notes.push("生成已停止，但没能自动切回空白会话")
    }
  }

  report.ok = Boolean(report.clientReady && !report.error)
  return report
}

/** One line for the account panel / check-in message. */
export function summarizeSweep(r) {
  if (!r) return ""
  const bits = []
  if (r.claimed?.length) bits.push(`领取 ${r.claimed.map((c) => `${c.label} +${c.credit}`).join("、")}`)
  else if (r.checkedIn) bits.push("今日已签")
  bits.push(`累计 ${r.total} 点`)
  const earned = (r.tasks ?? []).filter((t) => t.action === "earned").length
  if (earned) bits.push(`${earned} 个任务已计分`)
  const left = (r.tasks ?? []).filter((t) => t.action === "listed").length
  if (left) bits.push(`${left} 个任务待你手动完成`)
  return bits.join(" · ")
}

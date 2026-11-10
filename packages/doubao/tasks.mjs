#!/usr/bin/env node
// What is left on the Doubao `pc/agent-explore` page, and what it takes.
//
// The activity mixes two very different things:
//   - credit you already earned (daily sign-in, reached milestone tiers) — the
//     plugin claims it for you, no action needed;
//   - credit you have to *work* for (生成文档/PPT/表格, 技能, 定时任务, 电脑文件)
//     — each one runs a real generation that spends quota.
//
// This helper prints the second kind honestly, together with the prompts Doubao
// itself recommends for them, so finishing one is a copy-paste instead of a
// guess. It never generates anything on its own (that would spend quota to win
// quota), and it never claims either — that is `checkin()`'s job.
//
// Usage:
//   node packages/doubao/tasks.mjs              # read the cookie magpie stored
//   DOUBAO_COOKIE='sessionid=…' node packages/doubao/tasks.mjs
//   node packages/doubao/tasks.mjs --prompts 3  # how many prompts per task
//
//   # drive the client: open the right surface and prefill the official prompt
//   node packages/doubao/tasks.mjs --run pc_task_use_skill_v2
//   # …and actually send it, stopping the generation once the task registers
//   node packages/doubao/tasks.mjs --run pc_task_use_skill_v2 --send
//
//   # Doubao's own prompts usually expect you to paste your material. Supply a
//   # self-contained one instead (this is the only way a skill task can actually
//   # run: 润色论文 only counts if there is a paper to polish).
//   node packages/doubao/tasks.mjs --run pc_task_use_skill_v2 \
//     --prompt "润色这段摘要：…" --send
//
//   # The install-time pass, by hand: bring the client up, claim everything
//   # earned, then drive the +100 tasks (all of them by default; --tasks probe
//   # stops after the first one that earns nothing)
//   node packages/doubao/tasks.mjs --sweep
//   node packages/doubao/tasks.mjs --sweep --tasks probe
//
// `--sweep` is exactly what the plugin runs the first time it checks in a new
// account; running it again is harmless (nothing left to claim) but it will
// spend quota on every drivable task that is still at 未完成.
//
// `--run` without `--send` is free: it opens the surface and leaves the prompt
// in the composer for you to send. `--send` spends quota — see the measurement
// notes in lib/task-runner.mjs.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { prepareTask, sendTask, TASK_SURFACE } from "./lib/task-runner.mjs"
import { sweepRewards, defaultPromptFor } from "./lib/sweep.mjs"

const PARAMS = [
  "version_code=20800", "language=zh", "device_platform=web",
  "doubao_device_platform=web", "aid=497858", "real_aid=497858",
  "pkg_type=release_version", "pc_version=2.32.6", "doubao_pc_version=5.72.66",
  "samantha_web=1", "web_platform=desktop", "use-olympus-account=1",
  "web_tab_id=0",
].join("&")

const GROUP = "pc_incentive_task_mvp_v3"

function cookieFromStore() {
  const path = join(homedir(), ".config/magpie/plugin-auth.json")
  try {
    const all = JSON.parse(readFileSync(path, "utf8"))
    return all?.doubao?.key ?? ""
  } catch {
    return ""
  }
}

const STATUS = { 0: "未开放", 1: "未完成", 2: "待领取", 3: "已领取" }

// `recommend_prompts` entries are JSON *strings* ({"skill_name","show_prompt",
// "prompt"}), not objects — decode before reading.
function parsePrompts(task) {
  const raw = Array.isArray(task?.recommend_prompts) ? task.recommend_prompts : []
  const out = []
  for (const p of raw) {
    let item = p
    if (typeof p === "string") {
      const s = p.trim()
      if (s.startsWith("{")) { try { item = JSON.parse(s) } catch { item = { prompt: s } } }
      else item = { prompt: s }
    }
    if (item?.prompt) out.push({ prompt: item.prompt, shown: item.show_prompt, skill: item.skill_name })
  }
  return out
}

// One campaign read, returning just the task's status — used while the runner
// watches for the turn to be credited.
async function statusOf(cookie, code) {
  const url = `https://www.doubao.com/alice/ug/campaign/v3/detail/?${PARAMS}&_t=${Date.now()}`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", cookie },
      body: JSON.stringify({ campaign_group_code: GROUP }),
    })
    const body = await res.json()
    if (Number(body?.code) !== 0) return null
    const t = (body.data?.tasks ?? []).find((x) => x.campaign_code === code)
    return t ? Number(t.task_status) : null
  } catch {
    return null
  }
}

// The shape index.mjs's fetchDoubaoStatus returns, so the sweep engine can be
// driven from the CLI without reaching into the plugin's private reader.
async function campaignOf(cookie) {
  const url = `https://www.doubao.com/alice/ug/campaign/v3/detail/?${PARAMS}&_t=${Date.now()}`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", cookie },
      body: JSON.stringify({ campaign_group_code: GROUP }),
    })
    const body = await res.json()
    if (Number(body?.code) !== 0) return { auth: false, loginInvalid: true, checkin: null, totalAmount: 0 }
    const d = body.data ?? {}
    const tasks = Array.isArray(d.tasks) ? d.tasks : []
    const signin = tasks.find((t) => t.task_kind === "daily_signin")
    const c = signin?.daily_checkin || {}
    return {
      auth: true,
      checkin: signin
        ? {
            checkedIn: c.checked_in_today === true,
            continuousDays: Number(c.continuous_days) || 0,
            totalDays: Number(c.total_days) || 0,
            rewardAmount: Number(c.reward?.reward_amount) || 0,
          }
        : null,
      totalAmount: Number(d.progress?.total_amount) || 0,
      milestones: (Array.isArray(d.milestones) ? d.milestones : [])
        .filter((m) => m?.task_kind === "points_milestone")
        .map((m) => ({
          code: String(m.campaign_code ?? ""),
          threshold: Number(m.milestone_threshold) || 0,
          status: Number(m.task_status),
          reward: Number(m.reward_summaries?.[0]?.reward_amount) || 0,
          title: typeof m.title === "string" ? m.title : "",
        })),
      tasks: tasks.map((t) => ({
        code: String(t.campaign_code ?? ""),
        kind: String(t.task_kind ?? ""),
        status: Number(t.task_status),
        reward: Number(t.reward_summaries?.[0]?.reward_amount) || 0,
        title: typeof t.title === "string" ? t.title : "",
        // Same shape index.mjs produces, so the sweep can pass the activity
        // page's own prompt chip instead of falling back to a written one.
        type: String(t.campaign_type ?? ""),
        prompts: parsePrompts(t).map((p) => ({ prompt: p.prompt, title: p.shown, skill: p.skill })),
      })),
    }
  } catch (e) {
    return { auth: false, unexpected: true, code: String(e?.message ?? e), checkin: null, totalAmount: 0 }
  }
}

const ACTION_LABEL = {
  listed: "列入待办（未自动执行）",
  manual: "需手动完成",
  "prepare-failed": "打开界面失败",
  "no-prompt": "没有可用提示词",
  "send-failed": "发送失败",
  "no-credit": "已发送但未计分",
  earned: "已计分",
}

async function main() {
  const cookie = process.env.DOUBAO_COOKIE || cookieFromStore()
  if (!cookie) {
    console.error("没有豆包 Cookie：先添加账号，或设置 DOUBAO_COOKIE='sessionid=…'")
    return 1
  }
  // ---------------------------------------------------------------------
  // --sweep: the install-time pass, exactly as the plugin runs it.
  // ---------------------------------------------------------------------
  if (process.argv.includes("--sweep")) {
    const modeAt = process.argv.indexOf("--tasks")
    const taskMode = modeAt > 0 ? String(process.argv[modeAt + 1] ?? "full") : "full"
    console.log(`=== 首装福利扫描（任务模式：${taskMode}）===`)
    const r = await sweepRewards({
      taskMode,
      readStatus: () => campaignOf(cookie),
      readTaskStatus: (code) => statusOf(cookie, code),
    })
    console.log(`客户端：${r.client.stage}${r.client.action !== "none" ? `（${r.client.action}）` : ""}`)
    console.log(`累计额度：${r.total} 点 · ${r.checkedIn ? "今日已签" : "今日未签"}`)
    console.log(
      r.claimed.length
        ? `已领取：${r.claimed.map((c) => `${c.label} +${c.credit}`).join("、")} = +${r.credit}`
        : "已领取：无（没有已赚未领的奖励）",
    )
    if (r.tasks.length) {
      console.log("任务：")
      for (const t of r.tasks) console.log(`  · ${t.title || t.code} → ${ACTION_LABEL[t.action] ?? t.action}`)
    }
    for (const n of r.notes) console.log(`注：${n}`)
    return r.ok ? 0 : 1
  }

  const wantPrompts = (() => {
    const i = process.argv.indexOf("--prompts")
    return i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 3) : 2
  })()

  const url = `https://www.doubao.com/alice/ug/campaign/v3/detail/?${PARAMS}&_t=${Date.now()}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", cookie },
    body: JSON.stringify({ campaign_group_code: GROUP }),
  })
  const body = await res.json().catch(() => null)
  if (!body) { console.error(`豆包返回了非 JSON（HTTP ${res.status}）`); return 1 }
  if (Number(body.code) !== 0) { console.error(`豆包接口拒绝（code ${body.code}）——Cookie 可能已失效`); return 1 }

  const d = body.data ?? {}
  const total = Number(d.progress?.total_amount) || 0
  const tasks = Array.isArray(d.tasks) ? d.tasks : []
  const milestones = (Array.isArray(d.milestones) ? d.milestones : []).filter((m) => m?.task_kind === "points_milestone")

  const signin = tasks.find((t) => t.task_kind === "daily_signin")
  const signed = signin?.daily_checkin?.checked_in_today === true
  const dailyReward = Number(signin?.daily_checkin?.reward?.reward_amount) || 0

  const claimable = []
  if (!signed && signin) claimable.push({ label: "每日签到", credit: dailyReward })
  for (const m of milestones) {
    if (Number(m.task_status) === 2) {
      claimable.push({
        label: m.title || `累计 ${m.milestone_threshold} 点`,
        credit: Number(m.reward_summaries?.[0]?.reward_amount) || 0,
      })
    }
  }
  const claimSum = claimable.reduce((s, c) => s + c.credit, 0)

  console.log(`累计获得额度：${total} 点`)
  console.log(`签到：${signed ? `今日已签（+${dailyReward}）` : `今日未签（+${dailyReward} 待领）`}`)
  console.log(
    claimSum > 0
      ? `待领奖励：${claimable.map((c) => `${c.label} +${c.credit}`).join("、")} = +${claimSum}`
      : "待领奖励：无（已全部领取）",
  )
  if (claimSum > 0) console.log("  → 插件内置自动领取会处理；也可在客户端活动页手动点击。")

  const nextTier = milestones
    .filter((m) => Number(m.task_status) === 1)
    .sort((a, b) => a.milestone_threshold - b.milestone_threshold)[0]
  if (nextTier) {
    const gap = Math.max(0, Number(nextTier.milestone_threshold) - total)
    console.log(`下一档：累计 ${nextTier.milestone_threshold} 点 → +${Number(nextTier.reward_summaries?.[0]?.reward_amount) || 0}（还差 ${gap} 点）`)
  }

  const todo = tasks.filter((t) => t.task_kind === "chat_activity" && Number(t.task_status) === 1)
  if (!todo.length) {
    console.log("\n没有需要你动手的任务了。")
    return 0
  }

  console.log(`\n需要真实使用才能完成的 ${todo.length} 个任务（每个 +100，会消耗额度）：`)
  for (const t of todo) {
    console.log(`\n  ${t.title}   [${STATUS[Number(t.task_status)] ?? t.task_status}]`)
    if (t.description) console.log(`     ${t.description}`)
    const ps = parsePrompts(t)
    for (const p of ps.slice(0, wantPrompts)) {
      const skill = p.skill ? `（技能：${p.skill}）` : ""
      console.log(`     · ${p.shown ? p.shown + skill + "：" : ""}${p.prompt}`)
    }
    if (!ps.length) console.log("     （在客户端点「去完成」，按页面引导操作）")
  }
  console.log(
    "\n提示：这些任务要真的用 文档 / PPT / 表格 / 技能 / 定时任务 才能计分，" +
    "每次生成都从你的额度里扣。用 300 额度换 100 额度是亏的——值不值得你自己判断，所以插件不会替你做。",
  )

  // ---------------------------------------------------------------------
  // --run: drive the desktop client instead of just describing the task.
  // ---------------------------------------------------------------------
  const runAt = process.argv.indexOf("--run")
  if (runAt > 0) {
    const code = process.argv[runAt + 1]
    if (!code || code.startsWith("--")) { console.error("--run 后面要跟一个任务 code"); return 1 }
    if (!TASK_SURFACE[code]) {
      console.error(`未知任务 code：${code}\n可选：${Object.keys(TASK_SURFACE).join("、")}`)
      return 1
    }
    const task = tasks.find((t) => t.campaign_code === code)
    if (!task) { console.error(`活动里没有这个任务：${code}`); return 1 }
    if (Number(task.task_status) === 3) { console.log(`\n${task.title} 已经领过了。`); return 0 }
    if (Number(task.task_status) === 2) { console.log(`\n${task.title} 已完成待领取——等插件自动领即可。`); return 0 }

    const first = parsePrompts(task)[0]
    const customAt = process.argv.indexOf("--prompt")
    const custom = customAt > 0 ? String(process.argv[customAt + 1] ?? "") : ""
    // The two tasks that act on this machine are pinned to the plugin's own
    // minimal prompt — Doubao's recommendation for 本地电脑 may well be
    // "整理一下我的桌面", which is not something to send by accident.
    const pinned = Boolean(TASK_SURFACE[code].ownPrompt)
    const prompt = custom || (pinned ? "" : first?.prompt) || defaultPromptFor(code)
    if (!prompt) { console.error(`\n${task.title} 没有推荐提示词，只能在客户端按页面引导操作。`); return 1 }

    console.log(`\n=== 在客户端打开「${TASK_SURFACE[code].surface}」并填入提示词 ===`)
    console.log(`提示词：${prompt}`)
    // Prefer the activity page's own chip when we are sending Doubao's prompt:
    // it opens the right surface and fills the prompt for us. A pinned prompt
    // still uses the chip for the routing, then gets replaced.
    const chipTitle = custom ? "" : first?.shown || ""
    const prep = await prepareTask({ taskCode: code, prompt, skillHint: first?.shown || first?.skill, chipTitle })
    if (prep.manual) {
      console.log(`\n这个任务没法安全地代做：\n  ${prep.hint}\n\n提示词：\n  ${prompt}`)
      return 0
    }
    if (!prep.ok) { console.error(`打开失败：${prep.error}`); return 1 }
    const bits = []
    if (prep.toggled?.length) bits.push(`已开启 ${prep.toggled.join("、")}`)
    if (prep.openedSkill) bits.push(`已打开技能「${prep.openedSkill}」`)
    console.log(`已在 ${prep.surface}${bits.length ? `（${bits.join("，")}）` : ""} 填入提示词${prep.composed ? "" : "失败"}。`)

    if (!process.argv.includes("--send")) {
      console.log("\n未发送（这样不花额度）。确认无误后加 --send 重跑，或直接在客户端点发送。")
      return 0
    }

    const tIdx = process.argv.indexOf("--timeout")
    // A real artifact takes minutes. The old 120 s default cut every attempt
    // short, which is exactly why nothing ever registered.
    const timeoutMs = tIdx > 0 ? Math.max(60, Number(process.argv[tIdx + 1]) || 240) * 1000 : 240000
    console.log(`\n=== 发送，让它跑完；中途一旦变成可领取就立刻停止（最多等 ${Math.round(timeoutMs / 1000)} 秒）===`)
    const r = await sendTask({
      taskCode: code,
      timeoutMs,
      readStatus: (c) => statusOf(cookie, c),
    })
    if (r.error) { console.error(`发送失败：${r.error}`); return 1 }
    console.log(
      `已发送=${r.sent}  开始生成=${r.started}  自然跑完=${r.finished}  ` +
      `状态 ${r.statusBefore ?? "?"} → ${r.statusAfter ?? "?"}  ` +
      `计入任务=${r.earned}  已提前停止=${r.stopped}  生成 ${Math.round((r.generationMs || 0) / 1000)}s  共 ${Math.round(r.elapsedMs / 1000)}s`,
    )
    if (r.earned) {
      console.log(
        r.stopped
          ? "任务在生成中途就已计分，已停止生成省额度；插件会自动刷新活动页领取。"
          : "任务已完成，插件会自动刷新活动页领取。",
      )
    } else if (r.sent && !r.started) {
      console.log("提示词填进去了，但对话没有开始生成——检查客户端输入框是否被其他窗口挡住。")
    } else {
      console.log("这次对话已经完整跑完但没有计分：豆包按真实功能使用（GenWord / SkillUsed / WorkTaskMode…）判定，换提示词或换任务再试。")
    }
    return 0
  }

  return 0
}

process.exit(await main())

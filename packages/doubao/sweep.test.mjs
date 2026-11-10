// The install-time sweep, and the campaign arithmetic it shares with the
// check-in path. Everything external (client, claim engine, task runner) is
// injected, so these tests never launch a GUI, never spend quota, and are
// deterministic.
import { describe, expect, test } from "bun:test"

import { sweepRewards, orderTasks, drivableTasks, defaultPromptFor, summarizeSweep } from "./lib/sweep.mjs"
import { claimTargets, claimableCredit, diffClaims, todoTasks, statusLabel } from "./lib/campaign.mjs"

// A campaign read in the shape index.mjs's fetchDoubaoStatus produces.
function st({ checkedIn = true, days = 3, total = 900, milestones = [], tasks = [] } = {}) {
  return {
    auth: true,
    checkin: { checkedIn, continuousDays: days, totalDays: days, rewardAmount: 200 },
    totalAmount: total,
    milestones,
    tasks: [
      { code: "daily_signin", kind: "daily_signin", status: checkedIn ? 3 : 1, reward: 200, title: "每日签到" },
      ...tasks,
    ],
  }
}

const READY = { ok: true, stage: "ready", action: "none", version: "2.34.6" }
const NO_CLIENT = { ok: false, stage: "not-running", action: "launch-failed", error: "boom" }

function sweep(opts) {
  return sweepRewards({
    ensureClient: async () => READY,
    claim: async () => ({ clicked: [], clickedCodes: [], clientFound: true }),
    prepareTask: async () => ({ ok: true }),
    sendTask: async () => ({ ok: true, sent: true, earned: false, statusAfter: 1 }),
    endTurn: async () => ({ ok: true, stopped: false }),
    readTaskStatus: async () => 1,
    taskMode: "off",
    ...opts,
  })
}

describe("campaign arithmetic", () => {
  test("claimTargets is the daily sign-in plus every reached-but-uncollected tier", () => {
    const s = st({
      checkedIn: false,
      milestones: [
        { code: "points_milestone_500", threshold: 500, status: 2, reward: 200, title: "累计 500 点" },
        { code: "points_milestone_2000", threshold: 2000, status: 1, reward: 500, title: "累计 2000 点" },
        { code: "points_milestone_5000", threshold: 5000, status: 3, reward: 1300, title: "累计 5000 点" },
      ],
    })
    expect(claimTargets(s).map((t) => t.code)).toEqual(["daily_signin", "points_milestone_500"])
    expect(claimableCredit(s)).toBe(400)
  })

  test("an already-claimed day has nothing left to claim", () => {
    const s = st({
      checkedIn: true,
      milestones: [{ code: "points_milestone_500", threshold: 500, status: 3, reward: 200 }],
    })
    expect(claimTargets(s)).toEqual([])
    expect(claimableCredit(s)).toBe(0)
  })

  test("a quota-spending read (cooling / unexpected) never looks claimable", () => {
    expect(claimableCredit({ cooling: true })).toBe(0)
    expect(claimableCredit({ unexpected: true })).toBe(0)
    expect(claimableCredit({ loginInvalid: true })).toBe(0)
    expect(claimableCredit(null)).toBe(0)
  })

  test("todoTasks keeps status 1 only, and never the sign-in row", () => {
    const s = st({
      tasks: [
        { code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" },
        { code: "pc_task_work", kind: "chat_activity", status: 2, title: "待领" },
        { code: "pc_task_done", kind: "chat_activity", status: 3, title: "已领" },
      ],
    })
    expect(todoTasks(s).map((t) => t.code)).toEqual(["pc_task_use_skill_v2"])
  })

  test("diffClaims reports the sign-in and the tier that flipped", () => {
    const before = st({
      checkedIn: false,
      milestones: [{ code: "points_milestone_500", threshold: 500, status: 2, reward: 200, title: "累计 500 点" }],
    })
    const after = st({
      checkedIn: true,
      stripes: null,
      milestones: [{ code: "points_milestone_500", threshold: 500, status: 3, reward: 200, title: "累计 500 点" }],
    })
    const got = diffClaims(before, after)
    expect(got.map((g) => g.label)).toEqual(["每日签到", "累计 500 点"])
    expect(got.reduce((s, g) => s + g.credit, 0)).toBe(400)
  })

  test("diffClaims stays empty when nothing moved", () => {
    const s = st()
    expect(diffClaims(s, s)).toEqual([])
  })

  test("statusLabel never renders a bare number", () => {
    expect(statusLabel(1)).toBe("未完成")
    expect(statusLabel(2)).toBe("待领取")
    expect(statusLabel(99)).toBe("99")
  })
})

describe("task ordering", () => {
  test("完成复杂任务 is probed first — it wants a real artifact, like the GenPPT task that already paid", () => {
    const tasks = [
      { code: "pc_task_complete_computer_task_v2" },
      { code: "pc_task_use_skill_v2" },
      { code: "pc_task_complete_work_task_v2" },
    ]
    expect(orderTasks(tasks).map((t) => t.code)).toEqual([
      "pc_task_complete_work_task_v2",
      "pc_task_use_skill_v2",
      "pc_task_complete_computer_task_v2",
    ])
  })

  test("定时任务 is drivable too, and goes last — it is the only one that leaves a job behind", () => {
    const tasks = [
      { code: "pc_task_create_schedule_v2" },
      { code: "pc_task_complete_computer_task_v2" },
      { code: "pc_task_use_skill_v2" },
      { code: "pc_task_complete_work_task_v2" },
      { code: "unknown_task" },
    ]
    expect(drivableTasks(tasks).map((t) => t.code)).toEqual([
      "pc_task_complete_work_task_v2",
      "pc_task_use_skill_v2",
      "pc_task_complete_computer_task_v2",
      "pc_task_create_schedule_v2",
    ])
  })

  test("every drivable task ships a self-contained prompt", () => {
    for (const code of [
      "pc_task_use_skill_v2",
      "pc_task_complete_work_task_v2",
      "pc_task_complete_computer_task_v2",
      "pc_task_create_schedule_v2",
    ]) {
      expect(defaultPromptFor(code).length).toBeGreaterThan(20)
    }
    expect(defaultPromptFor("nope")).toBe("")
  })

  test("the two tasks that touch the machine are pinned to our own minimal prompt", () => {
    // Doubao's own text for these is "整理一下我的桌面" / "每小时提醒我" — neither
    // may be sent unattended, so the sweep has to ignore it here.
    expect(defaultPromptFor("pc_task_complete_computer_task_v2")).toContain("doubao-task-check.txt")
    expect(defaultPromptFor("pc_task_complete_computer_task_v2")).toContain("不要读取或修改其他任何文件")
    expect(defaultPromptFor("pc_task_create_schedule_v2")).toContain("只执行这一次")
  })
})

describe("sweepRewards", () => {
  test("claims exactly the earned rewards and reports the credit", async () => {
    const before = st({
      checkedIn: false,
      total: 500,
      milestones: [{ code: "points_milestone_500", threshold: 500, status: 2, reward: 200, title: "累计 500 点" }],
    })
    const after = st({
      checkedIn: true,
      total: 900,
      milestones: [{ code: "points_milestone_500", threshold: 500, status: 3, reward: 200, title: "累计 500 点" }],
    })
    let reads = 0
    const asked = []
    const r = await sweep({
      readStatus: async () => (reads++ === 0 ? before : after),
      claim: async (o) => {
        asked.push(o.codes)
        return { clicked: ["立即签到", "额外领 200 点额度"], clickedCodes: ["daily_signin", "points_milestone_500"], clientFound: true }
      },
    })
    expect(asked).toEqual([["daily_signin", "points_milestone_500"]])
    expect(r.credit).toBe(400)
    expect(r.claimed.map((c) => c.label)).toEqual(["每日签到", "累计 500 点"])
    expect(r.ok).toBe(true)
    expect(r.total).toBe(500) // the pre-claim read is what the report describes
  })

  test("does not claim when there is nothing earned", async () => {
    let claimed = false
    const r = await sweep({
      readStatus: async () => st({ checkedIn: true }),
      claim: async () => { claimed = true; return {} },
    })
    expect(claimed).toBe(false)
    expect(r.credit).toBe(0)
    expect(r.targets).toEqual([])
    expect(r.ok).toBe(true)
  })

  test("an unreachable client fails the sweep without touching the claim engine", async () => {
    let claimed = false
    const r = await sweep({
      ensureClient: async () => NO_CLIENT,
      readStatus: async () => st({ checkedIn: false }),
      claim: async () => { claimed = true; return {} },
    })
    expect(claimed).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.clientReady).toBe(false)
    expect(r.client.action).toBe("launch-failed")
    expect(r.credit).toBe(0)
  })

  test("an expired session is reported, not clicked at", async () => {
    const r = await sweep({ readStatus: async () => ({ auth: false, loginInvalid: true }) })
    expect(r.error).toBe("login-invalid")
    expect(r.ok).toBe(false)
    expect(r.targets).toEqual([])
  })

  test("taskMode off lists the tasks and executes none", async () => {
    const prepared = []
    const r = await sweep({
      readStatus: async () => st({ checkedIn: true, tasks: [{ code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" }] }),
      prepareTask: async (o) => { prepared.push(o.taskCode); return { ok: true } },
    })
    expect(prepared).toEqual([])
    expect(r.tasks[0].action).toBe("listed")
    // The list lives in `todos`/`tasks`, not in a duplicated note.
    expect(r.todos.map((t) => t.code)).toEqual(["pc_task_use_skill_v2"])
    expect(r.notes.join(" ")).not.toContain("未自动执行")
  })

  test("probe executes exactly one task and stops when it earns nothing", async () => {
    const prepared = []
    const sent = []
    const r = await sweep({
      taskMode: "probe",
      readStatus: async () => st({
        checkedIn: true,
        tasks: [
          { code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" },
          { code: "pc_task_complete_work_task_v2", kind: "chat_activity", status: 1, title: "工作任务" },
        ],
      }),
      prepareTask: async (o) => { prepared.push(o.taskCode); return { ok: true } },
      sendTask: async (o) => { sent.push(o.taskCode); return { ok: true, sent: true, started: true, finished: true, earned: false, statusAfter: 1, generationMs: 42000 } },
    })
    expect(prepared).toEqual(["pc_task_complete_work_task_v2"])
    expect(sent).toEqual(["pc_task_complete_work_task_v2"])
    expect(r.tasks.find((t) => t.code === "pc_task_complete_work_task_v2").action).toBe("no-credit")
    expect(r.tasks.find((t) => t.code === "pc_task_use_skill_v2").action).toBe("listed")
    expect(r.notes.join(" ")).toContain("已经完整跑完")
  })

  test("probe continues into the rest in full mode and reports the one that paid", async () => {
    const sent = []
    const r = await sweep({
      taskMode: "full",
      readStatus: async () => st({
        checkedIn: true,
        tasks: [
          { code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" },
          { code: "pc_task_complete_work_task_v2", kind: "chat_activity", status: 1, title: "工作任务" },
        ],
      }),
      sendTask: async (o) => {
        sent.push(o.taskCode)
        return { ok: true, sent: true, earned: o.taskCode === "pc_task_complete_work_task_v2", statusAfter: 2 }
      },
    })
    expect(sent).toHaveLength(2)
    expect(r.tasks.find((t) => t.code === "pc_task_complete_work_task_v2").action).toBe("earned")
    expect(r.notes.join(" ")).toContain("+100")
  })

  test("without a task-status reader nothing is sent (no blind spending)", async () => {
    const prepared = []
    const r = await sweep({
      taskMode: "probe",
      readTaskStatus: undefined,
      readStatus: async () => st({ checkedIn: true, tasks: [{ code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" }] }),
      prepareTask: async (o) => { prepared.push(o.taskCode); return { ok: true } },
    })
    expect(prepared).toEqual([])
    expect(r.notes.join(" ")).toContain("避免白花额度")
  })

  test("full mode drives every task, then ends the conversation", async () => {
    const prepared = []
    const sent = []
    let ended = 0
    const r = await sweep({
      taskMode: "full",
      readStatus: async () => st({
        checkedIn: true,
        tasks: [
          { code: "pc_task_complete_work_task_v2", kind: "chat_activity", status: 1, title: "工作任务" },
          { code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" },
          { code: "pc_task_complete_computer_task_v2", kind: "chat_activity", status: 1, title: "本地电脑" },
          { code: "pc_task_create_schedule_v2", kind: "chat_activity", status: 1, title: "定时任务" },
        ],
      }),
      prepareTask: async (o) => { prepared.push(o.taskCode); return { ok: true } },
      sendTask: async (o) => {
        sent.push(o.taskCode)
        return { ok: true, sent: true, started: true, earned: true, stopped: true, statusAfter: 2 }
      },
      endTurn: async () => { ended += 1; return { ok: true, stopped: true } },
      taskGapMs: 0,
    })
    expect(prepared).toEqual([
      "pc_task_complete_work_task_v2",
      "pc_task_use_skill_v2",
      "pc_task_complete_computer_task_v2",
      "pc_task_create_schedule_v2",
    ])
    expect(sent).toHaveLength(4)
    // One conversation, so one reset at the end — not one per task.
    expect(ended).toBe(1)
    expect(r.chatEnded).toBe(true)
    expect(r.notes.join(" ")).toContain("已立即停止生成")
    expect(r.notes.join(" ")).toContain("2 分钟后执行一次")
  })

  test("a sweep never fires more turns than its budget", async () => {
    const sent = []
    const r = await sweep({
      taskMode: "full",
      maxTurns: 1,
      readStatus: async () => st({
        checkedIn: true,
        tasks: [
          { code: "pc_task_complete_work_task_v2", kind: "chat_activity", status: 1, title: "工作任务" },
          { code: "pc_task_use_skill_v2", kind: "chat_activity", status: 1, title: "技能" },
          { code: "pc_task_create_schedule_v2", kind: "chat_activity", status: 1, title: "定时任务" },
        ],
      }),
      sendTask: async (o) => { sent.push(o.taskCode); return { ok: true, sent: true, earned: false, statusAfter: 1 } },
      endTurn: async () => ({ ok: true }),
    })
    expect(sent).toEqual(["pc_task_complete_work_task_v2"])
    expect(r.tasks.filter((t) => t.action === "over-budget")).toHaveLength(2)
  })

  test("the machine-touching tasks ignore Doubao's own recommended prompt", async () => {
    // The prompt reaches the client through prepareTask (it types it into the
    // composer), so that is the argument worth asserting on.
    const prepared = []
    await sweep({
      taskMode: "full",
      readStatus: async () => st({
        checkedIn: true,
        tasks: [
          {
            code: "pc_task_complete_computer_task_v2",
            kind: "chat_activity",
            status: 1,
            title: "本地电脑",
            prompts: [{ prompt: "帮我把桌面上的文件按类型整理到不同文件夹", title: "整理桌面" }],
          },
        ],
      }),
      prepareTask: async (o) => { prepared.push(o); return { ok: true } },
      sendTask: async () => ({ ok: true, sent: true, earned: false, statusAfter: 1 }),
      endTurn: async () => ({ ok: true }),
    })
    expect(prepared[0].prompt).toContain("doubao-task-check.txt")
    expect(prepared[0].prompt).not.toContain("整理到不同文件夹")
    // The chip may still be used to *reach* the right surface, but it carries
    // Doubao's title — prepareTask replaces its text with ours and refuses to
    // send if that replacement does not take.
    expect(prepared[0].chipTitle).toBe("整理桌面")
  })
})

describe("summarizeSweep", () => {
  test("names the credit, the total and what is left", () => {
    const line = summarizeSweep({
      claimed: [{ label: "每日签到", credit: 200 }],
      total: 900,
      checkedIn: true,
      tasks: [{ action: "earned" }, { action: "listed" }],
    })
    expect(line).toContain("每日签到 +200")
    expect(line).toContain("累计 900 点")
    expect(line).toContain("1 个任务已计分")
    expect(line).toContain("1 个任务待你手动完成")
  })

  test("an empty report is an empty string, never 'undefined'", () => {
    expect(summarizeSweep(null)).toBe("")
  })
})

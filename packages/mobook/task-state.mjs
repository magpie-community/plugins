// 成长计划的「今日已完成」缓存与进度文案：插件（签到 / 用量卡）和后台 runner 共用。
// 账号目录由 taskPaths(uid) 给出，done.json 只在当天有效。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const TASK_TZ = 'Asia/Shanghai'

// dayKey 按墨宝的北京时区算「今天」：跨时区/跨 UTC 零点都不会把日期算错。
export function dayKey(date = new Date(), timeZone = TASK_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

// readDoneAt 读账号目录下的 done.json；日期不是今天就当作没有（第二天重新跑）。
export function readDoneAt(dir, date = new Date()) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'done.json'), 'utf8'))
    if (!raw || raw.date !== dayKey(date)) return null
    return raw
  } catch {
    return null
  }
}

export function writeDoneAt(dir, detail = {}, date = new Date()) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'done.json'), JSON.stringify({ date: dayKey(date), at: new Date().toISOString(), ...detail }))
  } catch {}
}

// 不做的：审校批注、小程序端对话是人工任务。
// 录音笔记可以做：要求是「5 分钟以上的录音笔记并查看总结」，用段落 JSON + 时长元数据即可，不产生录音计费。
export const NON_AUTOMATABLE_RULES = [20, 16]

// AUTOMATABLE_RULES 是「算进 任务 x/y 进度」的口径：只有 runner 真有动作能做的规则才该列进来。
// 列进来却没动作的规则会让 done >= total 永远不成立 → done.json 永远写不出来 →
// 每天的签到都会重跑一遍成长任务，白花墨滴（这正是 25 造成过的后果：
// 25 在网页端自己的规则枚举里根本不存在，见 task-runner.mjs 的 HANDLED_RULES 注释）。
// 不变量：runner 的 HANDLED_RULES 必须 ⊇ 本列表，由 task-runner.test.mjs 的用例守住。
export const AUTOMATABLE_RULES = [12, 13, 14, 15, 17, 18, 19, 22, 23]

export function isAutomatable(task) {
  if (NON_AUTOMATABLE_RULES.includes(Number(task?.ruleType) || 0)) return false
  return AUTOMATABLE_RULES.includes(Number(task?.ruleType) || 0)
}

export function automatableTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(isAutomatable)
}

// claimDaily 给「一天只该做一次」的动作（签到、活跃打卡）打一个当天的标记。
// 插件的签到线程（magpie 宿主进程）与后台 runner（独立子进程）是两个进程，
// 两边都做一遍就会重复花墨滴：各发一条活跃对话、重复领一次签到。
//
// 标记按天分文件（daily-<name>-<YYYY-MM-DD>.lock），用 O_EXCL 独占创建：
//   - 建成功 → 返回 { claimed: true, release }，调用方去做这件事；
//   - 已存在 → 返回 null，意思是「今天已经有人做过了」，调用方跳过。
// 标记**成功后不删**（整天有效），否则后到的那一方会重新拿锁再做一遍：
// 服务端只管签到一天一次，却不管活跃对话一天一次 —— 活跃对话才是真正花钱的那一步。
// 只有失败才 release()，让它当天还能重试。
export function claimDaily(dir, name, date = new Date()) {
  if (!dir) return { claimed: true, release: () => {} }
  const lockPath = path.join(dir, `daily-${name}-${dayKey(date)}.lock`)
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    return { claimed: true, release: () => releaseLock(lockPath) }
  } catch {
    return null
  }
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch {}
}

// taskDoneCount / taskProgressText：claimed 算完成；没有可自动化任务或全部完成时不给进度文案。
export function taskDoneCount(tasks) {
  return automatableTasks(tasks).filter((task) => String(task?.status ?? '') === 'claimed').length
}

export function taskProgressText(tasks) {
  const list = automatableTasks(tasks)
  if (!list.length) return ''
  const done = list.filter((task) => String(task?.status ?? '') === 'claimed').length
  if (done >= list.length) return ''
  return '任务 ' + done + '/' + list.length
}
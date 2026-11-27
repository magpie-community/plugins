// 成长计划任务按人类用户最快完成操作所需的时间计时。
export const HUMAN_MIN_MS = {
  checkin: 3000, // 点一下签到
  activity: 15000, // 发一条短对话并等回复
  desktop: 10000, // 切到桌面端发一句
  cron: 40000, // 填定时任务名称/时间/提示词并保存
  knowledge: 30000, // 建文件、上传、等解析
  'image-note': 35000, // 传图、写笔记、等 AI 总结
  'recording-note': 30000, // 建 5 分钟录音笔记并查看总结
  xhs: 30000, // 装数字内容专家并写一篇笔记
  experts3: 75000, // 3 个专家各发一条并等回复
  reviser3: 75000, // 同一个审校专家带稿件发 3 次
}
export const SKILL_MIN_MS = 25000 // 打开技能、粘贴素材、运行
export const EXPERT_MIN_MS = 25000 // 每个专家一条短提示：打开、打字、发送、等回复
export const EXTRA_MIN_MS = 15000 // 在“真人最快时间”之上再随机加 15–30 秒
export const EXTRA_MAX_MS = 30000

// 按动作类型返回人类最快操作时间；专家动作可用 timingType='expert' 并按实际使用数累加。
export function humanMinMs(name, detail) {
  if (name === 'expert') {
    const n = Array.isArray(detail) ? detail.length : 0
    return EXPERT_MIN_MS * Math.max(1, n)
  }
  if (String(name).startsWith('skill:')) return SKILL_MIN_MS
  return HUMAN_MIN_MS[name] ?? 15000
}

// 每条动作之间的等待：该类动作的真人最快时间 + 15–30 秒随机（最后一个动作不等）。
export function humanGapMs(name, detail, random = Math.random) {
  return humanMinMs(name, detail) + EXTRA_MIN_MS + Math.floor(random() * (EXTRA_MAX_MS - EXTRA_MIN_MS + 1))
}


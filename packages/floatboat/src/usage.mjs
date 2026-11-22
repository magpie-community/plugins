// src/usage.mjs —— 把 /api/desktop/user/me 的账号信息翻成 magpie 的 usage 卡片
//
// ⚠ 契约边界（magpie 0.1.4445，宿主 `usageOf` 原文）：
//   · 顶层 balance 走 `text(u.balance)` —— 只认**字符串**，给数字会被丢成 ""。
//   · 窗口的 balance 走 `typeof w.balance === "number"` —— 只认**数字**，给字符串变 null。
//   · `used == null` 现在是 null（「没表态」），不再是老的「归一成 0」。
//     所以钱包型窗口**不给 used**：宿主当它没有占比，但仍按 balance 给账号排序（#3950）。
//   · 硬凑 used/limit 只会画出一条永远 100% 的假进度条 —— 上游给的本来就是余额不是百分比。
//
// 结论：积分是「没有总量的预付钱包」，正确形状就是 `{name, balance:<number>, unit}`。

const LEVEL_LABEL = {
  free: "Free",
  lite: "Lite",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
}

/**
 * @param {Awaited<ReturnType<import("./desktop-api.mjs").fetchUser>>} user
 * @param {{accountId?: string}} [o]
 */
export function buildUsage(user, { accountId } = {}) {
  const credits =
    typeof user?.credits === "number" && Number.isFinite(user.credits) ? user.credits : null

  // 上游没给余额时**不要报 0**：0 是「钱包空了」，true 的情况是「上游没说」。
  // 用一条 aside 的纯文本窗口说明 —— 宿主不当它是占比，路由按「未读」处理。
  const windows =
    credits === null
      ? [{ name: "积分", used: 0, aside: true, display: "上游没有返回余额", unit: "积分" }]
      : [{ name: "积分", balance: credits, unit: "积分" }]

  const level = LEVEL_LABEL[String(user?.membershipLevel || "").toLowerCase()] ?? null
  const plan = level ?? (user?.hasActiveSubscription ? "会员" : "免费")

  // 只出钱包型窗口这一处余额。顶层 balance 也会渲染，两个一起给会显示成
  // 「余额 180 积分」+「积分 剩余 180 积分」两条重复信息（2026-11-20 截图确认）。
  return {
    plan,
    user: accountId || user?.email || user?.name || undefined,
    windows,
  }
}

/** 拿不到账号信息时的兜底卡片（不要甩 JWT / 堆栈给用户看） */
export function usageError(message, { signIn } = {}) {
  return {
    error: String(message ?? "读取额度失败"),
    windows: [],
    // 只认 expired / kept / renewed；expired 会让宿主把这个账号标成要重新登录
    ...(signIn === "expired" || signIn === "kept" || signIn === "renewed" ? { signIn } : {}),
  }
}

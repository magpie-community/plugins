export const SITE = "https://ccx.autobits.cc"
export const WALLET = `${SITE}/app/wallet`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等签到按钮真正渲染出来。不能用「页面里有『每日签到』字样」判断——
// 侧边栏导航和充值记录里都有这几个字，会提前放行。
export async function waitWalletReady(page, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      for (const b of document.querySelectorAll("button,[role=button]")) {
        const t = (b.innerText || "").trim()
        if (t === "每日签到" || t.startsWith("今日已签")) return true
      }
      return location.pathname.includes("/login")
    }).catch(() => false)
    if (ready) return true
    await sleep(500)
  }
  return false
}

// 读页面上的余额和签到状态（不调 API，避免鉴权问题）
export async function readUsage(page) {
  await waitWalletReady(page)
  const text = await page.evaluate(() => document.body?.innerText ?? "")
  // 匹配「现金余额: $X.XX」或「可用合计: $X.XX」，不要匹配「约可用 N 天」
  const m = text.match(/(?:现金余额|可用合计)[:：]\s*\$?([\d,.]+)/)
  const streak = text.match(/连签\s*(\d+)\s*天/)
  return {
    balance: m ? parseFloat(m[1].replace(/,/g, "")) : undefined,
    checkedIn: text.includes("今日已签"),
    streak: streak ? Number(streak[1]) : undefined,
    enabled: !text.includes("签到未开放") && !text.includes("签到活动目前没有开放"),
    loggedIn: text.includes("可用余额") || text.includes("今日已签"),
  }
}

export async function waitForSignIn(page, { signal, timeoutMs = 8 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("登录已取消")
    const url = await page.url()
    if (url.includes("/app/") && !url.includes("/login")) {
      const ok = await waitWalletReady(page, { timeoutMs: 30000 })
      if (ok) return readUsage(page)
    }
    await sleep(500)
  }
  throw new Error("登录超时，请重试")
}

// 在页面里找到「每日签到」按钮并点击（和独立脚本一致）
export async function claim(page) {
  const clicked = await page.evaluate(() => {
    for (const b of document.querySelectorAll("button,[role=button]")) {
      if ((b.innerText || "").trim() === "每日签到") { b.click(); return true }
    }
    return false
  })
  if (!clicked) return { outcome: "failed", message: "没找到签到按钮" }
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText ?? "")
    if (text.includes("签到成功")) {
      const m = text.match(/签到成功[！!]?\s*获得\s*([^\n]+)/)
      return { outcome: "claimed", credit: m?.[1]?.trim() }
    }
    if (text.includes("今日已签")) return { outcome: "done" }
    if (text.includes("签到活动目前没有开放") || text.includes("签到未开放")) return { outcome: "inactive" }
    await sleep(300)
  }
  return { outcome: "failed", message: "点了签到按钮，但没看到成功提示" }
}

export function walletCard(data) {
  return {
    plan: "钱包积分",
    ...(data.balance !== undefined ? { balance: data.balance, unit: "积分" } : {}),
    windows: [{
      name: "每日签到",
      used: data.checkedIn ? 100 : 0,
      display: !data.enabled ? "签到未开放" : data.checkedIn ? `今天已签 · 连签 ${data.streak ?? "?"} 天` : "今天可签到",
      aside: true,
    }],
  }
}

// 模型列表走公开 API（OpenAI 兼容，用 API Key 即可，不需要浏览器）
export async function listModels(key) {
  const r = await fetch(`${SITE}/v1/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })
  if (!r.ok) return []
  const data = await r.json()
  return (data.data ?? data.models ?? []).map((m) => ({ id: m.id, name: m.id }))
}

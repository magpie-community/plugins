;(async () => {
  await magpie.ready

  const status = document.getElementById("status")
  const balance = document.getElementById("balance")
  const balanceMeta = document.getElementById("balance-meta")

  if (window.__QUWORK_BALANCE__) {
    balance.textContent = window.__QUWORK_BALANCE__
    const detail = window.__QUWORK_BALANCE_DETAIL__
    if (detail?.updatedAt) {
      const when = new Date(detail.updatedAt)
      const parts = [`更新于 ${when.toLocaleString()}`]
      if (detail.limited > 0) parts.push(`限时 ${detail.limited}`, `永久 ${detail.permanent}`)
      balanceMeta.textContent = parts.join(" · ")
    }
  } else {
    balance.textContent = "—"
  }

  try {
    const providers = await magpie.read("providers:list")
    const list = Array.isArray(providers) ? providers : []
    const quwork = list.find((provider) => provider?.id === "quwork")
    if (quwork) {
      status.textContent = `已找到供应商：${quwork.name || "QuWork"}。现在到 Providers 页面点登录即可。`
      status.className = "ok"
    } else {
      status.textContent = "供应商列表里还没有 QuWork：确认插件是 On，必要时重启 magpie。"
      status.className = "missing"
    }
  } catch (error) {
    status.textContent = `读取供应商列表失败：${error instanceof Error ? error.message : String(error)}`
    status.className = "missing"
  }
})()

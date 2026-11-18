;(async () => {
  const status = document.getElementById("status")

  async function refresh() {
    try {
      const providers = await magpie.read("providers:list")
      const list = Array.isArray(providers) ? providers : providers?.providers
      if (Array.isArray(list) && list.some((provider) => provider?.id === "quwork")) {
        status.textContent = "已找到 QuWork，可以在供应商页管理模型密钥。"
        status.className = "ok"
      } else {
        status.textContent = "请在供应商页查看 QuWork。首次安装后可重启 Magpie 再查看。"
        status.className = "missing"
      }
    } catch {
      status.textContent = "请在 Magpie 供应商页查看 QuWork 状态。"
      status.className = "missing"
    }
  }

  try {
    await magpie.ready
    await refresh()
    magpie.onVisibility?.((visible) => {
      if (visible) refresh()
    })
  } catch {
    status.textContent = "在 Magpie 内打开此页即可查看供应商状态。"
  }
})()

const api = "https://api.factory.ai"
const periods = [["fiveHour", "5 hours", 18_000], ["weekly", "7 days", 604_800], ["monthly", "30 days", 2_592_000]]

// Droid ACP omits billingPool. Keep these verified IDs in sync with the Factory provider.
const pools = {
  standard: [
    "claude-fable-5.1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8",
    "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5",
    "claude-haiku-4-5-20251001", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol",
    "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "grok-4.7", "grok-4.6",
    "muse-spark-1.2", "gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.7-flash",
    "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "claude-fable-5.2",
    "gemini-4-carbon", "gemini-4-hydrogen", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra",
    "gemini-4-neon", "muse-spark-open", "claude-opus-5-5-fast", "claude-opus-5-fast",
    "claude-opus-4-8-fast", "gpt-5.5-fast", "gpt-5.4-fast", "gpt-5.3-codex-fast", "gpt-6-sol-fast",
    "gpt-6-luna-fast", "gpt-5.6-sol-fast", "gpt-6.2-astra-fast", "gpt-6.2-sol-fast",
  ],
  core: [
    "glm-5.3", "glm-5.3-flash", "glm-5.2", "kimi-k3.1-pro", "kimi-k3", "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-1017", "qwen3.8-max", "minimax-m3.1-flash", "minimax-m3", "minimax-m2.7",
    "mistral-large-4", "mistral-medium-3.5", "nemotron-3.5-super", "nemotron-3-ultra", "inkling",
    "beam-1.0", "glm-5.2-fast",
  ],
}

// These windows mirror the Factory subscription. Model selection stays in Droid.
export async function accountQuota(key, region) {
  if (!key) return { error: "An API key is required to read Factory limits. Local Droid logins can use /status.", signIn: "kept" }
  const headers = { Authorization: "Bearer " + key, Accept: "application/json", "X-Factory-Client": "cli" }
  const get = async url => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), redirect: "error" })
    if (!r.ok) throw new Error("Factory quota request returned HTTP " + r.status)
    return r.json()
  }
  try {
    if (region == null) region = (await get(api + "/api/cli/whoami")).region
    const base = region === "eu" ? "https://api.eu.factory.ai" : api
    const limits = await get(base + "/api/billing/limits")
    const windows = []
    const extra = limits.extraUsageAllowed === true && limits.extraUsageBalanceCents > 0
    for (const [pool, prefix] of [["standard", ""], ["core", "Droid Core · "]]) {
      for (const [field, name, span] of periods) {
        const w = limits.limits?.[pool]?.[field]
        if (!Number.isFinite(w?.usedPercent)) continue
        const win = { name: prefix + name, used: Math.max(0, Math.min(100, w.usedPercent)), span, models: [...pools[pool]] }
        if (extra) win.aside = true
        const end = w.windowEnd
        if (end) {
          const date = new Date(/^\d+$/.test(end) ? Number(end) : end)
          if (Number.isFinite(date.getTime())) win.resetsAt = date.toISOString()
        }
        windows.push(win)
      }
    }
    if (Number.isFinite(limits.extraUsageBalanceCents) && limits.extraUsageBalanceCents > 0) {
      windows.push({ name: "Extra usage", used: 0, display: "$" + (limits.extraUsageBalanceCents / 100).toFixed(2), aside: true })
    }
    if (!windows.length) throw new Error("Factory reported no usage limits for this account.")
    return { windows, signIn: "kept" }
  } catch (error) { return { error: error.message, signIn: "kept" } }
}

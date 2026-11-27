// Droid 1.21 writes cumulative counts after each model call, including calls
// made before an MCP result. ACP usage_update.used measures context size.
import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
const zero = () => Object.fromEntries(fields.map(key => [key, 0]))
const valid = value => Number.isSafeInteger(value) && value >= 0

export function sessionMeter(cwd, sessionId, previous = {}) {
  const dir = realpathSync(cwd).replace(/[\\/:]/g, "-")
  const file = /^[\w-]+$/.test(sessionId)
    ? join(process.env.FACTORY_HOME_OVERRIDE || homedir(), ".factory", "sessions", dir, sessionId + ".settings.json")
    : undefined
  const charged = zero()
  for (const field of fields) if (valid(previous[field])) charged[field] = previous[field]
  let base = zero()
  return {
    begin() { base = { ...charged } },
    snapshot() { return { ...charged } },
    async read(acp) {
      let totals
      const direct = { ...acp, cacheReadTokens: acp?.cachedReadTokens ?? acp?.cacheReadTokens,
        cacheCreationTokens: acp?.cachedWriteTokens ?? acp?.cacheCreationTokens }
      // Tool boundaries often arrive just before Droid replaces the settings file.
      for (let attempt = 0; file; attempt++) {
        try { totals = JSON.parse(readFileSync(file, "utf8")).tokenUsage } catch {}
        if (fields.some(f => valid(totals?.[f]) && totals[f] > charged[f]) ||
            valid(direct.inputTokens) && valid(direct.outputTokens) || attempt === 6) break
        await sleep(25)
      }
      const delta = zero()
      for (const field of fields) {
        const total = Math.max(valid(totals?.[field]) ? totals[field] : 0,
          valid(direct[field]) ? base[field] + direct[field] : 0)
        delta[field] = Math.max(0, total - charged[field])
        charged[field] += delta[field]
      }
      return delta
    },
  }
}

import fs from "node:fs"
import path from "node:path"
import { createMcpBridge } from "../mcp-sync.mjs"

export default async function DesignMcpBridge({ serverUrl }) {
  if (process.env.HILO_AGENT_PROFILE_VERSION !== "3" || !process.env.GATEWAY_URL) return {}
  if (process.env.XDG_CONFIG_HOME) {
    const ownership = path.resolve(process.env.XDG_CONFIG_HOME, "../../.magpie-mcp/ownership.json")
    if (fs.existsSync(ownership) && JSON.parse(fs.readFileSync(ownership, "utf8")).nativeReady === true) return {}
  }
  const bridge = createMcpBridge({
    file: path.join(process.env.XDG_CONFIG_HOME, "opencode/opencode.json"), serverUrl,
  })
  let running = false
  let lastError
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await bridge.sync()
      lastError = undefined
    } catch (error) {
      if (error.message !== lastError) console.error(`[minimax-design-mcp] ${error.message}`)
      lastError = error.message
    } finally { running = false }
  }, 5000)
  timer.unref()
  return { config: async (config) => bridge.config(config), dispose: async () => clearInterval(timer) }
}

import { applyMedia, connection, mediaPaths, prepareAgentPath, syncMedia } from "./media-sync.mjs"
import { installMcpBridge } from "./mcp-sync.mjs"

const instance = Symbol.for("magpie.minimax-design.media.v1")

export default async function MiniMaxDesignMediaPlugin(_input, options = {}) {
  if (globalThis[instance]) return {}
  const paths = mediaPaths()
  let running = false
  let lastConnection
  let lastRefresh = 0
  let lastError
  let config
  const tick = async () => {
    if (running) return
    running = true
    try {
      if (!prepareAgentPath(paths)) return
      installMcpBridge(paths.control)
      const current = JSON.stringify(connection(paths))
      if (current === lastConnection && Date.now() - lastRefresh < 60000) return
      await syncMedia(paths, options, config?.provider)
      lastConnection = current
      lastRefresh = Date.now()
      lastError = undefined
    } catch (error) {
      const message = error.code === "EEXIST" ? "Design is updating its media store; waiting." : error.message
      if (message !== lastError) console.error(`[minimax-design] ${message}`)
      lastError = message
    } finally { running = false }
  }
  const timer = setInterval(tick, 5000)
  timer.unref()
  globalThis[instance] = timer
  process.once("exit", () => {
    try { if (!connection(paths)) applyMedia(paths, null, []) }
    catch { console.error("[minimax-design] Media cleanup pending; ownership record retained.") }
  })
  await tick()
  return { config(value) { config = value; lastRefresh = 0 } }
}

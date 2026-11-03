// Magpie selects exports["./server"]. Its MCP tools use Magpie's account
// store; the OpenCode entry points expose the two chat providers.
export { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin, MiniMaxCodeToolsPlugin } from "./index.mjs"

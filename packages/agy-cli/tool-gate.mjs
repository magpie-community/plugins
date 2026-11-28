// agy's PreToolUse hook for a session on agy's default agent (default-agent.mjs).
// agy runs it before every tool call with the call as JSON on stdin; the
// arguments are the tool names the session may call, a trailing * matching a
// prefix. Any other call is denied, and agy fails it without running it.
// Nothing but node:fs: it runs twice for every call.
import fs from "node:fs"

const allowed = process.argv.slice(2)
let name = ""
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"))
  if (typeof input?.toolCall?.name === "string") name = input.toolCall.name
} catch {}
const ok = !!name && allowed.some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
process.stdout.write(JSON.stringify(ok
  ? { decision: "allow" }
  : { decision: "deny", reason: `${name || "This tool"} is turned off in this session. Use only the tools you were given.` }))

// Droid runs this PreToolUse hook before its single native image call.
import { readFileSync } from "node:fs"
try {
  const args = JSON.parse(readFileSync(0, "utf8")).tool_input
  const allowed = JSON.parse(readFileSync(process.argv[2], "utf8"))
  const refs = args.references ?? []
  if (typeof args.prompt !== "string" || Object.keys(args).some(k => !["prompt", "references", "complexity"].includes(k)) ||
      !Array.isArray(refs) || refs.length !== allowed.length || refs.some((p, i) => p !== allowed[i])) process.exitCode = 2
} catch { process.exitCode = 2 }

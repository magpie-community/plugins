#!/usr/bin/env node
// Opt-in command hook. Telemetry failure must never block the harness.
import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTaskCollector } from "../lib/task-duration.mjs"

let printingConfig = false
try {
  const { values } = parseArgs({ options: {
    source: { type: "string", default: "protocol" },
    agent: { type: "string" },
    "data-dir": { type: "string" },
    "print-cursor-config": { type: "string" },
    help: { type: "boolean" },
  } })
  if (values.help) {
    console.log(`Usage: node bin/task-event.js --source protocol|cursor [--agent cursor] [--data-dir PATH]

Reads one JSON object from stdin; normal hook execution writes nothing to stdout.
Use the same --data-dir as HarnessWeight, or omit it for the default Magpie data directory.

Configuration preview (does not write files or install hooks):
  node bin/task-event.js --print-cursor-config /project/.cursor/hooks.json --agent GATEWAY_ID --data-dir PATH
Reads existing JSON if present, preserves all hooks, and prints a merged configuration.
Review the output before installing it. Never redirect output over the input file.

Cursor: register this command for beforeSubmitPrompt and stop in .cursor/hooks.json.
Use synchronous command hooks and an absolute path to this script. --agent must match
its gateway agent ID. Events correlate conversation_id + generation_id; completed,
aborted and error are distinct. Auto-followup stops are excluded. No config is installed.
Reference: https://cursor.com/docs/hooks

Protocol v1: {"version":1,"agent":"my-harness","runId":"unique-execution-id",
"taskId":"unique-user-task-id","event":"started","atMs":<Unix milliseconds>}
Send started then completed, failed or cancelled from real harness lifecycle events.
Reuse IDs and original atMs on retries. New executions after a restart need new IDs;
a resumed task may retain its IDs only if it is the same execution cycle.
Never send session start/end or model request events as task boundaries.

The mean is total wall-clock time / completed samples, selected by completion time.
Tasks need both boundaries within the retained 30-day log. Missing boundaries,
conflicting events, failures and cancellations do not contribute. Events are local,
best-effort samples; empty coverage returns null. No prompts or raw IDs are stored.`)
  } else if (values["print-cursor-config"]) {
    printingConfig = true
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(values.agent ?? "") || !values["data-dir"]) throw new TypeError("Agent and data directory required")
    const text = await readFile(resolve(values["print-cursor-config"]), "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e
      return '{"version":1,"hooks":{}}'
    })
    const config = JSON.parse(text)
    if (config?.version !== 1 || !config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new TypeError("Unsupported Cursor hooks config")
    const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
    const command = [process.execPath, fileURLToPath(import.meta.url), "--source", "cursor", "--agent", values.agent,
      "--data-dir", resolve(values["data-dir"])].map(quote).join(" ")
    for (const phase of ["beforeSubmitPrompt", "stop"]) {
      if (config.hooks[phase] !== undefined && !Array.isArray(config.hooks[phase])) throw new TypeError("Invalid hook list")
      const hooks = config.hooks[phase] ??= []
      if (!hooks.some((h) => h?.command === command)) hooks.push({ command, ...(phase === "stop" ? { loop_limit: null } : {}) })
    }
    console.log(JSON.stringify(config, null, 2))
  } else {
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) throw new RangeError("Task hook input too large")
      chunks.push(chunk)
    }
    await createTaskCollector()(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
      source: values.source, agent: values.agent, dataDir: values["data-dir"],
    })
  }
} catch {
  if (printingConfig) {
    console.error("[harnessweight] config preview failed; check version, hook lists, --agent and --data-dir")
    process.exitCode = 1
  } else {
    console.error("[harnessweight] task event skipped; check hook IDs, phase, timestamp and data directory")
  }
}

// Every agy session the plugin opens runs on agy's default agent. From agy
// 1.5.17 a session of a custom agent (--agent, .agents/agents/*) costs about
// four times the quota (google-antigravity/antigravity-cli#1890), and Google's
// answer is to drop --agent and give the instructions as rules. So a session's
// folder gets, in place of an agent.md:
// - AGENTS.md, the instructions: agy loads it as a workspace rule, also with
//   --include-default-customizations=false (agy 1.5.19, measured).
// - .agents/skills.json excludes agy's bundled skills from the prompt index.
// - .agents/hooks.json, a PreToolUse hook (tool-gate.mjs) that denies every
//   tool call but the ones named. The default agent lists all of agy's own
//   tools and no setting takes them away, so a call to one is failed before
//   it runs, and the model goes on without it. A hook that fails to run
//   fails the call too (agy 1.5.19, measured), never lets it through.
// What a custom agent had and the default agent has no equivalent for:
// tools: [...] (the model still sees agy's tools), inheritCustomizations:
// false, and excludeDefaultComponents.
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const TOOL_GATE_PATH = fileURLToPath(new URL("./tool-gate.mjs", import.meta.url))
const HOOK_NAME = "magpie-tool-gate"
// agy 1.5.19's bundled skills, including the two whose directory and skill names differ.
const BUNDLED_SKILLS = [
  "agy-customizations", "antigravity-guide", "antigravity_guide", "automation", "conversations",
  "generative_ui", "mcp-app-development", "migrate-agent-settings", "migrate-workflows",
  "native_swarm", "permissioned-github", "plugin", "run-workflow", "swarm", "swarm_monitor",
  "swarm_narrator", "swarm_pane", "ui-plugin-navigation",
]

export function toolGateCommand(allowed, { execPath = process.execPath, gate = TOOL_GATE_PATH, platform = process.platform, wrapper } = {}) {
  if (platform === "win32") {
    // cmd /c gets a single quoted path. Metacharacters can cause it to strip
    // the quotes or expand the path before it enters the batch file.
    if (!wrapper || /["\x00-\x1f\x7f%!&<>()@^|\uD800-\uDFFF]/u.test(wrapper)) throw new Error("invalid Windows hook wrapper path")
    return `"${wrapper}"`
  }
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
  return [execPath, gate, ...allowed].map(quote).join(" ")
}

function windowsToolGate(allowed, { execPath = process.execPath, gate = TOOL_GATE_PATH }) {
  const env = {}
  const quote = (value, variable) => {
    if (/["\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) throw new Error("invalid Windows hook argument")
    // Duplicate final backslashes for the called runtime's argv parser.
    const argument = value.replace(/\\+$/, "$&$&")
    if (/[^\x20-\x7e]/.test(value)) {
      // Keep the batch file ASCII on any cmd code page. Windows gives cmd
      // the paths as Unicode, and one %VAR% expansion leaves their % literal.
      if (!variable) throw new Error("invalid Windows hook argument")
      env[variable] = argument
      return `"%${variable}%"`
    }
    // ^ and & inside quotes are literal; % still needs doubling in a batch.
    return `"${argument.replace(/%/g, "%%")}"`
  }
  const args = [quote(execPath, "MAGPIE_AGY_HOOK_RUNTIME"), quote(gate, "MAGPIE_AGY_HOOK_GATE"), ...allowed.map(value => quote(value))]
  return { content: `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.join(" ")}\r\n`, env }
}

function toolGateHooks(command) {
  return {
    [HOOK_NAME]: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] }],
    },
  }
}

async function writeIfChanged(file, content) {
  const bytes = Buffer.from(content)
  const previous = await fs.readFile(file).catch(error => {
    if (error.code !== "ENOENT") throw error
  })
  if (previous?.equals(bytes)) return
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.unlink(temporary).catch(() => {})
    throw error
  }
}

async function removeIfThere(file) {
  const stat = await fs.lstat(file).catch(error => {
    if (error.code !== "ENOENT") throw error
  })
  if (stat) await fs.rm(file, { recursive: true, force: true })
}

async function bundledSkills(geminiDir) {
  if (!geminiDir) return BUNDLED_SKILLS
  const entries = await fs.readdir(path.join(geminiDir, "antigravity-cli", "builtin", "skills"), { withFileTypes: true }).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
    return []
  })
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  return [...new Set([...BUNDLED_SKILLS, ...names])]
}

// writeDefaultAgentFiles readies dir for a session on the default agent.
// allowed: the tool names its model may call (a trailing * a prefix); null
// leaves every tool to agy's own permissions, with no hook. A folder used
// before keeps nothing of an older plugin's agent definition.
export async function writeDefaultAgentFiles(dir, { instructions, allowed, geminiDir }, options = {}) {
  const agents = path.join(dir, ".agents")
  const hooks = path.join(agents, "hooks.json")
  const wrapper = path.join(agents, "tool-gate.cmd")
  const platform = options.platform ?? process.platform
  const command = allowed && toolGateCommand(allowed, { ...options, platform, wrapper })
  const batch = command && platform === "win32" ? windowsToolGate(allowed, options) : null
  await fs.mkdir(agents, { recursive: true, mode: 0o700 })
  await removeIfThere(path.join(agents, "agents"))
  await writeIfChanged(path.join(dir, "AGENTS.md"), instructions.endsWith("\n") ? instructions : instructions + "\n")
  await writeIfChanged(path.join(agents, "skills.json"), JSON.stringify({ exclude: await bundledSkills(geminiDir) }) + "\n")
  if (batch) await writeIfChanged(wrapper, batch.content)
  if (command) await writeIfChanged(hooks, JSON.stringify(toolGateHooks(command), null, 2) + "\n")
  else await removeIfThere(hooks)
  if (!batch) await removeIfThere(wrapper)
  return batch?.env
}

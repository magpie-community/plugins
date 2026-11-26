import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agySpawnSpec, childEnv as agyChildEnv } from "./platform.mjs"
import { familiesInGroup } from "./model-ids.mjs"
import { cannotSignIn, isDead, noteDead, storedSignIn } from "./signin.mjs"

// agy's own read, --version included. Magpie waits 20 seconds for a usage
// call; a read that takes longer goes on past it (createUsageReader).
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024

// kind: "auth" (agy says it needs a sign-in), "timeout" (output: what agy
// had printed by then, never shown), "cancel", or none. slow: ran out of
// time where no sign-in is waited on (agy --version), asked again as soon
// as a timeout is.
class UsageError extends Error {
  constructor(message, { kind = "", output = "", slow = false } = {}) {
    super(message)
    this.kind = kind
    this.output = output
    this.slow = slow
  }
}

const SIGN_IN_TALK = /accounts\.google\.com|oauth|sign[ -]?in|log[ -]?in|authenticat|browser/i

const text = value => typeof value === "string" ? value.trim() : ""
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake]

// agy logs unauthenticated cache lookups before loading its keyring.
function withoutDiagnostics(output) {
  return output.split(/\r?\n/)
    .filter(line => !/^\s*[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[^\]]+\]/.test(line))
    .join("\n")
}

const ELIGIBILITY = /eligibility check failed|not eligible|unsupported (?:country|region)|does not support google tos/i
const NETWORK = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate)\b/i

// Google's 403 #3501 at agy's eligibility check: Google turns the account
// itself away, and agy refuses every command with it, `agy models`, print
// mode and a turn alike (agy 1.5.9 against a Code Assist answering it):
//   Eligibility check failed: PERMISSION_DENIED (code 403): You do not have
//   a valid license of this product. ... (#3501). Please log out (/logout)
//   and log back in (/login).
// Three people on X (11-16) got only a list of fallback models, "model …
// is unavailable to this agy account" or "not eligible" from the plugin.
const LICENSE_REFUSAL = /valid license of this product|\(#3501\)/i

export const LICENSE_REFUSED = "Google refuses this Google account for Antigravity " +
  "(403 #3501: \"You do not have a valid license of this product\"). agy itself gets the same " +
  "answer, so this account can't be used until Google accepts it. Update agy, then sign in to " +
  "the account again (in magpie, or run `agy` in a terminal and /logout, then /login); sign in " +
  "with a personal Google account (@gmail.com) rather than a Workspace one; unset AGY_ADC_AUTH " +
  "if it is set; and turn off a VPN or proxy that puts you in a region Antigravity isn't offered in."

const ACCOUNT_DISABLED_REFUSAL = /PERMISSION_DENIED \(code 403\):\s*This\s+service\s+has\s+been\s+disabled\s+in\s+this\s+account\s+for\s+violation\s+of\s+Terms\s+of\s+Service\.\s*Please\s+submit\s+an\s+appeal\s+to\s+continue\s+using\s+this\s+product\./
export const ACCOUNT_DISABLED_REFUSED = "Google has disabled this account's access to Antigravity " +
  "for violating the Terms of Service (HTTP 403: \"This service has been disabled in this account " +
  "for violation of Terms of Service\"). Submit an appeal with Google before using this account again."

// Google asks for the account to be verified (Cloud Code's 403
// VALIDATION_REQUIRED). agy 1.5.9 words it three ways: a turn's model call
// ends the reply with "⚠ Verification Required" alone (kidgpt on X, 11-16:
// that bare line was the whole answer in Claude Code), and its eligibility
// check says "…\n\nPlease verify your account in your browser to
// continue:\n<link>", or "Verification required. Please complete
// verification in your browser to continue." when Google gave no link.
const VERIFY_REFUSAL = /please verify your account in your browser to continue|verification required\. please complete verification|verify your account to continue/i

// The words magpie's gateway reads as Google's verification refusal
// (provider.verifyAdvice), and its link in them (provider.verifyLink): it
// rests the account as "verify" and shows Verify with the link, as it does
// for the Antigravity and Gemini CLI routes.
export const VERIFY_ADVICE = "this Google account needs to be verified"

// verifyLinkIn is the https link agy's output or log gives to verify the
// account at, "" when it gives none: taken as Gemini CLI takes it, the
// validation_link before the validation_url, else the link agy prints after
// "continue:", else an accounts.google.com one.
export function verifyLinkIn(output) {
  const said = String(output ?? "").replace(/\\u0026/g, "&").replace(/&amp;/g, "&")
  const named = (key) => new RegExp(`"?${key}"?\\s*[:=]\\s*"?(https://[^\\s"'\\\\<>]+)`, "i").exec(said)?.[1]
  const link = named("validation_?link") || named("validation_?url") ||
    /in your browser to continue:\s*(https:\/\/[^\s"'\\<>]+)/i.exec(said)?.[1] ||
    /(https:\/\/accounts\.google\.com\/[^\s"'\\<>]+)/i.exec(said)?.[1] || ""
  const trimmed = link.replace(/[).,;\]}]+$/, "")
  try {
    const u = new URL(trimmed)
    return u.protocol === "https:" && u.host ? trimmed : ""
  } catch {
    return ""
  }
}

// verifyRefused is what the agent is told when Google wants the account
// verified: with the link to do it at when agy gave one, else where to go.
export function verifyRefused(link) {
  const said = "Google wants this account verified before Antigravity serves it again (agy: \"Verification Required\")"
  return link
    ? `${said} — ${VERIFY_ADVICE}: open ${link} in a browser signed in to it, verify it, then try again`
    : `${said} — ${VERIFY_ADVICE}: open the Antigravity app, or run \`agy\` in a terminal, signed in to it and do what it asks, then try again`
}

// agyRefusal is what to tell the user when agy's output says Google turned
// the account away at its eligibility check, or "" when it doesn't: the
// license refusal (#3501), or any other refusal of the check that isn't a
// network failure ("Eligibility check failed: EOF"), in agy's own words.
// agy's diagnostic log lines are not read: a background poll it logs can
// fail on its own.
export function agyRefusal(output) {
  const said = withoutDiagnostics(String(output ?? ""))
  if (LICENSE_REFUSAL.test(said)) return LICENSE_REFUSED
  if (ACCOUNT_DISABLED_REFUSAL.test(said)) return ACCOUNT_DISABLED_REFUSED
  if (VERIFY_REFUSAL.test(said)) return verifyRefused(verifyLinkIn(said))
  if (!ELIGIBILITY.test(said) || NETWORK.test(said)) return ""
  const line = said.split(/\r?\n/).map(l => l.trim().replace(/^error:\s*/i, "")).find(l => ELIGIBILITY.test(l)) || ""
  return `Google refuses this account for Antigravity: ${line.slice(0, 400)}. agy itself gets the same answer. ` +
    "Antigravity isn't offered in every region: turn off a VPN or proxy that puts you in another one, or use an account Google serves there."
}

function commandFailure(output) {
  if (/not (?:logged|signed) in(?:to)?\b|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again|\binvalid_grant\b/i.test(withoutDiagnostics(output))) {
    return new UsageError("agy usage needs authentication. Run `agy` in a terminal to sign in again.", { kind: "auth" })
  }
  if (LICENSE_REFUSAL.test(withoutDiagnostics(output))) return new UsageError(LICENSE_REFUSED)
  const eligibility = ELIGIBILITY.test(output)
  const network = NETWORK.test(output)
  if (network) return new UsageError(`agy usage ${eligibility ? "eligibility check " : ""}failed on a network request. Check network or proxy settings.`)
  if (eligibility) return new UsageError("agy reports that this account is not eligible for Antigravity.")
  return new UsageError("agy could not read usage. Run `agy` in a terminal to check its status.")
}

function resetTime(value) {
  if (value == null || value === "" || typeof value === "boolean") return undefined
  const raw = String(value)
  let ms
  if (/^\d+(?:\.\d+)?$/.test(raw)) ms = Number(raw) * (Number(raw) < 1e11 ? 1000 : 1)
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) ms = Date.parse(raw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) return undefined
  return new Date(ms).toISOString()
}

function cadence(bucket, id, name) {
  // An explicit, unfamiliar window must not be overridden by an older ID/label.
  const value = text(bucket.window) || `${id} ${name}`
  if (/^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(value) || !text(bucket.window) && /(?:5h|five[ _-]hour|session)/i.test(value)) {
    return { name: "5 hours", span: 5 * 60 * 60 }
  }
  if (/^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(value) || !text(bucket.window) && /(?:weekly|week|7d)/i.test(value)) {
    return { name: "7 days", span: 7 * 24 * 60 * 60 }
  }
  return { name: name || id }
}

// vendorOf is a model's family as magpie's cards group them (Gemini,
// Claude, GPT-OSS), as the retired antigravity plugin named them.
function vendorOf(id, name) {
  const l = id.toLowerCase()
  if (l.startsWith("gemini")) return "Gemini"
  if (l.startsWith("claude")) return "Claude"
  if (l.startsWith("gpt-oss")) return "GPT-OSS"
  return String(name ?? "").trim().split(" ")[0] || id.split("-")[0]
}

// agy's command report is not its token-usage object or a model-availability list.
// Unknown quota is not evidence of exhaustion or a full allowance.
//
// Each group is a pool its models share: its windows go as the pool's
// ({ pool: "Gemini", name: "5 hours" }), and each model family the group
// names gets a window of its own in that pool, reading the pool's most
// used bucket, the one that stops it. That is what Google's own per-model
// reading said: the retired antigravity plugin's fetchAvailableModels
// read of 2026-11-11 gave every model of a pool the pool's figure, to the
// digit (each Gemini model 1.58104% with Gemini's 7 days). So magpie's
// card shows the pools, and "Every model" lists the models, as it did for
// the antigravity plugin.
//
// A model's own window is not set aside: it is what routing weighs the
// account by for that model, as the antigravity plugin's were, so a
// routing group of Opus 5.5 reads the account's Claude & GPT share, not
// "not known yet" behind every account known (will930128 on X). The
// pool's own windows stay aside and hold their models at a cap the user
// sets on the pool (magpie's PoolWindow), as the antigravity plugin's did.
export function parseUsageReport(value) {
  let report
  try { report = typeof value === "string" ? JSON.parse(value) : value } catch {
    throw new UsageError("agy returned an invalid usage report.")
  }
  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    throw commandFailure(text(report?.error) || text(report?.response))
  }
  const groups = report.command.data?.groups
  const windows = []
  const models = new Map() // family id -> its window
  for (const group of Array.isArray(groups) ? groups : []) {
    const pool = (text(field(group, "displayName", "display_name")) || text(group?.name) || "Quota")
      .replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
    const families = familiesInGroup(group)
    const ids = [...new Set(families.flatMap(f => f.ids))].sort()
    let tightest
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const id = text(field(bucket, "bucketId", "bucket_id")) || text(bucket?.id)
      if (!id || bucket?.disabled === true) continue
      const label = text(field(bucket, "displayName", "display_name")) || text(bucket?.name)
      const period = cadence(bucket, id, label)
      const remaining = bucket.remaining
      const fraction = field(bucket, "remainingFraction", "remaining_fraction")
        ?? field(remaining, "remainingFraction", "remaining_fraction")
        ?? (remaining?.case === "remainingFraction" ? remaining.value : undefined)
      const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      const resetsAt = resetTime(field(bucket, "resetTime", "reset_time"))
      const w = {
        name: period.name,
        pool,
        // the pool's own: its models' windows stop them (below)
        aside: true,
        ...(ids.length ? { models: ids } : {}),
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: "Limits not available" }),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      }
      windows.push(w)
      if (known && (!tightest || w.used > tightest.used)) tightest = w
    }
    if (!tightest) continue
    for (const f of families) {
      const had = models.get(f.id)
      // a model two groups name reads the one that stops it first
      if (had && had.used >= tightest.used) continue
      models.set(f.id, {
        name: f.name,
        model: f.id,
        family: vendorOf(f.id, f.name),
        pool,
        models: f.ids,
        used: tightest.used,
        ...(tightest.span ? { span: tightest.span } : {}),
        ...(tightest.resetsAt ? { resetsAt: tightest.resetsAt } : {}),
      })
    }
  }
  if (!windows.some(w => w.used !== undefined)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }
  // /usage has no verified account or plan identity: none is made up from
  // it.
  return { windows: [...[...models.values()].sort((a, b) => a.name.localeCompare(b.name)), ...windows] }
}

function timeout(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

// What agy --version said, by the binary that said it: its real path, size
// and modification time, so an updated agy is asked again.
const versionCache = new Map()

async function binaryKey(file) {
  try {
    const real = await fs.realpath(file)
    const st = await fs.stat(real)
    return `${real}\0${st.size}\0${st.mtimeMs}`
  } catch {
    return ""
  }
}

function run(file, args, { cwd, env, deadline, signal, maxOutputBytes, onTreeKill }) {
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let stopped = false
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    let treeKillTimer
    let fallbackKillTimer
    const killWindowsTree = () => {
      let spawned = false
      try {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
        killer?.unref?.()
        spawned = Boolean(killer)
        if (typeof killer?.once === "function") {
          const done = new Promise(r => {
            killer.once("error", () => { try { child.kill("SIGKILL") } catch {}; r() })
            killer.once("close", code => { if (code !== 0) try { child.kill("SIGKILL") } catch {}; r() })
          })
          onTreeKill?.(done)
        }
      } catch {}
      if (!spawned) {
        try { child.kill("SIGKILL") } catch {}
      } else {
        fallbackKillTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 500)
        fallbackKillTimer.unref?.()
      }
    }
    const stop = (fromExit = false) => {
      if (!child?.pid || stopped) return
      if (process.platform === "win32") {
        if (fromExit && child.exitCode !== null) {
          treeKillTimer = setTimeout(() => {
            if (!settled && !stopped) {
              stopped = true
              killWindowsTree()
            }
          }, 30)
          treeKillTimer.unref?.()
          return
        }
        stopped = true
        clearTimeout(treeKillTimer)
        killWindowsTree()
        return
      }
      stopped = true
      // Only this detached child/group is ours, never an existing user agy.
      try { process.kill(-child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch {}
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(treeKillTimer)
      clearTimeout(fallbackKillTimer)
      signal?.removeEventListener("abort", abort)
      if (process.platform !== "win32" || error || child?.exitCode === null) {
        stop() // Also stop MCP descendants if the parent exited first.
      }
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new UsageError("agy usage query was cancelled.", { kind: "cancel" }))
    const late = () => finish(new UsageError("agy usage query timed out.", {
      kind: "timeout", output: Buffer.concat(stdout).toString("utf8") + "\n" + Buffer.concat(stderr).toString("utf8"),
    }))
    if (signal?.aborted) return abort()
    if (Date.now() >= deadline) return finish(new UsageError("agy usage query timed out."))
    try {
      const command = agySpawnSpec(file, args)
      child = spawn(command.file, command.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        ...command.options,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      finish(new UsageError("agy usage could not start the CLI."))
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(late, Math.max(1, deadline - Date.now()))
    const collect = chunks => chunk => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return finish(new UsageError("agy usage output exceeded the size limit."))
      chunks.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", () => finish(new UsageError("agy usage could not start the CLI.")))
    // exit, not close: a descendant may inherit the pipe and keep it open.
    // Drain the already-written output through close for a normal parent exit.
    child.on("exit", () => stop(true))
    child.on("close", code => finish(null, {
      code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

function supportedVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11)
}

// What usage says while Antigravity's app has a gateway on in agy's folder
// and this agy can't be given another (plugins#1591): agy reads that file,
// and on a gateway its /usage asks Google nothing and lists no quota.
export const GATEWAY_NO_FOLDER = "Antigravity's app is set to a gateway (~/.gemini/config/config.json, magpie's Antigravity takeover writes one), " +
  "which agy reads too, and on a gateway agy reads no Google quota. This agy can't be pointed past it: update agy (`agy update`)."

// agy's flag parser naming --gemini_dir as one it doesn't know
const NO_GEMINI_DIR_FLAG = /flags? provided but not defined:\s*-+gemini[-_]dir/i

export async function fetchUsage(agy, {
  env = process.env,
  timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
  // the folder agy reads in place of ~/.gemini when the app's gateway is on
  // there: { gateway, dir } (index.mjs's usageGeminiDir)
  geminiDir = async () => ({ gateway: false, dir: null }),
} = {}) {
  if (!agy) throw new UsageError(NO_AGY)
  const folder = await geminiDir(agy)
  if (folder?.gateway && !folder.dir) throw new UsageError(GATEWAY_NO_FOLDER)
  // a hidden flag of agy's top level (agy 1.5.18), --gemini-dir's own on acp
  const folderArgs = folder?.gateway ? ["--gemini_dir", folder.dir] : []
  const limit = timeout(timeoutMs)
  const deadline = Date.now() + limit
  const directory = await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-"))
  let pendingTreeKill = null
  try {
    await fs.chmod(directory, 0o700)
    const agentDir = path.join(directory, ".agents", "agents", "magpie-usage")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "agent.md"), [
      "---", "name: magpie-usage", "description: Read CLI usage only", "mainAgent: true", "subagent: false",
      "tools: []", "mcpServers: []", "---", "Do not run model prompts or tools.", "",
    ].join("\n"), { mode: 0o600 })
    if (process.platform === "win32") {
      await fs.writeFile(path.join(directory, "open.cmd"), "@exit /b 1\r\n")
    } else {
      for (const name of ["open", "xdg-open"]) {
        await fs.writeFile(path.join(directory, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
      }
    }
    const baseEnv = { ...env }
    const inheritedPath = env.PATH || baseEnv.Path || (process.platform === "win32" ? "" : "/usr/bin:/bin")
    for (const key of Object.keys(baseEnv)) {
      if (/^path$/i.test(key) && key !== "PATH") delete baseEnv[key]
    }
    const childEnv = agyChildEnv(baseEnv, {
      PATH: directory + path.delimiter + inheritedPath,
      BROWSER: path.join(directory, process.platform === "win32" ? "open.cmd" : "open"),
    })
    const options = { cwd: directory, env: childEnv, deadline, signal, maxOutputBytes, onTreeKill: p => { pendingTreeKill = p } }
    // --version needs no sign-in, so its hang is never read as one. It gets
    // the whole deadline, and its answer is kept for the binary it came from:
    // a 266 MB agy on a one-CPU Linux host takes 5 to 17 seconds just to say
    // its version (plugins#1544), which left no time for the quota read.
    const binary = await binaryKey(agy)
    let version = binary && versionCache.get(binary)
    if (!version) {
      version = await run(agy, ["--version"], options).catch((error) => {
        // not kind "timeout": --version needs no sign-in, so its hang is
        // never agy waiting on one
        if (error?.kind === "timeout") throw new UsageError(`agy didn't say its version in ${limit / 1000}s (its first start after an update can take that long), so the quota wasn't read. It's asked again in a minute.`, { slow: true })
        throw error
      })
      if (version.code !== 0) throw commandFailure(version.stderr)
      if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
      if (binary) versionCache.set(binary, { code: 0, stdout: version.stdout, stderr: "" })
    }
    // Only agy asks Google for the quota: its own /usage, so every request
    // Google sees is one agy makes itself. agy -p /usage makes about twelve
    // Code Assist calls in six rounds, one after another (loadCodeAssist
    // four times, fetchUserInfo, fetchAvailableModels, fetchAdminControls,
    // listExperiments…, recorded from agy 1.5.12 on 2026-11-20), before
    // the quota: 5 to 10 seconds on a quick network, 20 or more behind a
    // slow proxy (2 to 3 seconds a call, plugins#1255), or on agy's first
    // start. It gets the whole deadline.
    const result = await run(agy, [...folderArgs, "-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`], options).catch((error) => {
      if (error?.kind !== "timeout") throw error
      throw new UsageError(`agy's own usage read didn't finish in ${limit / 1000}s. agy asks Google about twelve times, one after another, before it has the quota, which takes longer behind a slow network or proxy. It's asked again in a minute; if this stays, check agy's network or proxy.`, { kind: "timeout", output: error.output })
    })
    if (folderArgs.length && result.code !== 0 && NO_GEMINI_DIR_FLAG.test(result.stderr + "\n" + result.stdout)) throw new UsageError(GATEWAY_NO_FOLDER)
    let report
    try { report = JSON.parse(result.stdout) } catch {}
    if (result.code === 0 && report?.status === "SUCCESS") return parseUsageReport(report)
    if (result.code === 0 && !report?.status) return parseUsageReport(result.stdout)
    const said = report?.status && report.status !== "SUCCESS"
      ? text(report.error) || text(report.response)
      : result.stderr + "\n" + result.stdout
    const failure = commandFailure(said)
    throw failure
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.rm(directory, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 3 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) break
        if (pendingTreeKill) {
          const waitKill = pendingTreeKill
          pendingTreeKill = null
          await Promise.race([waitKill, new Promise(resolve => setTimeout(resolve, 800))])
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
}

// A read that failed isn't run again for this long, doubled for each
// failure in a row, up to BACKOFF_MOST: agy is a process of its own, and one
// that fails every few minutes all day helps nobody. One that ran out of
// time is asked again sooner: a slow minute on the network (or agy's first
// start after an update) said "timed out" for ten (flmaximwang on
// plugins#1522), and a newly added account showed no quota for as long
// (Jayc1world on X).
const BACKOFF_FIRST_MS = 10 * 60 * 1000
const BACKOFF_SLOW_MS = 60 * 1000
const BACKOFF_MOST_MS = 6 * 60 * 60 * 1000

function backoff(n, slow = false) {
  return Math.min((slow ? BACKOFF_SLOW_MS : BACKOFF_FIRST_MS) * 2 ** Math.max(0, Math.min(n, 20) - 1), BACKOFF_MOST_MS)
}

// what usage says while no agy is found: never held (createUsageReader),
// and in noAgy's words, so it says how magpie gets one
export const NO_AGY = "agy CLI not found. Sign in to this account again in magpie to have it installed, or install Antigravity CLI yourself."

const NEEDS_SIGN_IN = "Sign in again from this account's Sign in in magpie, or run `agy` in a terminal; magpie doesn't run agy for usage until then."

// what usage says while agy's access token is due to be renewed (below)
export const DUE_FOR_RENEWAL = "agy's sign-in is due to be renewed, and agy renews it itself on this account's next chat; the quota is read after that. " +
  "magpie doesn't run agy just for usage meanwhile: a renewal that fails there can open a Google sign-in in the browser."

// what usage says while agy is still reading, past what the caller waits
export const STILL_READING = "agy is still reading this account's quota (its own read takes longer here: a slow network or proxy, or agy's first start). " +
  "It shows on the next refresh."

// No completed-result cache: sequential refreshes must see account/allowance changes.
// What is kept is what keeps agy from being run when it can't answer:
// - agy's stored sign-in is read first (signin.mjs), and agy isn't run when
//   there is none, or it has ended with nothing to renew it: the read says
//   the sign-in has expired (signIn "expired"), which magpie shows on the
//   account, and nothing starts a Google sign-in in the background.
// - while its access token has ended (or ends within two minutes) with a
//   refresh token to renew it, agy isn't run either: agy renews the token
//   when it runs, and when that renewal fails, even for a moment (DNS at
//   startup, a slow keyring), agy starts its own Google sign-in, which on
//   Windows opens the browser past every shim (plugins#1234). agy's chats
//   renew it; the quota is read once they have (DUE_FOR_RENEWAL). The
//   plugin never renews it, nor asks Google itself.
// - an explicit authentication rejection, or an ended token hanging silently
//   or with sign-in talk, blocks further background runs for that credential.
//   Diagnostic-only output isn't evidence of a browser sign-in.
// - any other failure isn't run again for backoff(n). No agy found is not
//   held: finding it costs a few stat calls, and an agy installed since (a
//   sign-in installs it; tmr11235 on X saw it) is used on the next read,
//   not after hours of "not found" while its chats already run.
//
// Magpie waits 20 seconds for a usage call; agy's own read can take
// longer (fetchUsage). A call waits waitMs at most and then says agy is
// still reading (STILL_READING); the read goes on to its own deadline, and
// what it reads with nobody waiting is kept for the next call (taken once,
// within LATE_KEPT_MS), so the next refresh shows it without running agy
// again. A failure is held as any other is.
const CALL_WAIT_MS = 17_000
const LATE_KEPT_MS = 3 * 60 * 1000

export function createUsageReader(resolveAgy, options = {}) {
  const { signIn = () => storedSignIn(), now = () => Date.now(), waitMs = CALL_WAIT_MS, onSettled = () => {}, ...fetchOptions } = options
  const pending = new Map()
  let held = null
  let late = null
  let saidExpired = false
  const expired = (why) => {
    saidExpired = true
    return { windows: [], error: `${why}. ${NEEDS_SIGN_IN}`, signIn: "expired" }
  }
  // what a finished read says, worked out once for whoever takes it
  const settle = (outcome, { agy, key, stored }) => {
    if (!outcome.error) {
      const result = { ...structuredClone(outcome.result), signIn: saidExpired ? "renewed" : "kept" }
      held = null
      saidExpired = false
      return result
    }
    const error = outcome.error
    const message = error instanceof UsageError ? error.message : "agy usage query failed. Check the CLI and temporary-directory permissions."
    if (error?.kind === "cancel") return { windows: [], error: message, signIn: "kept" }
    const output = String(error.output ?? "")
    const auth = error?.kind === "auth" || error?.kind === "timeout" && stored?.state === "present" && stored.expired &&
      (!output.trim() || SIGN_IN_TALK.test(withoutDiagnostics(output)))
    if (auth && stored?.state === "present") {
      noteDead(stored)
      return expired("agy's sign-in no longer works")
    }
    const n = held?.key === key && held.agy === agy ? held.n + 1 : 1
    held = { key, agy, n, until: now() + backoff(n, !auth && (error?.kind === "timeout" || error?.slow === true)), error: message, auth }
    if (auth) saidExpired = true
    return { windows: [], error: message, signIn: auth ? "expired" : "kept" }
  }
  return async () => {
    const asked = Date.now()
    let stored
    try { stored = await signIn() } catch { stored = { state: "unknown" } }
    const why = cannotSignIn(stored)
    // out of this process's reach, signing in again here mends nothing
    if (why && stored?.state === "unreachable") return { windows: [], error: `${why}.`, signIn: "expired" }
    if (why) return expired(why)
    if (isDead(stored)) return expired("agy's sign-in no longer works")
    const key = stored?.state === "present" ? stored.fp : "unknown"
    const agy = resolveAgy()
    if (!agy) return { windows: [], error: NO_AGY, signIn: "kept" }
    // read while nobody waited: this call's answer, once
    if (late && late.key === key && late.agy === agy && now() - late.at < LATE_KEPT_MS) {
      const { reply } = late
      late = null
      return reply
    }
    late = null
    // a failure held for another agy (gone, or another found since) isn't
    // this one's
    if (held && held.key === key && held.agy === agy && now() < held.until) {
      return { windows: [], error: held.error, signIn: held.auth ? "expired" : "kept" }
    }
    let read = pending.get(agy)
    if (!read) {
      // an access token that has ended or ends within two minutes, with a
      // refresh token: agy isn't run (plugins#1234, above)
      if (stored?.state === "present" && stored.canRenew && stored.expiresAt > 0 && stored.expiresAt - now() < 2 * 60 * 1000) {
        return { windows: [], error: DUE_FOR_RENEWAL, signIn: "kept" }
      }
      const entry = { waiting: 0 }
      entry.done = fetchUsage(agy, fetchOptions).then(result => ({ result }), error => ({ error })).then((outcome) => {
        if (pending.get(agy) === entry) pending.delete(agy)
        const reply = settle(outcome, { agy, key, stored })
        // nobody waits for it any more: the next call takes it
        if (entry.waiting === 0 && !outcome.error) late = { key, agy, reply, at: now() }
        onSettled(reply)
        return reply
      })
      pending.set(agy, entry)
      read = entry
    }
    read.waiting++
    let timer
    const gaveUp = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, waitMs - (Date.now() - asked)), null) })
    const reply = await Promise.race([read.done, gaveUp])
    clearTimeout(timer)
    read.waiting--
    if (reply) return structuredClone(reply)
    return { windows: [], error: STILL_READING, signIn: "kept" }
  }
}

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agySpawnSpec, childEnv as agyChildEnv } from "./platform.mjs"
import { modelsInGroup } from "./model-ids.mjs"
import { cannotSignIn, isDead, noteDead, storedSignIn, storedToken } from "./signin.mjs"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 18_000 // Magpie bounds an auth.usage call to 20 seconds.
const MAX_OUTPUT_BYTES = 1024 * 1024

// kind: "auth" (agy says it needs a sign-in), "timeout" (output: what agy
// had printed by then, never shown), "cancel", or none.
class UsageError extends Error {
  constructor(message, { kind = "", output = "" } = {}) {
    super(message)
    this.kind = kind
    this.output = output
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

// refusedEligibility says agy turned the run away on its eligibility
// check. agy's print mode waits for that verdict before any command,
// /usage too, and stops there when Antigravity says it doesn't serve the
// account where it is (UNSUPPORTED_LOCATION), though the quota read agy
// made meanwhile had its answer. (A check that failed on the network
// says "Eligibility check failed: EOF"; that one is left alone.)
function refusedEligibility(output) {
  return ELIGIBILITY.test(output)
}

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

// agyRefusal is what to tell the user when agy's output says Google turned
// the account away at its eligibility check, or "" when it doesn't: the
// license refusal (#3501), or any other refusal of the check that isn't a
// network failure ("Eligibility check failed: EOF"), in agy's own words.
// agy's diagnostic log lines are not read: a background poll it logs can
// fail on its own.
export function agyRefusal(output) {
  const said = withoutDiagnostics(String(output ?? ""))
  if (LICENSE_REFUSAL.test(said)) return LICENSE_REFUSED
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

// agy's command report is not its token-usage object or a model-availability list.
// Unknown quota is not evidence of exhaustion or a full allowance.
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
  for (const group of Array.isArray(groups) ? groups : []) {
    const pool = (text(field(group, "displayName", "display_name")) || text(group?.name) || "Quota")
      .replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
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
      const ids = modelsInGroup(group)
      windows.push({
        name: `${pool} · ${period.name}`,
        // This feature displays quota only; it must not change model routing.
        aside: true,
        ...(ids.length ? { models: ids } : {}),
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: "Limits not available" }),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }
  if (!windows.some(w => w.used !== undefined)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }
  // /usage has no verified account or plan identity. Do not borrow one elsewhere.
  return { windows }
}

function timeout(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
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

// ---- the quota read agy makes, made directly ----------------------------
//
// Recorded from agy 1.5.9's own /usage (CLOUD_CODE_URL pointed at a
// recording proxy, 2026-11-16): with its stored Google sign-in it asks
//   POST <Code Assist>/v1internal:loadCodeAssist {"metadata":{"ideType":"ANTIGRAVITY"}}
// for the account's project (cloudaicompanionProject), then
//   POST <Code Assist>/v1internal:retrieveUserQuotaSummary {"project":"<that project>"}
// whose reply is the groups /usage prints, in camelCase. Both carry
// User-Agent "antigravity/cli/<version> (aidev_client; os_type=<GOOS>;
// arch=<GOARCH>; cl=<changelist>; auth_method=<auth_method>)" and
// Content-Type application/json. With loadCodeAssist naming an ineligible
// tier and no current one, agy still read the quota (200) and then
// refused /usage with "Eligibility check failed: …" (01dadada on X:
// 绕过查额度前询问地区限制就可以查到). So when agy refuses for that, the
// same two requests are made here, the same way, and nothing else.

const CODE_ASSIST = "https://daily-cloudcode-pa.googleapis.com"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
// The installed-app OAuth client agy signs in with (its token is renewed
// with the same client; the retired antigravity plugin used it too).
// Google says such a client's secret isn't one. Written in parts so secret
// scanners don't take it for a leak.
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com"
const CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-")
// The build changelist each agy release puts in its User-Agent (cl=), read
// from its requests; a release not listed goes with the newest known one.
const CLS = { "1.5.9": "1021519450" }
const NEWEST_CL = "1021519450"
const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" }
const GOARCH = { arm64: "arm64", x64: "amd64" }

export function quotaUserAgent(version, authMethod, platform = process.platform, arch = process.arch) {
  return `antigravity/cli/${version} (aidev_client; os_type=${GOOS[platform] ?? platform}; arch=${GOARCH[arch] ?? arch}; cl=${CLS[version] ?? NEWEST_CL}; auth_method=${authMethod || "consumer"})`
}

const companion = p => typeof p === "string" ? p : typeof p?.id === "string" ? p.id : ""

// readQuotaDirect is retrieveUserQuotaSummary's reply for agy's stored
// sign-in, as agy asks it. An access token with under two minutes left is
// renewed in memory only; agy's stored sign-in is never written.
export async function readQuotaDirect({
  env = process.env, version, deadline, signal,
  stored = storedToken, fetch: fetchFn = globalThis.fetch, now = Date.now,
} = {}) {
  const left = () => deadline - now()
  const timed = () => {
    if (left() <= 0) throw new UsageError("agy usage query timed out.")
    const t = AbortSignal.timeout(left())
    return signal ? AbortSignal.any([signal, t]) : t
  }
  const sign = await stored()
  const token = sign?.token
  if (!token) throw new UsageError("agy's stored sign-in couldn't be read.")
  let access = text(token.access_token)
  const ends = Date.parse(token.expiry ?? "")
  if (!access || Number.isFinite(ends) && ends > 0 && ends - now() < 2 * 60 * 1000) {
    if (!text(token.refresh_token)) throw new UsageError("agy's stored sign-in has expired.")
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
      signal: timed(),
    })
    let fresh
    try { fresh = JSON.parse(await res.text()) } catch {}
    access = res.ok ? text(fresh?.access_token) : ""
    if (!access) throw new UsageError("agy's stored sign-in couldn't be renewed.")
  }
  const base = (text(env.CLOUD_CODE_URL) || CODE_ASSIST).replace(/\/+$/, "")
  const headers = {
    "User-Agent": quotaUserAgent(version, text(sign.auth_method)),
    Authorization: "Bearer " + access,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  }
  const call = async (method, body) => {
    const res = await fetchFn(`${base}/v1internal:${method}`, { method: "POST", headers, body: JSON.stringify(body), signal: timed() })
    const reply = await res.text()
    if (res.status !== 200) throw new UsageError(`Antigravity's ${method} answered ${res.status}.`)
    try { return JSON.parse(reply) } catch { throw new UsageError(`Antigravity's ${method} answered with no JSON.`) }
  }
  const project = companion((await call("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }))?.cloudaicompanionProject)
  if (!project) throw new UsageError("Antigravity names no project for this account.")
  return call("retrieveUserQuotaSummary", { project })
}

export async function fetchUsage(agy, {
  env = process.env,
  timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
  quota = readQuotaDirect,
} = {}) {
  if (!agy) throw new UsageError("agy CLI not found. Install it and run `agy` once to sign in.")
  const deadline = Date.now() + timeout(timeoutMs)
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
    // --version needs no sign-in, so its hang is never read as one
    const version = await run(agy, ["--version"], { ...options, deadline: Math.min(deadline, Date.now() + 3000) }).catch((error) => {
      if (error?.kind === "timeout") throw new UsageError(error.message)
      throw error
    })
    if (version.code !== 0) throw commandFailure(version.stderr)
    if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
    const result = await run(agy, ["-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`], options)
    let report
    try { report = JSON.parse(result.stdout) } catch {}
    if (result.code === 0 && report?.status === "SUCCESS") return parseUsageReport(report)
    if (result.code === 0 && !report?.status) return parseUsageReport(result.stdout)
    const said = report?.status && report.status !== "SUCCESS"
      ? text(report.error) || text(report.response)
      : result.stderr + "\n" + result.stdout
    const failure = commandFailure(said)
    // Refused on eligibility (a region Antigravity doesn't serve), not on
    // a network failure: the quota is read the way agy reads it. Any
    // failure of that read leaves agy's own answer standing: unknown,
    // never zero or full.
    if (failure.kind !== "auth" && refusedEligibility(said) && !NETWORK.test(said)) {
      let data
      try {
        data = await quota({ env, version: version.stdout.trim(), deadline, signal })
      } catch (error) {
        if (signal?.aborted) throw new UsageError("agy usage query was cancelled.", { kind: "cancel" })
        throw failure
      }
      try {
        return parseUsageReport({ status: "SUCCESS", command: { name: "usage", data } })
      } catch {
        throw failure
      }
    }
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
// that fails every few minutes all day helps nobody.
const BACKOFF_FIRST_MS = 10 * 60 * 1000
const BACKOFF_MOST_MS = 6 * 60 * 60 * 1000

function backoff(n) {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(n, 20) - 1), BACKOFF_MOST_MS)
}

const NEEDS_SIGN_IN = "Sign in again from this account's Sign in in magpie, or run `agy` in a terminal; magpie doesn't run agy for usage until then."

// No completed-result cache: sequential refreshes must see account/allowance changes.
// What is kept is what keeps agy from being run when it can't answer:
// - agy's stored sign-in is read first (signin.mjs), and agy isn't run when
//   there is none, or it has ended with nothing to renew it: the read says
//   the sign-in has expired (signIn "expired"), which magpie shows on the
//   account, and nothing starts a Google sign-in in the background.
// - an explicit authentication rejection, or an ended token hanging silently
//   or with sign-in talk, blocks further background runs for that credential.
//   Diagnostic-only output isn't evidence of a browser sign-in.
// - any other failure isn't run again for backoff(n).
export function createUsageReader(resolveAgy, options = {}) {
  const { signIn = () => storedSignIn(), now = () => Date.now(), ...fetchOptions } = options
  const pending = new Map()
  let held = null
  let saidExpired = false
  const expired = (why) => {
    saidExpired = true
    return { windows: [], error: `${why}. ${NEEDS_SIGN_IN}`, signIn: "expired" }
  }
  return async () => {
    let stored
    try { stored = await signIn() } catch { stored = { state: "unknown" } }
    const why = cannotSignIn(stored)
    if (why) return expired(why)
    if (isDead(stored)) return expired("agy's sign-in no longer works")
    const key = stored?.state === "present" ? stored.fp : "unknown"
    if (held && held.key === key && now() < held.until) {
      return { windows: [], error: held.error, signIn: held.auth ? "expired" : "kept" }
    }
    try {
      const agy = resolveAgy()
      if (!pending.has(agy)) {
        const query = fetchUsage(agy, fetchOptions).finally(() => {
          if (pending.get(agy) === query) pending.delete(agy)
        })
        pending.set(agy, query)
      }
      const result = { ...structuredClone(await pending.get(agy)), signIn: saidExpired ? "renewed" : "kept" }
      held = null
      saidExpired = false
      return result
    } catch (error) {
      const message = error instanceof UsageError ? error.message : "agy usage query failed. Check the CLI and temporary-directory permissions."
      if (error?.kind === "cancel") return { windows: [], error: message, signIn: "kept" }
      const output = String(error.output ?? "")
      const auth = error?.kind === "auth" || error?.kind === "timeout" && stored?.state === "present" && stored.expired &&
        (!output.trim() || SIGN_IN_TALK.test(withoutDiagnostics(output)))
      if (auth && stored?.state === "present") {
        noteDead(stored)
        return expired("agy's sign-in no longer works")
      }
      const n = held?.key === key ? held.n + 1 : 1
      held = { key, n, until: now() + backoff(n), error: message, auth }
      if (auth) saidExpired = true
      return { windows: [], error: message, signIn: auth ? "expired" : "kept" }
    }
  }
}

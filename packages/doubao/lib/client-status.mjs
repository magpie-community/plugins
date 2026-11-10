// Where the Doubao desktop client actually is on this machine, and which of
// the four stages it is stuck at.
//
// The daily-credit campaign can only be claimed inside the desktop client's
// own webview (a plain browser renders the "去下载" placeholder and the write
// endpoint answers 710010702 to everyone else — verified 2026-11-02). So
// "why did the auto check-in do nothing" almost always has one of four
// answers, and telling them apart is the whole point of this module:
//
//   1. not-installed      no /Applications/Doubao.app
//   2. not-running        installed, process absent
//   3. running-no-debug   process up, but no CDP port → attach impossible
//   4. ready              port answers; claim can be driven
//
// Each stage carries a one-line hint and a copy-pasteable fix, so the plugin's
// check-in message and the account panel say something actionable instead of
// a generic failure.

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"

import { isCdpUp, isDoubaoRunning, launchClient } from "./client-checkin.mjs"

const APP_PATH = "/Applications/Doubao.app"
const PLIST = `${APP_PATH}/Contents/Info.plist`
// The client ships its own Chromium browser as a helper app. It is NOT a
// separately installed product: it lives inside Doubao.app and shares the
// client's version. We only report it — the claim path never drives it.
const BROWSER_APP = `${APP_PATH}/Contents/Helpers/Doubao Browser.app`
const BROWSER_PLIST = `${BROWSER_APP}/Contents/Info.plist`

function plistValue(plist, key) {
  try {
    return execSync(`/usr/libexec/PlistBuddy -c "Print :${key}" "${plist}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).toString().trim()
  } catch {
    return ""
  }
}

let cachedInstall = null

/** Installed? Which version? Cached: the app doesn't change mid-session. */
export function installInfo({ fresh = false } = {}) {
  if (cachedInstall && !fresh) return cachedInstall
  const installed = existsSync(APP_PATH) && existsSync(PLIST)
  cachedInstall = {
    installed,
    appPath: installed ? APP_PATH : null,
    version: installed ? plistValue(PLIST, "CFBundleShortVersionString") : "",
    bundleId: installed ? plistValue(PLIST, "CFBundleIdentifier") : "",
    // Doubao ships a full Chromium browser as a nested helper app (1.2 GB,
    // com.bot.pc.doubao.browser, registers http/https/file + doubaobrowser://).
    // Users see it in their app list and wonder where it came from; it is
    // part of the client, not a separate install.
    browser: {
      installed: existsSync(BROWSER_APP),
      appPath: existsSync(BROWSER_APP) ? BROWSER_APP : null,
      version: existsSync(BROWSER_PLIST) ? plistValue(BROWSER_PLIST, "CFBundleShortVersionString") : "",
      bundleId: existsSync(BROWSER_PLIST) ? plistValue(BROWSER_PLIST, "CFBundleIdentifier") : "",
    },
  }
  return cachedInstall
}

/**
 * Diagnose the client in one call: what is installed, whether it runs, whether
 * CDP is reachable, and what to do next.
 *
 * @param {{port?:number, fresh?:boolean}} [opts]
 * @returns {Promise<{stage:"not-installed"|"not-running"|"running-no-debug"|"ready",
 *   installed:boolean, running:boolean, debuggable:boolean, port:number,
 *   version:string, browserInstalled:boolean, hint:string, fix:string|null}>}
 */
export async function diagnoseClient(opts = {}) {
  const port = Number(opts.port ?? process.env.DOUBAO_CDP_PORT ?? 9333)
  const inst = installInfo({ fresh: opts.fresh })

  if (!inst.installed) {
    return {
      stage: "not-installed",
      installed: false,
      running: false,
      debuggable: false,
      port,
      version: "",
      browserInstalled: false,
      hint: "未安装豆包电脑客户端。签到活动只在客户端内开放，网页端只显示「去下载」。",
      fix: "安装豆包电脑版：https://www.doubao.com/download",
    }
  }

  const running = isDoubaoRunning()
  const debuggable = running ? await isCdpUp(port, 1500) : false

  if (debuggable) {
    return {
      stage: "ready",
      installed: true,
      running,
      debuggable: true,
      port,
      version: inst.version,
      browserInstalled: inst.browser.installed,
      hint: `豆包客户端 ${inst.version || ""} 已连接（调试端口 ${port}），插件可自动签到并领取奖励。`.trim(),
      fix: null,
    }
  }

  if (running) {
    return {
      stage: "running-no-debug",
      installed: true,
      running,
      debuggable: false,
      port,
      version: inst.version,
      browserInstalled: inst.browser.installed,
      hint: `豆包客户端在运行，但没有开启远程调试端口 ${port}，插件无法附着。`,
      fix: "node packages/doubao/ensure-doubao.mjs --force",
    }
  }

  return {
    stage: "not-running",
    installed: true,
    running: false,
    debuggable: false,
    port,
    version: inst.version,
    browserInstalled: inst.browser.installed,
    hint: `豆包客户端已安装但未运行；插件会自动以调试端口 ${port} 启动它。`,
    fix: `open -a Doubao --args --remote-debugging-port=${port}`,
  }
}

// Human-readable one-liner for logs and panel rows.
export function stageLabel(stage) {
  return {
    "not-installed": "未安装客户端",
    "not-running": "客户端未运行",
    "running-no-debug": "未开调试端口",
    ready: "客户端已连接",
  }[stage] ?? stage
}

// ---------------------------------------------------------------------------
// Getting the client to a state the claim engine can actually attach to
// ---------------------------------------------------------------------------

const UDD = `${homedir()}/Library/Application Support/Doubao`
// Chromium leaves these behind when it is killed hard; a stale SingletonLock
// makes the next launch refuse to start ("profile in use").
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"]
// A restarted client is disruptive (the user may have been mid-conversation),
// so at most one restart per window even if check-in is re-asked repeatedly.
const RESTART_COOLDOWN_MS = 10 * 60_000
let lastRestartAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(intervalMs)
  }
  return false
}

function quitClientSoft() {
  try { execSync(`osascript -e 'quit app "Doubao"'`, { stdio: "ignore", timeout: 6000 }) } catch {}
}

function killClientHard() {
  try { execSync(`pkill -9 -f 'Doubao.app/Contents/MacOS/Doubao'`, { stdio: "ignore", timeout: 4000 }) } catch {}
}

function clearSingletonFiles() {
  for (const f of SINGLETON_FILES) {
    try { rmSync(join(UDD, f), { force: true }) } catch {}
  }
}

/**
 * Bring the client to "attachable": already fine, launch it if closed, or
 * restart it with the debug port if it is running without one.
 *
 * This is what turns "auto check-in silently does nothing" into "auto check-in
 * works": `running-no-debug` is by far the most common stage (a normal double
 * click on the app starts it without the flag), and reporting it to the user
 * every day is not a fix. The restart is the only disruptive step, so it is
 * capped to once per window and skipped entirely when allowRestart is false.
 *
 * @param {{port?:number, allowRestart?:boolean, fresh?:boolean,
 *          launchTimeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, stage:string, action:"none"|"launched"|"restarted"|
 *   "launch-failed"|"restart-failed"|"cooldown"|"skipped", port:number,
 *   version:string, launched?:boolean, restarted?:boolean, error?:string}>}
 */
export async function ensureClientReady(opts = {}) {
  const port = Number(opts.port ?? process.env.DOUBAO_CDP_PORT ?? 9333)
  const allowRestart = opts.allowRestart !== false
  // Launching is separately controllable so a test (or a host that manages the
  // client itself) can probe without spawning a GUI.
  const allowLaunch = opts.allowLaunch !== false
  const inst = installInfo({ fresh: opts.fresh })
  const base = { port, version: inst.version || "" }

  if (!inst.installed) return { ...base, ok: false, stage: "not-installed", action: "none" }
  if (await isCdpUp(port, 1500)) return { ...base, ok: true, stage: "ready", action: "none" }

  if (!isDoubaoRunning()) {
    if (!allowLaunch) return { ...base, ok: false, stage: "not-running", action: "skipped" }
    const r = await launchClient({ port, detached: true, timeoutMs: opts.launchTimeoutMs ?? 45000 })
    return r.ok
      ? { ...base, ok: true, stage: "ready", action: "launched", launched: true }
      : { ...base, ok: false, stage: "not-running", action: "launch-failed", error: r.error ?? "launch-failed" }
  }

  // Running, but nobody can attach. Restarting is the only way in.
  if (!allowRestart) return { ...base, ok: false, stage: "running-no-debug", action: "skipped" }
  if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
    return { ...base, ok: false, stage: "running-no-debug", action: "cooldown" }
  }
  lastRestartAt = Date.now()

  // Polite first: an app-level quit lets the client flush its session.
  quitClientSoft()
  let gone = await waitUntil(() => !isDoubaoRunning(), 5000)
  if (!gone) {
    killClientHard()
    gone = await waitUntil(() => !isDoubaoRunning(), 4000)
  }
  if (!gone) {
    return { ...base, ok: false, stage: "running-no-debug", action: "restart-failed", error: "客户端未退出" }
  }
  clearSingletonFiles()
  await sleep(1200)

  const r = await launchClient({ port, detached: true, timeoutMs: opts.launchTimeoutMs ?? 45000 })
  return r.ok
    ? { ...base, ok: true, stage: "ready", action: "restarted", launched: true, restarted: true }
    : { ...base, ok: false, stage: "not-running", action: "restart-failed", error: r.error ?? "重启失败" }
}

// Only here so the version probe has a single reader; kept out of the module
// top level so importing this file never shells out.
export const _paths = { APP_PATH, PLIST, BROWSER_APP, UDD }

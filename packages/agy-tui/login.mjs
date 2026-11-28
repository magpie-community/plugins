import { spawn } from "node:child_process"
import os from "node:os"

// The Google sign-in, run by agy itself (from the agy-cli plugin's
// login.mjs): `agy acp --login` prints Google's sign-in link, then reads
// the code the page shows from stdin, trades it and keeps the token in
// the account's home. The plugin never sees the token. magpie opens the
// link and takes the code in its own field.

export const LOGIN_WAIT_MS = 15 * 60 * 1000
export const LOGIN_START_MS = 30_000
export const LOGIN_FINISH_MS = 60_000

const SIGN_IN_LINK = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/

let pending = null

function lastLine(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? ""
}

function stop(child) {
  try { child.stdin?.end() } catch {}
  try { child.kill() } catch {}
}

// startLogin starts agy's sign-in with env (the account's) and resolves
// with its link and finish, or with why it couldn't start. A second
// sign-in ends the first's agy.
export function startLogin(agy, env, { waitMs = LOGIN_WAIT_MS, startMs = LOGIN_START_MS } = {}) {
  if (pending) {
    stop(pending)
    pending = null
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(agy, ["acp", "--login"], { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    } catch (err) {
      resolve({ error: `couldn't run agy: ${err.message}` })
      return
    }
    pending = child
    let out = ""
    let settled = false
    let exited = null
    const waiters = []
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(startTimer)
      resolve(value)
    }
    const startTimer = setTimeout(() => {
      stop(child)
      settle({ error: `agy didn't print a sign-in link within ${Math.round(startMs / 1000)}s${lastLine(out) ? ` (${lastLine(out)})` : ""}` })
    }, startMs)
    const waitTimer = setTimeout(() => stop(child), waitMs)
    waitTimer.unref?.()
    const read = (data) => {
      out += data
      const link = SIGN_IN_LINK.exec(out)?.[0]
      if (link) settle({ url: link, finish })
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.stdin?.on("error", () => {})
    child.on("error", (err) => {
      exited = { code: null, err }
      for (const w of waiters.splice(0)) w()
      settle({ error: `couldn't run agy: ${err.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(waitTimer)
      if (pending === child) pending = null
      exited = exited ?? { code }
      for (const w of waiters.splice(0)) w()
      if (/Usage:/.test(out) && !SIGN_IN_LINK.test(out)) {
        settle({ error: "this agy can't sign in from magpie (it has no `agy acp --login`): update it with `agy update`" })
      }
      settle({ error: `agy exited before printing a sign-in link${lastLine(out) ? `: ${lastLine(out)}` : ""}` })
    })

    // finish hands agy the code and waits for it to trade it.
    async function finish(code, { signal, finishMs = LOGIN_FINISH_MS } = {}) {
      const value = String(code ?? "").trim()
      if (!value || /[\r\n]/.test(value)) {
        stop(child)
        return { error: "paste the code the sign-in page shows" }
      }
      if (exited) return { error: "this sign-in is over (its link waits 15 minutes); start it again" }
      const before = out.length
      const done = new Promise((r) => waiters.push(r))
      let timer
      const late = new Promise((r) => { timer = setTimeout(() => r("late"), finishMs) })
      const onAbort = () => stop(child)
      signal?.addEventListener?.("abort", onAbort, { once: true })
      try {
        child.stdin.write(value + "\n")
        if ((await Promise.race([done, late])) === "late") {
          stop(child)
          return { error: `agy didn't finish the sign-in within ${Math.round(finishMs / 1000)}s` }
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener?.("abort", onAbort)
      }
      if (exited.code === 0) return { ok: true }
      const said = lastLine(out.slice(before)) || lastLine(out)
      if (/invalid_grant/.test(said)) return { error: `Google turned the code away: mistyped, used already, or from another sign-in page. Start the sign-in again. (${said})` }
      return { error: said || `agy exited with code ${exited.code}` }
    }
  })
}

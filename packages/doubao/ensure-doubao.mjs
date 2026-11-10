// Keep the Doubao desktop client running with remote debugging enabled on the
// port the plugin's built-in auto check-in attaches to. Run this before
// magpie's daily check-in (e.g. from a cron / the daily automation), or once
// by hand after (re)starting Doubao, so the plugin can reach the client.
//
//   node packages/doubao/ensure-doubao.mjs          # no-op if already up
//   node packages/doubao/ensure-doubao.mjs --force  # kill+relaunch if up but no debug port
//
// With --force it quits any running Doubao and relaunches it with
// --remote-debugging-port=9333 so the webview is reachable. Without --force it
// only launches when Doubao is not running at all; an already-running client
// without the debug port is reported (you must quit it and relaunch) rather
// than killed, because killing the user's live client mid-session is rude.

import { execSync } from "node:child_process"
import { isClientDebuggable, isDoubaoRunning, launchClient, attemptClientInstall, openDownloadPage } from "./lib/client-checkin.mjs"

const port = Number(process.env.DOUBAO_CDP_PORT ?? 9333)
const force = process.argv.includes("--force")
const install = process.argv.includes("--install")

async function main() {
  if (install) {
    const r = await attemptClientInstall({ port })
    if (r.ok) {
      console.log(`Doubao 已就绪（${r.installed ? "刚安装并" : ""}已连接调试端口 ${port}）。插件自动签到可以直接用了。`)
      return 0
    }
    if (r.needDownload) {
      console.log(r.error)
      return 1
    }
    console.error("安装失败：", r.error)
    return 1
  }

  if (await isClientDebuggable({ port })) {
    console.log(`Doubao already debuggable on port ${port} — nothing to do.`)
    return 0
  }
  if (isDoubaoRunning()) {
    if (!force) {
      console.log(
        `Doubao is running but WITHOUT the remote-debugging port ${port}.\n` +
        `Quit Doubao, then either:\n` +
        `  open -a Doubao --args --remote-debugging-port=${port}\n` +
        `or run this helper with --force to kill and relaunch it.`,
      )
      return 1
    }
    console.log("Doubao running without debug port; quitting it to relaunch with the flag…")
    try { execSync("osascript -e 'quit app \"Doubao\"'", { stdio: "ignore" }) } catch {}
    // give it a moment to let go of the user-data-dir
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log(`Launching Doubao with --remote-debugging-port=${port}…`)
  const res = await launchClient({ port, detached: true, timeoutMs: 45000 })
  if (!res.ok) {
    console.error("Failed to launch Doubao:", res.error)
    return 1
  }
  console.log(`Doubao up with debug port ${port}. The plugin's auto check-in can now reach it.`)
  return 0
}

main().then((code) => { process.exit(code) }).catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})

// A fake Chromium for tests: serves the DevTools HTTP + WebSocket endpoints
// and writes the DevToolsActivePort file, so the plugin's real openSession /
// waitForToken / CDP cookie read run against it. Modes come from argv:
//   --headless=new  → serve CDP (the renewal / post-sign-in read)
//   (no headless)   → the login window: wait for the plugin's close
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
// "--user-data-dir=" is 16 characters; the path starts right after it.
const profile = args.find((a) => a.startsWith("--user-data-dir="))?.slice(16) ?? "."
// bun build --compile's Windows launcher mangles argument values: the drive
// letter and part of the path is eaten. A path that exists as given is taken
// as it is (an account's own profile lives one level under tmpdir); only a
// mangled one is repaired by re-seating its last segment under tmpdir().
const profilePath = existsSync(profile)
  ? profile
  : /^[A-Za-z]:/.test(profile)
    ? profile
    : join(tmpdir(), profile.split(/[\\/]/).filter(Boolean).pop() ?? "fake-profile")
const headless = args.includes("--headless=new")
const url = args.find((a) => a.startsWith("http")) ?? ""
let pageTargetUrl = ""

try {
if (!headless) {
    // login window. On Unix it waits for the plugin's SIGTERM and records
    // the signal (the test asserts no SIGKILL was needed). On Windows
    // TerminateProcess is uncatchable and the plugin's WM_CLOSE cannot reach
    // a windowless exe, so exit on our own — otherwise the close path waits
    // its full 15s grace period per sign-in.
    const exit = () => {
      try {
        writeFileSync(join(profilePath, "close-signal.txt"), "SIGTERM")
      } catch {}
      process.exit(0)
    }
    // B1/B4: after "the user signed in", write the console session into the
    // profile's real Cookies sqlite — the plugin watches it off Windows to
    // close the window itself. FAKE_BROWSER_HOLD_COOKIE keeps it out
    // (an old session with no new cookie: the wait must not read that as done).
    if (!process.env.FAKE_BROWSER_HOLD_COOKIE) {
      setTimeout(() => {
        try {
          mkdirSync(join(profilePath, "Default"), { recursive: true })
          const { Database } = require("bun:sqlite")
          const db = new Database(join(profilePath, "Default", "Cookies"))
          db.query(
            "CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)",
          ).run()
          const now = Date.now()
          const micros = (ms) => (ms + 11644473600000) * 1000
          db.query(
            "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES ('.intern-ai.org.cn', 'uaa-token', 'fake-uaa-token', ?, ?, ?)",
          ).run(micros(now), micros(now), micros(now + 86400_000))
          db.close()
        } catch (e) {
          console.error("[fake-chrome] cookie write failed:", e?.message ?? e)
        }
      }, 300)
    }
    if (process.platform === "win32") {
      setTimeout(() => process.exit(0), 500)
    } else {
      process.on("SIGTERM", exit)
      process.on("SIGINT", exit)
      setInterval(() => {}, 10_000)
    }
  } else {
    mkdirSync(profilePath, { recursive: true })
    const server = Bun.serve({
      port: 0,
      // 仅本机回环：绑 0.0.0.0（不指定 hostname 的默认）会触发 Windows 防火墙
      // 对每次编译出来的新 exe 弹"允许访问"，路径随机所以每次都弹
      hostname: "127.0.0.1",
      fetch(req, server) {
        const u = new URL(req.url)
        if (u.pathname === "/json/version") return Response.json({ Browser: "FakeChrome/1.0" })
        if (u.pathname === "/json/list") {
          // the plugin's Cdp.connect picks a type:"page" target whose URL
          // matches the console host and whose webSocketDebuggerUrl it can
          // open — hand it exactly that, then serve the socket on upgrade
          pageTargetUrl = `ws://127.0.0.1:${server.port}/devtools/page/1`
          return Response.json([
            {
              type: "page",
              url: url || "https://discovery.intern-ai.org.cn/token-plan/home",
              webSocketDebuggerUrl: pageTargetUrl,
            },
          ])
        }
        // any /devtools/* request is the WebSocket the plugin opened
        const up = server.upgrade(req, { data: { page: u.pathname } })
        if (up) return undefined
        return new Response("not found", { status: 404 })
      },
      websocket: {
        open() {},
        message(ws, raw) {
          const msg = JSON.parse(String(raw))
          if (msg.method === "Network.getAllCookies") {
            // FAKE_BROWSER_COOKIE_VALUE lets a test hand out a token with a
            // known expiry (a kept session about to expire, or one already
            // expired server-side). FAKE_BROWSER_FOREIGN_COOKIE puts a
            // same-named cookie on another org.cn host first: the plugin
            // must not take it for the console's session.
            const cookies = []
            if (process.env.FAKE_BROWSER_FOREIGN_COOKIE) {
              cookies.push({ name: "uaa-token", value: "foreign-org-cn-token", domain: ".other.org.cn" })
            }
            cookies.push({
              name: "uaa-token",
              value: process.env.FAKE_BROWSER_COOKIE_VALUE || "fake-uaa-token-for-tests",
              domain: ".intern-ai.org.cn",
            })
            ws.send(JSON.stringify({ id: msg.id, result: { cookies } }))
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
          }
        },
      },
    })
    // the browser-level target: /devtools/browser/<id> on the same port
    writeFileSync(join(profilePath, "DevToolsActivePort"), `${server.port}\n/devtools/browser/fake\n`)
    console.error("[fake-chrome] serving on", server.port)
    const exit = () => process.exit(0)
    process.on("SIGTERM", exit)
    process.on("SIGINT", exit)
    // keep alive; the plugin closes us when it has the cookie
  }
} catch (e) {
  console.error("[fake-chrome] FAILED:", e?.message ?? e, e?.stack?.slice(0, 400))
  process.exit(1)
}

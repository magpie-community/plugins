// A fake Chromium for the MOSS tests: serves the DevTools HTTP + WebSocket
// endpoints and writes the DevToolsActivePort file, so the plugin's real
// openSession / waitForToken / CDP cookie read run against it. Modes come
// from argv:
//   --headless=new  → serve CDP (the renewal / post-sign-in read)
//   (no headless)   → the login window: write the console session cookie
//                     into the profile's Cookies sqlite, then exit
import { writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const profile = args.find((a) => a.startsWith("--user-data-dir="))?.slice(17) ?? "."
// bun build --compile's Windows launcher mangles argument values: the drive
// letter and part of the path are eaten. The test always makes the profile
// under tmpdir(), so the safe repair is: take the last path segment and
// re-seat it under tmpdir().
const profilePath = /^[A-Za-z]:/.test(profile)
  ? profile
  : join(tmpdir(), profile.split(/[\\/]/).filter(Boolean).pop() ?? "fake-profile")
const headless = args.includes("--headless=new")
const url = args.find((a) => a.startsWith("http")) ?? ""

const CONSOLE_COOKIE = process.env.FAKE_MOSS_COOKIE_NAME || "moss_studio_prod_access_token"
const CONSOLE_TOKEN = process.env.FAKE_MOSS_TOKEN || "fake-moss-console-token"
const CONSOLE_DOMAIN = process.env.FAKE_MOSS_COOKIE_DOMAIN || ".mosi.cn"

try {
  if (!headless) {
    // login window. Write the console session into the profile's real
    // Cookies sqlite — off Windows the plugin watches that store to close
    // the window itself. FAKE_BROWSER_HOLD_COOKIE keeps it out (an old
    // session with no new cookie: the wait must not read that as done).
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
            "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(CONSOLE_DOMAIN, CONSOLE_COOKIE, CONSOLE_TOKEN, micros(now), micros(now), micros(now + 86400_000))
          db.close()
        } catch (e) {
          console.error("[fake-chrome] cookie write failed:", e?.message ?? e)
        }
      }, 300)
    }
    if (process.platform === "win32") {
      // a windowless exe cannot receive WM_CLOSE; exit on our own like the
      // production path expects after the completion signal
      setTimeout(() => process.exit(0), 500)
    } else {
      process.on("SIGTERM", () => process.exit(0))
      process.on("SIGINT", () => process.exit(0))
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
          const pageTargetUrl = `ws://127.0.0.1:${server.port}/devtools/page/1`
          return Response.json([
            {
              type: "page",
              url: url || "https://platform.mosi.cn/",
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
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  cookies: [
                    { name: CONSOLE_COOKIE, value: CONSOLE_TOKEN, domain: CONSOLE_DOMAIN },
                    // a decoy on a look-alike domain: the plugin must not
                    // take it (cookieDomainMatches rejects evil-mosi.cn)
                    { name: CONSOLE_COOKIE, value: "decoy-token", domain: ".evil-mosi.cn" },
                  ],
                },
              }),
            )
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

// A fake Chromium for tests: serves the DevTools HTTP + WebSocket endpoints
// and writes the DevToolsActivePort file, so the plugin's real openSession /
// waitForToken / CDP cookie read run against it. Modes come from argv:
//   --headless=new  → serve CDP (the renewal / post-sign-in read)
//   (no headless)   → the login window: wait for the plugin's close
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
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  cookies: [{ name: "uaa-token", value: "fake-uaa-token-for-tests", domain: ".intern-ai.org.cn" }],
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

// An end-to-end smoke of the whole hook path, the way magpie would run it:
// onRequest (must return undefined), an exchange "fails", magpie writes its
// row, onResponse fires, the debounce passes, the watch scans, and a mail
// lands on a fake SMTP server.
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"

const dir = mkdtempSync(join(tmpdir(), "mail-watch-e2e-"))
mkdirSync(join(dir, "magpie"), { recursive: true })
process.env.MAGPIE_CONFIG_DIR = dir

const { onRequest, onResponse } = await import("./mail-watch.hooks.js")
const { message } = await import("./template.js")

// the fake SMTP server, holding what it got until the test reads it
let body = ""
const server = net.createServer((s) => {
  s.write("220 e2e\r\n")
  let inData = false
  s.on("data", (d) => {
    const t = d.toString("utf8")
    if (inData) {
      body += t
      if (t.endsWith("\r\n.\r\n")) { inData = false; s.write("250 ok\r\n") }
      return
    }
    for (const line of t.split("\r\n").filter(Boolean)) {
      if (line === "DATA") { inData = true; s.write("354 go\r\n") }
      else if (line === "QUIT") { s.write("221 bye\r\n"); s.end() }
      else s.write("250 ok\r\n")
    }
  })
})
const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)))

// options as the user might set them, at the SMTP server above. No
// user/pass: a plain wire with credentials is refused by design, so the
// relay shape here is the sign-in-free one. secure: false is explicit:
// the default is TLS, and a plain relay must say so.
const options = {
  smtp: { host: "127.0.0.1", port, secure: false, from: "magpie@example.com" },
  to: ["me@example.com"],
  watch: { errors: true, quotaExhausted: true, quotaLow: true, quotaLowPct: 90 },
  cooldownMinutes: { error: 0, quota: 0 },
  template: { subject: "[e2e] {{kind}}: {{provider}}", body: "provider={{provider}} status={{status}} err={{errType}} {{detail}}" },
}

// 1. onRequest changes nothing
const b = { model: "x" }
console.log("onRequest returns undefined:", onRequest(b, { options }) === undefined)

// 2. warm-up: one exchange ends before anything has failed; the scan runs,
//    init takes the empty log as its baseline, and the state file is born
await onResponse(null, { options, success: true })
await new Promise((r) => setTimeout(r, 2200))

// 3. an exchange fails; magpie writes the row as it finishes
const row = { t: "2026-10-28T09:00:00Z", agent: "claude", provider: "provA", model: "m1", status: 502, err: "bad gateway", err_type: "server_error", ep: "/v1/messages" }
appendFileSync(join(dir, "magpie", "usage.jsonl"), JSON.stringify(row) + "\n")

// 4. onResponse fires with success false, reply null — the hook schedules
//    the scan and returns at once
const t0 = Date.now()
await onResponse(null, { options, success: false })
console.log("onResponse returned fast (not awaiting the mail):", Date.now() - t0 < 1000)

// 4. the debounce (1.5 s) passes; the queue sends. Wait long enough for both.
await new Promise((r) => setTimeout(r, 4500))

const ok = body.includes(Buffer.from("provider=provA status=502 err=server_error").toString("base64"))
console.log("mail arrived with the rendered event:", ok)
// an ASCII subject goes out as plain text; only a non-ASCII one is RFC 2047
console.log("subject line present:", body.includes("Subject: [e2e] error: provA\r\n"))
server.close()
rmSync(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)

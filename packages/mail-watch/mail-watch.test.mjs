// Tests for mail-watch: the template, the SMTP client against fake
// servers, and the watch (usage-log scan, quota scan, cooldown). Everything
// runs in a temp config dir (MAGPIE_CONFIG_DIR); the real folder is never
// touched.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"
import { execFileSync } from "node:child_process"

const dir = mkdtempSync(join(tmpdir(), "mail-watch-test-"))
process.env.MAGPIE_CONFIG_DIR = dir
mkdirSync(join(dir, "magpie"), { recursive: true })

// the temp dir serves every describe block; it goes when the file's tests
// are all done, not when the first block's are
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const watch = await import("./watch.js")
const { fill, message, renderHtml, DEFAULT_HTML } = await import("./template.js")
const { send, resolveSmtp, PRESETS } = await import("./smtp.js")
const { readDigest, baselineDigest } = await import("./digest.js")
const { onResponse, digestScheduleForTests, resetDigestScheduleForTests, setDigestStepCapForTests } = await import("./mail-watch.hooks.js")

// ---- the fake SMTP servers ---------------------------------------------
// Two shapes, matching what the client speaks:
//   plain (startPlain) — a net server for the relay tests; records every
//     command and the DATA body.
//   secure (startSecure) — Bun's own TLS listener (implicit TLS, the 465
//     shape). Bun's client-side STARTTLS upgrade does not survive against
//     a Node TLSSocket on every platform (handshake completes, the session
//     dies seconds later), so STARTTLS is not part of the client; the
//     secure tests run against the transport it actually uses. A
//     self-signed certificate made by openssl; a machine without it skips
//     the TLS tests.
let server, got

const cert = { key: null, cert: null }
try {
  const p = join(dir, "key.pem"), c = join(dir, "cert.pem")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", p, "-out", c, "-days", "1", "-nodes", "-subj", "/CN=localhost"], { stdio: "ignore" })
  cert.key = readFileSync(p)
  cert.cert = readFileSync(c)
} catch {}

// smtpBrain is the dialog both servers speak: greeting, answers per
// command, DATA collected until ".", QUIT ends.
function smtpBrain(answers = {}) {
  got = { commands: [], body: "", bodyInData: false }
  return {
    open(s) {
      s.write("220 fake ready\r\n")
    },
    data(s, d) {
      const text = d.toString("utf8")
      if (got.bodyInData) {
        got.body += text
        if (text.endsWith("\r\n.\r\n")) {
          got.bodyInData = false
          s.write("250 queued\r\n")
        }
        return
      }
      for (const line of text.split("\r\n").filter(Boolean)) {
        got.commands.push(line)
        if (line === "DATA") {
          got.bodyInData = true
          s.write("354 go\r\n")
        } else if (line === "QUIT") {
          s.write("221 bye\r\n")
          setTimeout(() => s.end(), 20) // let the 221 land before the FIN
        } else if (/^AUTH PLAIN/.test(line)) {
          s.write(answers.auth ?? "235 ok\r\n")
        } else if (answers.failRcpt && /^RCPT/.test(line)) {
          s.write("550 no such user\r\n")
        } else if (answers.failMailFrom && /^MAIL/.test(line)) {
          s.write("503 bad sender\r\n")
        } else {
          s.write("250 ok\r\n")
        }
      }
    },
  }
}

function startPlain(answers = {}) {
  const brain = smtpBrain(answers)
  // a net socket speaks the same .write/.end the brain's Bun-style
  // handlers call, so the one dialog serves both servers
  server = net.createServer((s) => {
    brain.open(s)
    s.on("data", (d) => brain.data(s, d))
  })
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)))
}

function startSecure(answers = {}) {
  if (!cert.cert) return Promise.resolve(null)
  const brain = smtpBrain(answers)
  server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    tls: { key: cert.key, cert: cert.cert },
    socket: brain,
  })
  return Promise.resolve(server.port)
}

// ---- template ------------------------------------------------------------
describe("template", () => {
  test("fill replaces {{name}} and leaves unknown braces", () => {
    expect(fill("a {{x}} b {{y}} c {{x}}", { x: "1" })).toBe("a 1 b  c 1")
    expect(fill("keep {{not a var}}", {})).toBe("keep {{not a var}}")
    expect(fill("{{missing}}", {})).toBe("")
  })

  test("message builds RFC 5322 headers and a base64 body", () => {
    const m = message({ from: "magpie@example.com", to: ["a@b.c"], subject: "s", body: "hi" })
    expect(m).toContain("From: magpie@example.com\r\n")
    expect(m).toContain("To: a@b.c\r\n")
    expect(m).toContain("Subject: s\r\n")
    expect(m).toContain('Content-Type: text/plain; charset="utf-8"\r\n')
    expect(m.endsWith(Buffer.from("hi").toString("base64") + "\r\n")).toBe(true)
  })

  test("message encodes a non-ASCII subject as RFC 2047 and a display name", () => {
    const m = message({ from: "喵喵 <me@example.com>", to: ["you@example.com"], subject: "额度用尽", body: "x" })
    expect(m).toContain("Subject: =?UTF-8?B?")
    expect(m).toContain("From: =?UTF-8?B?")
    expect(m).toContain("<me@example.com>")
  })

  test("word splits long encoded subjects at the RFC 2047 limit", () => {
    const m = message({ from: "f@x.y", to: ["t@x.y"], subject: "很长的主题".repeat(20), body: "x" })
    for (const line of m.split("\r\n")) {
      // each encoded word stays within RFC 2047 §2's 75 characters, and a
      // folded continuation line (the leading space) stays short
      if (line.startsWith("Subject:")) expect(line.length).toBeLessThanOrEqual(998)
      else if (line.startsWith(" =?")) {
        expect(line.length).toBeLessThanOrEqual(76)
        expect(line.trim().length).toBeLessThanOrEqual(75)
      }
    }
  })

  test("every encoded word decodes on its own (whole codepoints, valid base64)", () => {
    // the failure mode this locks down: slicing the base64 at a fixed
    // width cuts quads mid-way, and each word decodes to shifted garbage
    const subjects = ["很长的主题".repeat(20), "[magpie] 额度用尽 · provider-account-with-a-long-name", "emoji 😀 mixed 中文 text"]
    for (const s of subjects) {
      const m = message({ from: "f@x.y", to: ["t@x.y"], subject: s, body: "x" })
      const line = m.split("\r\n").filter((l) => l.startsWith("Subject:") || l.startsWith(" =?")).join(" ")
      const joined = line.replace(/^Subject: /, "").replace(/ \r?\n /g, "").replace(/ /g, "")
      const out = [...joined.matchAll(/=\?UTF-8\?B\?(.+?)\?=/g)].map((w) => Buffer.from(w[1], "base64").toString("utf8")).join("")
      expect(out).toBe(s)
    }
  })

  test("addr keeps a display name with specials quoted", () => {
    const m = message({ from: '"Acme, Inc." <a@b.c>', to: ["t@x.y"], subject: "s", body: "x" })
    expect(m).toContain('From: "Acme, Inc." <a@b.c>')
  })

  test("addr keeps an injected name on one line, as quoted text", () => {
    // the CRLF is gone, so nothing becomes a header of its own; what the
    // attacker wrote remains inside the quoted display name
    const m = message({ from: 'bad\r\nBcc: x@y.z <a@b.c>', to: ["t@x.y"], subject: "s", body: "x" })
    expect(m.split("\r\n")[0]).toBe('From: "bad Bcc: x@y.z" <a@b.c>')
    for (const line of m.split("\r\n")) expect(line.startsWith("Bcc:")).toBe(false)
  })

  test("message with html is multipart/alternative and both parts decode", () => {
    const m = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "plain", html: "<p>rich</p>" })
    expect(m).toContain('Content-Type: multipart/alternative; boundary="')
    const boundary = /boundary="([^"]+)"/.exec(m)[1]
    expect(m).toContain(`--${boundary}`)
    expect(m.endsWith(`--${boundary}--\r\n\r\n`)).toBe(true)
    // the plain part decodes to the text, the html part to the layout
    const parts = m.split(`--${boundary}`).slice(1, -1)
    const plain = Buffer.from(parts[0].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8")
    const rich = Buffer.from(parts[1].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8")
    expect(plain).toBe("plain")
    expect(rich).toBe("<p>rich</p>")
  })

  test("renderHtml escapes vars into the user's layout and fills the default card", () => {
    // an error's words stay text in the user's own page
    const out = renderHtml("<b>{{err}}</b>", { err: "<script>alert(1)</script>", provider: "p", time: "t" })
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("<script>")
    // the default card fills every slot and leaves no skeleton rows
    const card = renderHtml("", { kind: "error", provider: "p1", account: "", model: "m1", agent: "a1", window: "", used: "", time: "t", detail: "boom" })
    expect(card).toContain("p1")
    expect(card).toContain("m1")
    expect(card).not.toContain("{{modelRow}}")
    expect(card).not.toContain("{{windowRow}}")
  })

  test("resolveSmtp applies a preset under explicit options", () => {
    expect(resolveSmtp({ preset: "qq", user: "u" })).toEqual({ host: "smtp.qq.com", port: 465, secure: true })
    expect(resolveSmtp({ preset: "GMAIL" })).toEqual({ host: "smtp.gmail.com", port: 465, secure: true })
    // a hand-set host and port win; an unknown preset is ignored — and
    // secure defaults to TLS, so the port follows (465, not 587)
    expect(resolveSmtp({ preset: "qq", host: "relay.lan", port: 2525 })).toEqual({ host: "relay.lan", port: 2525, secure: true })
    expect(resolveSmtp({ preset: "nope", host: "relay.lan" })).toEqual({ host: "relay.lan", port: 465, secure: true })
    expect(resolveSmtp({ host: "relay.lan", secure: false })).toEqual({ host: "relay.lan", port: 587, secure: false })
    expect(Object.keys(PRESETS)).toContain("163")
  })
})

// ---- smtp ------------------------------------------------------------------
describe("smtp", () => {
  test("send walks the handshake over implicit TLS and delivers the body", async () => {
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "hello" })
    const r = await send({ host: "127.0.0.1", port, secure: true, user: "u", pass: "p", from: "f@x.y", insecure: true }, ["t@x.y"], body)
    expect(r.startsWith("250")).toBe(true)
    expect(got.commands).toEqual([
      "EHLO magpie", "AUTH PLAIN " + Buffer.from("\0u\0p").toString("base64"),
      "MAIL FROM:<f@x.y>", "RCPT TO:<t@x.y>", "DATA", "QUIT",
    ])
    expect(got.body).toContain(Buffer.from("hello").toString("base64"))
    expect(got.body.endsWith("\r\n.\r\n")).toBe(true)
  })

  test("a plain port with a user refuses to send the password", async () => {
    const port = await startPlain()
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    expect(send({ host: "127.0.0.1", port, secure: false, user: "u", pass: "p" }, ["t@x.y"], body)).rejects.toThrow(/cleartext/)
  })

  test("a plain relay with no user sends fine", async () => {
    const port = await startPlain()
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    const r = await send({ host: "127.0.0.1", port, secure: false, from: "f@x.y" }, ["t@x.y"], body)
    expect(r.startsWith("250")).toBe(true)
    expect(got.commands).toContain("MAIL FROM:<f@x.y>")
  })

  test("an unset secure means TLS: a TLS server answers, a plain one is never tried", async () => {
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    const r = await send({ host: "127.0.0.1", port, user: "u", pass: "p", from: "f@x.y", insecure: true }, ["t@x.y"], body)
    expect(r.startsWith("250")).toBe(true)
  })

  test("a preset's secure is used by send, not just by resolveSmtp", async () => {
    // the preset-only failure: resolving gave TLS on 465, but send read
    // cfg.secure (unset) and connected in plain text. Host overridden
    // here to the fake server; secure still comes from the preset.
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    const r = await send({ preset: "qq", host: "127.0.0.1", port, user: "u", pass: "p", from: "f@x.y", insecure: true }, ["t@x.y"], body)
    expect(r.startsWith("250")).toBe(true)
  })

  test("a refused AUTH (535) fails the send", async () => {
    const port = await startSecure({ auth: "535 no\r\n" })
    if (!port) return
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    expect(send({ host: "127.0.0.1", port, secure: true, user: "u", pass: "p", insecure: true }, ["t@x.y"], body)).rejects.toThrow("535")
  })

  test("a refused MAIL FROM (503) fails the send", async () => {
    const port = await startPlain({ failMailFrom: true })
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    expect(send({ host: "127.0.0.1", port, secure: false, from: "f@x.y" }, ["t@x.y"], body)).rejects.toThrow("503")
  })

  test("send rejects on a refused recipient", async () => {
    const port = await startPlain({ failRcpt: true })
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    expect(send({ host: "127.0.0.1", port, secure: false, from: "f@x.y" }, ["t@x.y"], body)).rejects.toThrow("550")
  })

  test("send refuses a host that never answers", async () => {
    const body = message({ from: "f@x.y", to: ["t@x.y"], subject: "s", body: "x" })
    expect(send({ host: "127.0.0.1", port: 1, secure: false, from: "f@x.y" }, ["t@x.y"], body, { timeoutMs: 800 })).rejects.toThrow()
  })
})

// ---- watch -------------------------------------------------------------------
describe("watch", () => {
  const usage = join(dir, "magpie", "usage.jsonl")
  const state = join(dir, "magpie", "mail-watch-state.json")

  beforeAll(() => {
    writeFileSync(usage, "")
  })

  const opts = (over = {}) => ({ watch: { errors: true, ...over }, cooldown: { error: 0, quota: 0 } })

  test("first init takes the log's size as its start, then sees new rows", () => {
    writeFileSync(usage, JSON.stringify({ provider: "old", status: 500 }) + "\n")
    watch.forTests(null)
    watch.init()
    const base = watch.forTests().offset
    expect(base).toBe(Buffer.byteLength(JSON.stringify({ provider: "old", status: 500 }) + "\n"))
    // a new failure arrives
    const row = { provider: "p1", status: 500, err: "boom", err_type: "server_error", model: "m", agent: "a" }
    writeFileSync(usage, readFileSync(usage, "utf8") + JSON.stringify(row) + "\n")
    const r = watch.fail(opts(), 1000)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ kind: "error", provider: "p1", status: 500, err: "boom" })
    expect(r.offset).toBe(base + Buffer.byteLength(JSON.stringify(row) + "\n"))
  })

  test("handed_on rows and successes are skipped; a final failure fires", () => {
    const rows = [
      JSON.stringify({ provider: "p1", status: 429, handed_on: true }) + "\n",
      JSON.stringify({ provider: "p2", status: 200 }) + "\n",
      JSON.stringify({ provider: "p3", status: 401, err_type: "auth" }) + "\n",
    ].join("")
    writeFileSync(usage, readFileSync(usage, "utf8") + rows)
    const r = watch.fail(opts(), 2000)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].provider).toBe("p3")
  })

  test("the user's cooldownMinutes option is honoured (not just the default)", () => {
    const row = JSON.stringify({ provider: "popt", status: 500 }) + "\n"
    const add = () => writeFileSync(usage, readFileSync(usage, "utf8") + row)
    add()
    // 1 minute: the second scan inside a minute is held, past it fires
    const cool = { watch: { errors: true }, cooldown: { error: 1 } }
    const r1 = watch.fail(cool, 60_000)
    expect(r1.events).toHaveLength(1)
    add()
    expect(watch.fail(cool, 90_000)).toEqual({ events: [], offset: watch.forTests().offset })
    add()
    expect(watch.fail(cool, 121_000).events).toHaveLength(1)
  })

  test("cooldown holds a repeat back and fires again after its window", () => {
    const row = JSON.stringify({ provider: "pc", status: 500 }) + "\n"
    const add = () => writeFileSync(usage, readFileSync(usage, "utf8") + row)
    add()
    const cool = { watch: { errors: true }, cooldown: { error: 10 } }
    const r1 = watch.fail(cool, 10_000)
    expect(r1.events).toHaveLength(1)
    add()
    const r2 = watch.fail(cool, 20_000)
    expect(r2.events).toHaveLength(0)
    add()
    const r3 = watch.fail(cool, 10_000 + 11 * 60_000)
    expect(r3.events).toHaveLength(1)
  })

  test("the provider list filters, an empty one lets all through", () => {
    const rows = [
      JSON.stringify({ provider: "a1", status: 500 }) + "\n",
      JSON.stringify({ provider: "b2", status: 500 }) + "\n",
    ].join("")
    writeFileSync(usage, readFileSync(usage, "utf8") + rows)
    const r = watch.fail({ watch: { errors: true, providers: ["b2"] }, cooldown: { error: 0 } }, 5000)
    expect(r.events.map((e) => e.provider)).toEqual(["b2"])
  })

  test("a log cut shorter than the offset restarts the scan", () => {
    writeFileSync(usage, "x")
    const r = watch.fail(opts(), 6000)
    expect(r.offset).toBe(0) // "x" holds no full line: the byte stays unread
    watch.forTests({ offset: 10 ** 9 }) // beyond any size
    const r2 = watch.fail(opts(), 6000)
    expect(r2.offset).toBe(0) // restarted; nothing scanned
    writeFileSync(usage, "")
    watch.forTests({ offset: 0 })
  })

  test("a byte that is not UTF-8 does not push the offset past a row", () => {
    // a row with a broken byte, then a good failing row after it
    const broken = Buffer.from(JSON.stringify({ provider: "pb", status: 200 }) + "\n")
    broken[5] = 0xff
    const good = Buffer.from(JSON.stringify({ provider: "pg", status: 503, err_type: "t" }) + "\n")
    writeFileSync(usage, Buffer.concat([broken, good]))
    const r = watch.fail(opts(), 6500)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].provider).toBe("pg")
    expect(r.offset).toBe(broken.length + good.length)
    writeFileSync(usage, "")
    watch.forTests({ offset: 0 })
  })

  test("state saves and reloads", () => {
    watch.forTests({ offset: 1234, sent: { "error|p|500": 42 } })
    watch.save()
    const raw = JSON.parse(readFileSync(state, "utf8"))
    expect(raw.offset).toBe(1234)
    const st = watch.forTests()
    expect(st.sent["error|p|500"]).toBe(42)
  })

  test("quotaScan reports exhausted and low windows, each its own cooldown", () => {
    writeFileSync(
      join(dir, "magpie", "quotas.json"),
      JSON.stringify({
        // magpie's real key shape: provider/account, account lowercased
        "prov/me@example.com": { at: "t", quota: { windows: [{ name: "5 hours", used: 100 }, { name: "7 days", used: 92 }] } },
        "other/u": { quota: { windows: [{ name: "w", used: 55 }] } },
      }),
    )
    const o = { watch: { quotaExhausted: true, quotaLow: true, quotaLowPct: 90 }, cooldown: { quota: 0 } }
    const ev = watch.quotaScan(o, 7000)
    expect(ev.map((e) => e.kind + ":" + e.window)).toEqual(["quotaExhausted:5 hours", "quotaLow:7 days"])
    expect(ev[0].account).toBe("me@example.com")
    expect(ev[0].provider).toBe("prov")
    // same again with a long cooldown: nothing — but the low and exhausted
    // keys are apart, so a window that goes 92→100 still alerts. The sent
    // map starts clean here: the scan above (cooldown 0) marked it already.
    watch.forTests({ sent: {} })
    const cool = { watch: { quotaExhausted: true, quotaLow: true, quotaLowPct: 90 }, cooldown: { quota: 240 } }
    const w1 = watch.quotaScan(cool, 7100)
    expect(w1.map((e) => e.kind)).toEqual(["quotaExhausted", "quotaLow"])
    expect(watch.quotaScan(cool, 7101)).toEqual([])
  })

  test("quotaScan skips unlisted providers and unconfigured kinds", () => {
    const o = { watch: { quotaExhausted: true, providers: ["other"] }, cooldown: { quota: 0 } }
    const ev = watch.quotaScan(o, 8000)
    expect(ev).toEqual([]) // prov/me is not listed
  })

  test("quotaScan matches the real key shape and skips windows whose reset passed", () => {
    // quotas.json holds last readings, not live state: a window whose
    // reset already passed is stale, not still full. A window with no
    // parseable reset keeps alerting — its state is unknown.
    const now = Date.parse("2026-10-28T12:00:00Z")
    writeFileSync(
      join(dir, "magpie", "quotas.json"),
      JSON.stringify({
        "claude/me@example.com": {
          quota: {
            windows: [
              { name: "stale", used: 100, resetsAt: "2026-10-28T11:00:00Z" },
              { name: "live", used: 100, resetsAt: "2026-10-28T13:00:00Z" },
              { name: "unknown", used: 100 },
            ],
          },
        },
      }),
    )
    watch.forTests({ sent: {} })
    const o = { watch: { quotaExhausted: true, providers: ["claude"] }, cooldown: { quota: 0 } }
    const ev = watch.quotaScan(o, now)
    expect(ev.map((e) => e.window)).toEqual(["live", "unknown"])
    expect(ev.every((e) => e.provider === "claude" && e.account === "me@example.com")).toBe(true)
  })

  test("an alert scan's save keeps the digest cursor (one state, one writer)", () => {
    // the reported failure: 1000 rows, digest baseline, one new failing
    // row, an alert scan, a save — then the digest must see exactly the
    // one new row, not the whole log again.
    const rows = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ session: `s${i}`, agent: "a", provider: "p", model: "m", status: 200 }) + "\n").join("")
    writeFileSync(usage, rows)
    writeFileSync(state, JSON.stringify({}))
    baselineDigest()
    const planted = JSON.parse(readFileSync(state, "utf8")).digestOffset
    expect(planted).toBe(Buffer.byteLength(rows))
    const failRow = JSON.stringify({ provider: "p9", status: 500, err: "boom" }) + "\n"
    writeFileSync(usage, rows + failRow)
    watch.forTests({ offset: Buffer.byteLength(rows), sent: {} })
    const r = watch.fail({ watch: { errors: true }, cooldown: { error: 0 } }, 9000)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].provider).toBe("p9")
    watch.save()
    const after = JSON.parse(readFileSync(state, "utf8"))
    expect(after.digestOffset).toBe(planted) // the scan did not wipe it
    const { digest } = readDigest({})
    expect(digest.rows).toBe(1)
    // clean up: later tests plant their own digest cursor
    const cleaned = JSON.parse(readFileSync(state, "utf8"))
    delete cleaned.digestOffset
    writeFileSync(state, JSON.stringify(cleaned))
    writeFileSync(usage, "")
    watch.forTests({ offset: 0 })
  })

  test("the hourly cap bounds a bad hour (default 20)", () => {
    const evs = [{ kind: "error" }, { kind: "error" }, { kind: "error" }]
    watch.forTests({ sent: {}, mailed: [] })
    expect(watch.takeWithinCap(evs, 2, 1000)).toHaveLength(2)
    expect(watch.takeWithinCap(evs, 2, 2000)).toHaveLength(0)
    expect(watch.takeWithinCap(evs, 2, 1000 + 3_600_000 + 1)).toHaveLength(2)
    watch.forTests({ mailed: [] })
    expect(watch.takeWithinCap(Array.from({ length: 25 }, () => ({})), undefined, 5000)).toHaveLength(20)
  })

  test("sent-marks older than the longest cooldown are pruned", () => {
    writeFileSync(
      join(dir, "magpie", "quotas.json"),
      JSON.stringify({ "claude/me@example.com": { quota: { windows: [{ name: "5h", used: 100 }] } } }),
    )
    watch.forTests({ sent: { "quota|quotaExhausted|claude/me@example.com|5h": 1000 } })
    const o = { watch: { quotaExhausted: true }, cooldown: { quota: 240 } }
    expect(watch.quotaScan(o, 1000 + 60_000)).toEqual([]) // still held
    const ev = watch.quotaScan(o, 1000 + 241 * 60_000) // past the window: pruned, alerts again
    expect(ev).toHaveLength(1)
    expect(ev[0].provider).toBe("claude")
    // the prune itself, not just the cooldown: a mark this scan never
    // touches must be gone afterwards, or the map grows without bound.
    // (The old test passed with pruning as a no-op: the cooldown alone
    // re-fires the event, so it never proved the key was deleted.)
    watch.forTests({ sent: { "error|stale|500": 1000 } })
    watch.quotaScan(o, 1000 + 241 * 60_000)
    expect(watch.forTests().sent["error|stale|500"]).toBeUndefined()
  })

  test("save writes atomically and leaves no temp file", () => {
    watch.save()
    expect(existsSync(state + ".tmp")).toBe(false)
    expect(existsSync(state)).toBe(true)
  })
})

// ---- digest ----------------------------------------------------------------
describe("digest", () => {
  const usage = join(dir, "magpie", "usage.jsonl")
  const state = join(dir, "magpie", "mail-watch-state.json")

  test("readDigest aggregates sessions, agents, providers, models, tokens", () => {
    writeFileSync(usage, "")
    watch.forTests(null)
    watch.init()
    watch.forTests({ offset: 0, sent: {} })
    // the digest cursor starts independent of the alert offset
    baselineDigest()
    const rows = [
      { session: "aaaaaaaa-1111", agent: "claude", provider: "p1", model: "m1", status: 200, credits: 0.5, in: 100, out: 50 },
      { session: "aaaaaaaa-1111", agent: "claude", provider: "p1", model: "m2", status: 200, credits: 0.25, in: 80, out: 30 },
      { session: "bbbbbbbb-2222", agent: "node", provider: "p2", model: "m1", status: 502, credits: 0, in: 10, out: 0 },
    ]
    writeFileSync(usage, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const { digest } = readDigest({})
    expect(digest.rows).toBe(3)
    expect(digest.ok).toBe(2)
    expect(digest.failed).toBe(1)
    expect(digest.credits).toBeCloseTo(0.75)
    expect(digest.tokensIn).toBe(190)
    expect(digest.tokensOut).toBe(80)
    expect(digest.agents).toEqual({ claude: 2, node: 1 })
    expect(digest.providers).toEqual({ p1: 2, p2: 1 })
    expect(digest.models).toEqual({ m1: 2, m2: 1 })
    expect(Object.keys(digest.sessions).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"])
    expect(digest.sessions["aaaaaaaa"]).toEqual({ rows: 2, agents: { claude: 2 } })
    // the cursor moved: a second read sees nothing
    expect(readDigest({}).digest.rows).toBe(0)
  })

  test("baselineDigest plants the log's end; later rows land in the window", () => {
    writeFileSync(usage, JSON.stringify({ session: "cccccccc-3333", agent: "claude", provider: "p", model: "m", status: 200 }) + "\n")
    // state already has a digestOffset from the previous test — reset it
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    writeFileSync(state, JSON.stringify(raw))
    baselineDigest()
    const st = JSON.parse(readFileSync(state, "utf8"))
    const before = st.digestOffset
    expect(before).toBeGreaterThan(0)
    // a new row arrives; the digest sees exactly it
    const row = JSON.stringify({ session: "dddddddd-4444", agent: "node", provider: "p", model: "m", status: 200 }) + "\n"
    writeFileSync(usage, readFileSync(usage, "utf8") + row)
    const { digest } = readDigest({})
    expect(digest.rows).toBe(1)
    expect(Object.keys(digest.sessions)).toEqual(["dddddddd"])
  })

  test("a log cut shorter than the digest cursor restarts from the start", () => {
    writeFileSync(usage, "x")
    const { digest } = readDigest({})
    expect(digest.rows).toBe(0)
    // the stale cursor is reset, not kept: the next read starts at the
    // beginning of the new log instead of staying silent until the log
    // grows past the old size and then starting mid-row. (The old code
    // returned nothing and left the cursor where it was; the old test
    // locked that in.)
    expect(JSON.parse(readFileSync(state, "utf8")).digestOffset).toBe(0)
    const row = JSON.stringify({ session: "iiiiiiii-9999", agent: "claude", provider: "p", model: "m", status: 200 }) + "\n"
    writeFileSync(usage, row)
    expect(readDigest({}).digest.rows).toBe(1)
    writeFileSync(usage, "")
  })

  test("readDigest honours the provider list, the way the alerts do", () => {
    writeFileSync(usage, "")
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    writeFileSync(state, JSON.stringify(raw))
    baselineDigest()
    const rows = [
      { session: "ffffffff-6666", agent: "claude", provider: "p1", model: "m", status: 200 },
      { session: "ffffffff-6666", agent: "claude", provider: "p1", model: "m", status: 200 },
      { session: "gggggggg-7777", agent: "node", provider: "p2", model: "m", status: 200 },
    ]
    writeFileSync(usage, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const { digest } = readDigest({ providers: ["p1"] })
    expect(digest.rows).toBe(2)
    expect(digest.providers).toEqual({ p1: 2 })
    writeFileSync(usage, "")
  })
})

// ---- hooks -------------------------------------------------------------------
describe("hooks", () => {
  const usage = join(dir, "magpie", "usage.jsonl")
  const state = join(dir, "magpie", "mail-watch-state.json")
  // the watch is off in these tests: the alert scan they schedule is a
  // no-op (save only), so no stray scan disturbs another test's rows.
  const quiet = (over = {}) => ({
    smtp: { host: "127.0.0.1", port: 1, secure: false },
    to: ["t@x.y"],
    watch: { errors: false, quotaExhausted: false, quotaLow: false },
    ...over,
  })

  // waitFor polls until a state appears instead of sleeping a fixed
  // duration: fixed waits race a loaded machine (and CI) — a poll returns
  // as soon as the state is there and still passes when slow. A state
  // read that throws (a file not written yet) counts as not ready.
  const waitFor = async (ok, ms = 15000) => {
    const deadline = Date.now() + ms
    for (;;) {
      try {
        if (ok()) return true
      } catch {}
      if (Date.now() >= deadline) return false
      await Bun.sleep(50)
    }
  }

  test("the digest timer is armed once: later exchanges don't move its due time", async () => {
    const o = quiet({ report: { hours: 6 } })
    await onResponse(null, { options: o, success: true })
    const s1 = digestScheduleForTests()
    expect(s1.armed).toBe(true)
    await Bun.sleep(20)
    await onResponse(null, { options: o, success: true })
    expect(digestScheduleForTests().at).toBe(s1.at)
    // a changed schedule re-arms; turning the report off cancels
    await onResponse(null, { options: quiet({ report: { hours: 12 } }), success: true })
    const s3 = digestScheduleForTests()
    expect(s3.armed).toBe(true)
    expect(s3.at).not.toBe(s1.at)
    await onResponse(null, { options: quiet(), success: true })
    expect(digestScheduleForTests()).toEqual({ at: 0, armed: false, stepMs: 0 })
    resetDigestScheduleForTests()
  })

  test("the digest fires on its original schedule under continuous traffic", async () => {
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    writeFileSync(usage, "")
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    writeFileSync(state, JSON.stringify(raw))
    const o = {
      smtp: { host: "127.0.0.1", port, secure: true, insecure: true, from: "f@x.y" },
      to: ["t@x.y"],
      report: { hours: 300 / 3_600_000 }, // due 300 ms after the first exchange
      watch: { errors: false, quotaExhausted: false, quotaLow: false },
    }
    await onResponse(null, { options: o, success: true }) // baseline + arm
    writeFileSync(usage, JSON.stringify({ session: "eeeeeeee-5555", agent: "claude", provider: "p", model: "m", status: 200 }) + "\n")
    // exchanges keep coming; the digest must still fire on its original
    // schedule instead of sliding with the traffic (the old code re-armed
    // on each exchange and would not fire until the traffic stopped).
    // Poll for the mail rather than a fixed span: under load the old
    // fixed loop ran past the test timeout before the mail landed.
    const deadline = Date.now() + 15000
    while (got.body.length === 0 && Date.now() < deadline) {
      await onResponse(null, { options: o, success: true })
      await Bun.sleep(10)
    }
    expect(got.commands).toContain("DATA")
    expect(got.body.length).toBeGreaterThan(0)
    resetDigestScheduleForTests()
  }, 20000)

  test("onResponse with a preset-only smtp still runs the scan", async () => {
    // the other half of the preset fix: send reading the resolved secure
    // is covered, but the onResponse gate reading the resolved host was
    // not — putting the old guard back passed all tests. A preset-only
    // config has no smtp.host of its own, so the old guard turned the
    // exchange away before the scan ever ran. The scan here has no
    // failing rows and sends nothing (no network): it proves itself by
    // the state file's offset moving to the log's end.
    const rows = JSON.stringify({ provider: "p", status: 200 }) + "\n" + JSON.stringify({ provider: "p", status: 200 }) + "\n"
    writeFileSync(usage, rows)
    writeFileSync(state, JSON.stringify({ offset: 0 }))
    watch.forTests({ offset: 0, sent: {} })
    const o = {
      smtp: { preset: "qq", user: "u", pass: "p" },
      to: ["t@x.y"],
      watch: { errors: true, quotaExhausted: false, quotaLow: false },
    }
    await onResponse(null, { options: o, success: true })
    // the scan's 1.5 s pause is a floor, not a schedule: poll for the
    // state instead of sleeping past it (a fixed 1700 ms sleep left only
    // 200 ms of room and failed under load).
    expect(await waitFor(() => JSON.parse(readFileSync(state, "utf8")).offset === Buffer.byteLength(rows))).toBe(true)
    writeFileSync(usage, "")
    watch.forTests({ offset: 0 })
  }, 20000)

  test("the digest survives a plugin host restart: the due time lives on disk", async () => {
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    writeFileSync(usage, "")
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    delete raw.digestAt
    delete raw.digestHours
    writeFileSync(state, JSON.stringify(raw))
    const o = {
      smtp: { host: "127.0.0.1", port, secure: true, insecure: true, from: "f@x.y" },
      to: ["t@x.y"],
      report: { hours: 0.0005 }, // due 1.8 s after the first exchange
      watch: { errors: false, quotaExhausted: false, quotaLow: false },
    }
    await onResponse(null, { options: o, success: true }) // baseline + arm, due persisted
    // the due time the first exchange armed: every restart below must
    // keep it, not arm a fresh window. Waiting on the mail alone cannot
    // prove that — a fresh 1.8 s window fires inside the 15 s poll, so
    // the mail arrives whether or not the due time survived. The
    // assertions on `at` are what make this test fail when persistence
    // is gone (a fresh arm moves `at` to now + hours).
    const kept = digestScheduleForTests().at
    expect(kept).toBeGreaterThan(Date.now())
    writeFileSync(usage, JSON.stringify({ session: "hhhhhhhh-8888", agent: "claude", provider: "p", model: "m", status: 200 }) + "\n")
    // the host restarts every 400 ms: the old module's timer is dropped
    // (resetDigestScheduleForTests stands in for the process ending) and
    // the hooks are imported fresh. The old code started the window
    // again at now + hours on every restart and never fired; the due
    // time on disk is waited for instead.
    let mod = { onResponse, resetDigestScheduleForTests }
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(400)
      mod.resetDigestScheduleForTests()
      mod = await import(`./mail-watch.hooks.js?restart=${Date.now()}-${i}`)
      await mod.onResponse(null, { options: o, success: true })
      // still the first exchange's due time, not a fresh window
      expect(mod.digestScheduleForTests().at).toBe(kept)
    }
    // poll for the mail instead of sleeping a fixed span past the
    // original due time, so a loaded machine still passes.
    expect(await waitFor(() => got.body.length > 0)).toBe(true)
    expect(got.commands).toContain("DATA")
    // clean up: the fired digest re-armed the next window; drop it and
    // the persisted due time so later runs start clean.
    mod.resetDigestScheduleForTests()
    const cleaned = JSON.parse(readFileSync(state, "utf8"))
    delete cleaned.digestAt
    delete cleaned.digestHours
    writeFileSync(state, JSON.stringify(cleaned))
    writeFileSync(usage, "")
  }, 20000)

  test("an early wake re-arms for the rest instead of sending", async () => {
    // the still-ahead re-arm had no test of its own: a probe covered it,
    // but a probe is not a test — removing the re-arm passed the suite.
    // A test-only step cap forces early wakes on a long window: the
    // timer fires every 50 ms, finds the due time still ahead, and
    // re-arms instead of sending. A usage row is present, so a misfire
    // would mail and this test would see it.
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    writeFileSync(usage, "")
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    delete raw.digestAt
    delete raw.digestHours
    writeFileSync(state, JSON.stringify(raw))
    const o = {
      smtp: { host: "127.0.0.1", port, secure: true, insecure: true, from: "f@x.y" },
      to: ["t@x.y"],
      report: { hours: 1 },
      watch: { errors: false, quotaExhausted: false, quotaLow: false },
    }
    setDigestStepCapForTests(50)
    await onResponse(null, { options: o, success: true })
    const s = digestScheduleForTests()
    expect(s.armed).toBe(true)
    expect(s.stepMs).toBe(50) // the cap, not the 1 h window
    writeFileSync(usage, JSON.stringify({ session: "iiiiiiii-9999", agent: "claude", provider: "p", model: "m", status: 200 }) + "\n")
    try {
      // several early wakes pass; the due time never moves and no mail
      // goes out before it.
      await Bun.sleep(300)
      expect(digestScheduleForTests().at).toBe(s.at)
      expect(digestScheduleForTests().stepMs).toBe(50)
      expect(got.commands).not.toContain("DATA")
    } finally {
      // the cap is module-global: a failure above must not leak it into
      // the monthly test's step assertion.
      resetDigestScheduleForTests()
    }
    const cleaned = JSON.parse(readFileSync(state, "utf8"))
    delete cleaned.digestAt
    delete cleaned.digestHours
    writeFileSync(state, JSON.stringify(cleaned))
    writeFileSync(usage, "")
  })

  test("a monthly digest does not fire at once: the timer step is capped", async () => {
    const port = await startSecure()
    if (!port) return // no openssl on this machine
    writeFileSync(usage, "")
    const raw = JSON.parse(readFileSync(state, "utf8"))
    delete raw.digestOffset
    delete raw.digestAt
    delete raw.digestHours
    writeFileSync(state, JSON.stringify(raw))
    const o = {
      smtp: { host: "127.0.0.1", port, secure: true, insecure: true, from: "f@x.y" },
      to: ["t@x.y"],
      report: { hours: 720 }, // 2,592,000,000 ms: past setTimeout's 2^31-1 ms limit
      watch: { errors: false, quotaExhausted: false, quotaLow: false },
    }
    await onResponse(null, { options: o, success: true })
    const s = digestScheduleForTests()
    expect(s.armed).toBe(true)
    // the delay actually passed to setTimeout: capped, not the 2.59e9 ms
    // the old code passed (which Bun/Node clamp to 1 ms with a warning,
    // so the digest fired at once and re-armed another 1 ms timer).
    expect(s.stepMs).toBe(2 ** 31 - 1)
    // and nothing fires promptly: give it a chance to misfire, then check.
    await Bun.sleep(300)
    expect(got.commands).not.toContain("DATA")
    resetDigestScheduleForTests()
    const cleaned = JSON.parse(readFileSync(state, "utf8"))
    delete cleaned.digestAt
    delete cleaned.digestHours
    writeFileSync(state, JSON.stringify(cleaned))
    writeFileSync(usage, "")
  })
})

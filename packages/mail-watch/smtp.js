// A small SMTP client over Bun.connect, with nothing to import from npm:
// the registry's packages ship no dependencies, and a hooks file runs where
// Bun's own socket API is the dependable one.
//
// One mail per run: connect, EHLO, AUTH PLAIN when a user was given, MAIL
// FROM, RCPT TO each recipient, one DATA, QUIT. Every reply is checked
// against the code its command expects, so a refused auth fails the send
// rather than stumble on. send resolves once the server has accepted the
// mail for its queue; failures reject with the server's last word.
//
// Two transports:
//   secure: true  — TLS from the first byte (implicit TLS, port 465): the
//     usual mailhost submission port. Verified by default; cfg.insecure
//     turns that off for a mailhost with a self-signed certificate the
//     user knows. An IP host goes without a server name (TLS wants a
//     name; an IP is the certificate's own).
//   secure: false — a plain relay on the user's own network (a localhost
//     or LAN mailhost that wants no sign-in). A user/password on a plain
//     wire is refused: AUTH PLAIN is the password in base64, and the
//     STARTTLS upgrade Bun offers dies mid-session on some platforms
//     (handshake completes, close_notify follows unprompted), so rather
//     than a send that breaks at random, credentials are not sent at all.
//     A plain relay without credentials works as it is.

import net from "node:net"

// PRESETS are the mailhosts people actually forward mail through, so the
// options can just name one: host, port and TLS come from the preset and
// the user adds their address and an app password (QQ/163/126 call it
// 授权码, Gmail an app password). All of these speak TLS from the first
// byte on 465 — the transport this client speaks.
export const PRESETS = {
  qq: { host: "smtp.qq.com", port: 465, secure: true },
  "163": { host: "smtp.163.com", port: 465, secure: true },
  "126": { host: "smtp.126.com", port: 465, secure: true },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
  zoho: { host: "smtp.zoho.com", port: 465, secure: true },
  yahoo: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
}

// resolveSmtp applies a preset under the explicit options: a host given by
// hand wins, an unset secure/port takes the preset's, an unknown preset is
// ignored (and a missing host then fails as before). secure defaults to
// TLS: a mailhost that wants no TLS must say so explicitly
// ("secure": false) — the safe direction for credentials, and the port
// follows (465 with TLS, 587 without).
export function resolveSmtp(cfg) {
  const preset = PRESETS[String(cfg.preset ?? "").toLowerCase()]
  const host = cfg.host ?? preset?.host
  const secure = cfg.secure ?? preset?.secure ?? true
  const port = Number(cfg.port) || preset?.port || (secure ? 465 : 587)
  return { host: host === undefined ? undefined : String(host), port, secure }
}

// send is one mail. host, port, user, pass and from come from the options;
// to is an array of addresses; body is the RFC 5322 text template.message
// made.
export async function send(cfg, to, body, { timeoutMs = 30000 } = {}) {
  const { host, port, secure } = resolveSmtp(cfg)
  if (!host) throw new Error(`smtp.host is required (or set smtp.preset to one of: ${Object.keys(PRESETS).join(", ")})`)
  const verify = cfg.insecure !== true
  const name = net.isIP(host) ? undefined : host
  // The connection as one object: connect makes it, and every reader below
  // reads through it. next() arms a waiter the data/error handlers fire;
  // one waiter at a time — the dialog is strictly command, reply.
  const link = { sock: null, waiter: null, openRes: null, openRej: null, pending: "" }
  // opened finishes when open() fires — or rejects at once when the socket
  // errors or closes before the handshake (a TLS attempt against a plain
  // port, a server that resets on connect), so the send fails now instead
  // of stalling to the connect timeout.
  const opened = new Promise((res, rej) => { link.openRes = res; link.openRej = rej })
  const handlers = {
    // open never answers a command; it only finishes the connect wait
    open() {
      link.openRes?.()
      link.openRes = null
    },
    data(_s, d) {
      const chunk = d.toString("utf8")
      // Bytes can land before a waiter is armed — a greeting that races the
      // client's own continuation (Bun can deliver it in the same tick that
      // fires open), or anything else between two commands. They wait in
      // pending; the next next() picks them up. Dropped, the send would
      // stall to its timeout.
      if (!link.waiter) {
        link.pending += chunk
        return
      }
      link.waiter.buf += chunk
      // a reply ends at a complete final line: "NNN<space>text\r\n", or a
      // bare "NNN\r\n" (RFC 5321 allows the parameterless form). A chunk
      // that stops mid-line is not one — more bytes are coming.
      if (endsReply(link.waiter.buf)) {
        const q = link.waiter
        link.waiter = null
        q.res(q.buf.trim())
      } else if (link.waiter.buf.length > 65536) {
        const q = link.waiter
        link.waiter = null
        q.rej(new Error("smtp reply too long"))
      }
    },
    error(_s, e) {
      link.openRej?.(e)
      link.openRej = null
      const q = link.waiter
      link.waiter = null
      if (q) q.rej(e)
    },
    end() {
      link.openRej?.(new Error("smtp server closed the connection"))
      link.openRej = null
      const q = link.waiter
      link.waiter = null
      if (q) q.rej(new Error("smtp server closed the connection"))
    },
    close() {
      link.openRej?.(new Error("smtp server closed the connection"))
      link.openRej = null
      const q = link.waiter
      link.waiter = null
      if (q) q.rej(new Error("smtp server closed the connection"))
    },
    timeout() {
      const q = link.waiter
      link.waiter = null
      if (q) q.rej(new Error("smtp reply timed out"))
    },
  }
  try {
    link.sock = await Bun.connect({
      hostname: host,
      port,
      // the RESOLVED secure: send used to read cfg.secure here, so a
      // preset-only config (secure true from the preset, unset in cfg)
      // connected in plain text to a TLS port and timed out — the
      // preset never worked, though resolving it did.
      tls: secure ? { rejectUnauthorized: verify, serverName: name } : undefined,
      socket: handlers,
    })
    await withTimeout(opened, timeoutMs, "connect")
    const greet = await next(link, timeoutMs)
    if (!greet.startsWith("220")) throw new Error(greet)
    const ehlo = await speak(link, "EHLO magpie", timeoutMs)
    if (!ehlo.startsWith("250")) throw new Error(ehlo)
    if (!secure && cfg.user) {
      throw new Error("a plain connection sends the password in cleartext; set \"secure\": true (TLS, port 465) or drop the user to use an open relay")
    }
    if (cfg.user) {
      const tok = Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ""}`, "utf8").toString("base64")
      const auth = await speak(link, `AUTH PLAIN ${tok}`, timeoutMs)
      if (!auth.startsWith("235")) throw new Error(auth)
    }
    // MAIL FROM: the explicit from, else the sign-in, else postmaster —
    // a null sender reads as a bounce to many relays
    const mail = await speak(link, `MAIL FROM:<${bare(cfg.from ?? cfg.user ?? "postmaster@localhost")}>`, timeoutMs)
    if (!mail.startsWith("250")) throw new Error(mail)
    for (const r of to) {
      const rep = await speak(link, `RCPT TO:<${bare(r)}>`, timeoutMs)
      if (!rep.startsWith("25")) throw new Error(rep)
    }
    const data = await speak(link, "DATA", timeoutMs)
    if (!data.startsWith("354")) throw new Error(data)
    write(link, body)
    write(link, "\r\n.\r\n")
    const done = await next(link, timeoutMs)
    if (!done.startsWith("250")) throw new Error(done)
    // QUIT's 221 (or the server hanging up) is waited for, so every byte
    // the mail needs is known to have left before the socket is ended
    write(link, "QUIT\r\n")
    await next(link, timeoutMs).catch(() => {})
    return done
  } finally {
    try { link.sock?.end() } catch {}
  }
}

// next is the next full reply. Replies that landed while no waiter was
// armed sit in pending: a complete one answers at once, a partial one
// becomes the waiter's starting bytes. data and error handlers fire the
// rest in.
function next(link, timeoutMs) {
  if (endsReply(link.pending)) {
    const out = link.pending.trim()
    link.pending = ""
    return Promise.resolve(out)
  }
  const p = new Promise((res, rej) => {
    link.waiter = { res, rej, buf: link.pending }
    link.pending = ""
  })
  const t = setTimeout(() => {
    const q = link.waiter
    link.waiter = null
    if (q) q.rej(new Error("smtp reply timed out"))
  }, timeoutMs)
  return p.finally(() => clearTimeout(t))
}

// speak arms the reply's waiter first, then writes, so a fast answer can't
// pass between the write and the reader.
function speak(link, cmd, timeoutMs) {
  const r = next(link, timeoutMs)
  write(link, cmd + "\r\n")
  return r
}

function write(link, data) {
  link.sock.write(data)
}

function withTimeout(promise, timeoutMs, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`smtp ${what} timed out`)), timeoutMs)),
  ])
}

// endsReply is whether buf holds a complete reply: continuation lines
// "NNN-text\r\n" zero or more, then one final line "NNN text\r\n" or
// "NNN\r\n", the \r\n included — a chunk cut mid-line keeps waiting.
function endsReply(buf) {
  if (!buf.endsWith("\r\n")) return false
  const lines = buf.split("\r\n")
  const last = lines[lines.length - 2]
  return /^\d{3}( |$)/.test(last)
}

function bare(a) {
  const m = /<([^>]*)>/.exec(String(a ?? ""))
  return m ? m[1] : String(a ?? "").trim()
}

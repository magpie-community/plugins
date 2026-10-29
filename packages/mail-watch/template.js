// Template rendering and the MIME message, with nothing to import.
//
// fill replaces {{name}} with vars[name]: a missing name becomes "", a
// value that isn't a string is JSON. Unknown braces are left as they are,
// so a template that means to show an example still does.

export function fill(text, vars) {
  return String(text ?? "").replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, k) => {
    const v = vars[k]
    if (v === undefined || v === null) return ""
    return typeof v === "string" ? v : JSON.stringify(v)
  })
}

// escape is text into HTML: a mail body the user's template wrote must not
// turn an error's words into markup or a link.
export function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// DEFAULT_HTML is the layout a mail goes out in when the user's html
// option is unset: a card with a kind badge, the facts as a table, and the
// error's words in a pre block. Everything inline-styled — mail clients
// strip <style> and class more often than they keep them.
export const DEFAULT_HTML = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="padding:16px 24px;background:#1f2937;color:#ffffff;">
      <span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;background:#dc2626;color:#fff;">{{kind}}</span>
      <span style="margin-left:8px;font-size:14px;color:#d1d5db;">magpie mail-watch</span>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#111827;">
        <tr><td style="padding:6px 0;color:#6b7280;width:96px;">Provider</td><td style="padding:6px 0;">{{provider}}{{account}}</td></tr>
        {{modelRow}}
        {{windowRow}}
        <tr><td style="padding:6px 0;color:#6b7280;">When</td><td style="padding:6px 0;">{{time}}</td></tr>
      </table>
      <div style="margin-top:16px;padding:12px 16px;background:#f9fafb;border-left:3px solid #dc2626;border-radius:0 4px 4px 0;font-size:13px;color:#374151;white-space:pre-wrap;word-break:break-word;">{{detail}}</div>
    </div>
    <div style="padding:12px 24px;background:#f9fafb;color:#9ca3af;font-size:12px;">sent by magpie mail-watch from your own gateway</div>
  </div>
</body></html>`

// renderHtml is the mail's HTML body: the user's own layout (filled with
// the same vars) when they set one, the default card otherwise. Every var
// interpolated into HTML is escaped first — an error's words are text, not
// markup, whoever wrote the layout. The rows the default needs — model,
// window — are built here so an empty model or a non-quota event leaves no
// skeleton behind.
export function renderHtml(templateHtml, vars) {
  const safe = {}
  for (const [k, v] of Object.entries(vars)) safe[k] = typeof v === "string" ? escape(v) : v
  return fill(templateHtml || DEFAULT_HTML, {
    ...safe,
    modelRow: vars.model
      ? `<tr><td style="padding:6px 0;color:#6b7280;">Model</td><td style="padding:6px 0;">${escape(vars.model)}${vars.agent ? ` <span style="color:#9ca3af;">· ${escape(vars.agent)}</span>` : ""}</td></tr>`
      : "",
    windowRow: vars.window
      ? `<tr><td style="padding:6px 0;color:#6b7280;">Window</td><td style="padding:6px 0;">${escape(String(vars.window).replace(/^ · /, ""))} — ${escape(String(vars.used))}% used${vars.resetsAt ? `, resets ${escape(String(vars.resetsAt))}` : ""}</td></tr>`
      : "",
  })
}

// message builds one RFC 5322 mail as a string. With an html part it is
// multipart/alternative — the plain text first (a client that shows text
// takes it), the HTML layout after; without, the single text part as
// before. Headers are RFC 2047 encoded words; bodies go out base64.
export function message({ from, to, subject, body, html, now = new Date() }) {
  const id = `<${now.getTime()}.${Math.random().toString(36).slice(2)}@magpie-mail-watch>`
  const date = now.toUTCString().replace("GMT", "+0000")
  const head = [
    `From: ${addr(from)}`,
    `To: ${to.map(addr).join(", ")}`,
    `Subject: ${word(subject ?? "")}`,
    `Date: ${date}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
  ]
  if (html === undefined || html === false) {
    return head.concat([
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
    ]).join("\r\n") + "\r\n" + b64(body ?? "") + "\r\n"
  }
  const boundary = "magpie-" + now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  return head.concat([
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(body ?? ""),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(html),
    `--${boundary}--`,
    "",
  ]).join("\r\n") + "\r\n"
}

function b64(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")
}

// addr is one address as the header wants it: bare as given, or the
// display name kept as quoted-text when ASCII with specials (a comma, a
// colon) and RFC 2047 encoded when it holds anything outside ASCII —
// "喵喵 <me@example.com>" and "Acme, Inc." <a@b.c> both survive.
// CR/LF is stripped first: an option is trusted, a header is a protocol.
function addr(a) {
  const s = String(a ?? "").replace(/[\r\n]+/g, " ").trim()
  if (!s) return "<postmaster@localhost>"
  const m = /^(.*)<([^>]*)>\s*$/.exec(s)
  if (!m) return s
  const name = m[1].trim()
  const box = m[2].trim()
  if (!name) return `<${box}>`
  if (/[^\x20-\x7e]/.test(name)) return `${word(name)} <${box}>`
  const quoted = name.replace(/^"|"$/g, "")
  // a name with specials (a comma, a colon) must stay quoted-text —
  // "Acme, Inc." <a@b.c> parsed bare would read as two addresses
  const shown = /[,;:()]/.test(quoted) ? `"${quoted}"` : quoted
  return `${shown} <${box}>`
}

// word is a header value as RFC 2047 encoded-words when it has anything
// outside ASCII, separated by a space-fold so a decoder joins them. Each
// encoded-word must decode on its own: the text is chunked by whole
// codepoints BEFORE encoding — at most 45 UTF-8 bytes a chunk, 60 base64
// characters, an encoded word of 72 — so no codepoint is split across
// words and every chunk's base64 is a valid, self-contained unit. (Slicing
// the base64 itself would cut quads mid-way: 63 is not a multiple of 4,
// and each word would decode to shifted garbage.) CR/LF never survives.
function word(s) {
  const v = String(s ?? "").replace(/[\r\n]+/g, " ")
  if (!/[^\x20-\x7e]/.test(v)) return v
  const parts = []
  let cur = ""
  for (const ch of v) {
    if (cur && Buffer.byteLength(cur + ch, "utf8") > 45) {
      parts.push(Buffer.from(cur, "utf8").toString("base64"))
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(Buffer.from(cur, "utf8").toString("base64"))
  return parts.map((p) => "=?UTF-8?B?" + p + "?=").join("\r\n ")
}

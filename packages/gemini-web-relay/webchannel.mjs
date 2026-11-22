// The Gemini web app's new protocol: processSession on
// geminiweb-pa.clients6.google.com, a WebChannel (the app's own transport).
// Everything runs INSIDE the page as XHR, so Google sees the browser's own
// cookies, TLS and session context — the part a bare Node client cannot
// fake (measured 2026-11-22: the same wire from Node serves the visitor
// tier no matter which headers are sent; from the page it serves the
// account's tier).
//
// Wire shape (from the Go reference + captures):
//   handshake  POST ?VER=8&RID=n&CVER=22&X-HTTP-Session-Id=gsessionid&$httpHeaders=..&zx=..&t=1  body count=0
//              gsid from the X-HTTP-Session-Id response header, SID from the ["c",token] frame
//   downstream GET  ?gsessionid=..&SID=..&VER=8&RID=rpc&AID=n&CI=0&TYPE=xmlhttp&zx=..&t=1
//              this network does not stream it; each GET returns the frames
//              buffered so far and closes, so the collector polls with a
//              growing AID
//   uplinks    POST ?VER=8&gsessionid=..&SID=..&RID=n&AID=n&zx=..&t=1
//              body count=1&ofs=N&req0___data__=<urlencode(json)>
//   ofs0 = [[meta,0,null,null,null,null,null,[null,null,null,null,[inner,null,null,1]]]]
//   ofs1 = [null,[1,null,null,null,null,null,null,null,[prompt]]]
//   ofs2 = [null,null,null,[1]]                      (close, after done)
// The reply text sits at inner[4][0][1][0] of the response frames and the
// served model name at inner[42] — the same spots the old protocol uses.
//
// Every relayed ask stays a temporary chat (inner[45] = 1): nothing is kept
// in the account's history.

export const WC_ENDPOINT = "https://geminiweb-pa.clients6.google.com/v1/processSession"

// modelHeaderBin builds the x-goog-ext-525001261-bin value: a protobuf
// (08 01 = field 1 varint 1) + the model hex as field 5 + the tier byte as
// field 15, base64'd.
function modelHeaderBin(hex, mode) {
  const bytes = [0x08, 0x01]
  if (hex) {
    bytes.push(0x2a, hex.length)
    for (const c of hex) bytes.push(c.charCodeAt(0))
  }
  if (mode > 0) bytes.push(0x78, mode)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// The page function. Built as a plain string (not a template literal): it is
// spliced into Runtime.evaluate, and its own string literals must survive.
const PAGE_WC = `(async (hex, mode, prompt) => {
  const Q = String.fromCharCode(34)
  const NL = String.fromCharCode(13, 10)
  const out = { log: [], served: [], reply: "", reasoning: "" }
  const html = document.documentElement.innerHTML
  const kidx = html.indexOf("d2zJAe")
  const apiKey = kidx >= 0 ? (html.slice(kidx).match(/AIza[0-9A-Za-z_-]{35}/) || [""])[0] : ""
  if (!apiKey) { out.err = "page: no api key"; return out }
  function mh(hx, md) {
    const b = [8, 1]
    if (hx) { b.push(42, hx.length); for (const c of hx) b.push(c.charCodeAt(0)) }
    if (md > 0) b.push(120, md)
    let s = ""; b.forEach(x => s += String.fromCharCode(x)); return btoa(s)
  }
  const hh = encodeURIComponent("X-Goog-Api-Key:" + apiKey + NL + "x-goog-ext-525001261-bin:" + mh(hex, mode) + NL + "X-WebChannel-Content-Type:application/json+protobuf" + NL)
  const zx = () => [...Array(12)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")
  const EP = "https://geminiweb-pa.clients6.google.com/v1/processSession"
  function xhr(method, url, body) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open(method, url, true)
      x.withCredentials = true
      if (body) x.setRequestHeader("content-type", "application/x-www-form-urlencoded")
      x.onload = () => resolve({ status: x.status, text: x.responseText, gsid: x.getResponseHeader("X-HTTP-Session-Id") || "" })
      x.onerror = () => reject(new Error("xhr network error " + x.status))
      x.send(body || null)
    })
  }
  function readFrames(text, fn) {
    // the body is a stream of JSON values: a number, then an array of
    // [id, payload] pairs
    let pos = 0, state = 0
    const dec = (s) => { try { return JSON.parse(s) } catch { return undefined } }
    while (pos < text.length) {
      while (pos < text.length && /\\s/.test(text[pos])) pos++
      if (pos >= text.length) break
      const start = pos
      let depth = 0, inStr = false, esc = false, hit = false
      for (; pos < text.length; pos++) {
        const c = text[pos]
        if (inStr) { if (esc) esc = false; else if (c === "\\\\\\\\") esc = true; else if (c === Q) inStr = false; continue }
        if (c === Q) { inStr = true; continue }
        if (c === "[" || c === "{") depth++
        else if (c === "]" || c === "}") { depth--; if (depth === 0) { pos++; hit = true; break } }
        else if (depth === 0 && /[0-9-]/.test(c)) {
          let j = pos
          while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++
          pos = j; hit = true; break
        }
      }
      if (!hit) break
      const v = dec(text.slice(start, pos).trim())
      if (v === undefined) break
      if (state === 0 && typeof v === "number") { state = 1; continue }
      if (state === 1 && Array.isArray(v)) {
        for (const it of v) { if (Array.isArray(it) && it.length >= 2) fn(it[0], it[1]) }
        state = 0
      }
    }
  }
  const CLOSE = "[" + Q + "close" + Q + "]"
  const ENDM = "[null,null,null,[]]"
  const ACKM = "[[]]"
  function classify(payload) {
    const s = typeof payload === "string" ? payload.trim() : JSON.stringify(payload)
    if (s === CLOSE || s === ENDM) return { end: true }
    if (s === ACKM) return { ack: true }
    if (s.charAt(0) === "{") return { err: s.slice(0, 300) }
    let msgs; try { msgs = typeof payload === "string" ? JSON.parse(payload) : payload } catch { return {} }
    if (!Array.isArray(msgs) || msgs.length === 0) return {}
    const m0 = typeof msgs[0] === "string" ? msgs[0].trim() : JSON.stringify(msgs[0])
    if (m0 === ENDM) return { end: true }
    if (m0 === ACKM) return { ack: true }
    let top; try { top = typeof msgs[0] === "string" ? JSON.parse(msgs[0]) : msgs[0] } catch { return {} }
    if (!Array.isArray(top) || top.length < 2) return {}
    let body; try { body = typeof top[1] === "string" ? JSON.parse(top[1]) : top[1] } catch { return {} }
    if (!Array.isArray(body) || body.length < 7) return {}
    let cands; try { cands = typeof body[6] === "string" ? JSON.parse(body[6]) : body[6] } catch { return {} }
    if (!Array.isArray(cands) || !cands.length || !Array.isArray(cands[0]) || cands[0].length < 4) return {}
    const done = String(cands[0][0]).trim() === "1"
    let wrap; try { wrap = typeof cands[0][3] === "string" ? JSON.parse(cands[0][3]) : cands[0][3] } catch { return { done } }
    if (!Array.isArray(wrap) || wrap.length < 4) return { done }
    const inr = typeof wrap[3] === "string" ? wrap[3].trim() : JSON.stringify(wrap[3])
    if (!inr || inr === "null") return { done }
    try { return { done, inner: JSON.parse(inr) } } catch { return { done } }
  }
  // ---- handshake ----
  let h0
  try {
    h0 = await xhr("POST", EP + "?VER=8&RID=" + (10000 + Math.floor(Math.random() * 80000)) + "&CVER=22&X-HTTP-Session-Id=gsessionid&$httpHeaders=" + hh + "&zx=" + zx() + "&t=1", "count=0")
  } catch (e) { out.err = "handshake: " + String(e && e.message || e); return out }
  const gsid = h0.gsid
  let sid = ""
  try {
    const ci = h0.text.indexOf(Q + "c" + Q)
    if (ci >= 0) { const q1 = h0.text.indexOf(Q, ci + 3); const q2 = h0.text.indexOf(Q, q1 + 1); sid = h0.text.slice(q1 + 1, q2) }
  } catch {}
  if (!sid || !gsid) { out.err = "handshake incomplete (status " + h0.status + ")"; return out }
  const sess = "gsessionid=" + encodeURIComponent(gsid) + "&SID=" + encodeURIComponent(sid)
  // ---- downstream collector: polls with a growing AID until done ----
  let done = false, ack = false, lastAid = 0, errFrame = ""
  const served = new Set(); let reply = ""; let reasoning = ""
  let collecting = true
  ;(async () => {
    for (let i = 0; i < 300 && collecting; i++) {
      let r
      try { r = await xhr("GET", EP + "?" + sess + "&VER=8&RID=rpc&AID=" + lastAid + "&CI=0&TYPE=xmlhttp&zx=" + zx() + "&t=1", null) }
      catch (e) { await new Promise(r2 => setTimeout(r2, 800)); continue }
      if (r.text && r.text.length) {
        readFrames(r.text, (id, payload) => {
          if (typeof id === "number" && id > lastAid) lastAid = id
          const ev = classify(payload)
          if (ev.err) { errFrame = ev.err; done = true }
          if (ev.end) done = true
          if (ev.ack) ack = true
          if (ev.inner) {
            const b = ev.inner
            if (typeof b[42] === "string" && b[42]) served.add(b[42])
            const c = b[4] && b[4][0]
            if (Array.isArray(c)) {
              if (c[1] && typeof c[1][0] === "string" && c[1][0].length > reply.length) reply = c[1][0]
              const th = c[37] && c[37][0] && c[37][0][0]
              if (typeof th === "string" && th.length > reasoning.length) reasoning = th
            }
          }
        })
      }
      if (done) break
      await new Promise(r2 => setTimeout(r2, 350))
    }
    collecting = false
  })()
  // ---- inner request (99 slots, temporary chat) ----
  const inner = new Array(99).fill(null)
  inner[0] = ["", 0, null, null, null, null, 0]
  inner[1] = ["en"]; inner[2] = ["", "", "", null, null, null, null, null, null, ""]
  inner[6] = [0]; inner[7] = 1; inner[10] = 1; inner[11] = 0
  inner[17] = [[0]]; inner[18] = 0; inner[27] = 1; inner[30] = [4]
  inner[41] = [1]
  inner[45] = 1 // temporary chat, always
  inner[53] = 0
  inner[59] = Math.random().toString(36).slice(2, 14) + Date.now().toString(36)
  inner[61] = []; inner[68] = 1; inner[79] = 1; inner[80] = 1
  const meta = [1, hex, "en", "u" + Math.random().toString(36).slice(2) + Date.now().toString(36)]
  let rid = 10001 + Math.floor(Math.random() * 80000)
  async function post(ofs, data) {
    const u = EP + "?VER=8&" + sess + "&RID=" + rid + "&AID=" + lastAid + "&zx=" + zx() + "&t=1"
    rid++
    return xhr("POST", u, "count=1&ofs=" + ofs + "&req0___data__=" + encodeURIComponent(JSON.stringify(data)))
  }
  // ---- ofs0 (setup), wait for ack, ofs1 (the prompt) ----
  let p0
  try { p0 = await post(0, [[meta, 0, null, null, null, null, null, [null, null, null, null, [inner, null, null, 1]]]]) }
  catch (e) { out.err = "ofs0: " + String(e && e.message || e); collecting = false; return out }
  if (p0.status !== 200) { out.err = "ofs0 status " + p0.status; collecting = false; return out }
  const t0 = Date.now()
  while (!ack && !done && Date.now() - t0 < 12000) await new Promise(r => setTimeout(r, 300))
  let p1
  try { p1 = await post(1, [null, [1, null, null, null, null, null, null, null, [prompt]]]) }
  catch (e) { out.err = "ofs1: " + String(e && e.message || e); collecting = false; return out }
  if (p1.status !== 200) { out.err = "ofs1 status " + p1.status; collecting = false; return out }
  // ---- wait for the end frame ----
  const t1 = Date.now()
  while (!done && Date.now() - t1 < 120000) await new Promise(r => setTimeout(r, 400))
  try { await post(2, [null, null, null, [1]]) } catch {}
  out.ack = ack
  out.served = [...served]
  out.reply = reply
  out.reasoning = reasoning
  out.ms = Date.now() - t1
  if (errFrame) out.errFrame = errFrame
  if (!done && !reply) out.err = "no end frame within 120s"
  return out
})`

export function pageWebChannelEval(hex, b14, b15, prompt) {
  return `(async function(){ const f = ${PAGE_WC}; return await f(${JSON.stringify(hex || "56fdd199312815e2")}, ${b14 ?? 1}, ${JSON.stringify(prompt)}) })()`
}

// what a tier byte is expected to serve (2026-11-22 measurements): 1 the
// free tier's 4 Hydrogen, 3 the pro tier's 4 Neon/Carbon. auto (hex "") is
// exempt from the check.
const EXPECTED_SERVED = {
  1: ["4 Hydrogen"],
  3: ["4 Neon", "4 Carbon"],
}

export function servedMismatch(served, model) {
  if (!served?.length || !model.hex) return null // auto: anything goes
  const ok = EXPECTED_SERVED[model.b14 ?? 1] ?? []
  if (ok.some((name) => served.some((s) => s.includes(name)))) return null
  return `请求的是 ${model.name}，但 Gemini 实际服务的是 ${served.join("、") || "未知模型"}（路由被降级）。`
}

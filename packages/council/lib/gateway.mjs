// Where magpie's gateway is and how to ask it. magpie tells its plugin host the
// gateway's address as MAGPIE_ADDR (the port in Settings, or the variable magpie
// runs under), and loopback needs no key.

export const UA = "council/1.0"

export function base(o = {}) {
  if (o.gateway) return String(o.gateway).replace(/\/+$/, "")
  const a = process.env.MAGPIE_ADDR || "127.0.0.1:3425"
  return /^https?:\/\//i.test(a) ? a.replace(/\/+$/, "") : `http://${a}`
}

export function headers(o = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": UA,
    "anthropic-version": "2023-06-01",
  }
  if (o.key) h.authorization = `Bearer ${o.key}`
  return h
}

export async function getJSON(o, path, ms = 8000) {
  const r = await fetch(base(o) + path, { headers: headers(o), signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

// A POST that never throws on an HTTP error: the caller reads status and body.
export async function postJSON(o, path, body, signal) {
  const r = await fetch(base(o) + path, { method: "POST", headers: headers(o), body: JSON.stringify(body), signal })
  const text = await r.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // an MCP server may answer as SSE: the last data line is the message
    const data = text.split("\n").filter((l) => l.startsWith("data:")).pop()
    try {
      json = data ? JSON.parse(data.slice(5)) : null
    } catch {}
  }
  return { status: r.status, ok: r.ok, json, text }
}

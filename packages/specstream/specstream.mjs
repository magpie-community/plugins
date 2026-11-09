// The two SpecStream calls. A reply is {data: {...}}, or {error: {code, message}} when the call stops.
const BASE = "https://api.specstream.ai"

// Only the key the caller gives: the tools pass SPECSTREAM_API_KEY, the search entry the key magpie keeps.
export const keyOf = (key) => {
  const k = typeof key === "string" ? key.trim() : ""
  if (!k) throw new Error("SpecStream needs an API key")
  return k
}

// Reads a reply: its `data`, or an error carrying error.message and the HTTP status.
export async function unwrap(r) {
  let body = null
  try {
    body = await r.json()
  } catch {}
  if (!r.ok || !body || body.data == null) {
    const message = body?.error?.message || `SpecStream answered ${r.status}`
    throw Object.assign(new Error(message), { status: r.status, code: body?.error?.code })
  }
  return body.data
}

export async function search({ query, count, key, signal }) {
  const params = new URLSearchParams({ q: String(query).slice(0, 2000) })
  // num, 1 to 100: how many sources come back (https://specstream.ai/agents.md, "num and page")
  const n = Math.trunc(Number(count))
  if (n >= 1) params.set("num", String(Math.min(100, n)))
  const r = await fetch(`${BASE}/v1/web-search?${params}`, {
    headers: { authorization: `Bearer ${keyOf(key)}` },
    signal,
  })
  return unwrap(r)
}

export async function extract({ urls, format = "markdown", key, signal }) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20) throw new Error("urls is a list of 1 to 20 addresses")
  const r = await fetch(`${BASE}/v1/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyOf(key)}`, "content-type": "application/json" },
    body: JSON.stringify({ urls, format: format === "text" ? "text" : "markdown" }),
    signal,
  })
  return unwrap(r)
}

// The two SpecStream calls. Both replies are wrapped: {request_id, status, data, error}.
const BASE = "https://api.specstream.ai"

export const keyOf = (key) => {
  const k = (key || process.env.SPECSTREAM_API_KEY || "").trim()
  if (!k) throw Object.assign(new Error("SpecStream needs an API key: set SPECSTREAM_API_KEY"), { status: 401 })
  return k
}

// Reads a reply: the wrapped `data`, or an error carrying error.message and the HTTP status.
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
  if (count) params.set("num", String(Math.min(100, Math.max(1, Math.trunc(count)))))
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

// The page in magpie's window is sandboxed (connect-src 'none'): it cannot
// fetch, so it cannot even check whether the service is up. The one thing it
// may do is navigate itself, so it goes straight to the plugin's service,
// carrying the window's theme and language.
(async () => {
  let port = 3492, dark = null, lang = "", service = ""
  try {
    const t = await window.magpie?.ready
    if (t && typeof t.dark === "boolean") dark = t.dark
    if (t && t.lang) lang = String(t.lang)
  } catch {}
  try {
    const s = window.magpie?.service
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s
  } catch {}
  try {
    const o = await window.magpie?.options?.get?.()
    if (o && Number(o.port) > 0) port = Number(o.port)
  } catch {}
  const q = new URLSearchParams()
  if (dark !== null) q.set("theme", dark ? "dark" : "light")
  if (lang) q.set("lang", lang)
  q.set("embed", "1")
  const base = service ? service.replace(/\/?$/, "/") : `http://127.0.0.1:${port}/`
  location.replace(base + "?" + q.toString())
})()

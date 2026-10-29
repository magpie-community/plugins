// The way in: this page's only job is to navigate its frame to the
// plugin host's own localhost service (page-service.mjs), the way
// page-chat's boot.js does it.
//
// It must jump directly, never probe first: the page's CSP is
// connect-src 'none', so no network probe of any kind is possible —
// even a no-cors probe is rejected, and a probe could never tell
// whether the service is up. The only network action a page like this
// has is navigating elsewhere.
//
// The port comes from the plugin's options (pagePort), falling back to
// the service's default (page-service.mjs's DEFAULT_PAGE_PORT — a
// static file cannot import it, so the number is repeated here and the
// two must match). A second host on the same machine fails to bind and
// leaves its page pointing at the first host's service, which serves
// the same store — the same behaviour page-chat relies on.
//
// The language rides along as a query: the served page is no longer
// inside magpie, so it cannot ask magpie.ready for it. The service
// hands it to the UI as LayerfsTheme; the theme itself stays with the
// system media query, which the served page's CSS already follows.
(async () => {
  const DEFAULT_PORT = 43717
  let port = DEFAULT_PORT
  let lang = ""

  try {
    const t = await window.magpie?.ready
    if (t && typeof t.lang === "string") lang = t.lang
  } catch { /* no bridge: the service falls back to English */ }

  try {
    const o = await window.magpie?.options?.get?.()
    const n = Number(o?.pagePort)
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n
  } catch { /* no options: the default port */ }

  const q = new URLSearchParams()
  if (lang) q.set("lang", lang)
  const qs = q.toString()
  location.replace(`http://127.0.0.1:${port}/${qs ? `?${qs}` : ""}`)
})()

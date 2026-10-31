// Magpie settings pages cannot fetch (connect-src 'none'). Navigate to this
// loopback confirmation page; only a user click tests the saved options.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { testConnection, textsFor } from "./probe.mjs"

const DEFAULT_PORT = 3481
const TOKEN_HEADER = "x-aelios-token"
let running
let pluginOptions = {}
let token

function page(lang) {
  const t = textsFor(lang)
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh" : "en"}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="aelios-token" content="${token}">
<title>Aelios</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; padding: 28px; } h1 { font-size: 18px; } p { font-size: 14px; line-height: 1.6; }
button { font: inherit; padding: 6px 12px; margin-right: 8px; }
</style>
<h1>Aelios</h1><p>${t.confirm}</p><p>${t.scope}</p>
<button id="run" type="button">${t.run}</button><button id="back" type="button">${t.back}</button>
<p id="state" role="status" aria-live="polite"></p>
<script>
(() => {
  const t = ${JSON.stringify(t)};
  const state = document.getElementById("state");
  const run = document.getElementById("run");
  document.getElementById("back").addEventListener("click", () => history.back());
  run.addEventListener("click", async () => {
    run.disabled = true;
    state.textContent = t.testing;
    try {
      // Resolved against this page, not the origin root: Magpie serves a
      // browser's page through its own /_magpie/service/ prefix.
      const response = await fetch(new URL("api/test", location.href), { method: "POST", headers: { "${TOKEN_HEADER}": document.querySelector('meta[name="aelios-token"]').content } });
      const result = await response.json();
      state.textContent = (result.ok ? t[result.code] : t.failed + " · " + (t[result.code] || t.invalid)) + " · " + t.checked + ": " + result.checkedIdentities + " · " + result.ms + " ms";
    } catch { state.textContent = t.noService; }
    finally { run.disabled = false; }
  });
})();
</script></html>`
}
function hostOK(req, port = running?.port) {
  const host = String(req.headers.get("host") ?? "").toLowerCase()
  return !!port && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
}
function originOK(req, port = running?.port) {
  const origin = req.headers.get("origin")
  return !!port && (origin === null || origin === "null" || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`)
}
function tokenOK(req) {
  const got = Buffer.from(req.headers.get(TOKEN_HEADER) ?? "")
  const want = Buffer.from(token ?? "")
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want)
}
function cors(req) {
  return req.headers.get("origin") === "null" ? {
    "access-control-allow-origin": "null", "access-control-allow-headers": TOKEN_HEADER,
    "access-control-allow-methods": "POST, OPTIONS", vary: "Origin",
  } : {}
}
async function handle(req) {
  if (!hostOK(req)) return new Response("Forbidden", { status: 403 })
  const url = new URL(req.url)
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }
  if (url.pathname === "/test" && req.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "lang")) return new Response("Invalid request", { status: 400, headers })
    return new Response(page(url.searchParams.get("lang")), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } })
  }
  if (url.pathname === "/api/test" && ["POST", "OPTIONS"].includes(req.method)) {
    if (!originOK(req) || (req.method === "POST" && !tokenOK(req))) return new Response("Forbidden", { status: 403, headers })
    if (url.search || req.body !== null) return new Response("Invalid request", { status: 400, headers })
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, ...cors(req) } })
    const result = await testConnection(pluginOptions)
    return Response.json(result, { headers: { ...headers, ...cors(req) } })
  }
  return new Response("Not found", { status: 404, headers })
}
export default {
  id: "magpie-aelios",
  async server(_input, options) {
    pluginOptions = options && typeof options === "object" ? structuredClone(options) : {}
    if (running) return {}
    const port = Number(pluginOptions.port ?? DEFAULT_PORT)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      console.error("[aelios] invalid connection test port")
      return {}
    }
    try {
      token = randomBytes(32).toString("hex")
      running = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle })
      console.log(`[aelios] connection test on http://127.0.0.1:${running.port}/test`)
    } catch {
      // Neither options nor runtime errors (which might contain secrets) escape.
      console.error("[aelios] connection test service could not start")
    }
    return {}
  },
}
export const _internal = {
  hostOK, originOK,
  stop() { running?.stop(true); running = undefined; pluginOptions = {}; token = undefined },
}

// The page's live channel, second shape: the plugin host's own
// localhost-only service (page-service.mjs, not the entry module — the
// plugin host takes every function the entry exports for an OpenCode
// plugin factory and calls it with the host's context at load, so the
// entry exports LayerfsTools alone).
//
// Why a service, not a file. A magpie page runs in an iframe with
// sandbox allow-scripts and CSP connect-src 'none': fetch, XHR and
// WebSocket are all refused, and files are readable only from the
// plugin's own install folder (inside()). The previous shape worked
// around that by pointing the installed page/ at a data folder beside
// the store — a junction on Windows, a symlink elsewhere — but the
// install's folder is not ours to rename or link: an update replaces
// it, two hosts race on it, and it can be read-only. This shape keeps
// the install untouched: the host serves the trajectory page itself,
// and the installed page/index.html only navigates its frame to it
// (page/boot.js, the way page-chat does it). magpie pulls the host up
// the moment the page is requested and waits up to 7 seconds for it
// (pageHost / plugin.Warm), so the service is there by the time the
// frame lands.
//
// The service starts only once a store exists (index.mjs's gates: a
// projects folder holding entries, and a backend answering real
// projects). A user with no store gets no service, no files, nothing
// written under ~.
//
// Security — the trajectory names workspace paths and file contents,
// and any website can point a sandboxed iframe at 127.0.0.1, so:
// - no CORS headers are ever emitted, and any request carrying an
//   Origin header is refused: the only legitimate caller is a
//   navigation, which carries no Origin. A sandboxed iframe's fetch
//   sends Origin: null; a real site's sends its own origin. Both are
//   refused, and without CORS headers a fetch could not read an
//   answer even if one were sent.
// - there is exactly one route, GET /, returning text/html with
//   X-Content-Type-Options: nosniff. No .js data file exists for
//   another site to <script src> — the data rides inside the HTML as
//   <script type="application/json" id="data">, and the page reads it
//   from the DOM, never by fetch.
// - the Host header must be 127.0.0.1:<port> or localhost:<port>:
//   a DNS-rebinding name resolving to 127.0.0.1 arrives with the
//   attacker's Host and is refused.
// - the embedded JSON escapes < as \u003c, so a commit message
//   containing </script> cannot break out of the data script.
// - Cache-Control: no-store, so each reload (the page reloads itself
//   every few seconds for liveness) re-asks and gets fresh data.
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The default port, shared with page/boot.js's fallback (a static file
// cannot import it): the user may move it in the plugin's options
// (pagePort), and MAGPIE_LAYERFS_PAGE_PORT moves it for a test run.
export const DEFAULT_PAGE_PORT = 43717

export function resolvePagePort(options = {}, env = process.env) {
  for (const raw of [options?.pagePort, env.MAGPIE_LAYERFS_PAGE_PORT]) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return DEFAULT_PAGE_PORT
}

const htmlLang = (lang) => {
  const l = String(lang || "").toLowerCase()
  if (l.startsWith("ja")) return "ja"
  if (/^(zh-tw|zh-hk|zh-hant)/.test(l)) return "zh-TW"
  if (l.startsWith("zh")) return "zh"
  return "en"
}

// Compose the served page from the shell and the UI files beside it:
// the shell carries two markers, one for the style, one for the
// scripts. Everything is inlined — the service has no asset routes to
// probe — and the data script sits before the UI scripts that read it.
function compose(pageDir, data, lang) {
  const shell = readFileSync(join(pageDir, "trajectory.html"), "utf8")
  const css = readFileSync(join(pageDir, "style.css"), "utf8")
  const view = readFileSync(join(pageDir, "view.js"), "utf8")
  const app = readFileSync(join(pageDir, "app.js"), "utf8")
  if (!shell.includes("<!-- layerfs:style -->") || !shell.includes("<!-- layerfs:scripts -->"))
    throw new Error("trajectory.html is missing its injection markers")
  const json = JSON.stringify(data).replace(/</g, "\\u003c")
  const theme = JSON.stringify({ lang: String(lang || "").slice(0, 20) }).replace(/</g, "\\u003c")
  return shell
    .replace('<html lang="en">', `<html lang="${htmlLang(lang)}">`)
    .replace("<!-- layerfs:style -->", `<style>${css}</style>`)
    .replace("<!-- layerfs:scripts -->",
      `<script>globalThis.LayerfsTheme = ${theme};</script>` +
      `<script type="application/json" id="data">${json}</script>` +
      `<script>${view}</script><script>${app}</script>`)
  // No reload script here: the page owns its own liveness tick (see
  // app.js) — it must write the view into location.hash and skip the
  // reload while the replay runs or the menu stands open, and a blind
  // timer appended here would reset the view every 5 s regardless.
}

// Start the service. backend answers trajectory(); port is the
// configured port (0 asks the OS for a free one, for tests). The
// returned listening promise resolves to { port, url } once bound, or
// null when the bind fails — a held port leaves no service, and the
// tools are untouched. close() stops the server.
export function startPageService({ backend, port, pageDir }) {
  const dir = pageDir ?? join(dirname(fileURLToPath(import.meta.url)), "page")
  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      })
      res.end(body)
    }
    const err = (code, text) => send(code, `<!doctype html><title>LayerFS</title><p>${text}</p>`)
    // The bound port, not the requested one: a test's port 0 binds
    // elsewhere, and a Host naming the requested port must not pass.
    const actual = server.address()?.port
    if (!actual) { err(503, "not listening"); return }
    const host = String(req.headers.host || "").toLowerCase()
    if (host !== `127.0.0.1:${actual}` && host !== `localhost:${actual}`) {
      err(403, "this service answers only its own loopback names")
      return
    }
    if (req.headers.origin !== undefined) {
      err(403, "this service answers navigations, not cross-origin reads")
      return
    }
    let path = "", lang = ""
    try {
      const u = new URL(req.url, "http://127.0.0.1")
      path = u.pathname
      lang = u.searchParams.get("lang") || ""
    } catch { /* a malformed target is not a route */ }
    if (req.method !== "GET" || path !== "/") { err(404, "no such route"); return }
    let data
    try { data = await backend.trajectory() } catch { err(500, "the trajectory could not be read"); return }
    let html
    try { html = compose(dir, data, lang) } catch { err(500, "the page could not be composed"); return }
    send(200, html)
  })
  server.on("error", () => { /* a held port or a refused bind: no service */ })
  // Unref: a listening server must not keep a test process (or a host
  // that is otherwise done) alive on its own — it still answers while
  // the process lives for other reasons.
  if (typeof server.unref === "function") server.unref()
  const listening = new Promise((resolve) => {
    server.once("listening", () => {
      const p = server.address().port
      resolve({ port: p, url: `http://127.0.0.1:${p}/` })
    })
    server.once("error", () => resolve(null))
  })
  server.listen(port, "127.0.0.1")
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/`,
    listening,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

// The connection test's loopback service. A Magpie page runs with
// connect-src 'none', so the settings page cannot fetch Mem. The page's Test
// button navigates the frame here; the test page asks for a click, then this
// service checks the saved connection with the plugin's own options. No URL,
// key or Space comes from the page, so a page cannot aim it at another host.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { installLibrary } from "./library.mjs";
import { testConnection, textsFor } from "./probe.mjs";

const DEFAULT_PORT = 3479;
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-nmem-token";
let running;
let pluginOptions = {};

const messages = {
    en: textsFor("en"),
    zh: textsFor("zh"),
    "zh-TW": textsFor("zh-TW"),
    ja: textsFor("ja"),
    de: textsFor("de"),
};

function page() {
    return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="nm-token" content="${TOKEN}">
<title>Nowledge Mem</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 28px; color: #1d1d1f; background: #fff; }
  h1 { margin: 0 0 10px; font-size: 17px; }
  p { margin: 0 0 14px; font-size: 14px; line-height: 1.5; }
  button { font: inherit; font-size: 13px; padding: 5px 12px; margin: 0 0 18px; }
  a { display: block; font-size: 13px; color: #0a6cff; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #1c1c1e; } a { color: #6ea8ff; } }
</style>
<h1>Nowledge Mem</h1>
<p id="state"></p>
<button id="run" type="button" hidden></button>
<a id="back" hidden></a>
<script>
(() => {
  const all = ${JSON.stringify(messages)};
  let cfg = {};
  try { cfg = JSON.parse(window.name || "{}"); } catch {}
  window.name = "";
  const t = all[cfg.lang] || all.en;
  const state = document.getElementById("state");
  const run = document.getElementById("run");
  const back = document.getElementById("back");
  if (typeof cfg.returnTo === "string" && /^https?:\\/\\/(127\\.0\\.0\\.1|localhost):\\d+\\/_magpie\\/plugin\\//u.test(cfg.returnTo)) {
    back.href = cfg.returnTo;
    back.textContent = t.back;
    back.hidden = false;
  } else {
    state.textContent = t.noReturn;
  }
  run.textContent = t.run;
  run.hidden = false;
  run.addEventListener("click", async () => {
    run.disabled = true;
    state.textContent = t.testing;
    try {
      const r = await fetch(new URL("api/test", location.href), {
        method: "POST",
        headers: { "x-nmem-token": document.querySelector('meta[name="nm-token"]').content },
      });
      const d = await r.json();
      state.textContent = d.ok ? t.connected + " · " + d.ms + " ms" : t.failed + " · " + (t[d.code] || d.code || t.empty);
    } catch {
      state.textContent = t.noService;
    } finally {
      run.disabled = false;
    }
  });
})();
</script>`;
}

function hostOK(req) {
    const port = running?.port;
    if (!port)
        return false;
    const host = String(req.headers.get("host") ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function originOK(req) {
    const origin = req.headers.get("origin");
    if (origin === null || origin === "null")
        return true;
    const port = running?.port;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function cors(req) {
    if (req.headers.get("origin") !== "null")
        return {};
    return {
        "access-control-allow-origin": "null",
        "access-control-allow-headers": TOKEN_HEADER,
        "access-control-allow-methods": "POST, OPTIONS",
        vary: "Origin",
    };
}

function tokenOK(req) {
    const got = Buffer.from(String(req.headers.get(TOKEN_HEADER) ?? ""));
    const want = Buffer.from(TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req) {
    if (!hostOK(req))
        return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
        if (!originOK(req))
            return new Response("Forbidden", { status: 403 });
        return new Response(null, { status: 204, headers: cors(req) });
    }
    if (url.pathname === "/test" && req.method === "GET")
        return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    if (url.pathname === "/api/test" && req.method === "POST") {
        if (!originOK(req) || !tokenOK(req))
            return new Response("Forbidden", { status: 403 });
        const result = await testConnection(pluginOptions);
        return Response.json(result, { headers: cors(req) });
    }
    return new Response("Not found", { status: 404 });
}

export default {
    id: "magpie-nowledge-mem",
    async server(input, options) {
        pluginOptions = options ?? {};
        try {
            const installed = installLibrary({ directory: input?.directory, options: pluginOptions });
            if (!installed.skipped)
                console.log(`[nowledge-mem] Library: ${installed.mcp} and ${installed.skill}, given to no agent yet`);
        }
        catch (error) {
            console.error(`[nowledge-mem] Library install failed: ${error?.message ?? error}`);
        }
        if (running)
            return {};
        const port = Number(pluginOptions.port ?? DEFAULT_PORT);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            console.error(`[nowledge-mem] the connection test needs a port, got ${pluginOptions.port}`);
            return {};
        }
        try {
            running = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
            console.log(`[nowledge-mem] connection test on http://127.0.0.1:${running.port}`);
        }
        catch (error) {
            console.error(`[nowledge-mem] the connection test could not start on port ${port}: ${error?.message ?? error}`);
        }
        return {};
    },
};

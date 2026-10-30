// The connection test's loopback service. A Magpie page runs with
// connect-src 'none', so the settings page cannot fetch Mem. The page hands
// its form values to this service by navigating to /test with them in
// window.name; the service makes the two requests and shows the result, with
// a link back to the settings page. It is only a test: it writes nothing.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { testConnection, textsFor, validReturn } from "./probe.mjs";

const DEFAULT_PORT = 3479;
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-nmem-token";
let running;

// The service page's own copy, in every language the settings page speaks.
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
  p { margin: 0 0 18px; font-size: 14px; line-height: 1.5; }
  a { font-size: 13px; color: #0a6cff; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #1c1c1e; } a { color: #6ea8ff; } }
</style>
<h1>Nowledge Mem</h1>
<p id="state">Testing the connection…</p>
<a id="back" hidden></a>
<script>
(async () => {
  const all = ${JSON.stringify(messages)};
  let cfg = {};
  try { cfg = JSON.parse(window.name || "{}"); } catch {}
  const t = all[cfg.lang] || all.en;
  const state = document.getElementById("state");
  state.textContent = t.testing;
  if (!cfg.returnTo) { state.textContent = t.noReturn; return; }
  try {
    const r = await fetch(new URL("api/test", location.href), {
      method: "POST",
      headers: { "content-type": "application/json", "x-nmem-token": document.querySelector('meta[name="nm-token"]').content },
      body: JSON.stringify({ serverUrl: cfg.serverUrl, apiKey: cfg.apiKey, spaceId: cfg.spaceId, returnTo: cfg.returnTo }),
    });
    const d = await r.json();
    if (d.returnTo) {
      const back = document.getElementById("back");
      back.href = d.returnTo;
      back.textContent = t.back;
      back.hidden = false;
    }
    state.textContent = d.ok ? t.connected + " · " + d.ms + " ms" : t.failed + " · " + (t[d.code] || d.code || t.empty);
  } catch {
    state.textContent = t.noService;
  }
})();
</script>`;
}

function cors() {
    return {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
        "access-control-allow-methods": "POST, OPTIONS",
    };
}

function tokenOK(req) {
    const got = Buffer.from(String(req.headers.get(TOKEN_HEADER) ?? ""));
    const want = Buffer.from(TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/test" && req.method === "GET")
        return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    if (url.pathname === "/api/test" && req.method === "POST") {
        if (!tokenOK(req))
            return Response.json({ error: "forbidden" }, { status: 403, headers: cors() });
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object")
            return Response.json({ error: "invalid" }, { status: 400, headers: cors() });
        if (!validReturn(body.returnTo, req.headers.get("host") ?? ""))
            return Response.json({ error: "invalid" }, { status: 400, headers: cors() });
        const result = await testConnection({ serverUrl: body.serverUrl, apiKey: body.apiKey, spaceId: body.spaceId });
        return Response.json({ ...result, returnTo: body.returnTo }, { headers: cors() });
    }
    return new Response("Not found", { status: 404 });
}

export default {
    id: "magpie-nowledge-mem",
    async server(_input, options) {
        if (running)
            return {};
        const port = Number(options?.port ?? DEFAULT_PORT);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            console.error(`[nowledge-mem] the connection test needs a port, got ${options?.port}`);
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

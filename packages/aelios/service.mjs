// Magpie settings pages cannot fetch (connect-src 'none'). Their Connect or
// Test click navigates to this loopback page, which probes saved options only.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readIdentities, testConnection, textsFor } from "./probe.mjs"

const DEFAULT_PORT = 3481
const TOKEN_HEADER = "x-aelios-token"
let running
let pluginOptions = {}
let token

function page(lang, auto = false) {
  const t = textsFor(lang)
  const zh = lang === "zh"
  const labels = zh ? { title: "助手匹配列表", name: "助手", models: "主模型匹配规则", empty: "未配置主模型", unavailable: "当前服务未提供匹配列表；请升级 Aelios 后重试。", rules: "自动分配复用 Aelios 的主模型规则，按列表顺序选择首个匹配的助手。支持 *、忽略大小写，同时匹配完整模型名及最后 / 后的名称。未匹配时不使用记忆。", override: "当前设置包含自定义身份或路由；它们优先于自动分配。", auto: "连接成功后显示此密钥可访问的助手。" } : { title: "Assistant mappings", name: "Assistant", models: "Main model patterns", empty: "No main models configured", unavailable: "This service does not provide mappings. Upgrade Aelios and retry.", rules: "Automatic assignment uses Aelios main model rules, choosing the first matching assistant in order. Patterns support *, ignore case, and match the full model name or the name after its last /. Unmatched models do not use memory.", override: "Custom identity or route settings are active and take priority over automatic assignment.", auto: "After connecting, this page lists the assistants available to this key." }
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh" : "en"}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="aelios-token" content="${token}">
<title>Aelios</title>
<style>
:root { color-scheme: light dark; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
body { margin: 0; padding: 20px 24px; max-width: 760px; } h1 { font-size: 20px; } h2 { font-size: 15px; }
button { font: inherit; padding: 4px 10px; margin-right: 8px; border-radius: 6px; cursor: pointer; }
table { width: 100%; border-collapse: collapse; } th,td { text-align: left; padding: 8px; border-bottom: 1px solid GrayText; overflow-wrap: anywhere; } td { white-space: pre-line; }
</style>
<h1>Aelios</h1><p>${auto ? labels.auto : t.confirm}</p><p>${t.scope}</p>
<button id="run" type="button">${t.run}</button><button id="back" type="button">${t.back}</button>
<p id="state" role="status" aria-live="polite"></p>
<section id="mappings" hidden><h2>${labels.title}</h2><p id="rules"></p><table><thead><tr><th>${labels.name}</th><th>${labels.models}</th></tr></thead><tbody id="identities"></tbody></table><p id="mapping-notice"></p></section>
<script>
(() => {
  const t = ${JSON.stringify(t)};
  const labels = ${JSON.stringify(labels)};
  const state = document.getElementById("state");
  const run = document.getElementById("run");
  document.getElementById("back").addEventListener("click", () => history.back());
  async function test() {
    run.disabled = true;
    document.getElementById('mappings').hidden = true;
    document.getElementById('identities').replaceChildren();
    state.textContent = t.testing;
    try {
      // Resolved against this page, not the origin root: Magpie serves a
      // browser's page through its own /_magpie/service/ prefix.
      const response = await fetch(new URL("api/test", location.href), { method: "POST", headers: { "${TOKEN_HEADER}": document.querySelector('meta[name="aelios-token"]').content } });
      const result = await response.json();
      state.textContent = (result.ok ? t[result.code] : t.failed + " · " + (t[result.code] || t.invalid)) + " · " + t.checked + ": " + result.checkedIdentities + " · " + result.ms + " ms";
      if (result.ok) {
        document.getElementById('mappings').hidden = false;
        document.getElementById('rules').textContent = labels.rules;
        document.getElementById('mapping-notice').textContent = result.mapping?.available ? (result.custom ? labels.override : '') : labels.unavailable;
        for (const identity of result.mapping?.identities || []) {
          const row = document.createElement('tr');
          for (const value of [identity.name, identity.mainModels.join('\\n') || labels.empty]) {
            const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
          }
          document.getElementById('identities').append(row);
        }
      }
    } catch { state.textContent = t.noService; }
    finally { run.disabled = false; }
  }
  run.addEventListener("click", test);
  ${auto ? 'test();' : ''}
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
    if ([...url.searchParams.keys()].some(key => !["lang", "auto"].includes(key)) || (url.searchParams.has('auto') && url.searchParams.get('auto') !== '1')) return new Response("Invalid request", { status: 400, headers })
    return new Response(page(url.searchParams.get("lang"), url.searchParams.get('auto') === '1'), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } })
  }
  if (url.pathname === "/api/test" && ["POST", "OPTIONS"].includes(req.method)) {
    if (!originOK(req) || (req.method === "POST" && !tokenOK(req))) return new Response("Forbidden", { status: 403, headers })
    if (url.search || req.body !== null) return new Response("Invalid request", { status: 400, headers })
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, ...cors(req) } })
    const options = structuredClone(pluginOptions)
    const result = await testConnection(options)
    if (result.ok) {
      result.mapping = await readIdentities(options)
      result.custom = Boolean(options.identity || options.routes?.length)
    }
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

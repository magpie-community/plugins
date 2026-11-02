// Real-browser regression for #582 (preview proxy): another web page must not be able to read or drive a previewed dev
// server through the proxy, while the preview frame itself (sandboxed, opaque, as inside Magpie) still works.
//
//   node scripts/preview-attack.mjs [--daemon daemon/dist/main.js] [--browser chromium|webkit|all]
//
// What it runs: a dev server that refuses foreign Origins (as Vite does since CVE-2025-24010), the real daemon bundle with a
// throwaway data folder, preview.open over the token WebSocket, then in a real browser
//   - attacker: a page on another origin whose sandbox="allow-scripts" frame (Origin: null) tries the proxy port directly
//     (127.0.0.1 / localhost / a made-up ac<key>.localhost name), a POST, a no-cors POST and a WebSocket;
//   - legit: a Magpie-like page → sandbox="allow-scripts" frame → the preview iframe at proxyHref, running an ES module app
//     that imports a module, fetches /secret, POSTs /admin, loads an absolute-path image and opens a WebSocket.
// Exit code 1 if the attacker read or changed anything, or the legit preview broke.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform as osPlatform, release as osRelease, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findBrowser } from "./browser-path.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { chromium, webkit } = require("playwright-core");
const WebSocket = require("ws");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const daemonPath = resolve(arg("--daemon", join(root, "daemon/dist/main.js")));
const which = arg("--browser", "chromium");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// ---- dev server: refuses a foreign Origin, never sends CORS headers ----
const hits = [];
let devPort = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const dev = http.createServer((req, res) => {
  const o = req.headers.origin;
  if (o && o !== `http://localhost:${devPort}`) { res.writeHead(403); res.end("foreign origin"); return; }
  const u = new URL(req.url, "http://x");
  hits.push(`${req.method} ${u.pathname}${u.search}`);
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>dev</title></head><body><img id="logo" src="/logo.png"><script type="module" src="/src/main.js"></script></body></html>`);
  } else if (u.pathname === "/src/main.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(`import { dep } from "/src/dep.js";
const out = { module: dep };
try { out.secret = await (await fetch("/secret")).text(); } catch (e) { out.secret = "ERR " + e; }
try { out.admin = await (await fetch("/admin?by=legit", { method: "POST", body: "x" })).text(); } catch (e) { out.admin = "ERR " + e; }
const img = document.getElementById("logo");
out.image = img.complete ? img.naturalWidth > 0 : await new Promise((r) => { img.onload = () => r(true); img.onerror = () => r(false); });
out.ws = await new Promise((r) => { try { const w = new WebSocket("ws://" + location.host + "/hmr"); w.onopen = () => w.send("hi"); w.onmessage = (e) => { r(String(e.data)); w.close(); }; w.onerror = () => r("ERR"); setTimeout(() => r("TIMEOUT"), 4000); } catch (e) { r("ERR " + e); } });
out.storage = (() => { try { localStorage.setItem("k", "v"); return localStorage.getItem("k"); } catch (e) { return "ERR"; } })();
parent.postMessage({ app: out }, "*");`);
  } else if (u.pathname === "/src/dep.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(`export const dep = "MODULE-OK";`);
  } else if (u.pathname === "/logo.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  } else if (u.pathname === "/secret") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("DEV-SECRET-4242");
  } else if (u.pathname === "/admin") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ADMIN-ACTION-DONE " + (u.searchParams.get("by") ?? ""));
  } else { res.writeHead(404); res.end(); }
});
dev.on("upgrade", (req, socket) => {
  const o = req.headers.origin;
  if (o && o !== `http://localhost:${devPort}`) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  hits.push(`WS ${req.url}`);
  // minimal WebSocket: accept, then echo "echo:<text>" for one short text frame
  const key = req.headers["sec-websocket-key"];
  const accept = require("node:crypto").createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  socket.on("data", (b) => {
    if (b.length < 6 || (b[0] & 0x0f) !== 1) return;
    const len = b[1] & 0x7f; const mask = b.subarray(2, 6); const data = Buffer.from(b.subarray(6, 6 + len)).map((x, i) => x ^ mask[i % 4]);
    const msg = Buffer.from("echo:" + data.toString());
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
  });
  socket.on("error", () => {});
});
devPort = await listen(dev);

// ---- the real daemon, throwaway data folder, preview.open over the token WebSocket ----
const data = mkdtempSync(join(tmpdir(), "ac-attack-"));
const daemon = spawn(process.execPath, [daemonPath, "--port", "0", "--data", data], {
  env: { ...process.env, AGENT_CONSOLE_MOCK: "1", HOME: data, USERPROFILE: data, XDG_CONFIG_HOME: join(data, "cfg") },
  stdio: ["ignore", "ignore", "pipe"],
});
let dj = null;
for (let i = 0; i < 100 && !dj; i++) { try { dj = JSON.parse(readFileSync(join(data, "magpie/agent-console/daemon.json"), "utf8")); } catch { await sleep(150); } }
if (!dj) throw new Error("daemon did not start");
const ws = new WebSocket(`ws://127.0.0.1:${dj.port}/ws`, { headers: { origin: "null" } });
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(String(b)); if (m.t === "res" && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
ws.send(JSON.stringify({ t: "hello", token: dj.token, v: 1 }));
await sleep(300);
let nid = 1;
const call = (m, p) => new Promise((r) => { const id = nid++; pending.set(id, r); ws.send(JSON.stringify({ t: "req", id, m, p })); });
const opened = await call("preview.open", { url: `http://localhost:${devPort}/` });
if (!opened.ok) throw new Error("preview.open failed: " + JSON.stringify(opened.e));
const { proxyOrigin, proxyHref, nonce, canaryOrigin, canaryNonce } = opened.r;
if (!nonce || !canaryOrigin || !canaryNonce) throw new Error("preview.open missing nonce/canary: " + JSON.stringify(opened.r));
// The daemon reports its own OS (the WebKit UA is frozen at 10_15_7): the panel refuses Apple WebKit on Darwin < 25
const host = opened.r.host;
const wantMajor = osPlatform() === "darwin" ? Number(osRelease().split(".")[0]) : null;
if (!host || host.platform !== osPlatform() || host.darwinMajor !== wantMajor) {
  throw new Error("preview.open host info wrong: " + JSON.stringify(host) + " want " + JSON.stringify({ platform: osPlatform(), darwinMajor: wantMajor }));
}
const proxyPort = Number(new URL(proxyOrigin).port);

// ---- attacker: another origin, sandboxed frame, knows the proxy port (worst case) but not the key ----
const attackJs = `
const P = ${proxyPort}, D = ${devPort};
const tryText = async (url, init) => { try { const r = await fetch(url, init); return r.status + " " + (await r.text()).slice(0, 60); } catch (e) { return "blocked (" + e.name + ")"; } };
(async () => {
  const out = {};
  out.devDirect = await tryText("http://localhost:" + D + "/secret");
  out.proxy127 = await tryText("http://127.0.0.1:" + P + "/secret");
  out.proxyLocalhost = await tryText("http://localhost:" + P + "/secret");
  out.proxyGuessedKey = await tryText("http://ac" + "0123456789abcdef0123456789abcdef" + ".localhost:" + P + "/secret");
  out.adminPost = await tryText("http://127.0.0.1:" + P + "/admin?by=attacker", { method: "POST", body: "x" });
  try { await fetch("http://127.0.0.1:" + P + "/admin?by=attacker-nocors", { method: "POST", body: "x", mode: "no-cors" }); out.adminNoCors = "sent"; } catch (e) { out.adminNoCors = "blocked"; }
  out.ws = await new Promise((r) => { try { const w = new WebSocket("ws://127.0.0.1:" + P + "/hmr"); w.onopen = () => w.send("hi"); w.onmessage = (e) => r("READ " + e.data); w.onerror = () => r("blocked"); setTimeout(() => r("timeout"), 3000); } catch (e) { r("blocked"); } });
  parent.postMessage({ attack: out }, "*");
})();`;
const attacker = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><script>window.__r=null;addEventListener("message",e=>{if(e.data&&e.data.attack)window.__r=e.data.attack});</script>
<iframe sandbox="allow-scripts" srcdoc="${`<script>${attackJs}</script>`.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
});
const attackerPort = await listen(attacker);

// ---- legit: Magpie-like page → sandboxed console-like frame → the preview iframe ----
const PING = "/__agent_console__/ping";
const consoleJs = `
(async () => {
  const pingOnce = async (origin, expect) => {
    try {
      const r = await fetch(origin + ${JSON.stringify(PING)}, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      const body = await r.text();
      return r.status + " " + (body === expect ? "nonce-ok" : ("nonce-bad:" + body.slice(0, 40)));
    } catch (e) { return "ERR " + e.name; }
  };
  let ping = "n/a";
  let canary = "n/a";
  if (${JSON.stringify(proxyOrigin)}.indexOf(".localhost:") > 0) {
    canary = await pingOnce(${JSON.stringify(canaryOrigin)}, ${JSON.stringify(canaryNonce)});
    ping = await pingOnce(${JSON.stringify(proxyOrigin)}, ${JSON.stringify(nonce)});
  }
  addEventListener("message", (e) => { if (e.data && e.data.app) parent.postMessage({ legit: Object.assign({ ping, canary }, e.data.app) }, "*"); });
  if (!/nonce-ok/.test(canary) || !/nonce-ok/.test(ping)) {
    parent.postMessage({ legit: { ping, canary, module: "SKIPPED", secret: "SKIPPED", admin: "SKIPPED", image: false, ws: "SKIPPED" } }, "*");
    return;
  }
  const f = document.createElement("iframe"); f.src = ${JSON.stringify(proxyHref)}; f.referrerPolicy = "no-referrer"; document.body.appendChild(f);
})();`;
const magpieSim = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><script>window.__r=null;addEventListener("message",e=>{if(e.data&&e.data.legit)window.__r=e.data.legit});</script>
<iframe sandbox="allow-scripts" srcdoc="${`<body><script>${consoleJs}</script></body>`.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
});
const magpiePort = await listen(magpieSim);

async function run(name, type, opts) {
  hits.length = 0;
  const browser = await type.launch({ headless: true, ...opts });
  const page = await browser.newPage();
  const get = async (url) => {
    await page.goto(url);
    for (let i = 0; i < 80; i++) { const r = await page.evaluate(() => window.__r); if (r) return r; await sleep(150); }
    return "no result";
  };
  const attack = await get(`http://127.0.0.1:${attackerPort}/`);
  await sleep(500);
  const attackerHits = hits.filter((h) => h.includes("attacker"));
  const legit = await get(`http://127.0.0.1:${magpiePort}/`);
  await browser.close();
  return { browser: name, attack, attackerHitsOnDevServer: attackerHits, legit };
}

const results = [];
const browsers = [];
if (which === "chromium" || which === "all") browsers.push(["chromium", chromium, { executablePath: findBrowser(), args: ["--no-sandbox"] }]);
if (which === "webkit" || which === "all") browsers.push(["webkit", webkit, {}]);
for (const [n, t, o] of browsers) {
  try { results.push(await run(n, t, o)); } catch (e) { results.push({ browser: n, error: String(e).split("\n")[0] }); }
}
ws.close();
daemon.kill();
dev.close(); attacker.close(); magpieSim.close();
await sleep(200);
rmSync(data, { recursive: true, force: true });

let bad = false;
for (const r of results) {
  if (r.error) { bad = true; continue; }
  const leaked = Object.values(r.attack).some((v) => /DEV-SECRET|ADMIN-ACTION|READ /.test(String(v))) || r.attackerHitsOnDevServer.length > 0;
  const l = r.legit;
  const works = l && /nonce-ok/.test(l.canary) && /nonce-ok/.test(l.ping) && l.module === "MODULE-OK" && l.secret === "DEV-SECRET-4242" && /ADMIN-ACTION-DONE legit/.test(l.admin) && l.image === true && l.ws === "echo:hi";
  r.verdict = { attackerGotIn: leaked, legitPreviewWorks: !!works };
  if (leaked || !works) bad = true;
}
console.log(JSON.stringify({ daemon: daemonPath.replace(root + "/", ""), proxyOrigin: proxyOrigin.replace(/ac[0-9a-f]{32}/, "ac<key>"), results }, null, 2));
process.exit(bad ? 1 : 0);

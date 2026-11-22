// Imported first by every test here: nothing a test runs reaches the real
// MOSS hosts. fetch goes to this machine (a test's fake) or fails, so a test
// left without its fake can't send a console token or API key to
// platform.mosi.cn / api.mosi.cn.
//
// The guard used to cover only globalThis.fetch; that left the node built-ins
// (http/https/net/dgram/dns, undici's request) as ways around it. The plugin
// and its fakes only use fetch, but the point of the guard is that a FUTURE
// import that reaches for node:https fails loudly here instead of quietly
// calling out — so the built-ins are blocked too.
//
// This file also pulls in safe-browser.mjs: `bun test packages/moss` runs
// files alphabetically and browser-args.test.mjs (b) loads lib/browser.mjs
// before fake-browser.test.mjs (f) installs the spawn guard — the guard must
// be registered before that first load, and this import is the one hook every
// test file already runs first.
import "./safe-browser.mjs"

const local = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error("a test asked " + u + " with no fake in place")
  return realFetch(input, init)
}

// Block the socket-opening exports of the built-in network modules. The
// plugin's own CDP client uses WebSocket over an already-open loopback port
// to the fake browser; tests that need a server use Bun.serve on 127.0.0.1.
const blocked = (mod, fn) =>
  function () {
    throw new Error(`a test used ${mod}.${fn} — network is off in tests (use the local fake via fetch)`)
  }
const refused = (what) =>
  class {
    constructor() {
      throw new Error(`${what} is off in tests`)
    }
  }
const httpBlock = {
  request: blocked("http", "request"),
  get: blocked("http", "get"),
  createServer: blocked("http", "createServer"),
  Agent: refused("http.Agent"),
}
const httpsBlock = { ...httpBlock, request: blocked("https", "request"), get: blocked("https", "get") }
const netBlock = {
  createConnection: blocked("net", "createConnection"),
  connect: blocked("net", "connect"),
  Socket: refused("net.Socket"),
  Server: refused("net.Server"),
}
const dgramBlock = { createSocket: blocked("dgram", "createSocket"), Socket: refused("dgram.Socket") }
// Without the resolver a hostname cannot be turned into an address at all.
const dnsBlock = new Proxy(
  {},
  {
    get(_t, fn) {
      if (typeof fn === "symbol") return undefined
      return blocked("dns", String(fn))
    },
  },
)
for (const [mod, patch] of [
  ["node:http", httpBlock],
  ["http", httpBlock],
  ["node:https", httpsBlock],
  ["https", httpsBlock],
  ["node:net", netBlock],
  ["net", netBlock],
  ["node:dgram", dgramBlock],
  ["dgram", dgramBlock],
  ["node:dns", dnsBlock],
  ["dns", dnsBlock],
  ["node:dns/promises", dnsBlock],
  ["undici", { request: blocked("undici", "request"), fetch: blocked("undici", "fetch"), Agent: refused("undici.Agent") }],
]) {
  try {
    const m = require(mod)
    for (const k of Object.keys(patch)) {
      try {
        Object.defineProperty(m, k, { value: patch[k], configurable: true, writable: true })
      } catch {}
    }
  } catch {    /* module not present in this runtime: nothing to block */
  }
}

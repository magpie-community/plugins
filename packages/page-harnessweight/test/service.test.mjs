import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler, TOKEN_HEADER } from "../service.mjs"

async function start() {
  const dir = await mkdtemp(join(tmpdir(), "al-svc-"))
  const usageLog = join(dir, "usage.jsonl")
  await writeFile(usageLog, JSON.stringify({ t: new Date().toISOString(), agent: "dsh", model: "m", status: 200, in: 1, cache_read: 9, out: 2 }) + "\n")
  const srv = createServer()
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  srv.on("request", createHandler({ port, usageLog, dataDir: dir, token: "t".repeat(64), gatewayUrl: "http://127.0.0.1:9" }))
  return { port, close: () => srv.close() }
}
const get = (port, path, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers })

test("api needs the token; the token is only in the page HTML, which has no CORS header", async () => {
  const s = await start()
  try {
    assert.equal((await get(s.port, "/api/summary")).status, 403)
    assert.equal((await get(s.port, "/api/summary", { [TOKEN_HEADER]: "wrong" })).status, 403)
    const ok = await get(s.port, "/api/summary", { [TOKEN_HEADER]: "t".repeat(64), Origin: "null" })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).agents[0].agent, "dsh")
    assert.equal((await get(s.port, `/api/summary?k=${"t".repeat(64)}`, { Origin: "null" })).status, 200)
    const page = await get(s.port, "/", { Origin: "null" })
    assert.equal(page.headers.get("access-control-allow-origin"), null)
    assert.match(await page.text(), /name="harnessweight-token" content="t{64}"/)
    const health = await (await get(s.port, "/api/health")).json()
    assert.deepEqual(Object.keys(health).sort(), ["ok", "service"])
  } finally { s.close() }
})

test("other hosts, other origins and path traversal are refused", async () => {
  const s = await start()
  try {
    const h = { [TOKEN_HEADER]: "t".repeat(64) }
    assert.equal((await get(s.port, "/api/summary", { ...h, Origin: "https://evil.example" })).status, 403)
    // DNS rebinding: same socket, foreign Host
    const r = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const q = request({ host: "127.0.0.1", port: s.port, path: "/api/summary", headers: { ...h, Host: "evil.example" } }, resolve)
        q.end()
      })
    })
    assert.equal(r.statusCode, 403)
    const t = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const q = request({ host: "127.0.0.1", port: s.port, path: "/../service.mjs" }, resolve)
        q.end()
      })
    })
    assert.notEqual(t.statusCode, 200)
  } finally { s.close() }
})

test("the page in magpie's frame reaches no network and declares no reads", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.deepEqual(pkg.magpie.permissions, [])
  const dir = new URL("../page/", import.meta.url)
  for (const f of (await readdir(dir)).filter((f) => /\.(js|html)$/.test(f))) {
    const src = await readFile(new URL(f, dir), "utf8")
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|magpie\.read\s*\(/, f)
  }
})

// The model picker opens above the composer. With many models in a short
// window its top used to run out of the page, where the page frame clips it,
// so the first models could not be scrolled to. This drives the real page in
// Chromium and WebKit against a stub bootstrap with 60 models.
// Run: NODE_PATH=<playwright's node_modules> node pop-clamp.gui.mjs
import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium, webkit } = require("playwright")
const root = join(import.meta.dirname, "chat")
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }
const models = Array.from({ length: 60 }, (_, i) => ({ id: "p/model-" + i, name: "Model " + i, provider: "p", efforts: [] }))

const srv = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname
  if (path === "/api/bootstrap") {
    res.setHeader("content-type", "application/json")
    return res.end(JSON.stringify({ models, settings: { model: "p/model-0" }, library: { instructions: [], skills: [], mcp: [] }, version: "0" }))
  }
  if (path.startsWith("/api/")) { res.setHeader("content-type", "application/json"); return res.end("[]") }
  const f = join(root, path === "/" ? "index.html" : path)
  if (!f.startsWith(root) || !existsSync(f)) { res.statusCode = 404; return res.end() }
  res.setHeader("content-type", types[extname(f)] || "application/octet-stream")
  res.end(readFileSync(f))
}).listen(0, "127.0.0.1")
await new Promise((r) => srv.once("listening", r))
const url = "http://127.0.0.1:" + srv.address().port + "/"

let bad = 0
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const h of [320, 420, 600, 900]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: h } })
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector("#modelBtn") && !document.querySelector("#modelBtn").disabled)
    await page.click("#modelBtn")
    const r = await page.evaluate(async () => {
      const pop = document.querySelector("#modelPop")
      const b = pop.getBoundingClientRect()
      pop.scrollTop = 0
      const first = pop.querySelector(".pop-item").getBoundingClientRect()
      const p = pop.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, vh: innerHeight, firstVisible: first.top >= p.top - 0.5 && first.bottom <= p.bottom + 0.5, scrolls: pop.scrollHeight > pop.clientHeight }
    })
    const ok = r.top >= 0 && r.bottom <= r.vh && r.firstVisible && r.scrolls
    console.log(ok ? "ok  " : "FAIL", name, h, JSON.stringify(r))
    if (!ok) bad++
    await page.close()
  }
  await browser.close()
}
srv.close()
process.exit(bad ? 1 : 0)

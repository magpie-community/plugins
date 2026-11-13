// The plugin's page service: a small loopback server that shows the model
// mirror preview and performs it only after the user confirms. Magpie serves
// page/index.html as the page shell; its boot.js navigates here.
//
// Nothing on this server reads Trae's credential storage, Magpie's gateway
// keys, or another plugin's sign-in. The preview uses the per-agent key Magpie
// put in connection.json and this package's own "trae-agent" sign-in.

import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMirror, previewModels } from "./bridge.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = join(HERE, "page", "ui.html")

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(body)
}

function sameOrigin(req, port) {
  const origin = String(req.headers.origin || "")
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      Number(url.port) === Number(port)
    )
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ""
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        resolve(null)
        req.destroy()
        return
      }
      body += chunk
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve(null)
      }
    })
    req.on("error", () => resolve(null))
  })
}

export function startPageServer({ port = 3499, paths, log = console } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        html(res, readFileSync(UI, "utf8"))
        return
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        json(res, { ok: true })
        return
      }
      if (url.pathname === "/api/preview" && req.method === "GET") {
        json(res, await previewModels(paths))
        return
      }
      if (url.pathname === "/api/mirror") {
        if (req.method !== "POST") {
          json(res, { ok: false, error: "POST required" }, 405)
          return
        }
        if (!sameOrigin(req, actualPort)) {
          json(res, { ok: false, error: "forbidden" }, 403)
          return
        }
        const body = await readBody(req)
        if (!body || body.confirm !== true) {
          json(
            res,
            { ok: false, code: "confirm-required", error: "Confirm the preview before mirroring." },
            400,
          )
          return
        }
        json(res, await applyMirror(paths, { previewId: body.previewId, confirm: true }))
        return
      }
      json(res, { ok: false, error: "not found" }, 404)
    } catch (err) {
      log.error?.(`trae page: ${err instanceof Error ? err.message : String(err)}`)
      json(res, { ok: false, error: "internal error" }, 500)
    }
  })

  let actualPort = port
  let readyResolve
  const ready = new Promise((resolve) => {
    readyResolve = resolve
  })
  server.on("error", (err) => {
    log.error?.(`trae page: cannot listen on 127.0.0.1:${port}: ${err.message}`)
    readyResolve(0)
  })
  server.listen(port, "127.0.0.1", () => {
    actualPort = server.address().port
    log.log?.(`trae page: http://127.0.0.1:${actualPort}/`)
    readyResolve(actualPort)
  })
  return {
    get port() {
      return actualPort
    },
    ready,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

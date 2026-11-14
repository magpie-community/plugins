// Images to show the models: local paths, http(s) URLs or data URLs, read here
// and sent inline, so every model that sees images gets the same bytes
// whichever API it is called on.

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname } from "node:path"

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const MAX_FILES = 8
const MAX_BYTES = 20 * 1024 * 1024

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif"
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp"
  if (b.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf"
  return null
}

async function read(item) {
  if (item.startsWith("data:")) {
    const m = item.match(/^data:([^;,]*)(;base64)?,(.*)$/s)
    if (!m) throw new Error("not a data URL")
    return { name: "data URL", buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3])), mime: m[1] }
  }
  if (/^https?:\/\//i.test(item)) {
    const r = await fetch(item, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return { name: item, buf: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get("content-type") || "").split(";")[0].trim() }
  }
  let path = item.startsWith("file://") ? decodeURIComponent(item.slice(7)) : item
  path = path.replace(/^~(?=$|[\\/])/, homedir())
  return { name: basename(path), buf: await readFile(path), mime: TYPES[extname(path).toLowerCase()] || "" }
}

export async function loadImages(items, T) {
  const list = (Array.isArray(items) ? items : items ? [items] : []).map((x) => String(x || "").trim()).filter(Boolean)
  const images = []
  const notes = []
  let total = 0
  for (const item of list.slice(0, MAX_FILES)) {
    try {
      const { name, buf, mime } = await read(item)
      const type = sniff(buf) || mime
      if (type === "application/pdf") notes.push(T.pdf(name))
      else if (!Object.values(TYPES).includes(type)) notes.push(T.notImage(name))
      else if ((total += buf.length) > MAX_BYTES) notes.push(T.tooBig(name))
      else images.push({ name, mime: type, b64: buf.toString("base64") })
    } catch (e) {
      notes.push(T.unreadable(item.length > 120 ? `${item.slice(0, 117)}…` : item, e?.code || e?.message || String(e)))
    }
  }
  if (list.length > MAX_FILES) notes.push(T.tooMany(MAX_FILES))
  return { images, notes }
}

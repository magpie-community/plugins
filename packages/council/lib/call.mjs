// One request to one model, on the API it speaks, with what it can take:
// images in that API's own form, and its reasoning level in that API's own
// field. No max_tokens: magpie gives each model its own output limit. Never
// throws: a failure comes back classified, so the others answer as usual.

import { classify } from "./health.mjs"
import { postJSON } from "./gateway.mjs"

const dataURL = (img) => `data:${img.mime};base64,${img.b64}`

export function build(m, { system, text, images = [] }, level) {
  if (m.protocol === "messages") {
    const content = images.length
      ? [...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } })), { type: "text", text }]
      : text
    const body = { model: m.id, stream: false, messages: [{ role: "user", content }] }
    if (system) body.system = system
    if (level) {
      body.output_config = { effort: level }
      body.thinking = { type: "adaptive" }
    }
    return { path: "/v1/messages", body }
  }
  if (m.protocol === "responses") {
    const content = [{ type: "input_text", text }, ...images.map((img) => ({ type: "input_image", image_url: dataURL(img) }))]
    const body = { model: m.id, stream: false, input: [{ role: "user", content }] }
    if (system) body.instructions = system
    if (level) body.reasoning = { effort: level }
    return { path: "/v1/responses", body }
  }
  const content = images.length
    ? [{ type: "text", text }, ...images.map((img) => ({ type: "image_url", image_url: { url: dataURL(img) } }))]
    : text
  const body = { model: m.id, stream: false, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content }] }
  if (level) body.reasoning_effort = level
  return { path: "/v1/chat/completions", body }
}

export function textOf(m, b) {
  if (!b || typeof b !== "object") return undefined
  let t
  if (m.protocol === "messages") {
    t = Array.isArray(b.content) ? b.content.filter((p) => p?.type === "text").map((p) => p.text).join("") : undefined
  } else if (m.protocol === "responses") {
    t =
      typeof b.output_text === "string" && b.output_text
        ? b.output_text
        : (b.output || []).flatMap((x) => x?.content || []).filter((p) => p?.type === "output_text").map((p) => p.text).join("")
  } else {
    const c = b.choices?.[0]?.message?.content
    t = Array.isArray(c) ? c.map((p) => p?.text || "").join("") : c
  }
  return typeof t === "string" ? t.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : undefined
}

const errorOf = (j, text, status) => {
  const e = j?.error
  return (typeof e === "string" ? e : e?.message) || j?.message || (text && text.length < 300 ? text.trim() : "") || `HTTP ${status}`
}

// a vendor that turns the reasoning field away is asked once more without it
const REASONING_REFUSED = /thinking|effort|reasoning|output_config|unknown (field|parameter|param)|extra (inputs|fields)|unrecognized|not permitted|unsupported param/i

export async function talk(o, m, prompt, { level, signal }) {
  const t0 = Date.now()
  let lv = level || null
  for (let attempt = 0; attempt < 2; attempt++) {
    const req = build(m, prompt, lv)
    let res
    try {
      res = await postJSON(o, req.path, req.body, signal)
    } catch (e) {
      if (signal?.aborted) {
        const why = signal.reason?.message || "aborted"
        return { ok: false, ms: Date.now() - t0, kind: signal.reason?.kind || "timeout", why, level: lv }
      }
      const why = String(e?.message || e)
      return { ok: false, ms: Date.now() - t0, kind: classify(0, why), why, level: lv }
    }
    if (res.ok) {
      const text = textOf(m, res.json)
      if (text) return { ok: true, ms: Date.now() - t0, text, level: lv }
      if (lv && attempt === 0) {
        lv = null // all of it went on thinking: once more without
        continue
      }
      return { ok: false, ms: Date.now() - t0, kind: "empty", why: "empty answer", level: lv }
    }
    const why = errorOf(res.json, res.text, res.status)
    if (lv && attempt === 0 && res.status === 400 && REASONING_REFUSED.test(why)) {
      lv = null
      continue
    }
    return { ok: false, ms: Date.now() - t0, kind: classify(res.status, why), why: why.slice(0, 300), status: res.status, level: lv }
  }
}

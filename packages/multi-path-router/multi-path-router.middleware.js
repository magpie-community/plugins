// Adaptive scenario-based & time-aware multi-path token router for magpie:
// 1. Modality gating (images -> vision target)
// 2. Scale gating (tokens >= threshold -> long-context target)
// 3. Time-window arbitrage: CST DeepSeek off-peak hours
//    - Weekdays: 12:00-14:00 (Lunch), 18:00-09:00 (Night/Morning)
//    - Weekends: Full 48h
//    Dynamically routes heavy/standard tasks to high-value models (e.g. DeepSeek-Reasoner / V3)
// 4. Fallback mappings & preserving the asked model name in replies

export function isDeepSeekOffPeak(d) {
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return false

  // Normalize to CST (UTC+8)
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000)
  const cst = new Date(utc + (8 * 3600000))

  const day = cst.getDay() // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return true // Weekend full off-peak

  const hours = cst.getHours()
  const minutes = cst.getMinutes()
  const time = hours + minutes / 60.0

  // Standard peak windows: 09:00-12:00, 14:00-18:00
  const isMorningPeak = (time >= 9.0 && time < 12.0)
  const isAfternoonPeak = (time >= 14.0 && time < 18.0)

  return !(isMorningPeak || isAfternoonPeak)
}

function hasImage(body) {
  if (!body || typeof body !== "object") return false

  // Anthropic / Chat messages
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m?.content)) {
        for (const part of m.content) {
          if (part?.type === "image" || part?.type === "image_url") return true
        }
      }
    }
  }

  // Responses input items
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (part?.type === "input_image" || part?.type === "image_url") return true
        }
      }
    }
  }

  // Gemini contents
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      if (Array.isArray(c?.parts)) {
        for (const p of c.parts) {
          if (p?.inlineData || p?.inline_data || p?.fileData || p?.file_data) return true
        }
      }
    }
  }

  return false
}

function estimateTokens(body) {
  if (!body || typeof body !== "object") return 0
  let chars = 0

  const countStr = (s) => { if (typeof s === "string") chars += s.length }

  countStr(body.system)
  if (Array.isArray(body.system)) {
    for (const b of body.system) countStr(b?.text)
  }

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m?.content === "string") countStr(m.content)
      else if (Array.isArray(m?.content)) {
        for (const p of m.content) countStr(p?.text)
      }
    }
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item?.content === "string") countStr(item.content)
      else if (Array.isArray(item?.content)) {
        for (const p of item.content) countStr(p?.text || p?.input_text)
      }
    }
  }

  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      if (Array.isArray(c?.parts)) {
        for (const p of c.parts) countStr(p?.text)
      }
    }
  }

  return Math.ceil(chars / 4)
}

function resolveMap(model, mapping) {
  if (!mapping || typeof mapping !== "object" || !model) return null
  if (mapping[model]) return mapping[model]
  if (mapping["*"]) return mapping["*"]

  for (const [pattern, target] of Object.entries(mapping)) {
    if (pattern.startsWith("/") && pattern.endsWith("/")) {
      try {
        const re = new RegExp(pattern.slice(1, -1))
        if (re.test(model)) return target
      } catch {
        // ignore invalid regex
      }
    }
  }
  return null
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return
  if (body.model === null || typeof body.model !== "string") return

  const options = ctx.options || {}
  const original = body.model
  let target = null

  // 1. Modality Gate (Images)
  if (options.constraints?.vision && hasImage(body)) {
    target = options.constraints.vision
  }

  // 2. Scale Gate (Context Length)
  if (!target && options.constraints?.tokens_gte) {
    const conf = options.constraints.tokens_gte
    const threshold = typeof conf === "number" ? conf : (conf.threshold || 64000)
    const tgt = typeof conf === "object" ? conf.target : null
    if (tgt && estimateTokens(body) >= threshold) {
      target = tgt
    }
  }

  // 3. Time-Window Arbitrage (DeepSeek CST Off-peak)
  if (!target && options.schedule?.offpeak_mapping) {
    const isOffPeak = isDeepSeekOffPeak(options.now || new Date())
    if (isOffPeak) {
      target = resolveMap(original, options.schedule.offpeak_mapping)
    }
  }

  // 4. Default / Standard Mappings
  if (!target && options.mapping) {
    target = resolveMap(original, options.mapping)
  }

  if (target && target !== original) {
    ctx.state.asked = original
    body.model = target
    return body
  }
}

export function onEvent(ev, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options?.keep_upstream_name) return

  if (ev.type === "message_start" && ev.message && typeof ev.message.model === "string") {
    ev.message.model = asked
    return ev
  }
  if (typeof ev.model === "string" && ev.model !== asked) {
    ev.model = asked
    return ev
  }
  if (ev.response && typeof ev.response.model === "string") {
    ev.response.model = asked
    return ev
  }
  if (typeof ev.modelVersion === "string" && ev.modelVersion !== asked) {
    ev.modelVersion = asked
    return ev
  }
}

export function onResponse(body, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options?.keep_upstream_name || ctx.status >= 400) return

  if (typeof body.model === "string") {
    body.model = asked
    return body
  }
  if (body.response && typeof body.response.model === "string") {
    body.response.model = asked
    return body
  }
  if (typeof body.modelVersion === "string" && body.modelVersion !== asked) {
    body.modelVersion = asked
    return body
  }
}

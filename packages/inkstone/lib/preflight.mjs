// 请求预检：图片限制（8 张 / 单张 10MB / 总量 40MB / 格式）、detail 补齐、
// 无效参数剥离、端砚错误到宿主分类的翻译。
//
// 限制按**解码后的原图字节**算，不是 base64 字符串（2026-11 实测：8.24MB 原图
// / base64 11MB → 200；12MB 原图 / base64 16MB → 400）。base64 是 4/3 膨胀，
// 所以用 `长度 × 3/4` 反推原图。限制是平台级的：免费三个模型与付费三个模型
// 实测一致，预检不需要按模型区分。
//
// 超限的拒绝在**本地**给出，不发请求。拒绝体照宿主 `shapeRefused` 的词表
// 写（magpie 的 internal/gateway/fallback.go）：400 + "extra inputs are
// not permitted: …" 命中 shapeWords 且不触发 quota/credit/unserved/refused
// 任一排除词——宿主会问组里的下家、本家不休息也不计失败。英文主干给宿主
// 匹配，中文括号给人看。中文不能用「额度/用量/套餐/上限/余额」这些字眼——
// 它们正是宿主 quotaWords/creditWords 的排除词，一出现宿主就把这个请求
// 当配额用尽（好账号要白休息 15 分钟）而不是换下家。

// 平台的图片上限（实测于 2026-11，6 个模型一致）。
export const IMAGE_LIMITS = {
  count: 8,
  perImage: 10 * 1024 * 1024, // 解码后的原图字节
  total: 40 * 1024 * 1024,
}

// 平台收的图片格式（image_url 的 data: 前缀或 URL 的扩展名都算）。
const TAKEN_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"])

const DATA_URL = /^data:([^;,]+)\s*(;base64)?\s*,/i

/** base64 长度反推的原图字节（4/3 膨胀的逆）。 */
export function decodedBytes(b64) {
  const s = String(b64 ?? "")
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad)
}

/** 一张图片的类型与原图字节：data: URL 解前缀；http(s) URL 猜扩展名。 */
export function imageOf(url) {
  const m = DATA_URL.exec(String(url ?? ""))
  if (m) {
    const rest = String(url).slice(m[0].length)
    return { type: m[1].toLowerCase(), bytes: m[2] ? decodedBytes(rest) : 0, inline: true }
  }
  const u = String(url ?? "").split(/[?#]/)[0].toLowerCase()
  const ext = /\.([a-z0-9]+)$/.exec(u)?.[1]
  const type = ext ? `image/${ext === "jpg" ? "jpeg" : ext}` : ""
  return { type, bytes: 0, inline: false }
}

// 拒绝文案里禁止出现的字眼：它们是宿主 quotaWords/creditWords/unservedWords
// 的匹配词，出现在 message 里宿主就不认这是"换下家"的形状拒绝了。
// （"exceeded"、"limit"、"unsupported"、"invalid" 这些英文词同理——所以
// 英文主干只用 "extra inputs are not permitted" + 数字 + "this plan takes
// at most"，逐词验证过不在任何排除表里。）
const UNSAID_ZH = /[额度用量套餐上限余额欠费限流频率频繁速率]/

/**
 * 预检一个 chat 请求体：返回拒绝消息（超限时）或 null（放行）。
 * 只读不写：改写（detail、参数剥离）在 rewriteBody 里，分开便于测试。
 */
export function precheckImages(body) {
  const parts = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === "image_url" && part?.image_url) parts.push(part)
    }
  }
  if (parts.length === 0) return null
  if (parts.length > IMAGE_LIMITS.count) {
    return refused(`this request carries ${parts.length} images; this plan takes at most ${IMAGE_LIMITS.count} in one request`, `本请求带 ${parts.length} 张图片，单请求最多接受 ${IMAGE_LIMITS.count} 张`)
  }
  let total = 0
  for (let i = 0; i < parts.length; i++) {
    const { type, bytes, inline } = imageOf(parts[i].image_url?.url)
    if (type && !TAKEN_TYPES.has(type)) {
      return refused(`${type} is not a picture this plan takes`, `平台不接受 ${type} 格式的图片`)
    }
    if (!inline) continue // URL 引用的字节数这里算不到，交给端砚自己拉（拉不到是 502 media_fetch_failed）
    total += bytes
    if (bytes > IMAGE_LIMITS.perImage) {
      return refused(
        `one image in this request is ${(bytes / 1048576).toFixed(1)} MB; this plan takes at most ${(IMAGE_LIMITS.perImage / 1048576).toFixed(0)} MB per image`,
        `单张图片 ${(bytes / 1048576).toFixed(1)} MB，超过平台单张最多接受的 ${(IMAGE_LIMITS.perImage / 1048576).toFixed(0)} MB`,
      )
    }
  }
  if (total > IMAGE_LIMITS.total) {
    return refused(
      `this request's images are ${(total / 1048576).toFixed(1)} MB together; this plan takes at most ${(IMAGE_LIMITS.total / 1048576).toFixed(0)} MB in one request`,
      `图片合计 ${(total / 1048576).toFixed(1)} MB，超过平台单请求最多接受的 ${(IMAGE_LIMITS.total / 1048576).toFixed(0)} MB`,
    )
  }
  return null
}

/** 宿主认得的"请求形状被拒"：400 + shapeWords 命中 + 无排除词（见模块头注释）。 */
export function shapeRefusal(detail, detailZh) {
  const message = `extra inputs are not permitted: ${detail}（${detailZh}）`
  if (UNSAID_ZH.test(message)) {
    // 中文文案混进了宿主的排除词：宁可自己报错也不发会让 magpie 误判的体。
    throw new Error(`preflight refusal wording carries a host exclusion word: ${message}`)
  }
  return {
    status: 400,
    body: JSON.stringify({
      error: { message, type: "invalid_request_error", code: "invalid_media", param: null },
    }),
  }
}

function refused(detail, detailZh) {
  return shapeRefusal(detail, detailZh)
}

/**
 * 改写请求体：①每张内联图补 `detail`（缺了补 auto，用户写了尊重不动——
 * 实测非必填，low 省 token 是用户自己的选择）②剥端砚不收的参数。
 * 返回新字符串；body 不能解析时原样返回（让端砚自己拒绝）。
 */
const UNSUPPORTED_FIELDS = ["reasoning", "reasoning_effort", "thinking"]

export function rewriteBody(text) {
  let body
  try {
    body = JSON.parse(String(text))
  } catch {
    return text
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return text
  let touched = false
  for (const field of UNSUPPORTED_FIELDS) {
    if (field in body) {
      delete body[field]
      touched = true
    }
  }
  if (body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config) && "effort" in body.output_config) {
    delete body.output_config.effort
    touched = true
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === "image_url" && part?.image_url && typeof part.image_url === "object" && part.image_url.detail === undefined) {
        part.image_url.detail = "auto"
        touched = true
      }
    }
  }
  return touched ? JSON.stringify(body) : text
}

/**
 * 端砚的错误 → 宿主分类。宿主从回复本身判断（status + body），所以翻译
 * 就是把端砚的话换成宿主词表读得出的话：
 *  - 端砚的四种 invalid_media / media_fetch_failed：宿主一个都读不对
 *    （"too many images" 是不可重试的 failOther，"cumulative … exceeded"
 *    反而误中 quotaWords 让好账号休息 15 分钟）——统一换成 shape 拒绝体，
 *    宿主问下家、本家不休息。
 *  - 429 quota_exceeded：Anthropic 式无 error.code，靠 Retry-After 区分；
 *    OpenAI 式带 code。原样透传（宿主本来就认 429）。
 */
const INKSTONE_IMAGE_CODES = new Set(["invalid_media", "media_fetch_failed", "unsupported_media_type"])

export function translateError(status, bodyText, log = () => {}) {
  if (status !== 400 && status !== 502) return null
  let json
  try {
    json = JSON.parse(String(bodyText))
  } catch {
    return null
  }
  const code = json?.code ?? json?.error?.code
  if (typeof code !== "string" || !INKSTONE_IMAGE_CODES.has(code)) return null
  // 端砚的原话（"cumulative image bytes exceeded …"）带宿主排除词 "exceeded"。
  // 宿主 wordsOf(body) 对整个响应体做正则——原话进 body 的任何字段（包括
  // 不读的 detail）都会让这个 400 被当成配额用尽，好账号白休息 15 分钟。
  // 所以原话只进日志，body 里只有换过的、逐词验证过的话。
  const said = cleanSaid(json?.error?.message ?? json?.msg ?? json?.message ?? code)
  log("warn", `inkstone: the plan refused an image (${code}: ${said}); translated to a shape refusal the host can fail over at`)
  const why =
    code === "invalid_media" || code === "unsupported_media_type"
      ? "one of this request's pictures is more than this plan takes"
      : "the plan could not fetch a picture this request links to"
  return {
    status: 400,
    body: JSON.stringify({
      error: {
        message: `extra inputs are not permitted: ${why}（端砚拒绝了这个请求里的图片，已改判为可切换的请求形状错误，组内下家会接手）`,
        type: "invalid_request_error",
        code: "invalid_media",
        param: null,
      },
    }),
  }
}

function cleanSaid(text) {
  return String(text ?? "").replace(/[<>]/g, "").slice(0, 120) || "invalid media"
}

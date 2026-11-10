// 预检层的测试：图片限制的边界、改写的正确性、错误翻译，以及最重要的——
// 我们给的拒绝体必须命中 magpie 宿主 shapeRefused 的词表且不触发任何排除词
// （词表从宿主源码 internal/gateway/fallback.go 的正则原样抄下，宿主改词表
// 时这里的测试要跟着对）。
import "./nonet.mjs"
import { describe, expect, test } from "bun:test"
import { IMAGE_LIMITS, decodedBytes, imageOf, precheckImages, rewriteBody, translateError } from "./lib/preflight.mjs"

/* ------------------------------------------------ 宿主词表（fallback.go 原样） */

const R = (s) => new RegExp(s, "i")
const HOST = {
  shapeWords: R(
    "failed to deserialize|unknown (item |content |input )?(type|variant|field|parameter)|unknown_parameter|unrecognized (request argument|field|parameter)|extra (inputs|fields) are not permitted|additional properties are not allowed|schema exceeds the maximum (nesting )?depth|schema[^\\\"]{0,60}\\bnesting depth\\b|function_declarations\\[\\d+\\]\\.parameters\\b|schema specified other fields alongside any_?of",
  ),
  quotaWords: R(
    "quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|频繁|速率|套餐|用量|上限",
  ),
  creditWords: R(
    "insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)",
  ),
  unservedWords: R(
    "model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|has no provider supported|deployment[ _]?not[ _]?found|deployment.{0,60}does ?n[o']t exist|模型.{0,12}(不存在|不支持|无权|未开通)",
  ),
  refusedWords: R("unapproved channel|illegal api invocation"),
}

/** 宿主 shapeRefused 的等价实现：400/422 + 命中形状词 + 无排除词 → 问下家不休息。 */
function hostShapeRefused(status, bodyText) {
  return (
    (status === 400 || status === 422) &&
    HOST.shapeWords.test(bodyText) &&
    !HOST.quotaWords.test(bodyText) &&
    !HOST.creditWords.test(bodyText) &&
    !HOST.unservedWords.test(bodyText) &&
    !HOST.refusedWords.test(bodyText)
  )
}

/* ------------------------------------------------ 图片模型 */

const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const img = (url, detail) => ({ type: "image_url", image_url: detail ? { url, detail } : { url } })
const body = (n, url = `data:image/png;base64,${tiny}`) => ({
  model: "Sage-A1.5",
  messages: [{ role: "user", content: [{ type: "text", text: "x" }, ...Array.from({ length: n }, () => img(url))] }],
})

describe("decodedBytes", () => {
  test("reverses the 4/3 b64 growth (no padding)", () => {
    expect(decodedBytes("AAAA")).toBe(3)
    expect(decodedBytes("AAAAA")).toBe(3) // 5*3/4=3.75 floor 3, no padding marker
  })
  test("subtracts the padding", () => {
    // tiny 是一个真实 1x1 PNG（70 字节），base64 后 96 字符、双 = 结尾。
    expect(decodedBytes(tiny)).toBe(70)
    // 多补一个 = 不改变解码语义（仍按 == 读 2 个填充）。
    expect(decodedBytes(`${tiny}=`)).toBe(70)
    expect(decodedBytes("")).toBe(0)
    expect(decodedBytes(undefined)).toBe(0)
    // 单 = 结尾的 4n+1 长度（非法长度向下取整到 2 字节）。
    const onePad = "AAAA=" // 5 chars, ends with single =
    expect(decodedBytes(onePad)).toBe(2)
  })
})

describe("imageOf", () => {
  test("reads a data: URL's type and size", () => {
    const one = imageOf(`data:image/png;base64,${tiny}`)
    expect(one.type).toBe("image/png")
    expect(one.inline).toBe(true)
    expect(one.bytes).toBe(decodedBytes(tiny))
  })
  test("data:image/jpg is read as image/jpeg (the informal type is in the wild)", () => {
    expect(imageOf("data:image/jpg;base64,AAAA").type).toBe("image/jpeg")
  })
  test("a data: URL without base64 is zero bytes", () => {
    expect(imageOf("data:image/svg+xml,<svg/>")).toEqual({ type: "image/svg+xml", bytes: 0, inline: true })
  })
  test("a URL whose extension is a known-untaken type is refused", () => {
    expect(imageOf("https://x.test/p.svg?w=1").type).toBe("image/svg")
    expect(imageOf("https://x.test/p.heic").type).toBe("image/heic")
    expect(imageOf("https://x.test/p.tif").type).toBe("image/tif")
  })
  test("a URL with an unknown (or no) extension passes — the plan fetches and judges the bytes itself", () => {
    // 每一个都曾被误判为图片类型而拒绝（真机审查，2026-11-07）
    for (const url of ["https://x.test/render.php?id=1", "https://x.test/abc.download", "https://x.test/12345.67", "https://x.test/noext", "https://x.test/a.png?w=1"]) {
      expect(imageOf(url).type).toBe("")
    }
  })
})

/* ------------------------------------------------ 边界（8/9 张、10MB、40MB、格式） */

const MB = 1048576
const b64OfRawMB = (mb) => "A".repeat(Math.round((mb * MB * 4) / 3))

describe("precheckImages", () => {
  test("eight images pass, nine are refused with the count", () => {
    expect(precheckImages(body(8))).toBeNull()
    const refusal = precheckImages(body(9))
    expect(refusal).not.toBeNull()
    expect(refusal.status).toBe(400)
    expect(refusal.body).toContain("9 images")
  })
  test("URL-referenced images count toward the cap too", () => {
    expect(precheckImages(body(8, "https://x.test/a.png"))).toBeNull()
    expect(precheckImages(body(9, "https://x.test/a.png"))).not.toBeNull()
  })
  test("a mixed base64 + URL request counts both", () => {
    const b = body(4)
    b.messages[0].content.push(...Array.from({ length: 4 }, () => img("https://x.test/a.png")))
    expect(precheckImages(b)).toBeNull()
    b.messages[0].content.push(img("https://x.test/a.png"))
    expect(precheckImages(b)).not.toBeNull()
  })
  test("a 9.9 MB image passes, a 10.1 MB one is refused", () => {
    expect(precheckImages(body(1, `data:image/png;base64,${b64OfRawMB(9.9)}`))).toBeNull()
    const refusal = precheckImages(body(1, `data:image/png;base64,${b64OfRawMB(10.1)}`))
    expect(refusal).not.toBeNull()
    expect(refusal.body).toContain("10.1 MB")
  })
  test("39 MB total passes, 41 MB is refused", () => {
    expect(precheckImages(body(4, `data:image/png;base64,${b64OfRawMB(9.5)}`))).toBeNull()
    const refusal = precheckImages(body(5, `data:image/png;base64,${b64OfRawMB(9.5)}`))
    expect(refusal).not.toBeNull()
    expect(refusal.body).toContain("together")
  })
  test("an SVG (data: or URL) is refused as a format", () => {
    expect(precheckImages(body(1, "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"))).not.toBeNull()
    expect(precheckImages(body(1, "https://x.test/picture.svg"))).not.toBeNull()
  })
  test("no images, no content array, a broken body: all pass", () => {
    expect(precheckImages({ messages: [{ role: "user", content: "hi" }] })).toBeNull()
    expect(precheckImages({})).toBeNull()
    expect(precheckImages(null)).toBeNull()
  })
})

/* ------------------------------------------------ 拒绝体必须命中宿主词表 */

describe("the refusal hits the host's shapeRefused, never its exclusions", () => {
  for (const [name, make] of [
    ["count", () => precheckImages(body(9))],
    ["per-image", () => precheckImages(body(1, `data:image/png;base64,${b64OfRawMB(10.1)}`))],
    ["total", () => precheckImages(body(5, `data:image/png;base64,${b64OfRawMB(9.5)}`))],
    ["format", () => precheckImages(body(1, "data:image/svg+xml,<svg/>"))],
  ]) {
    test(`${name}: 400 + shapeWords, no quota/credit/unserved/refused word`, () => {
      const refusal = make()
      expect(refusal.status).toBe(400)
      expect(hostShapeRefused(400, refusal.body)).toBe(true)
      // 逐词反查：哪一类误中了能直接看到
      expect(HOST.quotaWords.test(refusal.body)).toBe(false)
      expect(HOST.creditWords.test(refusal.body)).toBe(false)
      expect(HOST.unservedWords.test(refusal.body)).toBe(false)
      expect(HOST.refusedWords.test(refusal.body)).toBe(false)
      // 中英都在：英文给宿主，中文给人
      expect(refusal.body).toContain("extra inputs are not permitted")
      expect(refusal.body).toMatch(/（.+）/)
    })
  }
})

/* ------------------------------------------------ 改写 */

describe("rewriteBody", () => {
  test("adds detail: auto to every inline image lacking one", () => {
    const out = JSON.parse(rewriteBody(JSON.stringify(body(2))))
    for (const part of out.messages[0].content) {
      if (part.type === "image_url") expect(part.image_url.detail).toBe("auto")
    }
  })
  test("leaves a user's own detail alone", () => {
    const b = { messages: [{ role: "user", content: [img(`data:image/png;base64,${tiny}`, "low")] }] }
    const out = JSON.parse(rewriteBody(JSON.stringify(b)))
    expect(out.messages[0].content[0].image_url.detail).toBe("low")
  })
  test("strips the fields the plan does not take", () => {
    const b = { ...body(0), reasoning: { effort: "high" }, reasoning_effort: "high", thinking: { type: "enabled" }, output_config: { effort: "high" } }
    const out = JSON.parse(rewriteBody(JSON.stringify(b)))
    expect("reasoning" in out).toBe(false)
    expect("reasoning_effort" in out).toBe(false)
    expect("thinking" in out).toBe(false)
    expect("effort" in out.output_config).toBe(false)
  })
  test("a body that parses clean goes out byte-for-byte, not re-serialized (review N1)", () => {
    const spaced = '{\n  "model": "Sage-A1.5",\n  "messages": [ { "role": "user", "content": "hi" } ]\n}'
    expect(rewriteBody(spaced)).toBe(spaced)
  })
  test("a body that is not JSON, not an object, or already clean goes back as it came", () => {
    expect(rewriteBody("not json")).toBe("not json")
    expect(rewriteBody("[1,2]")).toBe("[1,2]")
    const clean = JSON.stringify(body(1, `data:image/png;base64,${tiny}`)).replace(/}$/,"") // keep detail-less
    const out = rewriteBody(JSON.stringify(body(1)))
    expect(() => JSON.parse(out)).not.toThrow()
    expect(rewriteBody(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))).toBe(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))
  })
})

/* ------------------------------------------------ 错误翻译 */

describe("translateError", () => {
  test("the four image refusals become shape refusals the host can switch on", () => {
    for (const [status, bodyText] of [
      [400, JSON.stringify({ code: "invalid_media", message: "too many images in request" })],
      [400, JSON.stringify({ code: "invalid_media", message: "inline image exceeds configured byte limit" })],
      [400, JSON.stringify({ code: "invalid_media", message: "cumulative image bytes exceeded configured request limit" })],
      [400, JSON.stringify({ code: "invalid_media", message: "unsupported media type" })],
      [502, JSON.stringify({ code: "media_fetch_failed", message: "could not fetch https://x.test/a.png" })],
    ]) {
      const translated = translateError(status, bodyText)
      expect(translated).not.toBeNull()
      expect(translated.status).toBe(400)
      // 宿主读得对：问下家、本家不休息——而不是 quota 误判（"exceeded" 在原话里！）
      expect(hostShapeRefused(translated.status, translated.body)).toBe(true)
      expect(HOST.quotaWords.test(translated.body)).toBe(false)
    }
  })
  test("a 400 the plan words differently, and non-JSON, pass through untranslated", () => {
    expect(translateError(400, JSON.stringify({ code: "invalid_request", message: "bad" }))).toBeNull()
    expect(translateError(400, "not json")).toBeNull()
    expect(translateError(429, JSON.stringify({ error: { code: "quota_exceeded" } }))).toBeNull()
    expect(translateError(500, JSON.stringify({ code: "invalid_media" }))).toBeNull()
  })
})

/* ------------------------------------------------ 限额常量与实测对齐 */

describe("IMAGE_LIMITS match what the platform answered", () => {
  test("8 images, 10 MB a picture, 40 MB a request", () => {
    expect(IMAGE_LIMITS.count).toBe(8)
    expect(IMAGE_LIMITS.perImage).toBe(10 * MB)
    expect(IMAGE_LIMITS.total).toBe(40 * MB)
  })
})

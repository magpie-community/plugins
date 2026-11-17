import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TEXT, languageFor, pageLanguage, languageTags, translate, insight } from "../app/i18n.mjs"
import { insights } from "../lib/summarize.mjs"
import { createHandler } from "../service.mjs"

const CJK = /[\u4e00-\u9fff]/

test("English and Chinese tables have the same keys and no empty strings", () => {
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT.zh).sort())
  for (const lang of ["en", "zh"]) for (const [k, v] of Object.entries(TEXT[lang])) assert.ok(v.trim(), `${lang} ${k}`)
  for (const [k, v] of Object.entries(TEXT.en)) assert.doesNotMatch(v, CJK, `en ${k} still Chinese`)
})

test("placeholders match between languages", () => {
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const k of Object.keys(TEXT.en)) assert.deepEqual(names(TEXT.en[k]), names(TEXT.zh[k]), k)
})

test("languageFor follows magpie's tags; untranslated languages read English", () => {
  assert.equal(languageFor("zh-CN"), "zh")
  assert.equal(languageFor("zh_Hans"), "zh")
  assert.equal(languageFor("zh-Hant-TW"), "zh-TW")
  assert.equal(languageFor("ja-JP"), "ja")
  assert.equal(languageFor("en-US"), "en")
  assert.equal(languageFor(""), "en")
  assert.equal(languageTags.zh, "zh-CN")
  assert.equal(pageLanguage("zh-TW"), "en")
  assert.equal(pageLanguage("ja-JP"), "en")
  assert.equal(pageLanguage("zh-CN"), "zh")
  // zh-TW and ja have no table yet: they must fall back to English, never Simplified Chinese
  assert.equal(translate("zh-TW", "status.loading"), TEXT.en["status.loading"])
  assert.equal(translate("ja", "status.loading"), TEXT.en["status.loading"])
  assert.equal(translate("zh", "status.loading"), "正在读取…")
  assert.equal(translate("en", "kpi.requests", { count: "1,234" }), "1,234 requests")
  assert.equal(translate("en", "kpi.requests"), "{count} requests")
  assert.equal(translate("en", "no.such.key"), "no.such.key")
})

test("insights speak the requested language with the same numbers and real Chinese names", () => {
  const mk = (agent, avgPrompt, cacheRate, prompt, errorRate) => ({ agent, kind: "agent", calls: 50, avgPrompt, cacheRate, prompt, errorRate })
  const agents = [mk("a", 30000, 0.9, 1.5e6, 0.0), mk("b", 6000, 0.4, 3e5, 0.1)]
  const names = { a: "克劳德<b>", b: "代码助手" }
  const zh = insights(agents, (a) => names[a], "zh")
  const en = insights(agents, (a) => names[a], "en")
  assert.deepEqual(zh.map((i) => i.kind), en.map((i) => i.kind))
  const zp = zh.find((i) => i.kind === "prompt").text, ep = en.find((i) => i.kind === "prompt").text
  assert.equal(zp, "克劳德<b> 每次请求平均读 30.0K token，是 代码助手 的 5.0 倍。")
  assert.equal(ep, "克劳德<b> reads an average of 30.0K tokens per request, 5.0x 代码助手.")
  // apart from user-supplied agent names, the English sentences carry no Chinese
  for (const i of en) assert.doesNotMatch(i.text.replaceAll(names.a, "").replaceAll(names.b, ""), CJK, i.kind)
  // default stays Chinese for existing callers
  assert.equal(insights(agents, (a) => names[a])[0].text, zh[0].text)
  assert.equal(insight("ja", "errors", { name: "x", rate: "10.0%" }), "x has a failure rate of 10.0%; failed requests may still consume tokens.")
})

test("interface sources outside the table carry no hardcoded Chinese", async () => {
  for (const f of ["../app/app.js", "../app/explain.js", "../lib/summarize.mjs"]) {
    const src = await readFile(new URL(f, import.meta.url), "utf8")
    const lines = src.split("\n").filter((l) => CJK.test(l) && !l.trim().startsWith("//"))
    assert.deepEqual(lines, [], f)
  }
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8")
  for (const l of html.split("\n").filter((l) => CJK.test(l))) assert.match(l, /data-t=|aria-label-t=/, l)
})

test("app.js escapes translated text it puts into HTML", async () => {
  const src = await readFile(new URL("../app/app.js", import.meta.url), "utf8")
  // every T(...) interpolated straight into markup goes through esc()
  const raw = src.split("\n").filter((l) => l.includes("<") && l.includes("${T("))
  assert.deepEqual(raw, [], "found ${T(...)} in markup without esc()")
})

async function start() {
  const dir = await mkdtemp(join(tmpdir(), "hw-i18n-"))
  const usageLog = join(dir, "usage.jsonl")
  await writeFile(usageLog, "")
  const srv = createServer()
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  srv.on("request", createHandler({ port, usageLog, dataDir: dir, token: "t".repeat(64), gatewayUrl: "http://127.0.0.1:9" }))
  return { port, close: () => srv.close() }
}

test("service serves the shared module as JavaScript and marks the page language", async () => {
  const s = await start()
  try {
    const mod = await fetch(`http://127.0.0.1:${s.port}/i18n.mjs`, { headers: { Origin: "null" } })
    assert.equal(mod.status, 200)
    assert.match(mod.headers.get("content-type"), /^text\/javascript/)
    const en = await (await fetch(`http://127.0.0.1:${s.port}/?lang=en-US`)).text()
    assert.match(en, /<html lang="en">/)
    const zh = await (await fetch(`http://127.0.0.1:${s.port}/?lang=zh-CN`)).text()
    assert.match(zh, /<html lang="zh-CN">/)
    const bad = await (await fetch(`http://127.0.0.1:${s.port}/?lang=%22%3E%3Cscript%3E`)).text()
    assert.match(bad, /<html lang="en">/)
    assert.match(await (await fetch(`http://127.0.0.1:${s.port}/?lang=ja-JP`)).text(), /<html lang="en">/)
  } finally { s.close() }
})

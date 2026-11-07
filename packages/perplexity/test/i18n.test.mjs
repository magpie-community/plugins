import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveLocale, strings, fill, LOCALES } from "../i18n.mjs"

test("both languages ship a table with the same keys", () => {
  for (const code of LOCALES) {
    const table = strings(code)
    assert.ok(table && typeof table === "object")
    assert.ok(Object.keys(table).length > 30)
  }
  const zh = Object.keys(strings("zh")).sort()
  const en = Object.keys(strings("en")).sort()
  assert.deepEqual(en, zh)
})

test("an unknown locale falls back to zh rather than throwing", () => {
  assert.equal(strings("fr"), strings("zh"))
})

test("a user-visible string never leaks an unresolved placeholder", () => {
  const t = strings("en")
  assert.equal(fill(t.proSearches, { n: 7 }), "7 Pro Searches left")
  assert.match(fill(t.cookieRejected, { status: 403, detail: "nope" }), /403.*nope/)
  // Unknown names stay visible instead of becoming "undefined".
  assert.equal(fill("a {missing} b", {}), "a {missing} b")
})

test("the locale option wins", () => {
  assert.equal(resolveLocale("en", {}, "zh-CN"), "en")
  assert.equal(resolveLocale("zh", {}, "en-US"), "zh")
  assert.equal(resolveLocale("zh-TW", {}, "en-US"), "zh")
})

test("auto follows the OS locale, then the environment, then English", () => {
  assert.equal(resolveLocale("auto", {}, "zh-CN"), "zh")
  assert.equal(resolveLocale("auto", {}, "en-GB"), "en")
  assert.equal(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }, ""), "zh")
  assert.equal(resolveLocale("auto", { LC_ALL: "C", LANG: "en_US.UTF-8" }, ""), "en")
  assert.equal(resolveLocale(undefined, {}, ""), "en")
  assert.equal(resolveLocale("auto", { LANG: "POSIX" }, ""), "en")
})

test("the English table is really English", () => {
  const t = strings("en")
  assert.equal(t.locale, "en")
  assert.match(t.sessionExpired, /expired/i)
  assert.doesNotMatch(t.toolsUnsupported, /[\u4e00-\u9fa5]/)
  assert.doesNotMatch(t.upstreamEmpty, /[\u4e00-\u9fa5]/)
})

test("the Chinese table is really Chinese", () => {
  const t = strings("zh")
  assert.match(t.sessionExpired, /[\u4e00-\u9fa5]/)
  assert.match(t.toolsUnsupported, /[\u4e00-\u9fa5]/)
})

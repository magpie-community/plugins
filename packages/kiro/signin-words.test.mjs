// mahiro233 (magpie's Discord, plugin 0.1.34): in a Chinese window the
// sheet's "Choose a sign-in method" and its choices read in English. Each
// way, question and choice gives its words in magpie's other languages
// (labels, messages, hints: magpie's own fields beside the English, which
// stays as it was for OpenCode). "AWS Builder ID" is a product's name and
// stays one, its hint aside.
import { test, expect, beforeAll } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})

const LANGS = ["zh", "zh-TW", "ja", "de"]
const each = (by, what) => {
  for (const l of LANGS) {
    expect(typeof by?.[l], `${what}: ${l}`).toBe("string")
    expect(by[l].trim().length, `${what}: ${l}`).toBeGreaterThan(0)
  }
}

test("every sign-in word has magpie's other languages, the English as it was", async () => {
  const { methods } = (await plugin({})).auth
  expect(methods.map((m) => m.label)).toEqual(["Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)", "Kiro CLI's or Kiro IDE's sign-in", "Kiro API key (ksk_…)"])
  for (const m of methods) each(m.labels, m.label)
  expect(methods[2].type).toBe("api")
  expect(methods[2].placeholder).toBe("ksk_…")
  const [pick, ...asked] = methods[0].prompts
  expect(pick.message).toBe("Choose a sign-in method")
  each(pick.messages, pick.message)
  expect(pick.options.map((o) => o.value)).toEqual(["enterprise", "builderid", "portal"])
  for (const o of pick.options) {
    each(o.hints, o.hint)
    if (o.value !== "builderid") each(o.labels, o.label)
  }
  expect(pick.options[1].labels).toBeUndefined()
  for (const q of asked) each(q.messages, q.message)
  expect([pick.messages.zh, methods[2].labels.zh]).toEqual(["选择登录方式", "Kiro API Key（ksk_…）"])
})

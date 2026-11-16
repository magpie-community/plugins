// The GUI's option page keeps at most 60 characters per localized label and
// 300 per localized description or confirm. The English `label` / `description`
// / `confirm` fields are the fallback for older hosts and OpenCode, so the
// localized `labels` / `descriptions` / `confirms` carry the same rules in
// the same five languages.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"

const languages = ["de", "ja", "zh", "zh-TW"]
const lengthOf = (text) => [...String(text)].length

test("the config screen's strings stay inside the host's caps and stay translated", async () => {
  const plugin = await InkStoneAuthPlugin({ client: { auth: { set: async () => {} } } })
  const options = plugin.auth.options
  expect(options.map((option) => option.key)).toEqual([
    "create_key",
    "prune_keys",
    "keep_sign_in",
    "reuse_kept_session",
  ])

  for (const option of options) {
    expect(lengthOf(option.label)).toBeLessThanOrEqual(60)
    expect(lengthOf(option.description)).toBeLessThanOrEqual(300)

    for (const field of ["labels", "descriptions"]) {
      const localized = option[field]
      expect(localized).toBeDefined()
      expect(Object.keys(localized).sort()).toEqual(languages)
      const cap = field === "labels" ? 60 : 300
      for (const lang of languages) {
        expect(lengthOf(localized[lang])).toBeLessThanOrEqual(cap)
      }
    }
  }

  const prune = options.find((option) => option.key === "prune_keys")
  expect(lengthOf(prune.confirm)).toBeLessThanOrEqual(300)
  expect(Object.keys(prune.confirms).sort()).toEqual(languages)
  for (const lang of languages) expect(lengthOf(prune.confirms[lang])).toBeLessThanOrEqual(300)

  // The English fallback tells every account where the line is: the key
  // created on this sign-in, and keys whose creation time is unreadable.
  expect(prune.description).toContain("The key created on this sign-in is always kept")
  expect(prune.description).toContain("manual keys")
  expect(prune.description).toContain("creation time cannot be read")
})

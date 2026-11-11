// cloak.mjs is a copy of packages/antigravity's TURNED_AWAY, cloak and hint
// (#980): these fail when the two packages stop agreeing.
import { expect, test } from "bun:test"
import { TURNED_AWAY, cloak, hint, turnsAway } from "./cloak.mjs"
import { _internal as antigravity } from "../antigravity/index.mjs"

const ZW = "​"

const samples = [
  "x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli; cch=1a2b3;",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Codex, an agent based on GPT-5. You are running as a coding agent.",
  "You are Codex, a coding agent based on GPT-5.",
  "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\n\nYou are omp.",
  "Two: RFC 2119 KEYWORDS: must, required, should, recommended, may, optional. and x-anthropic-billing-header: x",
  "Nothing to see here; Claude Agent SDK alone is fine.",
  "",
]

test("every turned-away line is broken up, and the model still reads it", () => {
  for (const s of samples) {
    const out = cloak(s)
    expect(out.replaceAll(ZW, "")).toBe(s)
    if (turnsAway(s)) {
      expect(out).not.toBe(s)
      expect(turnsAway(out)).toBe(false)
    } else {
      expect(out).toBe(s)
    }
  }
  expect(cloak("RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.")).toBe(
    `R${ZW}F${ZW}C 2${ZW}1${ZW}19 k${ZW}e${ZW}ywords: M${ZW}U${ZW}ST, R${ZW}E${ZW}QUIRED, S${ZW}H${ZW}OULD, R${ZW}E${ZW}COMMENDED, M${ZW}A${ZW}Y, O${ZW}P${ZW}TIONAL.`,
  )
})

test("agy-cli and antigravity break up and explain the same lines", () => {
  for (const line of TURNED_AWAY) {
    expect(antigravity.turnsAway(line)).toBe(true)
    expect(cloak(line)).toBe(antigravity.cloak(line))
    expect(hint(line)).toBe(antigravity.hint(line))
  }
  for (const s of samples) {
    expect(turnsAway(s)).toBe(antigravity.turnsAway(s))
    expect(cloak(s)).toBe(antigravity.cloak(s))
    expect(hint(s)).toBe(antigravity.hint(s))
  }
})

// What every number on this page means, in one place. Each entry becomes a
// small "?" that shows the explanation on hover or focus — so a reader who
// does not know the term can find out without leaving the page.
//
// The explanations name what is measured, where the number comes from, and
// what makes it misleading. Anything that is an estimate says so.
//
// The wording itself lives in i18n.mjs, beside the rest of the interface
// text; this file only says which explanation exists and where it goes.

import { translate } from "./i18n.mjs"

// The explanation for one metric, in the page's language.
export function explainFor(key, lang) {
  return {
    title: translate(lang, `explain.${key}.title`),
    body: translate(lang, `explain.${key}.body`),
  }
}

// The order the table uses, with the tooltip key for each column.
// [key, label key, is numeric, tooltip key]
export const COLS = [
  ["agent", "col.agent", false, null],
  ["calls", "col.calls", true, "calls"],
  ["prompt", "col.prompt", true, "prompt"],
  ["avgPrompt", "col.avgPrompt", true, "avgPrompt"],
  ["cacheRate", "col.cacheRate", true, "cacheRate"],
  ["fullPrice", "col.fullPrice", true, "fullPrice"],
  ["out", "col.out", true, "out"],
  ["errorRate", "col.errorRate", true, "errorRate"],
  ["p50ttft", "col.p50ttft", true, "p50ttft"],
  ["p50ms", "col.p50ms", true, "p50ms"],
  ["toolTokens", "col.toolTokens", true, "toolTokens"],
  ["protocol", "col.protocol", false, "protocol"],
  ["session", "col.session", true, "sessionMedian"],
]

// The card order: what the cards can be sorted by.
// [key, label key, tooltip key]
export const CARD_SORTS = [
  ["prompt", "sort.prompt", "prompt"],
  ["avgPrompt", "col.avgPrompt", "avgPrompt"],
  ["cacheRate", "col.cacheRate", "cacheRate"],
  ["fullPrice", "col.fullPrice", "fullPrice"],
  ["errorRate", "col.errorRate", "errorRate"],
  ["p50ms", "col.p50ms", "p50ms"],
  ["p50ttft", "col.p50ttft", "p50ttft"],
  ["toolTokens", "sort.toolTokens", "toolTokens"],
]

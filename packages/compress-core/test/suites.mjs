// test/suites.mjs — the one list of suites, shared by both entry points.
//
// `node test/run.mjs` and `bun test` (via ci.test.mjs) each used to keep their own
// copy of this list, and the copies drifted: four suites ran under node and never
// under bun, so CI silently skipped them. Keeping the names here means a new suite
// is added once and both entry points pick it up.
//
// Order matters for `node test/run.mjs` output; ci.test.mjs uses the same order so
// a failure reads the same way under either runner.
//
// page-catalog.test.mjs and page-save-flow.test.mjs are NOT here: the page/ folder
// arrives in PR 2, so those two suites do not exist in this package yet. Add them
// when it lands.
export const suites = [
  "capture-store.test.mjs",
  "capture-command.test.mjs",
  "redact.test.mjs",
  "lab.test.mjs",
  "approved-lite.test.mjs",
  "gateway-cases.test.mjs",
  "engine-cases.test.mjs",
  "prefix-stability.test.mjs",
  "lite.test.mjs",
  "session-dedup.test.mjs",
  "headroom.test.mjs",
  "codex-responses.test.mjs",
  "rtk.test.mjs",
  "observability.test.mjs",
  "relevance.test.mjs",
  "ultra.test.mjs",
  "caveman.test.mjs",
  "aggressive.test.mjs",
  "ionizer.test.mjs",
  "llm.test.mjs",
  "ccr.test.mjs",
  "ccr-persist.test.mjs",
  "active-shapes.test.mjs",
  "read-lifecycle.test.mjs",
  "body-limit.test.mjs",
  "audit.test.mjs",
  "config-contract.test.mjs",
  "performance.test.mjs",
]

/**
 * Every *.test.mjs in test/ that is neither this package's bun entry point
 * (ci.test.mjs) nor listed above. A new suite someone forgot to register shows up
 * here, which is how the two lists drift apart in the first place.
 */
export function unlistedSuites(files) {
  const known = new Set([...suites, "ci.test.mjs"])
  return files.filter((f) => f.endsWith(".test.mjs") && !known.has(f)).sort()
}

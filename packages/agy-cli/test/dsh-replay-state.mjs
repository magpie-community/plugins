import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose renderInitialPrompt from an isolated copy without adding production exports.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-state-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { renderInitialPrompt, extractMetaRemindersFromText };\n")
const { renderInitialPrompt, extractMetaRemindersFromText } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const joinText = ({ parts }) => parts.map((p) => p.text || "").join("")
const LIMIT = 112 * 1024

// Verbatim reminder builders matching DeepSeek Harness (@deepseek-ai/dsh-agent-instructions,
// @deepseek-ai/dsh-tool-skill, and @deepseek-ai/dsh-agent-loop).
const AGENT_INSTRUCTIONS_INTRO =
  "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions."
const REPLACEMENT_BASELINE_INTRO =
  "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. " +
  AGENT_INSTRUCTIONS_INTRO
const EMPTY_REPLACEMENT_INTRO =
  "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active."
const COMPACT_INTRO =
  "Workspace instructions were omitted or truncated to fit the configured byte budget."
const ADDITIONAL_GUIDANCE =
  "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions."

const reminderMsg = (body) => ({
  role: "user",
  content: [{ type: "text", text: `<system-reminder>\n${body}\n</system-reminder>` }],
})

const baselineMsg = (files, { replace = false, budgetLine = "", compact = false } = {}) => {
  const intro = compact
    ? COMPACT_INTRO
    : replace
      ? (files.length === 0 ? EMPTY_REPLACEMENT_INTRO : REPLACEMENT_BASELINE_INTRO)
      : AGENT_INSTRUCTIONS_INTRO
  const sections = files.map(({ path: filePath, content }) => `Instructions from: ${filePath}\n\n${content}`)
  return reminderMsg([budgetLine, intro, ...sections].filter(Boolean).join("\n\n"))
}

const changesMsg = (changes, { budgetLine = "", compact = false } = {}) => {
  const sections = changes.map((c) => {
    if (c.action === "add") {
      const applicability = c.scope === "user-global"
        ? "These user-global instructions apply to all work."
        : `These instructions apply to work under \`${c.scope}\`.`
      return `Additional instructions from: ${c.path}\n\n${applicability} ${ADDITIONAL_GUIDANCE}\n\n${c.content}`
    }
    if (c.action === "remove") {
      return `Instructions removed: ${c.path}\n\nThe previously loaded instructions from this file no longer apply.`
    }
    return [
      `Updated instructions from: ${c.path}`,
      "",
      "This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.",
      "",
      c.content,
    ].join("\n")
  })
  return reminderMsg([budgetLine, compact ? COMPACT_INTRO : "", ...sections].filter(Boolean).join("\n\n"))
}

const skillCatalogMsg = (entries, { update = false } = {}) => {
  const header = update
    ? "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:"
    : "A skill is a reusable set of task-specific instructions. The following skills are available in this session:"
  const footer = update
    ? "Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting."
    : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded."
  const lines = entries.map(([name, desc]) => `- \`${name}\`: ${desc}`)
  return reminderMsg([
    header,
    "",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "",
    footer,
    "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
  ].join("\n"))
}

const sessionInfoMsg = (body, { update = false } = {}) => {
  const intro = update
    ? "The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries."
    : "The following information describes your current session:"
  return reminderMsg(`${intro}\n\n${body}`)
}

const clearedRuntimeContextMsg = () =>
  reminderMsg("Current runtime context: none. Earlier runtime-context snapshots no longer apply.")

const pushFillerTurns = (messages, count = 40, size = 2500) => {
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `turn ${i} ` + "x".repeat(size) }] })
    messages.push({ role: "assistant", content: [{ type: "text", text: `reply ${i} ` + "y".repeat(size) }] })
  }
}

test("preserves latest <available_skills>, updated instructions, and updated session info across >112 KiB replay", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Initialize project plan" }] },
    baselineMsg([
      { path: "~/.dsh/AGENTS.md", content: "Old global rule v1" },
    ]),
    sessionInfoMsg('Current working directory: "/repo".'),
    skillCatalogMsg([["old-skill", "stale skill"]]),
    { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] },
    changesMsg([
      {
        action: "update",
        path: "~/.dsh/AGENTS.md",
        content: "New global rule v2 (even if docs mention <available_skills></available_skills>)",
      },
    ]),
    sessionInfoMsg('Current working directory: "/repo/packages/api".', { update: true }),
    skillCatalogMsg([["lark-doc", "Feishu doc skill"]], { update: true }),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Read this Feishu doc and update the code" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo/packages/api", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("`lark-doc`: Feishu doc skill"))
  assert.ok(!text.includes("`old-skill`: stale skill"))
  assert.ok(text.includes("New global rule v2"))
  assert.ok(!text.includes("Old global rule v1"))
  assert.ok(text.includes('Current working directory: "/repo/packages/api".'))
  assert.ok(!text.includes('Current working directory: "/repo".'))
  assert.ok(text.includes("Read this Feishu doc and update the code"))
})

test("replacement baseline supersedes earlier baseline and earlier change batches", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Start in repo A" }] },
    baselineMsg([
      { path: "~/.dsh/AGENTS.md", content: "STALE_BASELINE_GLOBAL" },
      { path: "AGENTS.md", content: "STALE_BASELINE_REPO_A" },
    ]),
    { role: "assistant", content: [{ type: "text", text: "Working in repo A." }] },
    changesMsg([
      { action: "add", path: "legacy/AGENTS.md", scope: "legacy", content: "STALE_PRE_REPLACEMENT_ADD" },
    ]),
    { role: "assistant", content: [{ type: "text", text: "Switching workspace root." }] },
    baselineMsg(
      [
        { path: "~/.dsh/AGENTS.md", content: "ACTIVE_REPLACEMENT_GLOBAL" },
        { path: "packages/web/AGENTS.md", content: "ACTIVE_REPLACEMENT_WEB" },
      ],
      { replace: true },
    ),
    changesMsg([
      { action: "add", path: "packages/web/ui/AGENTS.md", scope: "packages/web/ui", content: "ACTIVE_POST_REPLACEMENT_ADD" },
    ]),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Update the web UI button" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo/packages/web", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("ACTIVE_REPLACEMENT_GLOBAL"))
  assert.ok(text.includes("ACTIVE_REPLACEMENT_WEB"))
  assert.ok(text.includes("ACTIVE_POST_REPLACEMENT_ADD"))
  assert.ok(!text.includes("STALE_BASELINE_GLOBAL"))
  assert.ok(!text.includes("STALE_BASELINE_REPO_A"))
  assert.ok(!text.includes("STALE_PRE_REPLACEMENT_ADD"))
})

test("empty replacement baseline drops stale initial baseline instead of pinning it", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Start session with instructions" }] },
    baselineMsg([
      { path: "~/.dsh/AGENTS.md", content: "STALE_INITIAL_RULE" },
    ]),
    { role: "assistant", content: [{ type: "text", text: "Loaded initial instructions." }] },
    changesMsg([
      { action: "add", path: "sub/AGENTS.md", scope: "sub", content: "STALE_ADDED_RULE" },
    ]),
    baselineMsg([], { replace: true }),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Continue without workspace instructions" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/tmp/clean", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("No workspace instructions are currently active."))
  assert.ok(!text.includes("STALE_INITIAL_RULE"))
  assert.ok(!text.includes("STALE_ADDED_RULE"))

  // Standalone empty replacement text (without the preceding sentence) and
  // replacement baseline arriving in <current_turn> must drop stale history too.
  const standalone = [
    { role: "user", content: [{ type: "text", text: "Start" }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "STALE_STANDALONE_RULE" }]),
    reminderMsg("No workspace instructions are currently active."),
  ]
  pushFillerTurns(standalone)
  standalone.push({ role: "user", content: [{ type: "text", text: "Continue" }] })
  const standaloneText = joinText(renderInitialPrompt({ system: "You are DSH.", messages: standalone }, "/tmp/clean", false, 0))
  assert.ok(Buffer.byteLength(standaloneText, "utf8") <= LIMIT)
  assert.ok(standaloneText.includes("No workspace instructions are currently active."))
  assert.ok(!standaloneText.includes("STALE_STANDALONE_RULE"))

  const inCurrent = [
    { role: "user", content: [{ type: "text", text: "Start" }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "STALE_BEFORE_CURRENT_REPLACEMENT" }]),
  ]
  pushFillerTurns(inCurrent)
  inCurrent.push(baselineMsg([], { replace: true }))
  inCurrent.push({ role: "user", content: [{ type: "text", text: "Continue" }] })
  const inCurrentText = joinText(renderInitialPrompt({ system: "You are DSH.", messages: inCurrent }, "/tmp/clean", false, 0))
  assert.ok(Buffer.byteLength(inCurrentText, "utf8") <= LIMIT)
  assert.ok(inCurrentText.includes("No workspace instructions are currently active."))
  assert.ok(!inCurrentText.includes("STALE_BEFORE_CURRENT_REPLACEMENT"))
})

test("handles multi-file change batches with Updated, Additional, and Instructions removed", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Work across monorepo packages" }] },
    baselineMsg([
      { path: "~/.dsh/AGENTS.md", content: "GLOBAL_V1" },
      { path: "AGENTS.md", content: "ROOT_V1" },
    ]),
    { role: "assistant", content: [{ type: "text", text: "Ready." }] },
    // Batch 1: updates global + root AND adds pkg/a + pkg/b in a single reminder.
    changesMsg([
      { action: "update", path: "~/.dsh/AGENTS.md", content: "GLOBAL_V2" },
      { action: "update", path: "AGENTS.md", content: "ROOT_V2_ACTIVE" },
      { action: "add", path: "pkg/a/AGENTS.md", scope: "pkg/a", content: "PKG_A_ACTIVE" },
      { action: "add", path: "pkg/b/AGENTS.md", scope: "pkg/b", content: "PKG_B_SHOULD_DROP" },
    ]),
    // Batch 2: updates global again and removes pkg/b, plus adds pkg/c which is later removed alone.
    changesMsg([
      { action: "add", path: "pkg/c/AGENTS.md", scope: "pkg/c", content: "PKG_C_SHOULD_DROP" },
    ]),
    changesMsg([
      { action: "update", path: "~/.dsh/AGENTS.md", content: "GLOBAL_V3_ACTIVE" },
      { action: "remove", path: "pkg/b/AGENTS.md" },
      { action: "remove", path: "pkg/c/AGENTS.md" },
    ]),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Check rules across packages" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  // Both baseline files were superseded by Batch 1 -> stale baseline dropped.
  assert.ok(!text.includes("GLOBAL_V1"))
  assert.ok(!text.includes("ROOT_V1"))
  // Batch 1 stays because ROOT_V2_ACTIVE and PKG_A_ACTIVE were not superseded later.
  assert.ok(text.includes("ROOT_V2_ACTIVE"))
  assert.ok(text.includes("PKG_A_ACTIVE"))
  // Batch 2 (solo add of pkg/c) was fully superseded by removal in Batch 3 -> dropped.
  assert.ok(!text.includes("PKG_C_SHOULD_DROP"))
  // Batch 3 stays for GLOBAL_V3_ACTIVE and removal notices for pkg/b & pkg/c.
  assert.ok(text.includes("GLOBAL_V3_ACTIVE"))
  assert.ok(text.includes("Instructions removed: pkg/b/AGENTS.md"))
  assert.ok(text.includes("Instructions removed: pkg/c/AGENTS.md"))
})

test("recognizes budget-prefixed baselines, compact baselines, and budget-prefixed change batches", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Start under tight instruction budget" }] },
    baselineMsg(
      [{ path: "AGENTS.md", content: "BUDGET_BASELINE_V1" }],
      { budgetLine: "Workspace instruction budget 16384 bytes: omitted ~/.dsh/AGENTS.md; truncated AGENTS.md from 20000 to 15000 bytes" },
    ),
    { role: "assistant", content: [{ type: "text", text: "Understood." }] },
    changesMsg(
      [
        { action: "add", path: "pkg/x/AGENTS.md", scope: "pkg/x", content: "BUDGET_ADDED_PKG_X" },
      ],
      { budgetLine: "Workspace instruction budget 4096 bytes: truncated pkg/x/AGENTS.md from 8000 to 3600 bytes" },
    ),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Apply budget-clipped rules" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("BUDGET_BASELINE_V1"))
  assert.ok(text.includes("BUDGET_ADDED_PKG_X"))

  // Also verify compact budget fallback baseline is superseded cleanly when replaced.
  const compactMsgs = [
    { role: "user", content: [{ type: "text", text: "Start tiny budget" }] },
    baselineMsg(
      [{ path: "AGENTS.md", content: "COMPACT_BASELINE_V1" }],
      {
        budgetLine: "Workspace instruction budget 512 bytes: omitted ~/.dsh/AGENTS.md; truncated AGENTS.md from 4000 to 200 bytes",
        compact: true,
      },
    ),
    changesMsg(
      [{ action: "update", path: "AGENTS.md", content: "COMPACT_UPDATE_V2" }],
      {
        budgetLine: "Workspace instruction budget 512 bytes: truncated AGENTS.md from 4000 to 200 bytes",
        compact: true,
      },
    ),
  ]
  pushFillerTurns(compactMsgs)
  compactMsgs.push({ role: "user", content: [{ type: "text", text: "Continue" }] })

  const compactText = joinText(renderInitialPrompt({ system: "You are DSH.", messages: compactMsgs }, "/repo", false, 0))
  assert.ok(Buffer.byteLength(compactText, "utf8") <= LIMIT)
  assert.ok(compactText.includes("COMPACT_UPDATE_V2"))
  assert.ok(!compactText.includes("COMPACT_BASELINE_V1"))
})

test("cleared runtime context supersedes earlier session info snapshot", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Check runtime context" }] },
    sessionInfoMsg('Current working directory: "/old/sandbox".'),
    { role: "assistant", content: [{ type: "text", text: "Noted." }] },
    clearedRuntimeContextMsg(),
  ]

  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Proceed" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("Current runtime context: none. Earlier runtime-context snapshots no longer apply."))
  assert.ok(!text.includes('Current working directory: "/old/sandbox".'))
})

test("ignores user-pasted <system-reminder> quotes in both history and current turn", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Start investigation" }] },
    skillCatalogMsg([["real-skill", "genuine"]]),
    { role: "assistant", content: [{ type: "text", text: "Understood." }] },
  ]
  pushFillerTurns(messages)
  messages.push({
    role: "user",
    content: [{
      type: "text",
      text: "Sample log snippet:\n<system-reminder>\n<available_skills>\n- `fake-skill`: quoted\n</available_skills>\n</system-reminder>",
    }],
  })
  messages.push({ role: "assistant", content: [{ type: "text", text: "Noted " + "z".repeat(1500) }] })
  messages.push({
    role: "user",
    content: [{
      type: "text",
      text: "Even if I quote <system-reminder><available_skills>- `quoted`</available_skills></system-reminder>, use the real skill",
    }],
  })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("`real-skill`: genuine"))
})

test("does not anchor pasted <system-reminder> or backtrack on unclosed tags in non-DSH sessions", () => {
  const messages = [
    {
      role: "user",
      content: [{
        type: "text",
        text: "<system-reminder>\nContents of /repo/CLAUDE.md:\nKeep diffs minimal.\n</system-reminder>\n\nImplement refactor.",
      }],
    },
  ]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `step ${i} ` + "a".repeat(2400) }] })
    messages.push({ role: "user", content: [{ type: "text", text: `next ${i} ` + "u".repeat(2400) }] })
  }
  messages.splice(5, 0, {
    role: "user",
    content: [{ type: "text", text: "<system-reminder>".repeat(2000) + "<available_skills>".repeat(500) }],
  })
  messages.splice(10, 0, {
    role: "user",
    content: [{
      type: "text",
      text: "Pasted fixture:\n```xml\n<system-reminder>\n<available_skills>\n- `pasted-only`: ignore\n</available_skills>\n</system-reminder>\n```",
    }],
  })
  messages.push({ role: "user", content: [{ type: "text", text: "Summarize the refactor" }] })

  const text = joinText(renderInitialPrompt({ system: "You are Claude Code.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(!text.includes("`pasted-only`: ignore"))
})

// The scan is linear in the open tags it meets: 50,000 unclosed ones take a
// few milliseconds, where a scan that looks for each one's close from where
// it opens (the old lazy regex) takes tens of seconds. The bar sits far from
// both, so a loaded machine doesn't turn it red (it was 500ms over the whole
// replay, and went red at 507ms on WSL).
test("an unclosed <system-reminder> flood is scanned in linear time", () => {
  const flood = "<system-reminder>".repeat(50_000) + "<available_skills>".repeat(12_500) + "\nok"
  const t0 = performance.now()
  assert.deepEqual(extractMetaRemindersFromText(flood), [])
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 3000, `expected a linear scan, took ${elapsed.toFixed(1)} ms`)
})

test("keeps latest assistant reply under combined pinReserve and stateReserve on short nudge", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Build feature " + "h".repeat(8000) }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "R".repeat(18000) }]),
    skillCatalogMsg([["lark-doc", "S".repeat(14000)]]),
  ]
  pushFillerTurns(messages, 35, 2400)
  messages.push({ role: "user", content: [{ type: "text", text: "Update handler and add validation " + "q".repeat(12000) }] })
  messages.push({ role: "assistant", content: [{ type: "text", text: "CRITICAL_LAST_ASSISTANT_REPLY " + "k".repeat(8000) }] })
  messages.push({ role: "user", content: [{ type: "text", text: "continue" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("CRITICAL_LAST_ASSISTANT_REPLY"))
  assert.ok(text.includes("`lark-doc`:"))
})

test("preserves latest reply and <available_skills> when history[0] is oversized", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "HUGE_OPENING " + "O".repeat(65000) }] },
    skillCatalogMsg([["megrez-db-map", "db lookup"]]),
  ]
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `mid ${i} ` + "d".repeat(3000) }] })
    messages.push({ role: "user", content: [{ type: "text", text: `u ${i} ` + "e".repeat(3000) }] })
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "FINAL_ASSISTANT_TURN " + "F".repeat(18000) }] })
  messages.push({ role: "user", content: [{ type: "text", text: "Inspect the student table schema" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("HUGE_OPENING"))
  assert.ok(text.includes("FINAL_ASSISTANT_TURN"))
  assert.ok(text.includes("`megrez-db-map`: db lookup"))
})

test("recognizes marker-only compact-budget notice as a baseline", () => {
  const markerOnly = "Workspace instruction budget 128 bytes: omitted ~/.dsh/AGENTS.md; truncated ./AGENTS.md from 400 to 0 bytes"

  // Marker-only budget notice in history supersedes earlier baseline and changes.
  const messages = [
    { role: "user", content: [{ type: "text", text: "Start under ultra-tight budget" }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "STALE_BEFORE_MARKER_ONLY" }]),
    { role: "assistant", content: [{ type: "text", text: "Loaded." }] },
    changesMsg([{ action: "add", path: "sub/AGENTS.md", scope: "sub", content: "STALE_CHANGE_BEFORE_MARKER_ONLY" }]),
    reminderMsg(markerOnly),
  ]
  pushFillerTurns(messages)
  messages.push({ role: "user", content: [{ type: "text", text: "Proceed" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))
  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes(markerOnly))
  assert.ok(!text.includes("STALE_BEFORE_MARKER_ONLY"))
  assert.ok(!text.includes("STALE_CHANGE_BEFORE_MARKER_ONLY"))

  // Standalone compact intro without paths supersedes earlier baseline too.
  const compactOnly = [
    { role: "user", content: [{ type: "text", text: "Start" }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "STALE_BEFORE_COMPACT_ONLY" }]),
    reminderMsg(COMPACT_INTRO),
  ]
  pushFillerTurns(compactOnly)
  compactOnly.push({ role: "user", content: [{ type: "text", text: "Proceed" }] })

  const compactOnlyText = joinText(renderInitialPrompt({ system: "You are DSH.", messages: compactOnly }, "/repo", false, 0))
  assert.ok(Buffer.byteLength(compactOnlyText, "utf8") <= LIMIT)
  assert.ok(compactOnlyText.includes(COMPACT_INTRO))
  assert.ok(!compactOnlyText.includes("STALE_BEFORE_COMPACT_ONLY"))

  // Marker-only budget notice arriving in <current_turn> drops stale history baseline.
  const inCurrent = [
    { role: "user", content: [{ type: "text", text: "Start" }] },
    baselineMsg([{ path: "~/.dsh/AGENTS.md", content: "STALE_BEFORE_CURRENT_MARKER_ONLY" }]),
  ]
  pushFillerTurns(inCurrent)
  inCurrent.push(reminderMsg(markerOnly))
  inCurrent.push({ role: "user", content: [{ type: "text", text: "Proceed" }] })

  const inCurrentText = joinText(renderInitialPrompt({ system: "You are DSH.", messages: inCurrent }, "/repo", false, 0))
  assert.ok(Buffer.byteLength(inCurrentText, "utf8") <= LIMIT)
  assert.ok(inCurrentText.includes(markerOnly))
  assert.ok(!inCurrentText.includes("STALE_BEFORE_CURRENT_MARKER_ONLY"))
})

test("preserves middle of >12 KiB anchored state reminders via clipHistoryMessage preserveMeta", () => {
  const bigSkills = []
  for (let i = 0; i < 40; i++) {
    if (i === 20) {
      bigSkills.push(["middle-skill-sentinel", "MIDDLE_SKILL_MARKER_MUST_SURVIVE " + "m".repeat(450)])
    } else {
      bigSkills.push([`skill-${String(i).padStart(2, "0")}`, `entry ${i} ` + "s".repeat(480)])
    }
  }
  const bigAgents = "A".repeat(9500) + "\nMIDDLE_AGENTS_RULE_MUST_SURVIVE\n" + "B".repeat(9500)
  const skillsMessage = skillCatalogMsg(bigSkills)
  const agentsMessage = baselineMsg([{ path: "~/.dsh/AGENTS.md", content: bigAgents }])
  assert.ok(Buffer.byteLength(skillsMessage.content[0].text, "utf8") > 16 * 1024)
  assert.ok(Buffer.byteLength(agentsMessage.content[0].text, "utf8") > 16 * 1024)

  const messages = [
    { role: "user", content: [{ type: "text", text: "Run workflow using skills and workspace rules" }] },
    agentsMessage,
    skillsMessage,
    { role: "assistant", content: [{ type: "text", text: "Ready." }] },
  ]
  pushFillerTurns(messages, 45, 2400)
  messages.push({ role: "user", content: [{ type: "text", text: "Use the middle skill and follow the middle rule" }] })

  const text = joinText(renderInitialPrompt({ system: "You are DSH.", messages }, "/repo", false, 0))

  assert.ok(Buffer.byteLength(text, "utf8") <= LIMIT)
  assert.ok(text.includes("MIDDLE_SKILL_MARKER_MUST_SURVIVE"))
  assert.ok(text.includes("MIDDLE_AGENTS_RULE_MUST_SURVIVE"))
})

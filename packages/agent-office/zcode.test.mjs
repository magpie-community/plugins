import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionReader, readZcode } from "./lib/readers.mjs"
import { createScanner } from "./lib/scan.mjs"

const T0 = 1793196000000
const iso = (t) => new Date(t).toISOString()

const line = (o) => JSON.stringify({
  type: "model_io", sessionId: "sess_z1", querySource: "main_turn",
  startedAt: iso(o.at), completedAt: iso(o.at + (o.dur || 5000)),
  model: { modelId: o.model || "GLM-5.3" },
  request: { body: { model: o.model || "GLM-5.3" } },
  response: {
    finishReason: o.tools?.length ? "tool-calls" : "stop",
    text: o.text || "", toolCalls: (o.tools || []).map((t, i) => ({ name: t, input: { command: "cmd " + i } })),
  },
})

const SAMPLE = [
  line({ at: T0, tools: ["Bash"] }),
  line({ at: T0 + 60e3, tools: ["Read", "Edit"] }),
  line({ at: T0 + 120e3, text: "改完了，测试全绿。", model: "GLM-5.3-Flash" }),
].join("\n")

test("a zcode log reads into the session shape other readers share", () => {
  const s = readZcode(SAMPLE, "sess_z1")
  expect(s.agent).toBe("zcode")
  expect(s.id).toBe("sess_z1")
  expect(s.model).toBe("GLM-5.3-Flash") // the last round's model wins
  expect(s.phase).toBe("done")
  expect(s.reply).toContain("改完了")
  expect(s.turns).toBe(1)
  expect(s.started).toBe(T0 + 5000)
  expect(s.updated).toBe(T0 + 120e3 + 5000)
})

test("a log ending on tool calls is mid-turn: the tools are outstanding", () => {
  const s = readZcode([line({ at: T0, tools: ["Bash", "Read"] }), line({ at: T0 + 30e3, tools: ["Edit"] })].join("\n"), "sess_z1")
  expect(s.phase).toBe("tool")
  expect(s.stepName).toBe("Edit")
  expect(s.step).toContain("Edit")
  // the previous round's tools were answered by the next model call
  expect(s.pending.length).toBe(1)
})

test("an ask-shaped tool name asks, like the other readers", () => {
  const s = readZcode(line({ at: T0, tools: ["AskUserQuestion"] }).replace('"AskUserQuestion"', '"AskUserQuestion"'), "sess_z1")
  expect(s.phase).toBe("ask")
})

test("an errored round reads as an error", () => {
  const bad = JSON.stringify({ type: "model_io", sessionId: "sess_z1", completedAt: iso(T0), model: { modelId: "GLM-5.3" },
    response: { finishReason: "error", error: "429: usage limit", text: "", toolCalls: [] } })
  const s = readZcode(bad, "sess_z1")
  expect(s.phase).toBe("error")
  expect(s.error).toContain("429")
})

test("appended batches parse the same as one shot, at every boundary", () => {
  const rows = [
    line({ at: T0, tools: ["Bash"] }),
    line({ at: T0 + 60e3, tools: ["Read", "Edit"] }),
    line({ at: T0 + 120e3, text: "改完了，测试全绿。", model: "GLM-5.3-Flash" }),
    line({ at: T0 + 180e3, text: "又验证了一遍。", model: "GLM-5.3-Flash" }),
  ]
  for (const width of [1, 2, 3]) {
    const reader = createSessionReader("zcode", "zcode", "sess_z1")
    for (let i = 0; i < rows.length; i += width) {
      reader.update(rows.slice(i, i + width).join("\n"))
      expect(reader.session).toEqual(readZcode(rows.slice(0, Math.min(i + width, rows.length)).join("\n"), "sess_z1"))
    }
  }
})

test("the scanner finds zcode rollout files and ids them without the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rollout-"))
  const root = join(dir, "rollout")
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "model-io-sess_z1.jsonl"), SAMPLE)
  const scan = createScanner({ days: 2, max: 40, sources: [{ agent: "zcode", kind: "zcode", root, depth: 0, match: (n) => n.startsWith("model-io-") && n.endsWith(".jsonl") }] })
  const out = scan.scan(Date.now() + 60e3)
  expect(out.length).toBe(1)
  expect(out[0].agent).toBe("zcode")
  expect(out[0].id).toBe("sess_z1")
  expect(out[0].phase).toBe("done")
  expect(out[0].key).toBe("zcode|sess_z1")
})

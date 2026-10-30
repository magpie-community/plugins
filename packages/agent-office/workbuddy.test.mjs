import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCodebuddy } from "./lib/readers.mjs"
import { createScanner } from "./lib/scan.mjs"

const T0 = 1793196000000
const iso = (t) => new Date(t).toISOString()
const j = (o) => JSON.stringify(o)

// a turn: user asks, the agent reasons, calls a tool, gets a result,
// reasons again, and answers — then the user asks something shorter
const SAMPLE = [
  j({ type: "session-meta", id: "s1", sessionId: "wb-1", timestamp: iso(T0), cwd: "D:\\Code\\blog" }),
  j({ type: "ai-title", timestamp: iso(T0 + 1000), aiTitle: "播客栏目", cwd: "D:\\Code\\blog" }),
  j({ type: "message", timestamp: iso(T0 + 2000), role: "user", cwd: "D:\\Code\\blog",
      content: [{ type: "input_text", text: "<system-reminder data-role=\"user-context\">垫料</system-reminder>" },
                { type: "input_text", text: "给播客加个栏目" }] }),
  j({ type: "reasoning", timestamp: iso(T0 + 3000) }),
  j({ type: "function_call", timestamp: iso(T0 + 4000), callId: "call_1", name: "Edit",
      arguments: j({ file_path: "D:/Code/blog/a.ts" }), cwd: "D:\\Code\\blog" }),
  j({ type: "function_call_result", timestamp: iso(T0 + 5000), callId: "call_1", name: "Edit", status: "success" }),
  j({ type: "message", timestamp: iso(T0 + 6000), role: "assistant", status: "completed", cwd: "D:\\Code\\blog",
      content: [{ type: "output_text", text: "栏目加好了，已部署。" }] }),
  j({ type: "message", timestamp: iso(T0 + 60e3), role: "user", cwd: "D:\\Code\\blog",
      content: [{ type: "input_text", text: "再检查一遍样式" }] }),
  j({ type: "reasoning", timestamp: iso(T0 + 61e3) }),
].join("\n")

test("the CodeBuddy event format reads into the shared session shape", () => {
  const s = readCodebuddy(SAMPLE, "workbuddy", "wb-1")
  expect(s.agent).toBe("workbuddy")
  expect(s.id).toBe("wb-1")
  expect(s.title).toBe("播客栏目")
  expect(s.cwd).toBe("D:\\Code\\blog")
  expect(s.project).toBe("blog")
  expect(s.model).toBe("") // this format logs no model name
})

test("the turn's phases walk through: thinking → tool → done → next turn", () => {
  const s = readCodebuddy(SAMPLE, "workbuddy", "wb-1")
  // the fixture ends on a new turn's reasoning: the agent is thinking again
  expect(s.phase).toBe("thinking")
  expect(s.reply).toBe("") // a new turn clears the last answer until it answers again
  expect(s.turns).toBe(2) // two user prompts
})

test("a log ending on function_call reads as running that tool", () => {
  const tail = SAMPLE + "\n" + j({ type: "function_call", timestamp: iso(T0 + 62e3), callId: "call_2",
    name: "Bash", arguments: j({ command: "bun test" }), cwd: "D:\\Code\\blog" })
  const s = readCodebuddy(tail, "workbuddy", "wb-1")
  expect(s.phase).toBe("tool")
  expect(s.stepName).toBe("Bash")
  expect(s.step).toContain("bun test")
})

test("system-reminder harness blocks don't count as the user's words", () => {
  const s = readCodebuddy(SAMPLE, "workbuddy", "wb-1")
  expect(s.query).toBe("再检查一遍样式") // the latest prompt wins
})

test("the scanner picks workbuddy sessions up through the new reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-projects-"))
  const root = join(dir, "projects", "d-Code-blog")
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "wb-1.jsonl"), SAMPLE)
  const scan = createScanner({ days: 2, max: 40, sources: [{ agent: "workbuddy", kind: "codebuddy", root: join(dir, "projects"), depth: 1, match: (n) => n.endsWith(".jsonl") }] })
  const out = scan.scan(Date.now() + 60e3)
  expect(out.length).toBe(1)
  expect(out[0].agent).toBe("workbuddy")
  expect(out[0].phase).toBe("thinking")
  expect(out[0].title).toBe("播客栏目")
})

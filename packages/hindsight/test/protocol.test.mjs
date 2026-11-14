import test from "node:test";
import assert from "node:assert/strict";
import { CLOSE, finalAnswer, memoryBlock, OPEN } from "../lib/protocol.mjs";

test("memory delimiters in recalled text cannot escape the wrapper", () => {
  const wrapped = memoryBlock([`before ${OPEN} inside ${CLOSE} after`], 1024);
  assert.equal(wrapped.indexOf(OPEN), 0);
  assert.equal(wrapped.indexOf(OPEN, 1), -1);
  assert.match(wrapped, /&lt;hindsight-memories&gt;/);
  assert.match(wrapped, /&lt;\/hindsight-memories&gt;/);
  assert.equal(wrapped.split(CLOSE).length, 2);
  assert.ok(wrapped.endsWith(`\n${CLOSE}`));
});

test("non-string memory entries are ignored", () => {
  assert.equal(memoryBlock([null, undefined, {}, [], 42], 1024), "");
  const wrapped = memoryBlock([null, "valid", { text: "not raw text" }], 1024);
  assert.ok(wrapped.includes("[1] valid\n</hindsight-memories>"));
});

test("memory text is NUL-free, trimmed and whitespace-only entries are skipped", () => {
  assert.equal(memoryBlock([" \t\r\n\0 "], 1024), "");
  const wrapped = memoryBlock([" \0 first fact \r\n"], 1024);
  assert.equal(wrapped.includes("\0"), false);
  assert.ok(wrapped.includes("[1] first fact\n</hindsight-memories>"));
});

test("only completed final answers are eligible for capture", () => {
  assert.equal(finalAnswer({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }, "chat"), "done");
  assert.equal(finalAnswer({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }, "chat"), "");
  assert.equal(finalAnswer({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }, "anthropic"), "done");
  assert.equal(finalAnswer({ status: "completed", output_text: "done" }, "responses"), "done");
  assert.equal(finalAnswer({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }, "gemini"), "done");
});

import test from "node:test";
import assert from "node:assert/strict";
import { finalAnswer, memoryBlock, OPEN } from "../lib/protocol.mjs";

test("memory delimiters in recalled text cannot escape the wrapper", () => {
  const wrapped = memoryBlock([`before ${OPEN} inside </hindsight-memories> after`], 1024);
  assert.equal(wrapped.indexOf(OPEN), 0);
  assert.equal(wrapped.indexOf(OPEN, 1), -1);
  assert.match(wrapped, /&lt;hindsight-memories&gt;/);
});

test("only completed final answers are eligible for capture", () => {
  assert.equal(finalAnswer({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }, "chat"), "done");
  assert.equal(finalAnswer({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }, "chat"), "");
  assert.equal(finalAnswer({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }, "anthropic"), "done");
  assert.equal(finalAnswer({ status: "completed", output_text: "done" }, "responses"), "done");
  assert.equal(finalAnswer({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }, "gemini"), "done");
});

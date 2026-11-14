import test from "node:test";
import assert from "node:assert/strict";
import { CLOSE, estimateTokens, finalAnswer, memoryBlock, OPEN, truncateToTokens } from "../lib/protocol.mjs";

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

test("token estimation separates CJK from Latin text", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens("你好 world"), 4, "2 CJK tokens + ceil(6/4) Latin tokens");
});

test("truncation stops on a token boundary instead of a byte or char count", () => {
  const long = "记".repeat(500);
  const cut = truncateToTokens(long, 100);
  assert.ok(estimateTokens(cut) <= 101, `over budget: ${estimateTokens(cut)}`);
  assert.ok(cut.startsWith("记"));
  assert.ok(cut.endsWith("…"));
  assert.equal(truncateToTokens("short", 100), "short");
});

test("the block budget is a token budget, not maxTokens * 8 characters", () => {
  // 8 chars per token would let this through; a token estimate must not.
  const memories = Array.from({ length: 20 }, (_, i) => `记忆${i} ` + "内容".repeat(200));
  const block = memoryBlock(memories, 200);
  assert.ok(estimateTokens(block) <= 210, `block is ${estimateTokens(block)} tokens for a 200 token budget`);
  assert.equal(block.indexOf(OPEN), 0);
  assert.ok(block.endsWith(`\n${CLOSE}`));
});

test("one oversized memory cannot crowd out the rest of the recall", () => {
  const block = memoryBlock(["巨".repeat(5000), "SECOND_ENTRY"], 512);
  assert.ok(block.includes("巨"));
  assert.ok(block.includes("SECOND_ENTRY"), "the later entry still gets budget");
  assert.ok(estimateTokens(block) <= 540, `block is ${estimateTokens(block)} tokens for a 512 token budget`);
});

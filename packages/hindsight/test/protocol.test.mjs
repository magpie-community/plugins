import test from "node:test";
import assert from "node:assert/strict";
import { alreadyInjected, finalAnswer, injectSystem, latestUserText, memoryBlock, OPEN } from "../lib/protocol.mjs";

const block = memoryBlock(["remember the synthetic codeword"], 1024);

test("latest user text handles complete histories and content parts", () => {
  assert.equal(latestUserText({ messages: [
    { role: "user", content: "old" },
    { role: "assistant", content: "answer" },
    { role: "user", content: [{ type: "text", text: "latest" }] }
  ] }, "chat"), "latest");
  assert.equal(latestUserText({ input: "responses input" }, "responses"), "responses input");
  assert.equal(latestUserText({ contents: [{ role: "user", parts: [{ text: "gemini input" }] }] }, "gemini"), "gemini input");
  assert.equal(latestUserText({ messages: [{ role: "assistant", content: "none" }] }, "chat"), "");
});

test("Chat Completions gets a new system message without mutating the request", () => {
  const body = { messages: [{ role: "system", content: "original" }, { role: "user", content: "q" }], stream: true };
  const changed = injectSystem(body, "chat", block);
  assert.equal(changed.messages[0].role, "system");
  assert.match(changed.messages[0].content, /synthetic codeword/);
  assert.equal(changed.messages[1].content, "original");
  assert.equal(changed.stream, true);
  assert.equal(body.messages.length, 2);
  assert.equal(alreadyInjected(changed, "chat"), true);
});

test("Anthropic, Responses and Gemini preserve existing system instructions", () => {
  const anthropic = injectSystem({ system: "original", messages: [] }, "anthropic", block);
  assert.match(anthropic.system, /^<hindsight-memories>/);
  assert.match(anthropic.system, /original$/);
  const anthropicParts = injectSystem({ system: [{ type: "text", text: "original" }] }, "anthropic", block);
  assert.equal(anthropicParts.system.length, 2);

  const responses = injectSystem({ instructions: "original", input: [] }, "responses", block);
  assert.match(responses.instructions, /original$/);

  const gemini = injectSystem({ systemInstruction: { role: "system", parts: [{ text: "original" }] }, contents: [] }, "gemini", block);
  assert.equal(gemini.systemInstruction.role, "system");
  assert.equal(gemini.systemInstruction.parts.length, 2);
  assert.equal(gemini.systemInstruction.parts[1].text, "original");
});

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

import { createHash } from "node:crypto";
import { CLOSE, OPEN } from "./protocol.mjs";

// Turn-level replay, the same model PowerContext and Nowledge Mem use: the
// agent resends the ORIGINAL conversation every request, so a memory block is
// attached to the user turn it belongs to and replayed byte-for-byte on later
// requests of the same turn. Tool loops never trigger a new recall and the
// provider prompt cache keeps working.
export function turns(body, protocol) {
  if (protocol === "responses" && typeof body.input === "string") {
    return [{ index: 0, text: body.input, append: t => { body.input += `\n\n${t}`; } }];
  }
  const list = protocol === "gemini" ? body.contents : protocol === "responses" ? body.input : body.messages;
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((msg, index) => {
    if (!msg || typeof msg !== "object") return;
    if (protocol === "responses" && msg.type !== undefined && msg.type !== "message") return;
    if (msg.role !== "user") return;
    const key = protocol === "gemini" ? "parts" : "content";
    if (typeof msg[key] === "string") {
      out.push({ index, text: msg[key], append: t => { msg[key] += `\n\n${t}`; } });
      return;
    }
    if (!Array.isArray(msg[key])) return;
    const content = msg[key].filter(p => p && (protocol === "gemini" ? !p.functionResponse : p.type !== "tool_result"));
    if (!content.length) return;
    const parts = content.filter(p => typeof p.text === "string" &&
      (protocol === "gemini" ? p.thought !== true : p.type === "text" || p.type === "input_text"));
    out.push({
      index,
      text: parts.map(p => p.text).join("\n"),
      append: t => msg[key].push(protocol === "gemini" ? { text: t }
        : { type: protocol === "responses" ? "input_text" : "text", text: t })
    });
  });
  return out;
}

export const turnKey = (turn, previousResponse = "") =>
  createHash("sha256").update(`${previousResponse}\0${turn.index}\0${userText(turn.text)}`).digest("hex");

export function userText(text) {
  const start = text.lastIndexOf(OPEN);
  return start !== -1 && text.trimEnd().endsWith(CLOSE) ? text.slice(0, start).trimEnd() : text;
}

export const injected = turn => userText(turn.text) !== turn.text;

const MAX_TURNS = 200;
// Per-plugin-instance store: one Magpie plugin instance keeps its own turn
// cache, so sessions never leak across instances (or across tests).
export function createConversationStore() {
  const conversations = new Map();

  return function conversation(ctx, config) {
    const key = JSON.stringify([ctx.origin, ctx.protocol, ctx.agent, ctx.session, ctx.cwd,
      config.hindsight_api, config.bank, config.recall_max_tokens]);
    const cache = conversations.get(key) ?? new Map();
    conversations.delete(key);
    while (conversations.size >= 64) conversations.delete(conversations.keys().next().value);
    conversations.set(key, cache);
    return {
      get: id => cache.get(id),
      delete: id => cache.delete(id),
      set(id, value) {
        cache.delete(id);
        while (cache.size >= MAX_TURNS) cache.delete(cache.keys().next().value);
        cache.set(id, value);
      }
    };
  };
}

// Reattach every cached block to its own user turn, oldest first, so a resent
// conversation carries exactly the same injections as when they were made.
export function replay(all, cache, previousResponse) {
  let changed = false;
  for (const t of all) {
    if (injected(t)) continue;
    const kept = cache.get(turnKey(t, previousResponse));
    if (kept?.text) {
      t.append(kept.text);
      changed = true;
    }
  }
  return changed;
}

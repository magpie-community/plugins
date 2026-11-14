import { createHash } from "node:crypto";
import { OPEN } from "./protocol.mjs";

// Turn-level replay, the same model PowerContext and Nowledge Mem use: the
// agent resends the ORIGINAL conversation every request, so a memory block is
// attached to the user turn it belongs to and replayed byte-for-byte on later
// requests of the same turn. Tool loops never trigger a new recall and the
// provider prompt cache keeps working.
export function turns(body, protocol) {
  if (protocol === "responses" && typeof body.input === "string") {
    return [{ index: 0, role: "user", text: body.input, append: t => { body.input += t; } }];
  }
  const list = protocol === "gemini" ? body.contents : protocol === "responses" ? body.input : body.messages;
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((msg, index) => {
    if (!msg || typeof msg !== "object") return;
    if (protocol === "responses" && msg.type !== undefined && msg.type !== "message") return;
    const role = msg.role === "user" ? "user"
      : msg.role === "assistant" || (protocol === "gemini" && msg.role === "model") ? "assistant" : undefined;
    if (!role) return;
    const key = protocol === "gemini" ? "parts" : "content";
    if (typeof msg[key] === "string") {
      out.push({ index, role, text: msg[key], append: t => { msg[key] += t; } });
      return;
    }
    if (!Array.isArray(msg[key])) return;
    const parts = msg[key].filter(p => p && typeof p.text === "string" &&
      (protocol === "gemini" ? p.thought !== true
        : role === "assistant" ? p.type === "text" || p.type === "output_text"
        : p.type === "text" || p.type === "input_text"));
    if (!parts.length) return;
    out.push({
      index, role,
      text: parts.map(p => p.text).join("\n"),
      append: t => msg[key].push(protocol === "gemini" ? { text: t }
        : { type: protocol === "responses" ? "input_text" : "text", text: t })
    });
  });
  return out;
}

export function target(all, query) {
  const q = String(query ?? "").trim();
  const users = all.filter(t => t.role === "user");
  if (q) {
    for (let i = users.length - 1; i >= 0; i--) {
      if (users[i].text.includes(q)) return users[i];
    }
  }
  return users[users.length - 1];
}

export const turnKey = turn => createHash("sha256").update(`${turn.index}\0${turn.text}`).digest("hex");
export const injected = turn => turn.text.includes(OPEN);

const MAX_TURNS = 200;
const MAX_CONVERSATIONS = 64;
const CONVERSATIONS_AFTER_EVICTION = 32;

// Per-plugin-instance store: one Magpie plugin instance keeps its own turn
// cache, so sessions never leak across instances (or across tests).
export function createConversationStore() {
  const conversations = new Map(); // conversation key -> { turns: Map, at }
  // Monotonic access counter: two conversations touched in the same millisecond
  // must still be orderable, otherwise least-recently-used eviction degenerates
  // into insertion order.
  let clock = 0;

  return function conversation(ctx, config) {
    const key = createHash("sha256").update([
      ctx.origin ?? "", ctx.protocol ?? "", ctx.session ?? "", ctx.cwd ?? "", config.hindsight_api, config.bank
    ].join("\0")).digest("hex");
    let conv = conversations.get(key);
    if (!conv) {
      conv = { turns: new Map(), at: 0 };
      conversations.set(key, conv);
    }
    conv.at = ++clock;
    // Least-recently-used first: a long-running conversation must not be
    // evicted while idle ones survive.
    if (conversations.size > MAX_CONVERSATIONS) {
      const victims = [...conversations].filter(([k]) => k !== key).sort((a, b) => a[1].at - b[1].at);
      for (const [k] of victims) {
        if (conversations.size <= CONVERSATIONS_AFTER_EVICTION) break;
        conversations.delete(k);
      }
    }
    if (conv.turns.size > MAX_TURNS) {
      const oldest = conv.turns.keys().next().value;
      conv.turns.delete(oldest);
    }
    return conv;
  };
}

// Reattach every cached block to its own user turn, oldest first, so a resent
// conversation carries exactly the same injections as when they were made.
//
// `maxBlocks` bounds how much recalled memory may stay in context. A sliding
// window (drop the single oldest block once the cap is crossed) would change
// the conversation prefix on EVERY later request, which is precisely the cache
// miss this design avoids. Instead the whole tail is dropped in one go: one
// cache miss every `maxBlocks` turns, byte-stable in between.
export function replay(all, conv, maxBlocks = 0) {
  const pending = [];
  for (const t of all) {
    if (t.role !== "user" || injected(t)) continue;
    const kept = conv.turns.get(turnKey(t));
    if (kept?.text) pending.push({ turn: t, kept });
  }
  if (maxBlocks > 0 && pending.length > maxBlocks) {
    const newest = pending.length - 1;
    for (let i = 0; i < newest; i++) conv.turns.delete(turnKey(pending[i].turn));
    pending.splice(0, newest);
  }
  for (const { turn, kept } of pending) turn.append(kept.text);
}

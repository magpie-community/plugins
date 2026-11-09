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
// Per-plugin-instance store: one Magpie plugin instance keeps its own turn
// cache, so sessions never leak across instances (or across tests).
export function createConversationStore() {
  const conversations = new Map(); // conversation key -> { turns: Map, at }

  return function conversation(ctx, config) {
    const key = createHash("sha256").update([
      ctx.origin ?? "", ctx.protocol ?? "", ctx.session ?? "", ctx.cwd ?? "", config.hindsight_api, config.bank
    ].join("\0")).digest("hex");
    let conv = conversations.get(key);
    if (!conv) {
      conv = { turns: new Map(), at: Date.now() };
      conversations.set(key, conv);
    }
    conv.at = Date.now();
    if (conversations.size > 64) {
      for (const [k, v] of conversations) {
        if (v !== conv) conversations.delete(k);
        if (conversations.size <= 32) break;
      }
    }
    if (conv.turns.size > MAX_TURNS) {
      const oldest = conv.turns.keys().next().value;
      conv.turns.delete(oldest);
    }
    return conv.turns;
  };
}

// Reattach every cached block to its own user turn, oldest first, so a resent
// conversation carries exactly the same injections as when they were made.
export function replay(all, cache) {
  for (const t of all) {
    if (t.role !== "user" || injected(t)) continue;
    const kept = cache.get(turnKey(t));
    if (kept?.text) t.append(kept.text);
  }
}

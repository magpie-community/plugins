import { createHash } from "node:crypto";
import { CLOSE, OPEN } from "./protocol.mjs";

function contents(body, protocol) {
  return protocol === "gemini" ? body.contents : protocol === "responses" ? body.input : body.messages;
}

export function turns(body, protocol) {
  if (protocol === "responses" && typeof body.input === "string") {
    return [{ index: 0, text: body.input, append: text => { body.input += "\n\n" + text; } }];
  }
  const list = contents(body, protocol);
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((msg, index) => {
    if (!msg || typeof msg !== "object") return;
    if (protocol === "responses" && msg.type !== undefined && msg.type !== "message") return;
    if (msg.role !== "user") return;
    const key = protocol === "gemini" ? "parts" : "content";
    if (typeof msg[key] === "string") {
      out.push({ index, id: msg.id, text: msg[key], append: text => { msg[key] += "\n\n" + text; } });
      return;
    }
    if (!Array.isArray(msg[key])) return;
    const content = msg[key].filter(p => p && (protocol === "gemini" ? !p.functionResponse : p.type !== "tool_result"));
    if (!content.length) return;
    const parts = content.filter(p => typeof p.text === "string" &&
      (protocol === "gemini" ? p.thought !== true : p.type === "text" || p.type === "input_text"));
    out.push({
      index,
      id: msg.id,
      text: parts.map(p => p.text).join("\n"),
      append: text => msg[key].push(protocol === "gemini" ? { text }
        : { type: protocol === "responses" ? "input_text" : "text", text })
    });
  });
  return out;
}

export function hasNewUserTurn(body, protocol, turn) {
  const list = contents(body, protocol);
  return !Array.isArray(list) || turn.index === list.length - 1;
}

export function turnKeys(all, previousResponse) {
  let prefix = "";
  return all.map((turn, index) => {
    const stableId = typeof turn.id === "string" && turn.id ? turn.id : null;
    const identity = stableId ?? (index === 0 ? previousResponse : prefix);
    const key = hash([identity, userText(turn.text)]);
    prefix = key;
    return key;
  });
}

export function userText(text) {
  const start = text.lastIndexOf(OPEN);
  return start !== -1 && text.trimEnd().endsWith(CLOSE) ? text.slice(0, start).trimEnd() : text;
}

export const injected = turn => userText(turn.text) !== turn.text;
export const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function conversationIdentity(ctx, config) {
  return hash([ctx.origin, ctx.protocol, ctx.caller?.agent, ctx.caller?.name, ctx.agent,
    ctx.session, ctx.kind, ctx.cwd, config.hindsight_api, config.bank,
    config.recall_max_tokens, config.injection_max_bytes, config.recall_tags]);
}

// Keep both access patterns bounded. An expiry check also covers idle sessions
// where the hook host stays alive while its cache receives no traffic.
export function createConversationStore({ maxBytes = 8 * 1024 * 1024 } = {}) {
  const conversations = new Map();
  let bytes = 0;

  function remove(cache, id) {
    const entry = cache.get(id);
    if (!entry) return;
    bytes -= entry.size;
    cache.delete(id);
  }

  return (ctx, config) => {
    const key = conversationIdentity(ctx, config);
    const cache = conversations.get(key) ?? new Map();
    conversations.delete(key);
    conversations.set(key, cache);

    function evict() {
      while (cache.size > 200) remove(cache, cache.keys().next().value);
      while (bytes > maxBytes || conversations.size > 64) {
        const [oldKey, old] = conversations.entries().next().value;
        for (const id of old.keys()) remove(old, id);
        conversations.delete(oldKey);
      }
    }
    evict();
    return {
      get(id) {
        const entry = cache.get(id);
        if (entry && entry.expires > Date.now()) return entry.value;
        remove(cache, id);
      },
      delete(id) { remove(cache, id); },
      set(id, value, ttl = 30 * 60 * 1000) {
        if (conversations.get(key) !== cache) return;
        remove(cache, id);
        const size = Buffer.byteLength(value.query ?? "") + Buffer.byteLength(value.text ?? "") + 256;
        cache.set(id, { value, size, expires: Date.now() + ttl });
        bytes += size;
        evict();
      }
    };
  };
}

export function replay(all, keys, cache, currentBlock, budget) {
  let available = budget;
  for (const turn of all) {
    if (injected(turn)) available -= Buffer.byteLength(turn.text.slice(userText(turn.text).length));
  }
  let bytes = 0;
  for (let i = all.length - 1; i >= 0 && available > 0; i--) {
    const turn = all[i];
    if (injected(turn)) continue;
    const block = i === all.length - 1 ? currentBlock : cache?.get(keys[i])?.text;
    if (!block) continue;
    const size = Buffer.byteLength(block) + 2;
    if (size > available) continue;
    turn.append(block);
    available -= size;
    bytes += size;
  }
  return bytes;
}

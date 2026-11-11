// Amp's ledger/message reconciliation follows Tokscale's MIT-licensed parser.
// See NOTICE. Unlike its charts, an append-only ledger must not invent dates.
import { createHash } from "node:crypto";

export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const validThread = (id) =>
  typeof id === "string" && /^T-[a-zA-Z0-9-]{1,120}$/.test(id);
const idOf = (id) =>
  (Number.isSafeInteger(id) && id >= 0) ||
  (typeof id === "string" && /^[\w-]{1,100}$/.test(id))
    ? String(id)
    : null;
const timeOf = (t) =>
  typeof t === "string" &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(t) &&
  Number.isFinite(Date.parse(t)) &&
  Date.parse(t) >= Date.UTC(2000, 0, 1)
    ? new Date(t).toISOString()
    : null;
const token = (n) =>
  n == null
    ? 0
    : Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000
      ? n
      : null;
const counts = (u, ledger) => [
  token(ledger ? u.input : u.inputTokens),
  token(ledger ? u.output : u.outputTokens),
  token(u.cacheReadInputTokens),
  token(u.cacheCreationInputTokens),
];
const modelOf = (m) =>
  typeof m === "string" &&
  m.trim() &&
  m.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(m)
    ? m.trim()
    : null;
export const fingerprint = (r) =>
  digest([r.session, r.t, r.model, r.in, r.out, r.cache_read, r.cache_write]);
export const tokenSignature = (r) =>
  JSON.stringify([
    r.in || 0,
    r.out || 0,
    r.cache_read || 0,
    r.cache_write || 0,
  ]);

export function parseThread(
  thread,
  { now = Date.now(), settleMs = 120_000 } = {},
) {
  if (!thread || !validThread(thread.id))
    throw new Error("Invalid Amp thread ID");
  const issues = {};
  const note = (code) => {
    issues[code] = (issues[code] || 0) + 1;
  };
  const make = (u, ledger, id, state, ordinal) => {
    const tokens = counts(u, ledger);
    const model = modelOf(u.model);
    if (!model || tokens.includes(null)) {
      note("invalidUsage");
      return null;
    }
    if (!tokens.some(Boolean)) return null;
    return {
      ledger,
      model,
      tokens,
      time: timeOf(u.timestamp),
      id,
      state,
      ordinal,
      operation: String(u.operationType || ""),
      from: idOf(u.fromMessageId),
    };
  };
  const messages = (
    Array.isArray(thread.messages) ? thread.messages : []
  ).flatMap((m, i) => {
    if (m?.role !== "assistant" || !m.usage) return [];
    const r = make(m.usage, false, idOf(m.messageId), m.state?.type, i);
    return r ? [r] : [];
  });
  const ledger = (
    Array.isArray(thread.usageLedger?.events) ? thread.usageLedger.events : []
  ).flatMap((e, i) => {
    if (!e?.tokens) return [];
    const r = make(
      {
        ...e.tokens,
        model: e.model,
        timestamp: e.timestamp,
        operationType: e.operationType,
        fromMessageId: e.fromMessageId,
      },
      true,
      idOf(e.toMessageId),
      undefined,
      i,
    );
    return r ? [r] : [];
  });
  const consumed = new Set();
  const unmatched = [];
  for (const message of messages) {
    let index = ledger.findIndex(
      (r, i) =>
        !consumed.has(i) &&
        message.id !== null &&
        r.id === message.id &&
        r.model === message.model &&
        (!r.operation || r.operation === "inference"),
    );
    if (index < 0)
      index = ledger.findIndex(
        (r, i) =>
          !consumed.has(i) &&
          r.model === message.model &&
          JSON.stringify(r.tokens) === JSON.stringify(message.tokens) &&
          (!r.time || !message.time || r.time === message.time),
      );
    if (index < 0) {
      unmatched.push(message);
      continue;
    }
    consumed.add(index);
    const r = ledger[index];
    // Message identity survives a ledger appearing in a later export.
    r.id = message.id ?? r.id;
    r.matched = true;
    r.time ||= message.time;
    r.state = message.state;
  }
  const records = [];
  const seen = new Map();
  const occurrences = new Map();
  for (const r of [...ledger, ...unmatched]) {
    if (r.state && r.state !== "complete") {
      note("unfinished");
      continue;
    }
    if (!r.time) {
      note("missingTimestamp");
      continue;
    }
    if (Date.parse(r.time) > now - settleMs) {
      note("settling");
      continue;
    }
    const messageIdentity =
      r.id !== null &&
      (!r.ledger || r.matched || !r.operation || r.operation === "inference");
    const key = messageIdentity
      ? `message:${r.id}`
      : `event:${digest([r.time, r.model, r.operation, r.from, r.id])}`;
    const ordinal = occurrences.get(key) || 0;
    occurrences.set(key, ordinal + 1);
    // Repeated anonymous events can be distinct calls. Message IDs cannot.
    const identity = messageIdentity ? key : `${key}:${ordinal}`;
    const [input, output, cacheRead, cacheWrite] = r.tokens;
    const rec = {
      t: r.time,
      agent: "amp",
      provider: "session-unknown",
      model: r.model,
      in: input,
      out: output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      status: 200,
      session: thread.id,
      rid: `amp-usage:v1:${digest([thread.id, identity])}`,
    };
    if (seen.has(rec.rid)) {
      if (
        seen.get(rec.rid) &&
        fingerprint(seen.get(rec.rid)) !== fingerprint(rec)
      ) {
        note("conflictingIdentity");
        seen.set(rec.rid, null);
      }
      continue;
    }
    seen.set(rec.rid, rec);
  }
  for (const r of seen.values()) if (r) records.push(r);
  return { records, issues };
}

// Only metering fields leave the in-memory export; never cache content or titles.
export function projectThread(t) {
  const pick = (v, keys) =>
    Object.fromEntries(
      keys.filter((k) => v?.[k] !== undefined).map((k) => [k, v[k]]),
    );
  const usageKeys = [
    "model",
    "timestamp",
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ];
  const eventKeys = [
    "model",
    "timestamp",
    "fromMessageId",
    "toMessageId",
    "operationType",
  ];
  return {
    id: t.id,
    messages: (t.messages || [])
      .filter((m) => m?.role === "assistant" && m.usage)
      .map((m) => ({
        role: m.role,
        messageId: m.messageId,
        state: { type: m.state?.type },
        usage: pick(m.usage, usageKeys),
      })),
    usageLedger: {
      events: (t.usageLedger?.events || []).map((e) => ({
        ...pick(e, eventKeys),
        tokens: pick(e.tokens, [
          "input",
          "output",
          "cacheReadInputTokens",
          "cacheCreationInputTokens",
        ]),
      })),
    },
  };
}

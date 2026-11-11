// Amp's ledger/message reconciliation follows Tokscale's MIT-licensed parser.
// See NOTICE. A call with no time of its own takes the moment its turn was
// sent; nothing is dated from a thread's creation or a file's mtime.
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
// An ISO string or epoch milliseconds; anything a Date cannot hold is no time.
const timeOf = (t) => {
  const ms =
    typeof t === "number"
      ? t
      : typeof t === "string" &&
          /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(t)
        ? Date.parse(t)
        : NaN;
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms <= 8.64e15
    ? new Date(ms).toISOString()
    : null;
};
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
  const make = (u, ledger, id, state) => {
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
      operation: String(u.operationType || ""),
    };
  };
  let sent = null;
  const messages = (
    Array.isArray(thread.messages) ? thread.messages : []
  ).flatMap((m) => {
    if (m?.role === "user" && Number.isFinite(m.sentAt))
      sent = timeOf(m.sentAt);
    if (m?.role !== "assistant" || !m.usage) return [];
    const r = make(m.usage, false, idOf(m.messageId), m.state?.type);
    if (r) r.sent = sent;
    return r ? [r] : [];
  });
  const ledger = (
    Array.isArray(thread.usageLedger?.events) ? thread.usageLedger.events : []
  ).flatMap((e) => {
    if (!e?.tokens) return [];
    // The subagent's own thread reports these calls one by one, with cache.
    if (e.operationType === "subagent" && validThread(e.subagentThreadID)) {
      note("subagentThread");
      return [];
    }
    const r = make(
      {
        ...e.tokens,
        model: e.model,
        timestamp: e.timestamp,
        operationType: e.operationType,
      },
      true,
      idOf(e.toMessageId),
    );
    if (r) r.event = idOf(e.id);
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
          // Amp's ledger usually carries input/output only.
          r.tokens.every((n, k) => n === message.tokens[k] || (k > 1 && !n)) &&
          (!r.time || !message.time || r.time === message.time),
      );
    if (index < 0) {
      message.time ||= message.sent;
      unmatched.push(message);
      continue;
    }
    consumed.add(index);
    const r = ledger[index];
    // Message identity survives a ledger appearing in a later export.
    r.id = message.id ?? r.id;
    r.matched = true;
    r.time ||= message.time || message.sent;
    r.tokens[2] ||= message.tokens[2];
    r.tokens[3] ||= message.tokens[3];
    r.state = message.state;
  }
  const records = [];
  const seen = new Map();
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
    if (!messageIdentity && r.event === null) {
      note("missingIdentity");
      continue;
    }
    const identity = messageIdentity ? `message:${r.id}` : `event:${r.event}`;
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
    "id",
    "model",
    "timestamp",
    "toMessageId",
    "operationType",
    "subagentThreadID",
  ];
  return {
    id: t.id,
    messages: (t.messages || []).flatMap((m) =>
      m?.role === "assistant" && m.usage
        ? [
            {
              role: m.role,
              messageId: m.messageId,
              state: { type: m.state?.type },
              usage: pick(m.usage, usageKeys),
            },
          ]
        : m?.role === "user" && Number.isFinite(m.meta?.sentAt)
          ? [{ role: m.role, sentAt: m.meta.sentAt }]
          : [],
    ),
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

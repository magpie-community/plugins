import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { timestamp } from "./estimate.mjs";

const files = new Map();
const uuid = value => typeof value === "string" && /^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(value);

async function logFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await logFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(file);
  }
  return result;
}

function event(line) {
  if (!line.includes('"assistant"') && !line.includes('"session_context"') && !line.includes('"credential_org"')) return null;
  const entry = JSON.parse(line);
  const at = timestamp(entry.timestamp), session = entry.sessionId;
  if (!Number.isFinite(at) || typeof session !== "string" || !session) return null;
  const attachment = entry.type === "attachment" && entry.attachment;
  if (attachment?.type === "session_context") {
    // This generated attachment is identity data; its prose is never executed or treated as instructions.
    const text = attachment.context?.userEmail;
    const email = typeof text === "string" ? text.match(/^The user's email address is ([^\s@]+@[^\s@]+)\. Use it only/) : null;
    return { at, session, kind: "email", value: email?.[1].toLowerCase() || null };
  }
  if (attachment?.type === "credential_org") {
    return { at, session, kind: "org", value: uuid(attachment.organizationUuid) ? attachment.organizationUuid.toLowerCase() : null };
  }
  const message = entry.message, usage = message?.usage;
  if (entry.type !== "assistant" || entry.isApiErrorMessage || message?.model === "<synthetic>" || !usage) return null;
  if (typeof entry.requestId !== "string" || !entry.requestId || typeof message.id !== "string" || !message.id) {
    return { at, session, kind: "invalid" };
  }
  const row = { t: entry.timestamp, provider: "claude", source: "claude-native", session,
    rid: entry.requestId, response_id: message.id, model: message.model, status: 200,
    in: usage.input_tokens, out: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens ?? 0, cache_write: usage.cache_creation_input_tokens ?? 0,
    cache_write_1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0 };
  if (["in", "out", "cache_read", "cache_write", "cache_write_1h"].some(k => !Number.isSafeInteger(row[k]) || row[k] < 0)
    || row.cache_write_1h > row.cache_write) return { at, session, kind: "invalid" };
  if (usage.fallback_credit != null) row.credits = 1;
  if (usage.speed && usage.speed !== "standard" || usage.service_tier && usage.service_tier !== "standard") row.unpriced = true;
  return { at, session, kind: "usage", row };
}

async function readEvents(file, info) {
  let cached = files.get(file);
  if (!cached || cached.ino !== info.ino || info.size < cached.size
    || info.size === cached.size && info.mtimeMs !== cached.mtime) {
    cached = { ino: info.ino, size: 0, mtime: 0, offset: 0, events: [], malformed: false };
  }
  if (info.size === cached.size && info.mtimeMs === cached.mtime) return cached;
  // Native JSONL is append-only; retain only parsed identity/usage metadata, never conversation bodies.
  let tail = Buffer.alloc(0);
  if (info.size > cached.offset) {
    for await (const chunk of createReadStream(file, { start: cached.offset, end: info.size - 1 })) {
      tail = Buffer.concat([tail, chunk]);
      let start = 0, end;
      while ((end = tail.indexOf(10, start)) !== -1) {
        const line = tail.subarray(start, end).toString("utf8");
        if (line.trim()) {
          try { const item = event(line); if (item) cached.events.push(item); }
          catch { cached.malformed = true; }
        }
        cached.offset += end - start + 1;
        start = end + 1;
      }
      tail = tail.subarray(start);
    }
  }
  Object.assign(cached, { size: info.size, mtime: info.mtimeMs });
  files.set(file, cached);
  return cached;
}

export async function readClaudeNative({ claudeDir, since, until }) {
  let profile;
  try { profile = JSON.parse(await readFile(`${claudeDir}.json`, "utf8")).oauthAccount; }
  catch (error) { return { rows: [], partial: true, note: `原生账号资料不可读（${error.code || error.name}），仅使用网关记录` }; }
  if (!uuid(profile?.accountUuid) || !uuid(profile?.organizationUuid) || typeof profile?.emailAddress !== "string") {
    return { rows: [], partial: true, note: "原生账号身份不完整，仅使用网关记录" };
  }
  const email = profile.emailAddress.toLowerCase(), org = profile.organizationUuid.toLowerCase();
  let entries;
  try { entries = await logFiles(path.join(claudeDir, "projects")); }
  catch (error) { return { rows: [], partial: true, note: `原生日志不可读（${error.code || error.name}），仅使用网关记录` }; }
  const active = new Set(entries);
  for (const file of files.keys()) if (!active.has(file)) files.delete(file);
  const events = [];
  let partial = false;
  for (const file of entries) {
    try {
      const info = await stat(file);
      if (info.mtimeMs < since) continue;
      const cached = await readEvents(file, info);
      events.push(...cached.events);
      partial ||= cached.malformed;
    } catch { partial = true; }
  }
  events.sort((a, b) => a.at - b.at);
  const sessions = new Map(), requests = new Map(), conflicts = new Set();
  let skipped = 0;
  for (const item of events) {
    if (item.at > until) continue;
    const identity = sessions.get(item.session) || {};
    if (item.kind === "email" || item.kind === "org") {
      identity[item.kind] = item.value;
      sessions.set(item.session, identity);
      continue;
    }
    if (item.at < since) continue;
    if (item.kind === "invalid" || identity.email !== email || identity.org !== org) { skipped++; continue; }
    const row = { ...item.row, providerAccount: email };
    const previous = requests.get(row.rid);
    if (previous && ["response_id", "model", "in", "cache_read", "cache_write", "cache_write_1h"].some(k => previous[k] !== row[k])) {
      conflicts.add(row.rid);
    }
    if (!previous || row.out >= previous.out) requests.set(row.rid, row);
  }
  for (const rid of conflicts) requests.delete(rid);
  return { rows: [...requests.values()], partial: partial || skipped > 0 || conflicts.size > 0,
    user: email, note: `原生会话邮箱、凭据组织与本机账号已核对${skipped ? "；未匹配的记录已排除" : ""}${conflicts.size ? "；冲突请求已排除" : ""}` };
}

export function mergeClaudeRows(gateway, native) {
  const ids = new Set(gateway.flatMap(row => [row.rid, row.response_id]).filter(Boolean));
  return [...gateway, ...native.filter(row => !ids.has(row.rid) && !ids.has(row.response_id))];
}

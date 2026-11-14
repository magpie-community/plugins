import fs from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash, randomUUID} from "node:crypto";
import {retainDetails} from "./receipt-details.mjs";
import {secureDir, stateRoot} from "./grant-store.mjs";

export const RECEIPT_VERSION = "0.4.3";
const writes = new Map();
export const RECEIPT_LIMIT = 25;

// Only confirmation metadata crosses from the synchronous middleware's log.
export function receiptCheckpoint(row) {
  if (!/^[a-f0-9-]{36}$/i.test(row?.id || "") || !["request_checked", "reply_processed"].includes(row.phase) || typeof row.ok !== "boolean") return null;
  return {id:row.id, phase:row.phase, ok:row.ok,
    reason:["processed", "upstream_incomplete", "restoration_incomplete"].includes(row.reason) ? row.reason : undefined,
    eventType:["response.completed", "response.failed", "response.incomplete", "message_stop", "chat.completed", "gemini.completed", "error"].includes(row.eventType) ? row.eventType : undefined,
    restoredNames:Number.isSafeInteger(row.restoredNames) && row.restoredNames >= 0 ? row.restoredNames : null};
}

export async function readReceiptConfirmations(ids, appLog, text) {
  const rows = [], selected = new Set(ids), marker = "NERO_COMPANY_GUARD_RECEIPT ";
  const log = text ?? await readTail(appLog || path.join(os.homedir(), "Library", "Logs", "magpie", "app.log"), 4*1024*1024);
  for (const line of log.split("\n")) {
    const i = line.indexOf(marker); if (i < 0) continue;
    try { const row = receiptCheckpoint(JSON.parse(line.slice(i + marker.length))); if (row && selected.has(row.id)) rows.push(row); } catch {}
  }
  return rows;
}

// The official plugin host is the writer. Serialize its concurrent callbacks,
// and replace complete files so readers never observe a partial JSON line.
export function retainReceipts(root, incoming, appLog) {
  const prior = writes.get(root) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => retain(root, incoming, appLog));
  writes.set(root, next);
  next.finally(() => { if (writes.get(root) === next) writes.delete(root); }).catch(() => {});
  return next;
}

async function retain(root, incoming, appLog) {
  const dir = path.join(root, "receipts");
  await secureDir(root, true); await secureDir(dir, true);
  const files = (await fs.readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const originals = new Map(), groups = new Map();
  const add = row => {
    if (!/^[a-f0-9-]{36}$/i.test(row.id || "") || !["prepared", "response_observed", "request_checked", "reply_processed"].includes(row.phase) || !/^\d{4}-\d{2}-\d{2}T/.test(row.startedAt || "")) throw new Error("invalid_receipt_record");
    if (["request_checked", "reply_processed"].includes(row.phase)) {
      const checkpoint = receiptCheckpoint(row); if (!checkpoint) throw new Error("invalid_receipt_checkpoint");
      row = {v:1, ...checkpoint, startedAt:row.startedAt};
    }
    const group = groups.get(row.id) || {startedAt:row.startedAt, phases:new Map()};
    if (group.startedAt !== row.startedAt) throw new Error("receipt_time_mismatch");
    group.phases.set(row.phase, row); groups.set(row.id, group);
  };
  for (const name of files) {
    const fd = await fs.open(path.join(dir,name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 64*1024*1024) throw new Error("unsafe_receipt_file");
      const text = await fd.readFile("utf8"); originals.set(name,text);
      for (const line of text.split("\n")) if (line.trim()) add(JSON.parse(line));
    } finally { await fd.close(); }
  }
  if (incoming) add(incoming);
  // Save observed confirmations before pruning. A rotated log cannot undo them.
  // An unavailable log must not prevent the hook's own receipt from being saved.
  try { for (const row of await readReceiptConfirmations(groups.keys(), appLog)) add({...row, startedAt:groups.get(row.id).startedAt}); } catch {}
  // Rank by request start, never by arrival of a late completion callback.
  const kept = [...groups].sort((a,b) => b[1].startedAt.localeCompare(a[1].startedAt) || b[0].localeCompare(a[0])).slice(0,RECEIPT_LIMIT);
  const output = new Map();
  for (const [,group] of kept) for (const row of group.phases.values()) {
    const name = row.startedAt.slice(0,10)+".jsonl";
    output.set(name,(output.get(name)||"")+JSON.stringify(row)+"\n");
  }
  // Persist retained data before removing any obsolete daily file.
  for (const [name,text] of output) {
    if (originals.get(name) === text) continue;
    const file = path.join(dir,name), temp = file+"."+randomUUID()+".tmp";
    const fd = await fs.open(temp, "wx", 0o600);
    try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
    try { await fs.rename(temp,file); } finally { await fs.rm(temp,{force:true}); }
  }
  for (const name of originals.keys()) if (!output.has(name)) await fs.unlink(path.join(dir,name));
  retainDetails(root,new Set(kept.map(([id])=>id)));
  return {retained:kept.length,removed:groups.size-kept.length};
}
const opaqueId = value => {
  if (typeof value !== "string" || !value) return null;
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : "id-" + createHash("sha256").update(value).digest("hex").slice(0,24);
};
export function newReceipt(ctx, identity) {
  return {v: 1, id: randomUUID(), task: opaqueId(ctx.session || identity?.thread), thread: opaqueId(identity?.thread), turn: opaqueId(identity?.turn), agent:receiptAgent(ctx.agent), version: RECEIPT_VERSION, protocol: ["chat","responses","anthropic","gemini"].includes(ctx.protocol) ? ctx.protocol : "unknown", startedAt: new Date().toISOString()};
}

export const receiptAgent = value => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : null;

// Whitelist every persisted field. No exception text, names, tokens or prompts.
export async function appendReceipt(ctx, base, phase, details = {}) {
  try {
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const row = {...base, phase, at: new Date().toISOString()};
    if (phase === "prepared") {
      row.status = ["replaced", "no_match", "authorized", "failed"].includes(details.status) ? details.status : "failed";
      row.errorCode = details.error ? "preparation_failed" : null;
      row.processingMs = count(details.processingMs);
      row.matchedNames = count(details.metrics?.matchedNames);
      row.replacedNames = count(details.metrics?.replacedNames);
      row.replacements = count(details.metrics?.replacements);
      row.allowedOccurrences = count(details.metrics?.allowedOccurrences);
      row.authorization = ["original", "public_lookup", "masked"].includes(details.metrics?.authorization) ? details.metrics.authorization : "masked";
      row.authorizationCoverage = ["all","names","none"].includes(details.metrics?.authorizationCoverage) ? details.metrics.authorizationCoverage : "none";
      const reason = details.metrics?.authorizationReason;
      row.authorizationReason = typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : "unknown";
      row.taskAliases = count(details.metrics?.taskAliases);
      row.aliasConflicts = count(details.metrics?.aliasConflicts);
      row.aliasLimitReached = details.metrics?.aliasLimitReached === true;
      row.scopes = {};
      for (const k of ["user", "history", "instructions", "tool_results", "tool_arguments", "tool_schema"]) {
        const s = details.metrics?.scopes?.[k];
        if (s) row.scopes[k] = {checkedTexts: count(s.checkedTexts), replacements: count(s.replacements)};
      }
    } else if (phase === "response_observed") {
      row.hostCompletionObserved = details.success === true;
      row.replyCaptured = details.replyCaptured === true;
      row.remainingCurrentPlaceholders = count(details.remaining);
    } else return;
    await retainReceipts(stateRoot(ctx.options?.stateDir), row, ctx.options?.appLog);
  } catch {
    // Receipt failure must never turn a model request into a failure.
    try { console.warn("company_guard_receipt_write_failed"); } catch {}
  }
}

export async function readTail(file, bytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid()) return "";
    const start = Math.max(0, stat.size - bytes), buf = Buffer.alloc(Math.min(bytes, stat.size));
    const {bytesRead} = await fd.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (e) { if (e.code === "ENOENT") return ""; throw e; }
  finally { await fd?.close(); }
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const responsePaths = new Set([
  "/v1/responses", "/responses", "/backend-api/codex/responses",
]);
const recordName = /^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/;
const tempName = /^\.[a-f0-9-]{36}\.tmp$/;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const maxRecords = 4096;
const maxAttempts = 32;
const maxRecordBytes = 16 * 1024;
const maxTraceBytes = 4 * 1024 * 1024;
const traceTimeoutMs = 650;

export function onRequest(body, ctx) {
  if (!mainCodexContext(ctx) || !ctx.state) return;
  const turn = nativeTurnId(body?.client_metadata, ctx.session);
  if (turn) ctx.state.paseoTurnKey = digest(ctx.session, turn);
}

export async function onResponse(reply, ctx) {
  if (typeof process.getuid !== "function" || ctx?.success !== true || !mainCodexContext(ctx) ||
      reply?.object !== "response" || !opaqueId(reply.id, 256) ||
      (reply.status != null && reply.status !== "completed") || reply.error != null ||
      !Array.isArray(reply.output) || reply.output.length > 256) return;
  const messageId = finalMessageId(reply);
  const turn = ctx.state?.paseoTurnKey;
  if (!messageId && !turn) return;

  try {
    const trace = await readTrace(process.env.MAGPIE_ADDR, ctx.signal);
    if (ctx.signal?.aborted) return;
    const hit = exactRoute(trace, ctx.session, reply.id);
    if (!hit) return;
    const { record, order } = hit;
    let history;
    if (typeof turn === "string" && /^[a-f0-9]{64}$/.test(turn) && order) {
      const request = createHash("sha256").update(reply.id).digest("hex");
      const phase = messageId ? "reply" : reply.output.some(isToolCall) ? "tool" : "model";
      storeRecord(`${turn}-${request}`, { ...record, order, phase });
      history = { turn, request, order };
    }
    if (messageId) storeRecord(digest(ctx.session, messageId), { ...record, ...(history && { history }) });
  } catch {
    // A local lookup or index error can only suppress the label. Error objects
    // from the trace, HTTP client and filesystem may contain private data.
  }
}

function mainCodexContext(ctx) {
  return ctx && !ctx.signal?.aborted &&
    (ctx.origin === "local" || ctx.origin === "magpie-key") &&
    ctx.agent === "codex" && ctx.protocol === "responses" && ctx.kind === "" &&
    responsePaths.has(ctx.path) && opaqueId(ctx.session, 128);
}

function opaqueId(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value);
}

function nativeTurnId(metadata, session) {
  if (!metadata || typeof metadata !== "object") return;
  const sources = [metadata];
  for (const key of ["x-codex-turn-metadata", "ws_request_header_x_codex_turn_metadata"]) {
    let value = metadata[key];
    if (value == null) continue;
    if (typeof value === "string" && value.length <= 16_384) {
      try { value = JSON.parse(value); } catch { return; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    sources.push(value);
  }
  const values = (key) => [...new Set(sources.map((source) => source[key]).filter((value) => value != null))];
  const threads = values("thread_id");
  const turns = values("turn_id");
  if (threads.length !== 1 || threads[0] !== session || turns.length !== 1 || !opaqueId(turns[0], 128) ||
      values("root_turn_id").some((root) => root !== turns[0])) return;
  return turns[0];
}

function digest(session, id) {
  return createHash("sha256").update(session).update("\0").update(id).digest("hex");
}

function isToolCall(item) {
  return ["function_call", "custom_tool_call", "computer_call", "local_shell_call", "shell_call",
    "apply_patch_call", "tool_search_call", "mcp_approval_request"].includes(item?.type);
}

function finalMessageId(reply) {
  let messageId;
  for (const item of reply.output) {
    // Tool calls awaiting client output continue the turn in another request.
    if (isToolCall(item)) return;
    if (item?.type !== "message" || item.role !== "assistant" || item.phase === "commentary") continue;
    if (messageId || !opaqueId(item.id, 256) || (item.status != null && item.status !== "completed") ||
        (item.phase != null && item.phase !== "final_answer")) return;
    messageId = item.id;
  }
  if (messageId && reply.output.filter((item) => item?.id === messageId).length === 1) return messageId;
}

function traceAddress(address) {
  const match = /^(localhost|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/i.exec(address ?? "");
  if (!match) return;
  let [, hostname, port] = match;
  port = Number(port);
  if (port < 1 || port > 65535) return;
  if (hostname.toLowerCase() === "localhost") hostname = "127.0.0.1";
  if (hostname === "[::1]") hostname = "::1";
  else if (!isIPv4(hostname) || !hostname.startsWith("127.")) return;
  return { hostname, port };
}

function readTrace(address, signal) {
  const target = traceAddress(address);
  if (!target) return;
  const timeout = AbortSignal.timeout(traceTimeoutMs);
  return new Promise((resolve) => {
    const request = get({
      ...target,
      path: "/v1/magpie/trace",
      agent: false,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, (response) => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"]) > maxTraceBytes) {
        response.destroy();
        resolve();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxTraceBytes) {
          response.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => resolve());
      response.on("close", () => resolve());
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve();
        }
      });
    });
    request.on("error", () => resolve());
  });
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function successfulStatus(value) {
  return httpStatus(value) && value >= 200 && value < 300;
}

function providerId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) && !secretLike(value);
}

function modelId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:+/-]{0,159}$/.test(value) &&
    !value.includes("://") && value.split("/").every((part) => part && part !== "." && part !== ".." && !secretLike(part));
}

function secretLike(value) {
  return /^(?:sk[-_]|gh[opusr]_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA)/.test(value);
}

function exactRoute(trace, session, responseId) {
  if (trace?.object !== "trace" || !Array.isArray(trace.routes)) return;
  const matches = trace.routes.filter((row) => row?.session === session && row.responseId === responseId);
  if (matches.length !== 1) return;
  const [row] = matches;
  if (row.agent !== "codex" || row.done !== true || !successfulStatus(row.status) || row.error ||
      row.fail || row.canceled || row.kind || row.for || row.sub || row.subagent || row.subagentId ||
      row.parentSession || !Array.isArray(row.order) ||
      (row.left != null && !Array.isArray(row.left)) || !Array.isArray(row.tries) ||
      row.tries.length === 0 || row.tries.length > maxAttempts) return;

  const seats = [...row.order, ...(row.left ?? [])];
  const attempts = [];
  let provider;
  for (const [index, attempt] of row.tries.entries()) {
    if (!attempt || !opaqueId(attempt.id, 512) || !modelId(attempt.model) || attempt.done !== true || attempt.gone) return;
    const providers = new Set(seats.filter((seat) => seat?.id === attempt.id).map((seat) => seat.provider));
    if (providers.size !== 1) return;
    [provider] = providers;
    if (!providerId(provider)) return;
    const failed = Boolean(attempt.error || attempt.fail || (httpStatus(attempt.status) && attempt.status >= 400));
    const last = index === row.tries.length - 1;
    if (last ? failed || !successfulStatus(attempt.status) : !failed) return;
    const status = httpStatus(attempt.status) ? { status: attempt.status } : {};
    attempts.push({ route: `${provider}/${attempt.model}`, ...status, failed });
  }
  const winner = row.tries.at(-1);
  if (winner.served && row.served && winner.served !== row.served) return;
  const model = winner.served || row.served || winner.model;
  if (!modelId(model)) return;
  const time = typeof row.time === "string" ? Date.parse(row.time) : NaN;
  const order = Number.isSafeInteger(time) && time > 0 && Number.isSafeInteger(row.id) && row.id > 0
    ? { time, id: row.id } : undefined;
  return { record: { version: 1, provider, model, attempts }, order };
}

function ownedDirectory(path, uid, privateDirectory = false) {
  if (privateDirectory) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & (privateDirectory ? 0o077 : 0o022))) {
    throw new Error("Unsafe index directory");
  }
}

function indexDirectory(uid) {
  const xdg = process.env.XDG_CONFIG_HOME ?? "";
  const config = isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  const magpie = join(config, "magpie");
  const bridge = join(magpie, "paseo-bridge");
  const index = join(bridge, "v1");
  ownedDirectory(config, uid);
  ownedDirectory(magpie, uid);
  ownedDirectory(bridge, uid, true);
  ownedDirectory(index, uid, true);
  return index;
}

function ownedFile(info, uid) {
  return privateFile(info, uid) && info.nlink === 1;
}

function privateFile(info, uid) {
  return info.isFile() && info.uid === uid && !(info.mode & 0o077);
}

function cleanAndCount(index, uid, now) {
  const dir = opendirSync(index);
  let count = 0;
  let removals = 0;
  try {
    for (let visited = 0; visited <= maxRecords + 128; visited++) {
      const entry = dir.readSync();
      if (!entry) return count;
      const temporary = tempName.test(entry.name);
      if (!temporary && !recordName.test(entry.name)) continue;
      const path = join(index, entry.name);
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info) continue;
      // The host can exit between linking the finished file and dropping its temporary name.
      const removable = temporary ? privateFile(info, uid) : ownedFile(info, uid);
      if (removals < 32 && removable && now - info.mtimeMs >= retentionMs) {
        try {
          unlinkSync(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        removals++;
      } else {
        count++;
      }
    }
    return maxRecords;
  } finally {
    dir.closeSync();
  }
}

function existingRecord(path, uid) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (!ownedFile(info, uid) || info.size > maxRecordBytes) throw new Error("Unsafe index entry");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!ownedFile(opened, uid) || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new Error("Index entry changed");
    }
    const data = Buffer.alloc(maxRecordBytes + 1);
    const size = readSync(fd, data);
    if (size > maxRecordBytes) throw new Error("Index entry too large");
    return data.toString("utf8", 0, size);
  } finally {
    closeSync(fd);
  }
}

function storeRecord(key, record) {
  const uid = process.getuid();
  const index = indexDirectory(uid);
  const path = join(index, `${key}.json`);
  const bytes = `${JSON.stringify(record)}\n`;
  const conflict = "{}\n";
  const count = cleanAndCount(index, uid, Date.now());
  let existing = existingRecord(path, uid);
  if (existing === bytes || existing === conflict || (existing === undefined && count >= maxRecords)) return;

  const temp = join(index, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    if (existing === undefined) {
      try {
        // Publication can win only once, even when two hosts share an index.
        linkSync(temp, path);
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        existing = existingRecord(path, uid);
      }
    }
    if (existing !== undefined && existing !== bytes && existing !== conflict) {
      // Keep an ambiguous key unreadable until it expires.
      writeFileSync(temp, conflict);
      renameSync(temp, path);
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

import { createHmac } from "node:crypto";
import { validKey } from "./src/crypto.js";
import { PROOF, identity, taskSession, validName, TASK_NAME_LIMIT } from "./src/policy.js";
import { inspectRequest } from "./src/protocols.js";
import { readGrant, stateRoot, observeAuthorizationRequest } from "./src/grant-store.mjs";
import {resolveAuthorization} from "./src/session-authorization.js";

async function attachGrant(body, ctx) {
  // Never accept a proof supplied by a caller, a tool result or an older request.
  delete body[PROOF];
  const managed = resolveAuthorization(body,ctx);
  if (managed.managed) {ctx.state.grantStatus=managed.reason;return body;}
  const o = ctx.options || {}, session = taskSession(body, ctx);
  ctx.state.grantStatus = "no_matching_grant";
  if (!validKey(o.authKey) || !session) {
    ctx.state.grantStatus = "request_identity_unavailable"; return body;
  }
  try {
    const record = await readGrant(stateRoot(o.stateDir), session), now = Date.now();
    if (record.v === 2 && record.scope === "session_task") {
      if (!session || record.session !== session || record.mode !== "original" ||
          (ctx.cwd && record.workspace !== ctx.cwd) || !Number.isFinite(record.created) || record.created > now) {
        ctx.state.grantStatus = "task_identity_mismatch"; return body;
      }
      if (record.state !== "active") { ctx.state.grantStatus = "task_not_active"; return body; }
      // Human authorization belongs to this registered session task.
      const names = record.names;
      if (!Array.isArray(names) || !names.length || names.length > TASK_NAME_LIMIT || names.some(n => !validName(n))) throw new Error("invalid_task_names");
      const payload = JSON.stringify({v:2, scope:"session_task", thread:session, expires:now+10000, mode:"original", names});
      if (payload.length > 2 * 1024 * 1024) { ctx.state.grantStatus = "task_request_too_large"; return body; }
      body[PROOF] = {payload, mac:createHmac("sha256", Buffer.from(o.authKey,"hex")).update(payload).digest("hex")};
      ctx.state.grantStatus = "session_task_active";
      return body;
    }
  } catch (e) {
    ctx.state.grantStatus = e.code === "ENOENT" ? "no_matching_grant" : "grant_state_unavailable";
    if (e.code !== "ENOENT") ctx.report?.("company_guard_grant_unavailable", 0);
  }
  return body;
}

import { rememberDetails } from "./src/receipt-details.mjs";
import { newReceipt, appendReceipt } from "./src/receipts.mjs";
import {initializeOptions} from "./src/local-options.mjs";
import { prepareRequest, PREPARED } from "./src/company-guard.js";
export async function onRequest(body, ctx) {
  ctx.options ||= {};
  if (!["authKey", "receiptReadKey", "authorizationKey"].every(field => validKey(ctx.options[field])))
    await initializeOptions(ctx.options);
  const started = Date.now(), receipt = newReceipt(ctx, identity(body));
  ctx.state ||= {}; ctx.state.receipt = receipt;
  delete body[PREPARED]; delete body[PROOF];
  const key = ctx.options?.authKey;
  if (!validKey(key)) {
    await appendReceipt(ctx, receipt, "prepared", {status: "failed", error: true, processingMs: Date.now()-started});
    return body;
  }
  const sign = (key, value) => createHmac("sha256", Buffer.from(key, "hex")).update(value).digest("hex");
  const originalTools = body.tools === undefined ? undefined : structuredClone(body.tools);
  let error, schema = [];
  const local = {...ctx, state: {}, sign, reject: (_status, message) => {error = message;}};
  try {
    // A request only creates a pending item. This path cannot approve it.
    try { await observeAuthorizationRequest(body,ctx); } catch { ctx.report?.("unavailable",0); }
    await attachGrant(body, ctx); local.grantStatus = ctx.state.grantStatus; prepareRequest(body, local);
    const originalSlots = inspectRequest({tools: originalTools}, ctx.protocol).slots;
    schema = inspectRequest({tools: body.tools}, ctx.protocol).slots.flatMap((s, i) => s.owner[s.key] === originalSlots[i]?.owner[originalSlots[i].key] ? [] : [[i, s.owner[s.key]]]);
  } catch { error = "本地脱敏处理失败"; }
  if (originalTools !== undefined) body.tools = originalTools;
  const state = local.state.guard;
  ctx.state.receiptTokens = Object.keys(state?.reverse || {});
  const payload = JSON.stringify({v: 1, receiptId: receipt.id, thread: identity(body)?.thread || "", session: ctx.session || "", protocol: ctx.protocol, expires: Date.now() + 20000, reverse: state?.reverse || {}, schema, error});
  body[PREPARED] = {payload, mac: sign(key, payload)};
  const status = error || !state?.ready ? "failed" : state.metrics?.replacements ? "replaced" : state.metrics?.allowedOccurrences || state.metrics?.authorizationCoverage === "all" ? "authorized" : "no_match";
  if (status !== "failed") rememberDetails(stateRoot(ctx.options?.stateDir), receipt, state?.reverse);
  await appendReceipt(ctx, receipt, "prepared", {status, error: status === "failed", metrics: state?.metrics, processingMs: Date.now()-started});
  return body;
}

export async function onResponse(reply, ctx) {
  const receipt = ctx.state?.receipt;
  if (!receipt) return;
  let remaining = 0;
  try {
    const tokens = new Set(ctx.state.receiptTokens || []);
    const text = JSON.stringify(reply);
    for (const token of text?.match(/\[\[NERO_ORG_[a-f0-9]{24}\]\]/g) || []) if (tokens.has(token)) remaining++;
    await appendReceipt(ctx, receipt, "response_observed", {success: ctx.success, replyCaptured: !!reply, remaining});
  } catch {
    await appendReceipt(ctx, receipt, "response_observed", {success: false, replyCaptured: false});
  }
}

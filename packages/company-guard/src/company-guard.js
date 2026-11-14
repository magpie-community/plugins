import { sign, scopedSigner, same, validKey } from "./crypto.js";
import { PROOF, TOKEN_PREFIX, configuredNames, detectNames, directive, escapeRE, expandAllowed, identity, nameFieldValue, namePattern, readProof, taskAliases, validName, webTool } from "./policy.js";
import { inspectRequest, publicContextSafe, safeInput } from "./protocols.js";
import {resolveAuthorization} from "./session-authorization.js";

const ESCAPED_STRING = /"[^"\\]*(?:\\.[^"\\]*)+"/g;
const TOKEN = /\[\[NERO_ORG_[a-f0-9]{24}\]\]/g;
const NOTE = "Company identifiers of the form [[NERO_ORG_…]] are opaque local labels. Copy them exactly in text and tool arguments; do not infer or expand them.";
const fail = (ctx, code) => { ctx.reject(400, "NERO 公司名保护：" + code); };

function addNote(body, protocol) {
  if (protocol === "responses") body.instructions = (body.instructions ? body.instructions + "\n\n" : "") + NOTE;
  else if (protocol === "anthropic") {
    if (Array.isArray(body.system)) body.system.push({type: "text", text: NOTE});
    else body.system = (body.system ? body.system + "\n\n" : "") + NOTE;
  } else if (protocol === "gemini") {
    body.systemInstruction ||= {parts: []}; body.systemInstruction.parts ||= [];
    body.systemInstruction.parts.push({text: NOTE});
  } else if (Array.isArray(body.messages)) body.messages.unshift({role: "system", content: NOTE});
}

export function prepareRequest(body, ctx) {
  const budget = () => { if (ctx.signal?.aborted) throw new Error("本地处理已取消"); };
  ctx.state.guard = {reverse: Object.create(null), buffers: Object.create(null), ready: false, failed: false};
  try {
    const o = ctx.options || {};
    if (!validKey(o.authKey)) { fail(ctx, "尚未配置本地保护密钥"); return; }
    let proof = readProof(body[PROOF], body, o.authKey, ctx);
    delete body[PROOF];
    const managed = resolveAuthorization(body,ctx);
    if (managed.managed) proof = managed.record ? {mode:"original",scope:"session_task",coverage:managed.record.coverage,names:managed.record.names,pattern:managed.record.pattern} : null;
    if (!["responses", "chat", "anthropic", "gemini"].includes(ctx.protocol)) throw new Error("不支持的请求协议");
    safeInput(body, ctx.protocol);
    const view = inspectRequest(body, ctx.protocol);
    const metrics = ctx.state.guard.metrics = {matchedNames: 0, replacedNames: 0, replacements: 0, allowedOccurrences: 0, scopes: {}};
    const matched = new Set();
    const scopeOf = s => s.source === "user" ? (s.index === view.user?.index ? "user" : "history") : ({tool: "tool_results", call: "tool_arguments", schema: "tool_schema", instruction: "instructions"}[s.source] || "history");
    let currentScope;
    for (const slot of view.slots) {
      const key = scopeOf(slot);
      metrics.scopes[key] ||= {checkedTexts: 0, replacements: 0};
      metrics.scopes[key].checkedTexts++;
    }
    let size = 0;
    for (const s of view.slots) { size += s.owner[s.key].length; if (size > 4 * 1024 * 1024) throw new Error("文字超过 4 MiB，请缩小本次输入"); }
    if (proof?.coverage === "all") {
      metrics.authorization="original";metrics.authorizationReason=managed.reason;metrics.authorizationCoverage="all";
      ctx.state.guard.authorization="original";ctx.state.guard.ready=true;
      return body;
    }
    const requested = managed.managed ? new Set(proof?.names || []) : expandAllowed(proof?.names || [], o);
    if (proof?.mode === "public_lookup" && !publicContextSafe(view, requested)) proof = null;
    const allowed = proof ? requested : new Set();
    ctx.state.guard.authorization = proof ? proof.mode : "masked";
    metrics.authorization = ctx.state.guard.authorization;
    metrics.authorizationReason = managed.managed ? managed.reason : proof ? (proof.scope === "session_task" ? "session_task_active" : "turn_grant_active") : (ctx.grantStatus || "no_matching_grant");
    metrics.authorizationCoverage=proof?"names":"none";
    const names = new Set(configuredNames(o));
    const aliases = taskAliases(view.slots);
    for (const n of aliases.names) names.add(n);
    metrics.taskAliases = aliases.names.length;
    metrics.aliasConflicts = aliases.conflicts;
    metrics.aliasLimitReached = aliases.limited;
    if(!proof?.pattern)for (const n of allowed) names.add(n);
    for (const s of view.slots) {
      budget();
      const text = s.owner[s.key];
      for (const n of detectNames(text)) names.add(n);
      if (s.nameField) { const name = nameFieldValue(text, s.nameField); if (name) names.add(name); }
      // Historical control text is a recognition hint, never an authorization.
      if (s.source === "user") for (const n of directive(text)?.names || []) names.add(n);
      if (text.includes("\\u")) for (const q of text.matchAll(ESCAPED_STRING)) {
        let t; try { t = JSON.parse(q[0]); } catch { continue; }
        for (const n of detectNames(t)) names.add(n);
      }

    }
    const candidates = [...names].filter(n => typeof n === "string" && n.length >= 2).sort((a, b) => b.length - a.length);
    const pattern = candidates.length ? namePattern(candidates) : "";
    const matcher = candidates.length ? new RegExp("\\[\\[NERO_ORG_[a-f0-9]{24}\\]\\]|(?:" + pattern + ")", "gi") : null;
    const prefixMatcher = candidates.length ? new RegExp(namePattern([...new Set(candidates.map(n=>n.slice(0,2)))]),"i") : null;
    const literalMatchers = !ctx.sign ? candidates.map((n,rank)=>({re:new RegExp(escapeRE(n),"gi"),rank})) : null;
    const opaque = new RegExp(TOKEN.source,"gi");
    const approvedMatcher=proof?.pattern?new RegExp(proof.pattern,"gi"):null;
    const id = identity(body);
    const scope = [ctx.session, id?.thread].filter(Boolean).join(":") || "request:" + Date.now() + ":" + Math.random();
    const signName = ctx.sign ? name => ctx.sign(o.authKey,scope+"\u0000"+name) : scopedSigner(o.authKey,scope+"\u0000");
    const forward = Object.create(null), reverse = ctx.state.guard.reverse;
    const allowedFold = new Set([...allowed].map(n => n.toLowerCase()));
    const tokenFor = name => {
      if (forward[name]) return forward[name];
      const token = TOKEN_PREFIX + signName(name).slice(0, 24) + "]]";
      if (reverse[token] && reverse[token] !== name) throw new Error("名称代号冲突");
      forward[name] = token; reverse[token] = name; return token;
    };
    const replaceName = (name, offset, original, allow) => {
      if (/^\[\[NERO_ORG_[a-f0-9]{24}\]\]$/.test(name)) return name;
      if (/[A-Za-z0-9_]/.test(name[0]) && offset > 0 && /[A-Za-z0-9_]/.test(original[offset - 1])) return name;
      if (/[A-Za-z0-9_]/.test(name.at(-1)) && /[A-Za-z0-9_]/.test(original[offset + name.length] || "")) return name;
      matched.add(name); metrics.matchedNames = matched.size;
      if (allow && allowedFold.has(name.toLowerCase())) { metrics.allowedOccurrences++; return name; }
      const token = tokenFor(name);
      metrics.replacements++; metrics.scopes[currentScope].replacements++;
      return token;
    };
    const sub = (text, allow) => {
      if (!matcher&&!approvedMatcher) return text;
      if (!literalMatchers&&!approvedMatcher) return text.replace(matcher,(n,i,s)=>replaceName(n,i,s,allow));
      // Literal searches stay fast in the synchronous interpreter. Include
      // overlaps, then retain the union-regex order: earliest, longest first.
      const hits = []; let m;
      opaque.lastIndex = 0;
      while ((m=opaque.exec(text))) hits.push({at:m.index,name:m[0],rank:-1});
      if(approvedMatcher){approvedMatcher.lastIndex=0;while((m=approvedMatcher.exec(text)))hits.push({at:m.index,name:m[0],rank:0});}
      if(!literalMatchers&&matcher){matcher.lastIndex=0;while((m=matcher.exec(text)))hits.push({at:m.index,name:m[0],rank:1});}
      for (const item of literalMatchers||[]) {
        item.re.lastIndex = 0;
        while ((m=item.re.exec(text))) {
          hits.push({at:m.index,name:m[0],rank:item.rank});
          item.re.lastIndex = m.index+1;
        }
      }
      hits.sort((a,b)=>a.at-b.at || (approvedMatcher?b.name.length-a.name.length:0) || a.rank-b.rank);
      const pieces = []; let after = 0;
      for (const hit of hits) {
        if (hit.at<after) continue;
        pieces.push(text.slice(after,hit.at),replaceName(hit.name,hit.at,text,allow));
        after = hit.at+hit.name.length;
      }
      return after ? pieces.join("")+text.slice(after) : text;
    };
    for (const s of view.slots) {
      budget();
      currentScope = scopeOf(s);
      const allow = !!proof && (proof.mode === "original" || (s.source === "user" && s.index === view.user?.index) || (["tool", "call"].includes(s.source) && webTool(s.tool)));
      let text = s.owner[s.key];
      if ((!matcher&&!approvedMatcher) || (!approvedMatcher&&ctx.sign && !text.includes("\\u") && !prefixMatcher.test(text))) continue;
      // Re-write string literals individually so JSON numbers keep their exact bytes.
      // Decode only escaped literals. Ordinary strings need one native replace.
      if (text.includes("\\")) text = text.replace(ESCAPED_STRING, raw => {
        let value; try { value = JSON.parse(raw); } catch { return raw; }
        const next = sub(value, allow); return next === value ? raw : JSON.stringify(next);
      });
      text = sub(text, allow);
      if (s.sealed && text !== s.owner[s.key]) throw new Error("签名思考内容不能安全改写，请使用干净的新上下文");
      s.owner[s.key] = text;
    }
    metrics.replacedNames = Object.keys(reverse).length;
    if (metrics.replacedNames) addNote(body, ctx.protocol);
    ctx.state.guard.ready = true;
    return body;
  } catch (e) { fail(ctx, e instanceof Error ? e.message : "本地检查失败"); }
}

function restore(text, state, json = false) {
  if (typeof text !== "string") return text;
  return text.replace(TOKEN, token => {
    const name = state.reverse[token];
    if (name !== undefined && state.restoredTokens) state.restoredTokens[token] = true;
    return name === undefined ? token : json ? JSON.stringify(name).slice(1, -1) : name;
  });
}

function whole(value, state, depth = 0, data = false) {
  if (!value || typeof value !== "object" || depth > 64) return;
  for (const key of Object.keys(value)) {
    if (!data && /^(?:id|type|role|name|model|call_id|tool_call_id|tool_use_id|signature|encrypted_content)$/.test(key)) continue;
    if (typeof value[key] === "string") value[key] = restore(value[key], state, key === "arguments");
    else whole(value[key], state, depth + 1, data || key === "args" || (key === "input" && value.type === "tool_use"));
  }
}

function chunk(text, state, key, json = false, final = false) {
  if (typeof text !== "string") return text;
  let value = (state.buffers[key] || "") + text;
  state.buffers[key] = "";
  if (!final) {
    let cut = value.lastIndexOf(TOKEN_PREFIX);
    if (cut >= 0) {
      const tail = value.slice(cut);
      if (tail.length < TOKEN_PREFIX.length + 26 && /^\[\[NERO_ORG_[a-f0-9]*\]?$/.test(tail)) {
        state.buffers[key] = tail; value = value.slice(0, cut);
      }
    }
    if (!state.buffers[key]) for (let n = Math.min(value.length, TOKEN_PREFIX.length - 1); n > 0; n--) {
      if (value.endsWith(TOKEN_PREFIX.slice(0, n))) { state.buffers[key] = value.slice(-n); value = value.slice(0, -n); break; }
    }
  }
  return restore(value, state, json);
}

function clear(state, prefix) { for (const key of Object.keys(state.buffers)) if (key.startsWith(prefix)) delete state.buffers[key]; }
function pending(state, prefix = "") { return Object.keys(state.buffers).some(k => k.startsWith(prefix) && state.buffers[k]); }
function streamError(ctx, state) {
  state.failed = true;
  receiptEvent(state, "reply_processed", false, "restoration_incomplete");
  const message = "NERO 公司名还原未完成，已停止此回复，请重试。";
  if (ctx.protocol === "responses") return {type: "error", code: "nero_restore_incomplete", message, param: null};
  if (ctx.protocol === "anthropic") return {type: "error", error: {type: "api_error", message}};
  return {error: {type: "nero_restore_incomplete", message}};
}

export function onEvent(ev, ctx) {
  const state = ctx.state.guard;
  if (!state?.ready) return;
  if (!Object.keys(state.reverse).length) { if (terminalEvent(ev, ctx.protocol)) receiptEvent(state, "reply_processed", terminalOK(ev), terminalOK(ev) ? "processed" : "upstream_incomplete", terminalLabel(ev, ctx.protocol)); return; }
  if (state.failed) return null;
  try {
    if (ctx.protocol === "responses") {
      const p = "r:" + (ev.output_index ?? 0) + ":";
      const key = p + (ev.content_index ?? ev.summary_index ?? 0) + ":" + (ev.type || "").replace(/\.(delta|done)$/, "");
      if (typeof ev.delta === "string" && /\.delta$/.test(ev.type)) ev.delta = chunk(ev.delta, state, key, ev.type === "response.function_call_arguments.delta");
      else {
        whole(ev, state);
        if (/\.(done)$/.test(ev.type)) {
          if (ev.type === "response.output_item.done") clear(state, p); else delete state.buffers[key];
        }
        if (["response.completed", "response.incomplete", "response.failed"].includes(ev.type)) {
          if (Array.isArray(ev.response?.output) && ev.response.output.length) clear(state, "r:");
          if (pending(state)) return streamError(ctx, state);
        }
      }
    } else if (ctx.protocol === "anthropic") {
      const p = "a:" + (ev.index ?? 0) + ":";
      if (ev.type === "content_block_delta") {
        for (const key of ["text", "thinking", "partial_json"]) if (typeof ev.delta?.[key] === "string") ev.delta[key] = chunk(ev.delta[key], state, p + key, key === "partial_json");
      } else {
        whole(ev, state);
        if (ev.type === "content_block_stop" && pending(state, p)) return streamError(ctx, state);
        if (ev.type === "message_stop" && pending(state)) return streamError(ctx, state);
      }
    } else if (Array.isArray(ev.choices)) {
      for (const c of ev.choices) {
        const p = "c:" + (c.index ?? 0) + ":", end = c.finish_reason != null;
        c.delta ||= {};
        for (const key of ["content", "reasoning", "reasoning_content", "refusal"]) if (typeof c.delta[key] === "string" || (end && state.buffers[p + key])) c.delta[key] = chunk(c.delta[key] || "", state, p + key, false, end);
        for (const t of c.delta.tool_calls || []) if (t.function) t.function.arguments = chunk(t.function.arguments || "", state, p + "tool:" + (t.index ?? 0), true, end);
        if (c.delta.function_call) c.delta.function_call.arguments = chunk(c.delta.function_call.arguments || "", state, p + "function", true, end);
        if (end && pending(state, p)) return streamError(ctx, state);
      }
    } else if (Array.isArray(ev.candidates)) {
      for (let ci = 0; ci < ev.candidates.length; ci++) {
        const c = ev.candidates[ci], parts = c.content?.parts || [];
        for (let pi = 0; pi < parts.length; pi++) {
          const part = parts[pi], key = "g:" + (c.index ?? ci) + ":" + pi + ":" + !!part.thought;
          if (typeof part.text === "string") part.text = chunk(part.text, state, key, false, !!c.finishReason);
          if (part.functionCall) whole(part.functionCall.args, state, 0, true);
        }
        if (c.finishReason && pending(state, "g:" + (c.index ?? ci) + ":")) return streamError(ctx, state);
      }
    } else whole(ev, state);
    if (terminalEvent(ev, ctx.protocol)) receiptEvent(state, "reply_processed", terminalOK(ev) && !state.failed && !pending(state), !terminalOK(ev) ? "upstream_incomplete" : state.failed || pending(state) ? "restoration_incomplete" : "processed", terminalLabel(ev, ctx.protocol));
    return ev;
  } catch { return streamError(ctx, state); }
}

export function onResponse(body, ctx) {
  const state = ctx.state.guard;
  if (!state?.ready) return;
  whole(body, state); receiptEvent(state, "reply_processed", !state.failed && !pending(state)); return body;
}

export const PREPARED = "__nero_company_prepared";
export function onRequest(body, ctx) {
  const envelope = body[PREPARED];
  delete body[PREPARED]; delete body[PROOF];
  const key = ctx.options?.authKey;
  try {
    if (!validKey(key)) throw new Error("本地保护密钥不可用");
    if (envelope === undefined || envelope === null) {
      // The async host can keep the original body when its result cannot cross
      // the RPC boundary. Process it here instead of depending on that handoff.
      // Confirmed session grants are read from the same protected options as
      // the async path; without one, recognized names use default masking.
      // A client thread id is a stable pseudonym salt, never an authorization.
      let metadata = body?.client_metadata?.["x-codex-turn-metadata"] || body?.client_metadata;
      if (typeof metadata === "string") { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
      const hint = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(metadata?.thread_id || "") ? metadata.thread_id : undefined;
      const result = prepareRequest(body, {...ctx, session:ctx.session || hint});
      const state = ctx.state.guard;
      if (state?.ready) {
        state.fallback = true;
        state.fallbackIdentity = identity(body);
        state.restoredTokens = Object.create(null);
        receiptEvent(state, "request_checked", true);
      }
      return result;
    }
    if (!envelope || typeof envelope.payload !== "string") throw new Error("本地脱敏处理未完成：缺少处理结果");
    if (!same(sign(key, envelope.payload), envelope.mac)) throw new Error("本地脱敏处理结果签名不匹配");
    const p = JSON.parse(envelope.payload), now = Date.now();
    if (p.v !== 1 || p.protocol !== ctx.protocol || p.expires < now || p.expires > now + 30000 || p.thread !== (identity(body)?.thread || "")) throw new Error("本地脱敏结果已失效");
    if (p.error) throw new Error(p.error);
    const reverse = Object.create(null);
    for (const [token, name] of Object.entries(p.reverse || {})) {
      if (!/^\[\[NERO_ORG_[a-f0-9]{24}\]\]$/.test(token) || !validName(name)) throw new Error("名称还原记录无效");
      reverse[token] = name;
    }
    ctx.state.guard = {reverse, buffers: Object.create(null), ready: true, failed: false, receiptId: p.receiptId, restoredTokens: Object.create(null)};
    if (p.schema?.length) {
      const slots = inspectRequest({tools: body.tools}, ctx.protocol).slots;
      for (const [i, text] of p.schema) {
        if (!slots[i] || typeof text !== "string") throw new Error("工具说明处理结果无效");
        slots[i].owner[slots[i].key] = text;
      }
    }
    receiptEvent(ctx.state.guard, "request_checked", true);
    return body;
  } catch (e) { fail(ctx, e.message || "本地处理失败"); }
}

function terminalOK(ev) { return !["error", "response.failed", "response.incomplete"].includes(ev.type); }
function terminalLabel(ev, protocol) {
  if (protocol === "chat") return ev.choices?.length && ev.choices.every(c => ["stop", "tool_calls", "function_call"].includes(c.finish_reason)) ? "chat.completed" : undefined;
  if (protocol === "gemini") return ev.candidates?.length && ev.candidates.every(c => c.finishReason === "STOP") ? "gemini.completed" : undefined;
  return ev.type;
}
function terminalEvent(ev, protocol) {
  if (protocol === "responses") return ["response.completed", "response.failed", "response.incomplete"].includes(ev.type);
  if (protocol === "anthropic") return ["message_stop", "error"].includes(ev.type);
  if (protocol === "chat") return ev.choices?.length && ev.choices.every(c => c.finish_reason != null);
  return ev.candidates?.length && ev.candidates.every(c => c.finishReason);
}
function receiptEvent(state, phase, ok, reason, eventType) {
  if (!state?.fallback && !/^[a-f0-9-]{36}$/.test(state?.receiptId || "")) return;
  if (phase === "reply_processed" && state.receiptDone) return;
  if (phase === "reply_processed") state.receiptDone = true;
  const replyReason = phase === "reply_processed" ? reason || (ok ? "processed" : "restoration_incomplete") : undefined;
  const terminalType = ["response.completed", "response.failed", "response.incomplete", "message_stop", "chat.completed", "gemini.completed", "error"].includes(eventType) ? eventType : undefined;
  if (state.fallback) {
    const metrics = state.metrics || {};
    try { console.info("NERO_COMPANY_GUARD_FALLBACK " + JSON.stringify({phase, ok, thread:state.fallbackIdentity?.thread || null, turn:state.fallbackIdentity?.turn || null, cause:"prepared_result_unavailable", authorization:metrics.authorization || "masked", authorizationCoverage:metrics.authorizationCoverage || "none", matchedNames:metrics.matchedNames || 0, replacements:metrics.replacements || 0, reason:replyReason, eventType:terminalType, restoredNames:Object.keys(state.restoredTokens).length})); } catch {}
    return;
  }
  try { console.info("NERO_COMPANY_GUARD_RECEIPT " + JSON.stringify({id: state.receiptId, phase, ok, reason:replyReason, eventType:terminalType, restoredNames: Object.keys(state.restoredTokens || {}).length})); } catch {}
}

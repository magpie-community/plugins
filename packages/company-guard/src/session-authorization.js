import {sign, same, validKey, digest} from "./crypto.js";

const PREFIX = "nero.session.authorization.v1\0";
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value);
export const AUTHORIZATION_REQUEST = "申请本会话原名放行";

export function sessionIdentity(body, ctx) {
  if (ctx?.agent !== "codex" || (ctx.origin && !["local", "magpie-key"].includes(ctx.origin))) return null;
  let meta = body?.client_metadata?.["x-codex-turn-metadata"] || body?.client_metadata;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { return null; } }
  if (!meta || !["user", "agent_created_thread"].includes(meta.thread_source) || !validId(meta.thread_id) || !validId(meta.turn_id)) return null;
  if (ctx.session && ctx.session !== meta.thread_id) return null;
  return {session: meta.thread_id, turn: meta.turn_id};
}

// Codex states its current directory in its own environment block. Tool output
// and assistant messages cannot supply the directory for a session grant.
export function sessionWorkspace(body, ctx) {
  if (typeof ctx?.cwd === "string" && ctx.cwd.startsWith("/")) return ctx.cwd.replace(/\/$/, "") || "/";
  let workspace = "";
  for (const item of body?.input || body?.messages || []) {
    if (!["user", "developer", "system"].includes(item?.role)) continue;
    const texts = typeof item.content === "string" ? [item.content] : (Array.isArray(item.content) ? item.content : []).filter(p => ["text", "input_text", "output_text"].includes(p?.type)).map(p => p.text || "");
    for (const text of texts) {
      for (const block of text.matchAll(/<environment_context>[\s\S]*?<\/environment_context>/g)) {
        const cwd = /<cwd>\s*([^<\n]+?)\s*<\/cwd>/.exec(block[0])?.[1];
        if (cwd?.startsWith("/")) workspace = cwd.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/\/$/, "") || "/";
      }
    }
  }
  return workspace;
}

export function signAuthorization(record, key) {
  const {names,pattern="",...header}=record;
  const payload = JSON.stringify({...header,nameCount:names.length,contentsHash:digest(JSON.stringify({names,pattern}))});
  if (payload.length > 2 * 1024 * 1024 || !validKey(key)) throw new Error("authorization_too_large");
  return {session:record.session, payload, mac:sign(key, PREFIX + payload),names,pattern};
}

export function readAuthorization(envelope, key, verifyContents=true) {
  if (!validKey(key) || !envelope || typeof envelope.payload !== "string" || envelope.payload.length > 2 * 1024 * 1024 || !same(sign(key,PREFIX+envelope.payload),envelope.mac)) return null;
  let record; try { record = JSON.parse(envelope.payload); } catch { return null; }
  record.names=envelope.names;record.pattern=envelope.pattern;
  if (record.v !== 1 || !validId(record.session) || record.session !== envelope.session || typeof record.workspace !== "string" || !record.workspace.startsWith("/") || !["active","revoked"].includes(record.state) || !["all","names"].includes(record.coverage) || !Number.isFinite(record.created) || record.created > Date.now() || !Array.isArray(record.names) || record.names.length > 32 || record.names.some(n => typeof n !== "string" || n.length < 2 || n.length > 120) || (record.coverage === "names" && record.state === "active" && !record.names.length) || (record.coverage === "all" && record.names.length)) return null;
  if(record.nameCount!==record.names.length||typeof record.pattern!=="string")return null;
  // Complete list integrity is verified in the page service before publishing.
  // The request runtime receives immutable host options, never a grant from the
  // request body. It verifies the compact scope seal within its 250 ms budget.
  if(verifyContents&&digest(JSON.stringify({names:record.names,pattern:record.pattern}))!==record.contentsHash)return null;
  return record;
}

export function resolveAuthorization(body, ctx) {
  const id = sessionIdentity(body,ctx);
  if (!id) return {record:null, reason:"request_identity_unavailable", managed:false};
  const entries = ctx.options?.sessionAuthorizations;
  if (!Array.isArray(entries) || entries.length > 64) return {record:null, managed:false};
  const matching = entries.filter(e => e?.session === id.session);
  if (!matching.length) return {record:null, managed:false};
  if (matching.length !== 1) return {record:null, managed:true, reason:"authorization_invalid"};
  const record = readAuthorization(matching[0],ctx.options?.authKey,false);
  if (!record) return {record:null, managed:true, reason:"authorization_invalid"};
  if (record.state !== "active") return {record:null, managed:true, reason:"session_revoked"};
  if (sessionWorkspace(body,ctx) !== record.workspace) return {record:null, managed:true, reason:"task_identity_mismatch"};
  return {record, managed:true, reason:record.coverage === "all" ? "session_all_active" : "session_names_active"};
}

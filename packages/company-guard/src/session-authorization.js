import {sign, same, validKey, digest} from "./crypto.js";

const PREFIX = "nero.session.authorization.v1\0";
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value);
export const AUTHORIZATION_REQUEST = "申请本会话原名放行";
export const AUTHORIZATION_ENTRY_LIMIT = 100;

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

export function planAuthorizationEntries(entries, record, key, legacySessions = new Set()) {
  const retained = entries.filter(envelope => {
    const prior = readAuthorization(envelope, key);
    if (!prior) throw new Error("invalid_registry");
    // Keep a revocation while an independent legacy grant could still revive it.
    return envelope.session !== record.session && (prior.state === "active" || legacySessions.has(envelope.session));
  });
  const entry = signAuthorization(record, key), next = retained.concat(entry);
  if (next.length > AUTHORIZATION_ENTRY_LIMIT || JSON.stringify(next).length > 3 * 1024 * 1024) throw new Error("authorization_too_large");
  return {entry, entries:next};
}

export function resolveAuthorization(body, ctx) {
  const id = sessionIdentity(body,ctx);
  if (!id) return {record:null, reason:"request_identity_unavailable", managed:false};
  const entries = ctx.options?.sessionAuthorizations;
  if (!Array.isArray(entries) || entries.length > AUTHORIZATION_ENTRY_LIMIT) return {record:null, managed:false};
  const matching = entries.filter(e => e?.session === id.session);
  if (!matching.length) return {record:null, managed:false};
  if (matching.length !== 1) return {record:null, managed:true, reason:"authorization_invalid"};
  const record = readAuthorization(matching[0],ctx.options?.authKey,false);
  if (!record) return {record:null, managed:true, reason:"authorization_invalid"};
  if (record.state !== "active") return {record:null, managed:true, reason:"session_revoked"};
  if (sessionWorkspace(body,ctx) !== record.workspace) return {record:null, managed:true, reason:"task_identity_mismatch"};
  return {record, managed:true, reason:record.coverage === "all" ? "session_all_active" : "session_names_active"};
}

export function receiptAuthorizationTarget(row) {
  const workspace=row?.authorizationWorkspace;
  if(row?.agent!=="codex"||!validId(row.id)||!validId(row.task)||row.task!==row.thread||typeof workspace!=="string"||!workspace.startsWith("/")||workspace.length>4096||/[\u0000-\u001f\u007f]/.test(workspace))return null;
  return {session:row.task,workspace,turn:row.id};
}

export function reapplicationTarget(request){
  if(request?.state!=="closed"||request.resolution!=="rejected"||!/^[a-f0-9]{64}$/.test(request.id||""))return null;
  return receiptAuthorizationTarget({id:request.id,task:request.session,thread:request.session,agent:"codex",authorizationWorkspace:request.workspace});
}

export function receiptAuthorizationSessions(rows, entries, key, pending = [], rejected = []) {
  const counts=new Map();
  for(const e of Array.isArray(entries)?entries:[])counts.set(e?.session,(counts.get(e?.session)||0)+1);
  const active=Array.isArray(entries)&&entries.length<=AUTHORIZATION_ENTRY_LIMIT?entries.map(e=>readAuthorization(e,key)).filter(r=>r?.state==="active"&&counts.get(r.session)===1):[];
  const sessions=new Map(),keyOf=(session,workspace,agent)=>JSON.stringify([session,workspace,agent]);
  const known=new Map(),remember=(session,workspace)=>{const scopes=known.get(session)||new Set();scopes.add(workspace);known.set(session,scopes);};
  for(const r of active)remember(r.session,r.workspace);
  for(const r of rejected){const target=reapplicationTarget(r);if(target)remember(target.session,target.workspace);}
  for(const row of rows){const target=receiptAuthorizationTarget(row);if(target)remember(target.session,target.workspace);}
  for(const r of active)sessions.set(keyOf(r.session,r.workspace,"codex"),{session:r.session,task:r.session,thread:r.session,workspace:r.workspace,agent:"codex",authorizationState:r.coverage==="all"?"all":"names",requestCount:0,receiptId:null});
  for(const row of rows){
    const session=row.task||row.thread;if(!session)continue;
    const target=receiptAuthorizationTarget(row),scopes=(!row.agent||row.agent==="codex")&&known.get(session),fallback=scopes?.size===1?[...scopes][0]:"",workspace=target?.workspace||fallback||"",agent=row.agent||(fallback?"codex":null),id=keyOf(session,workspace,agent);
    const current=sessions.get(id)||{session,task:session,thread:session,workspace,agent,authorizationState:"masked",requestCount:0,receiptId:null};
    current.requestCount++;
    if(row.at&&(!current.latestAt||row.at>current.latestAt))current.latestAt=row.at;
    if(target&&!current.receiptId){current.receiptId=row.id;current.receiptDate=row.at?.slice(0,10);}
    sessions.set(id,current);
  }
  for(const row of sessions.values()){
    row.pending=pending.some(r=>r.session===row.session&&r.workspace===row.workspace);
    const prior=rejected.find(r=>{const target=reapplicationTarget(r);return target&&row.agent==="codex"&&target.session===row.session&&target.workspace===row.workspace;});
    if(prior&&!row.pending&&row.authorizationState!=="all")row.reapplyRequestId=prior.id;
  }
  return [...sessions.values()];
}

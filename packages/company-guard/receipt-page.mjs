import fs from "node:fs/promises";
import {recordRuleRevision,recordAuthorizationEvent,readAuditHistory} from "./src/rule-history.mjs";
import {constants} from "node:fs";
import {createServer} from "node:http";
import {timingSafeEqual, randomBytes, randomUUID} from "node:crypto";
import path from "node:path";
import os from "node:os";
import {gunzipSync} from "node:zlib";
import {getReceiptReport,getRetainedReceiptRows} from "./src/receipt-report.mjs";
import {readDetails} from "./src/receipt-details.mjs";
import {stateRoot, secureDir, listAuthorizationRequests, closeAuthorizationRequest, legacyTaskGrants, revokeGrant, queueAuthorizationRequest} from "./src/grant-store.mjs";
import {retainReceipts, readTail, receiptAgent} from "./src/receipts.mjs";
import {validName,namePattern} from "./src/policy.js";
import {readAuthorization, planAuthorizationEntries, AUTHORIZATION_ENTRY_LIMIT, receiptAuthorizationTarget, receiptAuthorizationSessions, reapplicationTarget} from "./src/session-authorization.js";
import {initializeOptions,validateCompanyRules,companyRulesRevision} from "./src/local-options.mjs";

const services = new Map();
const agentNames={codex:"Codex",claude:"Claude Code","claude-code":"Claude Code",pi:"Pi",opencode:"OpenCode","deepseek-harness":"DeepSeek Harness",deepseek:"DeepSeek",hermes:"Hermes","nero-banker":"NERO Banker"};

// Titles and task kinds are display metadata only, never authorization.
// Read local indexes, never chat messages, and match complete session IDs.
async function withTaskTitles(rows, day, availableAgents) {
  const idOf=row=>row.session || row.task || row.thread;
  const ids=new Set(rows.map(idOf).filter(Boolean)),titles=new Map(),agents=new Map(),backgroundLabels=new Map();
  const addAgent=(id,value)=>{const agent=receiptAgent(value);if(agent){availableAgents?.add(agent);const found=agents.get(id)||new Set();found.add(agent);agents.set(id,found);}};
  for(const row of rows)addAgent(idOf(row),row.agent);
  if(ids.size)try{
    const file=path.join(process.env.CODEX_HOME || path.join(os.homedir(),".codex"),"session_index.jsonl");
    const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await fd.stat();
      if(stat.isFile()&&stat.uid===process.getuid()&&stat.size<=8*1024*1024){
        for(const line of (await fd.readFile("utf8")).split("\n")){
          let row;try{row=JSON.parse(line);}catch{continue;}
          if(ids.has(row?.id)&&typeof row.thread_name==="string"){
            addAgent(row.id,"codex");
            const title=row.thread_name.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,300);
            if(title)titles.set(row.id,title);
          }
        }
      }
    }finally{await fd.close();}
  }catch{} // An unavailable title index must not affect grants or receipts.
  const missing=new Set([...ids].filter(id=>!titles.has(id)));
  const days=/^\d{4}-\d{2}-\d{2}$/.test(day||"")?[day]:[...new Set(rows.map(r=>(r.latestAt||r.at||"").slice(0,10)).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))];
  if(missing.size && days.length){
    // Hidden Codex tasks need not appear in its chat-title index. Magpie's
    // routing history already records their kinds, including older receipts.
    const labels=new Map([
      ["memory_consolidation","后台记忆整理"], ["memgen","后台记忆处理"],
      ["guardian","后台审批复核"], ["guardian_review","后台审批复核"],
      ["thread_title","后台标题生成"], ["thread_title_reconsideration","后台标题更新"],
      ["composer_predictions","后台输入预测"], ["collab_spawn","子任务"],
      ["ambient_suggestions","后台建议生成"],
      ["compact","上下文压缩"], ["review","后台审阅"]
    ]), kinds=new Map();
    const config=path.isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(),".config");
    // Receipt dates use UTC; routes use local dates, which may be adjacent.
    const dates=new Set(days.flatMap(d=>[-1,0,1].map(offset=>new Date(Date.parse(d+"T00:00:00Z")+offset*86400000).toISOString().slice(0,10))));
    for(const date of dates)try{
      const file=path.join(config,"magpie","routing",date+".jsonl");
      let content=await readTail(file);
      if(!content){
        const fd=await fs.open(file+".gz",constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
          const stat=await fd.stat();
          if(stat.isFile()&&stat.uid===process.getuid()&&stat.size<=8*1024*1024)
            content=gunzipSync(await fd.readFile(),{maxOutputLength:16*1024*1024}).toString("utf8");
        }finally{await fd.close();}
      }
      for(const line of content.split("\n")){
        let route;try{route=JSON.parse(line);}catch{continue;}
        const knownAgent=receiptAgent(route?.agent);if(knownAgent)availableAgents?.add(knownAgent);
        if(!ids.has(route?.session))continue;
        addAgent(route.session,route.agent);
        if(route.agent!=="codex" || !missing.has(route.session))continue;
        const found=kinds.get(route.session) || new Set();
        found.add(labels.get(route.kind) || ""); kinds.set(route.session,found);
      }
    }catch{} // Missing, rotated or oversized history only affects the label.
    for(const [id,found] of kinds){
      // A session with ordinary or unknown calls must not acquire a false kind.
      if(!found.has("")){const label=found.size===1 ? [...found][0] : "后台任务";titles.set(id,label);backgroundLabels.set(id,label);}
    }
  }
  return rows.map(row=>{const own=receiptAgent(row.agent),found=own?[own]:[...(agents.get(idOf(row))||[])];return {...row,taskTitle:titles.get(idOf(row)) || "",backgroundTask:backgroundLabels.has(idOf(row)),agentIds:found,agentLabel:found.length?found.map(agent=>agentNames[agent]||agent).join("、"):"来源未记录"};});
}

// Runs inside Magpie's existing plugin host; no separate daemon or model call.
export const ReceiptPage = async (_input, options = {}) => {
  await initializeOptions(options);
  const port = Number(options.receiptPort || 3469);
  const key = options.receiptReadKey;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/.test(key || "")) {
    console.warn("company_guard_receipt_page_not_configured"); return {};
  }
  const root = stateRoot(options.stateDir);
  try{await recordRuleRevision(root,options.companies);}catch{console.warn("company_guard_rule_history_failed");}
  try { await retainReceipts(root, undefined, options.appLog); } catch { console.warn("company_guard_receipt_retention_failed"); }
  const assets = new Map();
  for (const [route,file,type] of [["/","page/dashboard.html","text/html"],["/session-authorization.html","page/authorization.html","text/html"],["/rules.html","page/rules.html","text/html"],["/rules.js","page/rules.js","text/javascript"],["/rules.css","page/rules.css","text/css"],["/authorization.js","page/authorization.js","text/javascript"],["/app.js","page/app.js","text/javascript"],["/style.css","page/style.css","text/css"],["/bridge.js","vendor/magpie-pagebridge.js","text/javascript"]]) {
    assets.set(route, {body:await fs.readFile(new URL(file,import.meta.url)),type});
  }
  if (services.has(port)) return {};
  const nonce=randomBytes(32).toString("hex");
  const canWrite=req=>{
    const writeKey=req.headers["x-authorization-key"];
    return req.headers.origin==="null"&&req.headers["x-authorization-nonce"]===nonce&&req.headers["content-type"]==="application/json"&&/^[a-f0-9]{64}$/.test(options.authorizationKey||"")&&typeof writeKey==="string"&&/^[a-f0-9]{64}$/.test(writeKey)&&timingSafeEqual(Buffer.from(writeKey),Buffer.from(options.authorizationKey));
  };
  const rules=async(req,res,url,send)=>{
    if(req.method==="GET"&&url.pathname==="/rules")return send(200,{nonce,revision:companyRulesRevision(options.companies),ruleCount:(options.companies||[]).length});
    if(req.method!=="POST"||url.pathname!=="/rules/validate")return send(405,{error:"method_not_allowed"});
    if(!canWrite(req))return send(403,{error:"forbidden"});
    let raw="";for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>384*1024)return send(413,{error:"too_many_names"});}
    let body;try{body=JSON.parse(raw);}catch{return send(400,{error:"invalid_json"});}
    if(!body||body.revision!==companyRulesRevision(options.companies))return send(409,{error:"rules_changed"});
    try{return send(200,validateCompanyRules(body.companies));}catch(error){return send(400,{error:error.message,conflicts:error.conflicts});}
  };
  const operationFile=id=>path.join(root,"authorization-operations",id+".json");
  const acquireOperationLock=async op=>{
    const dir=path.dirname(operationFile(op.id));await secureDir(root,true);await secureDir(dir,true);const lock=path.join(dir,"lock.json");
    try{const prior=JSON.parse(await fs.readFile(lock,"utf8"));if(prior.created<Date.now()-120000)await fs.unlink(lock);}catch(error){if(error.code!=="ENOENT")return false;}
    try{await fs.writeFile(lock,JSON.stringify({id:op.id,created:op.created}),{flag:"wx",mode:0o600});return true;}catch{return false;}
  };
  const releaseOperationLock=async id=>{
    const lock=path.join(root,"authorization-operations","lock.json");
    try{const row=JSON.parse(await fs.readFile(lock,"utf8"));if(row.id===id)await fs.unlink(lock);}catch(error){if(error.code!=="ENOENT")throw error;}
  };
  const readOperation=async id=>{
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("invalid_operation");
    await secureDir(path.dirname(operationFile(id)));
    const fd=await fs.open(operationFile(id),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>4096)throw new Error("invalid_operation");return JSON.parse(await fd.readFile("utf8"));}finally{await fd.close();}
  };
  const authorization=async(req,res,url,send)=>{
    if(req.method==="GET"){
      const pending=await listAuthorizationRequests(root),legacy=(await legacyTaskGrants(root)).map(g=>({session:g.session,workspace:g.workspace,coverage:"names",nameCount:g.names.length,names:g.names,created:g.created,legacy:true}));
      const rows=await withTaskTitles([...pending,...legacy]);
      let recent;
      try{
        const retained=await getRetainedReceiptRows(root),rejected=await listAuthorizationRequests(root,{rejected:true}),sessions=receiptAuthorizationSessions(retained,options.sessionAuthorizations||[],options.authKey,pending,rejected).filter(r=>r.requestCount>0).sort((a,b)=>(b.latestAt||"").localeCompare(a.latestAt||""));
        recent={available:true,requestCount:retained.length,unidentifiedCount:retained.length-sessions.reduce((n,s)=>n+s.requestCount,0),sessions:await withTaskTitles(sessions),readAt:new Date().toISOString()};
      }catch{recent={available:false,sessions:[],readAt:new Date().toISOString()};}
      return send(200,{nonce,revision:options.sessionAuthorizationRevision,pending:rows.slice(0,pending.length),legacy:rows.slice(pending.length),recent});
    }
    if(req.method!=="POST")return send(405,{error:"method_not_allowed"});
    if(!canWrite(req))return send(403,{error:"forbidden"});
    let raw="";for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4*1024*1024)return send(413,{error:"authorization_too_large"});}
    let body;try{body=JSON.parse(raw);}catch{return send(400,{error:"invalid_json"});}
    if(["/authorization/commit","/authorization/cancel"].includes(url.pathname)){
      const op=await readOperation(body.operationId);
      if(op.created<Date.now()-120000||body.entryMac!==op.entryMac)return send(409,{error:"operation_expired"});
      if(url.pathname==="/authorization/commit"){
        // A confirmed page operation replaces the old independent registration.
        await revokeGrant(root,op.session);
        if(op.requestId)await closeAuthorizationRequest(root,op.requestId);
        await recordAuthorizationEvent(root,{session:op.session,action:op.action,coverage:op.coverage,nameCount:op.nameCount,operationId:op.id});
      }
      await fs.unlink(operationFile(op.id));
      await fs.rm(path.join(root,"authorization-operations","lock.json"),{force:true});
      return send(200,{ok:true});
    }
    if(url.pathname==="/authorization/request"){
      let row,target;
      if(body.reapplyRequestId){
        if(!/^[a-f0-9]{64}$/.test(body.reapplyRequestId))return send(400,{error:"invalid_request"});
        const prior=(await listAuthorizationRequests(root,{rejected:true})).find(r=>r.id===body.reapplyRequestId);target=reapplicationTarget(prior);
        if(target)row={id:target.turn,task:target.session,thread:target.session,agent:"codex",authorizationWorkspace:target.workspace};
      }else{
        if(!/^[a-f0-9-]{36}$/i.test(body.receiptId||"")||!/^\d{4}-\d{2}-\d{2}$/.test(body.date||""))return send(400,{error:"invalid_receipt"});
        const report=await getReceiptReport({day:body.date,root,appLog:options.appLog});row=report.rows.find(r=>r.id===body.receiptId);target=receiptAuthorizationTarget(row);
      }
      if(!target)return send(409,{error:"receipt_target_unavailable"});
      const sessions=receiptAuthorizationSessions([row],options.sessionAuthorizations||[],options.authKey);
      if(sessions.some(s=>s.session===target.session&&s.workspace===target.workspace&&s.authorizationState==="all"))return send(409,{error:"already_authorized"});
      const request=await queueAuthorizationRequest(root,{session:target.session,turn:randomUUID()},target.workspace,"receipt");
      if(!request)return send(409,{error:"pending_capacity"});
      return send(200,{requestId:request.id,pending:true});
    }
    if(url.pathname==="/authorization/reject"){
      if(!/^[a-f0-9]{64}$/.test(body.requestId||""))return send(400,{error:"invalid_request"});
      const op={id:randomUUID(),created:Date.now()};if(!await acquireOperationLock(op))return send(409,{error:"operation_busy"});
      try{
        const request=(await listAuthorizationRequests(root)).find(r=>r.id===body.requestId);if(!request)return send(409,{error:"request_expired"});
        const closed=await closeAuthorizationRequest(root,request.id,"rejected");
        try{await recordAuthorizationEvent(root,{at:closed.closedAt,session:request.session,action:"reject",coverage:"none",nameCount:0,requestId:request.id,operationId:op.id});}
        catch{return send(500,{error:"rejection_history_unavailable"});}
        return send(200,{ok:true,requestId:request.id});
      }finally{await releaseOperationLock(op.id);}
    }
    if(!Array.isArray(body.entries)||body.entries.length>AUTHORIZATION_ENTRY_LIMIT||body.entries.some(e=>!readAuthorization(e,options.authKey)))return send(400,{error:"invalid_registry"});
    const ids=new Set(body.entries.map(e=>e.session));if(ids.size!==body.entries.length)return send(400,{error:"invalid_registry"});
    if(url.pathname==="/authorization/state")return send(200,{active:await withTaskTitles(body.entries.map(e=>readAuthorization(e,options.authKey)).filter(r=>r.state==="active").map(r=>({session:r.session,workspace:r.workspace,coverage:r.coverage,nameCount:r.names.length,names:r.names,created:r.created,requestId:r.requestId})))});
    if(url.pathname!=="/authorization/plan")return send(404,{error:"not_found"});
    let request, prior;
    const legacy=await legacyTaskGrants(root);
    if(body.action==="approve"){
      request=(await listAuthorizationRequests(root)).find(r=>r.id===body.requestId);
      if(!request)return send(409,{error:"request_expired"});
    }else if(body.action==="revoke"){
      prior=body.entries.map(e=>readAuthorization(e,options.authKey)).find(r=>r.session===body.session&&r.state==="active")||legacy.find(r=>r.session===body.session);
      if(!prior)return send(409,{error:"authorization_not_found"});
    }else return send(400,{error:"invalid_action"});
    const coverage=body.action==="revoke"?"all":body.coverage;
    if(!["all","names"].includes(coverage))return send(400,{error:"invalid_scope"});
    const names=coverage==="names"&&Array.isArray(body.names)?[...new Set(body.names.map(n=>typeof n==="string"?n.trim():n))]:[];
    if(coverage==="names"&&(!names.length||names.length>32||names.some(n=>!validName(n))))return send(400,{error:"invalid_names"});
    const target=request||prior;
    const record={v:1,session:target.session,workspace:target.workspace,requestId:request?.id,coverage,names,pattern:coverage==="names"?namePattern(names):"",state:body.action==="revoke"?"revoked":"active",created:Date.now()};
    let plan;
    try{plan=planAuthorizationEntries(body.entries,record,options.authKey,new Set(legacy.map(r=>r.session)));}
    catch(error){if(error.message==="authorization_too_large")return send(413,{error:"authorization_too_large"});throw error;}
    const {entry,entries}=plan;
    const op={id:randomUUID(),action:body.action,session:record.session,requestId:request?.id,entryMac:entry.mac,coverage:record.coverage,nameCount:names.length,created:Date.now()};
    if(!await acquireOperationLock(op))return send(409,{error:"operation_busy"});
    if(request&&!(await listAuthorizationRequests(root)).some(r=>r.id===request.id)){await releaseOperationLock(op.id);return send(409,{error:"request_expired"});}
    await fs.writeFile(operationFile(op.id),JSON.stringify(op)+"\n",{flag:"wx",mode:0o600});
    return send(200,{operationId:op.id,entryMac:entry.mac,entries,revision:op.id});
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (code, data) => {res.writeHead(code); res.end(JSON.stringify(data));};
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== "null")) return send(403, {error:"forbidden"});
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "X-Receipt-Key, X-Authorization-Key, X-Authorization-Nonce, Content-Type");
      return send(204, {});
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && assets.has(url.pathname)) {
      const asset = assets.get(url.pathname), local = `http://127.0.0.1:${port}`;
      res.setHeader("Content-Type", asset.type + "; charset=utf-8");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", `sandbox allow-scripts; default-src 'none'; script-src 'self' ${local}; style-src 'self' ${local} 'unsafe-inline'; connect-src 'self' ${local}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' wails://localhost`);
      res.writeHead(200); res.end(asset.body); return;
    }
    const supplied = req.headers["x-receipt-key"];
    if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) return send(401, {error:"unauthorized"});
    if(url.pathname==="/rules"||url.pathname.startsWith("/rules/")){
      try{return await rules(req,res,url,send);}catch{console.warn("company_guard_rules_unavailable");return send(400,{error:"rules_unavailable"});}
    }
    if(url.pathname==="/authorization"||url.pathname.startsWith("/authorization/")){
      try{return await authorization(req,res,url,send);}catch{console.warn("company_guard_authorization_unavailable");return send(400,{error:"authorization_unavailable"});}
    }
    if (req.method !== "GET") return send(405, {error:"read_only"});
    if(url.pathname==="/audit"){try{
      const history=await readAuditHistory(root),rejected=await listAuthorizationRequests(root,{rejected:true}),pending=await listAuthorizationRequests(root);
      history.authorizations=history.authorizations.map(row=>{
        const prior=rejected.find(r=>r.id===row.requestId),target=reapplicationTarget(prior);if(row.action!=="reject"||!target)return row;
        const scope=receiptAuthorizationSessions([{id:target.turn,task:target.session,thread:target.session,agent:"codex",authorizationWorkspace:target.workspace}],options.sessionAuthorizations||[],options.authKey,pending,rejected).find(s=>s.session===target.session&&s.workspace===target.workspace);
        return {...row,...(scope&&!scope.pending&&scope.authorizationState!=="all"?{reapplyRequestId:prior.id}:{})};
      });return send(200,history);
    }catch{return send(500,{error:"audit_unavailable"});}}
    if (url.pathname === "/details") {
      const id=url.searchParams.get("id") || "";
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return send(400,{error:"invalid_id"});
      return send(200,readDetails(root,id));
    }
    if (url.pathname !== "/receipts") return send(404, {error:"not_found"});
    const day = url.searchParams.get("date") || new Date().toISOString().slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(400, {error:"invalid_date"});
    try {
      const report = await getReceiptReport({day, root, appLog:options.appLog});
      const pending=await listAuthorizationRequests(root),sessions=receiptAuthorizationSessions(report.rows,options.sessionAuthorizations||[],options.authKey,pending);
      const availableAgents=new Set(),decorated=await withTaskTitles([...report.rows,...sessions],day,availableAgents),rows=decorated.slice(0,report.rows.length);
      send(200, {...report,rows,sessions:decorated.slice(report.rows.length),agentOptions:[...availableAgents].sort().map(id=>({id,label:agentNames[id]||id})),readAt:new Date().toISOString()});
    } catch { console.warn("company_guard_receipt_page_read_failed"); send(500, {error:"receipt_read_failed"}); }
  });
  server.requestTimeout = 10000;
  server.maxHeadersCount = 30;
  services.set(port,server);
  let retry, delay = 1000, recovering = false;
  const schedule = () => {
    if (retry) return;
    retry = setTimeout(() => {retry=null;server.listen(port,"127.0.0.1");},delay);
    retry.unref(); delay=Math.min(delay*2,30000);
  };
  server.on("error", error => {
    console.warn("company_guard_receipt_page_start_failed", error.code || "unknown");
    recovering=true; schedule();
  });
  server.on("listening", () => {
    clearTimeout(retry); retry=null; delay=1000;
    if(recovering)console.info("company_guard_receipt_page_recovered");
    recovering=false;
  });
  server.on("close",schedule);
  server.listen(port,"127.0.0.1");
  server.unref();
  return {};
};

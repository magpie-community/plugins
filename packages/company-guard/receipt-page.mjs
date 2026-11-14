import fs from "node:fs/promises";
import {constants} from "node:fs";
import {createServer} from "node:http";
import {timingSafeEqual, randomBytes, randomUUID} from "node:crypto";
import path from "node:path";
import os from "node:os";
import {gunzipSync} from "node:zlib";
import {getReceiptReport} from "./src/receipt-report.mjs";
import {readDetails} from "./src/receipt-details.mjs";
import {stateRoot, secureDir, listAuthorizationRequests, closeAuthorizationRequest, legacyTaskGrants, revokeGrant} from "./src/grant-store.mjs";
import {retainReceipts, readTail, receiptAgent} from "./src/receipts.mjs";
import {validName,namePattern} from "./src/policy.js";
import {readAuthorization, signAuthorization} from "./src/session-authorization.js";
import {initializeOptions} from "./src/local-options.mjs";

const services = new Map();
const agentNames={codex:"Codex",claude:"Claude Code","claude-code":"Claude Code",pi:"Pi",opencode:"OpenCode","deepseek-harness":"DeepSeek Harness",deepseek:"DeepSeek",hermes:"Hermes","nero-banker":"NERO Banker"};

// Titles and task kinds are display metadata only, never authorization.
// Read local indexes, never chat messages, and match complete session IDs.
async function withTaskTitles(rows, day, availableAgents) {
  const idOf=row=>row.session || row.task || row.thread;
  const ids=new Set(rows.map(idOf).filter(Boolean)),titles=new Map(),agents=new Map();
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
  if(ids.size && /^\d{4}-\d{2}-\d{2}$/.test(day || "")){
    // Hidden Codex tasks need not appear in its chat-title index. Magpie's
    // routing history already records their kinds, including older receipts.
    const labels=new Map([
      ["memory_consolidation","后台记忆整理"], ["memgen","后台记忆处理"],
      ["guardian","后台审批复核"], ["guardian_review","后台审批复核"],
      ["thread_title","后台标题生成"], ["thread_title_reconsideration","后台标题更新"],
      ["composer_predictions","后台输入预测"], ["collab_spawn","子任务"],
      ["compact","上下文压缩"], ["review","后台审阅"]
    ]), kinds=new Map();
    const config=path.isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(),".config");
    // Receipt dates use UTC; routes use local dates, which may be adjacent.
    for(const offset of [-1,0,1])try{
      const date=new Date(Date.parse(day+"T00:00:00Z")+offset*86400000).toISOString().slice(0,10);
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
      if(!found.has(""))titles.set(id,found.size===1 ? [...found][0] : "后台任务");
    }
  }
  return rows.map(row=>{const own=receiptAgent(row.agent),found=own?[own]:[...(agents.get(idOf(row))||[])];return {...row,taskTitle:titles.get(idOf(row)) || "",agentIds:found,agentLabel:found.length?found.map(agent=>agentNames[agent]||agent).join("、"):"来源未记录"};});
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
  try { await retainReceipts(root, undefined, options.appLog); } catch { console.warn("company_guard_receipt_retention_failed"); }
  const assets = new Map();
  for (const [route,file,type] of [["/","page/dashboard.html","text/html"],["/session-authorization.html","page/authorization.html","text/html"],["/authorization.js","page/authorization.js","text/javascript"],["/app.js","page/app.js","text/javascript"],["/style.css","page/style.css","text/css"],["/bridge.js","vendor/magpie-pagebridge.js","text/javascript"]]) {
    assets.set(route, {body:await fs.readFile(new URL(file,import.meta.url)),type});
  }
  if (services.has(port)) return {};
  const nonce=randomBytes(32).toString("hex");
  const operationFile=id=>path.join(root,"authorization-operations",id+".json");
  const readOperation=async id=>{
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("invalid_operation");
    await secureDir(path.dirname(operationFile(id)));
    const fd=await fs.open(operationFile(id),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>4096)throw new Error("invalid_operation");return JSON.parse(await fd.readFile("utf8"));}finally{await fd.close();}
  };
  const authorization=async(req,res,url,send)=>{
    if(req.method==="GET"){
      const pending=await listAuthorizationRequests(root),legacy=(await legacyTaskGrants(root)).map(g=>({session:g.session,workspace:g.workspace,coverage:"names",nameCount:g.names.length,created:g.created,legacy:true}));
      const rows=await withTaskTitles([...pending,...legacy]);
      return send(200,{nonce,revision:options.sessionAuthorizationRevision,pending:rows.slice(0,pending.length),legacy:rows.slice(pending.length)});
    }
    if(req.method!=="POST")return send(405,{error:"method_not_allowed"});
    const writeKey=req.headers["x-authorization-key"];
    if(req.headers.origin!=="null"||req.headers["x-authorization-nonce"]!==nonce||req.headers["content-type"]!=="application/json"||!/^[a-f0-9]{64}$/.test(options.authorizationKey||"")||typeof writeKey!=="string"||!/^[a-f0-9]{64}$/.test(writeKey)||!timingSafeEqual(Buffer.from(writeKey),Buffer.from(options.authorizationKey)))return send(403,{error:"forbidden"});
    let raw="";for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4*1024*1024)return send(413,{error:"authorization_too_large"});}
    let body;try{body=JSON.parse(raw);}catch{return send(400,{error:"invalid_json"});}
    if(["/authorization/commit","/authorization/cancel"].includes(url.pathname)){
      const op=await readOperation(body.operationId);
      if(op.created<Date.now()-120000||body.entryMac!==op.entryMac)return send(409,{error:"operation_expired"});
      if(url.pathname==="/authorization/commit"){
        // A confirmed page operation replaces the old independent registration.
        await revokeGrant(root,op.session);
        if(op.requestId)await closeAuthorizationRequest(root,op.requestId);
        const fd=await fs.open(path.join(root,"authorization-events.jsonl"),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
        try{const stat=await fd.stat();if(stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error("insecure_authorization_log");await fd.writeFile(JSON.stringify({at:new Date().toISOString(),session:op.session,action:op.action,coverage:op.coverage,nameCount:op.nameCount,operationId:op.id})+"\n");}finally{await fd.close();}
      }
      await fs.unlink(operationFile(op.id));
      await fs.rm(path.join(root,"authorization-operations","lock.json"),{force:true});
      return send(200,{ok:true});
    }
    if(!Array.isArray(body.entries)||body.entries.length>64||body.entries.some(e=>!readAuthorization(e,options.authKey)))return send(400,{error:"invalid_registry"});
    const ids=new Set(body.entries.map(e=>e.session));if(ids.size!==body.entries.length)return send(400,{error:"invalid_registry"});
    if(url.pathname==="/authorization/state")return send(200,{active:await withTaskTitles(body.entries.map(e=>readAuthorization(e,options.authKey)).filter(r=>r.state==="active").map(r=>({session:r.session,workspace:r.workspace,coverage:r.coverage,nameCount:r.names.length,created:r.created,requestId:r.requestId})))});
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
    const legacySessions=new Set(legacy.map(r=>r.session));
    const entry=signAuthorization(record,options.authKey),entries=body.entries.filter(e=>e.session!==record.session&&(readAuthorization(e,options.authKey).state==="active"||legacySessions.has(e.session))).concat(entry);
    if(entries.length>64||JSON.stringify(entries).length>3*1024*1024)return send(413,{error:"authorization_too_large"});
    const op={id:randomUUID(),action:body.action,session:record.session,requestId:request?.id,entryMac:entry.mac,coverage:record.coverage,nameCount:names.length,created:Date.now()};
    const dir=path.dirname(operationFile(op.id));await secureDir(root,true);await secureDir(dir,true);
    const lock=path.join(dir,"lock.json");
    try{const prior=JSON.parse(await fs.readFile(lock,"utf8"));if(prior.created<Date.now()-120000)await fs.unlink(lock);}catch(error){if(error.code!=="ENOENT")return send(409,{error:"operation_busy"});}
    try{await fs.writeFile(lock,JSON.stringify({id:op.id,created:op.created}),{flag:"wx",mode:0o600});}catch{return send(409,{error:"operation_busy"});}
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
    if(url.pathname==="/authorization"||url.pathname.startsWith("/authorization/")){
      try{return await authorization(req,res,url,send);}catch{console.warn("company_guard_authorization_unavailable");return send(400,{error:"authorization_unavailable"});}
    }
    if (req.method !== "GET") return send(405, {error:"read_only"});
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
      const availableAgents=new Set(),rows=await withTaskTitles(report.rows,day,availableAgents);
      send(200, {...report,rows,agentOptions:[...availableAgents].sort().map(id=>({id,label:agentNames[id]||id})),readAt:new Date().toISOString()});
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

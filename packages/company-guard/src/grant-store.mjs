import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {inspectRequest} from "./protocols.js";
import {sessionIdentity, sessionWorkspace} from "./session-authorization.js";

export const hash = s => createHash("sha256").update(s).digest("hex");
export const configRoot = () => path.join(path.isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config"), "magpie");
export const stateRoot = explicit => explicit || path.join(configRoot(), "company-guard");
export const grantPath = (root, session) => path.join(root, "grants", hash(session) + ".json");

export async function secureDir(dir, create = false) {
  if (create) await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error("insecure_grant_directory");
}
export async function readGrant(root, session) {
  await secureDir(root); await secureDir(path.join(root, "grants"));
  const f = await fs.open(grantPath(root, session), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 4 * 1024 * 1024) throw new Error("insecure_grant_record");
    const record = JSON.parse(await f.readFile("utf8"));
    if (record.v !== 2 && s.size > 16384) throw new Error("insecure_grant_record");
    return record;
  } finally { await f.close(); }
}
export async function writeGrant(root, session, record) {
  await secureDir(root, true); await secureDir(path.join(root, "grants"), true);
  const file = grantPath(root, session), temp = file + "." + randomBytes(8).toString("hex");
  await fs.writeFile(temp, JSON.stringify(record) + "\n", {flag: "wx", mode: 0o600});
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, {force: true}); }
}
export async function revokeGrant(root, session, turn = null) {
  let record; try { record = await readGrant(root, session); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  if (turn && record.turn !== turn) return;
  await fs.unlink(grantPath(root, session));
}

const pendingWrites = new Map();
function authorizationRequested(value) {
  if(typeof value!=="string"||value.length>200||/(?:^|\n)\s*>|```|~~~/.test(value))return false;
  let text=value.trim().replace(/[*_`]/g,"").replace(/\s+/g,"").replace(/(?:[，,]?(?:谢谢|麻烦了)|吧|一下)?[。！!]*$/,"");
  const scope="(?:(?:本|当前|这个|该|此|这次|本次|本轮)(?:会话|对话|任务|聊天)(?:中|里)?的?|本轮|本次)";
  text=text.replace(/^(?:(?:我)?(?:想要?|希望|需要)|请(?:帮我|帮忙|为我)?|帮我|麻烦(?:帮我)?|我要)/,"").replace(/^(?:我)?(?:申请|请求)/,"");
  text=text.replace(new RegExp("^(?:对|为|给|将|让|把)?"+scope),"").replace(/^(?:我)?(?:申请|请求)/,"");
  // Match the whole current user request. Questions, explanations, quoted
  // examples and instructions to restore masking cannot create applications.
  const names="(?:公司名称|公司名|企业名称|企业名|名称)?";
  return new RegExp("^(?:(?:取消|关闭|停止|停用)(?:一下)?(?:对)?(?:"+scope+")?"+names+"脱敏|"+names+"(?:不再|不|不用|无需|不需要)脱敏|原名(?:放行|授权)|(?:放行|允许|保留|使用|允许使用)(?:公司|企业)?原名)$").test(text);
}
const requestDirectory = root => path.join(root,"authorization-requests");
export async function listAuthorizationRequests(root) {
  const dir = requestDirectory(root);
  try { await secureDir(root); await secureDir(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const rows = [];
  for (const name of (await fs.readdir(dir)).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const fd = await fs.open(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) continue;
      const row = JSON.parse(await fd.readFile("utf8"));
      if (row.v === 1 && row.state === "pending" && typeof row.session === "string" && typeof row.workspace === "string" && row.requestedAt > Date.now()-24*60*60*1000) rows.push(row);
    } finally { await fd.close(); }
  }
  return rows.sort((a,b)=>b.requestedAt-a.requestedAt).slice(0,64);
}

export async function observeAuthorizationRequest(body, ctx) {
  const id = sessionIdentity(body,ctx), workspace = sessionWorkspace(body,ctx);
  if (!id || !workspace || !authorizationRequested(inspectRequest(body,ctx.protocol).user?.text)) return;
  const root = stateRoot(ctx.options?.stateDir), requestId = hash(id.session+"\0"+id.turn);
  const previous = pendingWrites.get(root) || Promise.resolve();
  const current = previous.catch(()=>{}).then(async () => {
    const dir = requestDirectory(root); await secureDir(root,true); await secureDir(dir,true);
    for(const name of (await fs.readdir(dir)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const file=path.join(dir,name),stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs<Date.now()-7*24*60*60*1000)await fs.unlink(file);}
    if((await listAuthorizationRequests(root)).length>=64)return;
    const row = {v:1,id:requestId,...id,workspace,state:"pending",requestedAt:Date.now()};
    try { await fs.writeFile(path.join(dir,requestId+".json"),JSON.stringify(row)+"\n",{flag:"wx",mode:0o600}); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  });
  pendingWrites.set(root,current);
  try { await current; } finally { if(pendingWrites.get(root)===current)pendingWrites.delete(root); }
}

export async function closeAuthorizationRequest(root, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_request");
  const dir = requestDirectory(root); await secureDir(dir);
  // Keep a small marker so retries of the same user turn do not recreate it.
  const file = path.join(dir,id+".json"), fd = await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let row; try { row=JSON.parse(await fd.readFile("utf8")); } finally { await fd.close(); }
  const temp=file+"."+randomBytes(8).toString("hex");
  await fs.writeFile(temp,JSON.stringify({...row,state:"closed"})+"\n",{flag:"wx",mode:0o600});
  try { await fs.rename(temp,file); } finally { await fs.rm(temp,{force:true}); }
}

export async function legacyTaskGrants(root) {
  const dir=path.join(root,"grants");
  try { await secureDir(root); await secureDir(dir); } catch(error) {if(error.code==="ENOENT")return [];throw error;}
  const rows=[];
  for(const name of (await fs.readdir(dir)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
    const fd=await fs.open(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    let session;try{const stat=await fd.stat();if(stat.size>4*1024*1024||!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077))continue;session=JSON.parse(await fd.readFile("utf8")).session;}finally{await fd.close();}
    if(typeof session!=="string")continue;
    const row=await readGrant(root,session);
    if(row.v===2&&row.scope==="session_task"&&row.state==="active"&&row.mode==="original"&&Array.isArray(row.names))rows.push(row);
  }
  return rows;
}

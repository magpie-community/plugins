import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {secureDir} from './grant-store.mjs';
import {companyRulesRevision,validateCompanyRules} from './local-options.mjs';

async function tail(file){
  let fd;try{fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('unsafe_history');const start=Math.max(0,stat.size-128*1024),buffer=Buffer.alloc(stat.size-start);const {bytesRead}=await fd.read(buffer,0,buffer.length,start);return buffer.subarray(0,bytesRead).toString('utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}catch(error){if(error.code==='ENOENT')return [];throw error;}finally{await fd?.close();}
}
export async function recordRuleRevision(root,companies){
  await secureDir(root,true);const file=path.join(root,'rule-events.jsonl'),revision=companyRulesRevision(companies),existing=await tail(file);
  if(existing.at(-1)?.revision===revision)return;
  const checked=validateCompanyRules(companies||[]),fd=await fs.open(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('unsafe_history');await fd.writeFile(JSON.stringify({at:new Date().toISOString(),revision,ruleCount:checked.ruleCount,nameCount:checked.nameCount})+'\n');await fd.sync();}finally{await fd.close();}
}
export async function recordAuthorizationEvent(root,event){
  if(!['approve','revoke','reject'].includes(event.action))throw Error('invalid_authorization_action');
  await secureDir(root,true);const fd=await fs.open(path.join(root,'authorization-events.jsonl'),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('insecure_authorization_log');await fd.writeFile(JSON.stringify({at:event.at||new Date().toISOString(),session:event.session,action:event.action,coverage:event.coverage,nameCount:event.nameCount,operationId:event.operationId,requestId:event.requestId})+'\n');await fd.sync();}finally{await fd.close();}
}
export async function readAuditHistory(root){
  const rules=(await tail(path.join(root,'rule-events.jsonl'))).filter(r=>r&&/^[a-f0-9]{64}$/.test(r.revision||'')).slice(-100).reverse().map(r=>({at:r.at,revision:r.revision,ruleCount:r.ruleCount,nameCount:r.nameCount}));
  const authorizations=(await tail(path.join(root,'authorization-events.jsonl'))).filter(r=>r&&['approve','revoke','reject'].includes(r.action)).slice(-100).reverse().map(r=>({at:r.at,session:r.session,action:r.action,coverage:r.coverage,nameCount:r.nameCount,...(r.action==='reject'?{requestId:r.requestId}:{})}));
  return {rules,authorizations};
}

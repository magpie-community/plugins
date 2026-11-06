import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {onRequest as hook, onResponse} from './provenance.hooks.mjs';
import {onRequest as middleware} from './compat.middleware.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-compat-test-'));
const token = 'TEST_ONLY_629';
const call = {type:'function_call',namespace:'agents',name:'spawn_agent',arguments:JSON.stringify({message:token}),encrypted_function_args:[]};
const agent = {type:'agent_message',author:'/root',recipient:'/root/probe',content:[{type:'input_text',text:'Payload:\n'},{type:'encrypted_content',encrypted_content:token}]};
const body = item => ({model:'cpa/gemini-3.8-flash-high',input:[structuredClone(item)]});
const ctx = () => ({protocol:'responses',origin:'local',options:{ledgerPath:path.join(dir,'hashes.json'),waitForProvenanceMs:0},reject(status,message){this.rejected={status,message};}});
let checks = 0;
try {
 const unknown=ctx();assert.equal(await hook(body(agent),unknown),undefined);middleware(body(agent),unknown);assert.equal(unknown.rejected.status,409);checks++;
 await onResponse({output:[call]},{...ctx(),success:true});
 const c=ctx();const restored=await hook(body(agent),c);const out=middleware(restored,c);assert.equal(out.input[0].type,'message');assert.equal(out.input[0].content[2].text,token);checks++;
 assert.equal((await readFile(c.options.ledgerPath,'utf8')).includes(token),false);checks++;
 const remote={...ctx(),origin:'remote'};assert.equal(await hook(body(agent),remote),undefined);checks++;
 const plain=body({...agent,content:[{type:'input_text',text:token}]});assert.equal(middleware(plain,ctx()).input[0].role,'user');checks++;
 const gpt={...body(agent),model:'cpa/gpt-6.1-sol'};assert.equal(await hook(gpt,ctx()),undefined);assert.equal(middleware(gpt,ctx()),undefined);checks++;
 const real={...agent,content:[{type:'encrypted_content',encrypted_content:'sealed.v1.unverified'}]};const realCtx=ctx();assert.equal(await hook(body(real),realCtx),undefined);middleware(body(real),realCtx);assert.equal(realCtx.rejected.status,409);checks++;
 const nonempty={...call,encrypted_function_args:['message']};const other={...nonempty,arguments:JSON.stringify({message:'NOT_PLAINTEXT'})};await onResponse({output:[other]},{...ctx(),success:true});const rejected=body({...agent,content:[{type:'encrypted_content',encrypted_content:'NOT_PLAINTEXT'}]});assert.equal(await hook(rejected,ctx()),undefined);checks++;
 const batch={...plain,input:[plain.input[0],{type:'message',role:'user',content:'middle'},plain.input[0]]};const mapped=middleware(batch,ctx());assert.equal(mapped.input.length,3);assert.equal(mapped.input[1].content,'middle');checks++;
 const trim=structuredClone(body(agent));const raceCtx={...ctx(),options:{...ctx().options,waitForProvenanceMs:150}};const raceToken='RACE_ONLY_812';trim.input[0].content[1].encrypted_content=raceToken;
 let captured;
 const pending=hook(trim,raceCtx);setTimeout(()=>{captured=onResponse({output:[{...call,arguments:JSON.stringify({message:raceToken})}]},{...ctx(),success:true});},25);assert.equal((await pending).input[0].content[1].text,raceToken);await captured;checks++;
 const oldFile=path.join(dir,'legacy.json');await writeFile(oldFile,JSON.stringify({version:1,entries:[{hash:createHash('sha256').update(token).digest('hex'),expires:1}]}));
 assert.equal((await hook(body(agent),{...ctx(),options:{ledgerPath:oldFile,waitForProvenanceMs:0}})).input[0].content[1].text,token);checks++;
 const imported='IMPORTED_HISTORICAL_CASE';const importBody=body({...agent,content:[{type:'encrypted_content',encrypted_content:imported}]});
 assert.equal(await hook(importBody,ctx()),undefined);
 const saved=JSON.parse(await readFile(c.options.ledgerPath,'utf8'));saved.entries.push({hash:createHash('sha256').update(imported).digest('hex'),verifiedAt:1});await writeFile(c.options.ledgerPath,JSON.stringify(saved));
 const revised={...ctx(),options:{...ctx().options,provenanceRevision:'import-test'}};
 assert.equal((await hook(importBody,revised)).input[0].content[0].text,imported);checks++;
 console.log(JSON.stringify({checks,passed:checks}));
} finally {await rm(dir,{recursive:true,force:true});}

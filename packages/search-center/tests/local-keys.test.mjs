import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.mjs";
import { LocalVault } from "../vault.mjs";
import { Center } from "../center.mjs";

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"search-local-keys-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root), vault=new LocalVault(store), calls=[];
  const center=new Center({store,vault,inherited:()=>({channels:{}}),backend:{capabilities:async()=>({channels:{exa:{configured:true}},grok:{}}),search:()=>assert.fail("old backend must not be used")},
    credential:async(id,key,args,url,signal,encrypted)=>{calls.push({id,encrypted});return {sources:[],routing:{channel_results:{[id]:{status:"no_sources"}}}}}});
  return {root,store,vault,center,calls};
}
const winTest = process.platform === "win32" ? test : test.skip;
winTest("local key create, retain, replace and delete never expose plaintext or fall back",async t=>{
  const {root,store,center,calls}=fixture(t);
  const secret="synthetic-only-api-key-not-a-real-secret";
  const input={channel:"exa",revision:0,baseUrl:"https://api.exa.ai",strategy:"rotate",keys:[{id:"draft",label:"测试 Key",enabled:true,value:secret}]};
  await center.saveChannel(input);
  const first=store.policy().channels.exa.keys[0];
  assert.ok(first.ref.startsWith("local://"));
  assert.ok(!fs.readFileSync(path.join(root,"credentials.encrypted.json"),"utf8").includes(secret));
  assert.ok(!JSON.stringify(await center.snapshot()).includes(secret));
  await center.search({query:"test",channels:["exa"]});
  assert.ok(calls[0].encrypted.cipher);assert.equal(calls[0].encrypted.id,first.id);
  await center.saveChannel({...input,revision:1,keys:[{...first,value:""}]});
  assert.equal(store.policy().channels.exa.keys[0].ref,first.ref);
  await center.saveChannel({...input,revision:2,keys:[{...first,value:secret+"-replacement"}]});
  assert.notEqual(store.policy().channels.exa.keys[0].ref,first.ref);
  await center.saveChannel({...input,revision:3,keys:[]});
  assert.deepEqual(store.read("credentials.encrypted.json",{}),{});
  assert.equal((await center.publicCapabilities()).channels.exa.configured,false);
  await center.search({query:"test",channels:["exa"]});assert.equal(calls.length,1);
  await assert.rejects(center.saveChannel({...input,revision:0}),e=>e.code==="CONFLICT");
});
winTest("encrypted keys are bound to their channel",async t=>{
  const {vault}=fixture(t);const e=await vault.protect("exa","synthetic-channel-binding-key");vault.persist([e]);
  assert.throws(()=>vault.cipher("tavily",{ref:`local://${e.id}`}),/不属于/);
});
test("Grok channel saves model choices atomically and rejects invalid IDs",async t=>{
  const {store,center}=fixture(t);
  const input={channel:"grok",revision:0,baseUrl:"https://example.test",strategy:"order",keys:[],models:{quick:"grok-fast",balanced:"grok-reasoning",deep:"grok-multi"},defaultProfile:"balanced"};
  await center.saveChannel(input);
  assert.deepEqual(store.policy().models,input.models);
  assert.equal(store.policy().defaultProfile,"balanced");
  await assert.rejects(center.saveChannel({...input,revision:1,models:{...input.models,quick:"bad model"}}),/模型/);
  assert.equal(store.policy().revision,1);
});

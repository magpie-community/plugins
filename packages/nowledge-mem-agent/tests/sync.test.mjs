import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ID = 'magpie:nowledge-agent';
const pick = (model='vendor/model-1') => ({model, gateway:{baseURL:'http://127.0.0.1:3425/v1',key:'gateway-secret'}, metadata:{context:65536,output:8192,images:true}});
const initial = () => ({enabled:false, active_provider:'old', provider:'old', model:'old-model', providers:{old:{provider_type:'openai_compatible',model:'old-model',has_api_key:true}}, purposes:{default:{provider:'old',model:'old-model'},ai_now:{provider:null,model:null,uses_default:true},background:{provider:'old',model:'background-model'},ocr:{provider:null,model:null,uses_default:true},embedding:{provider:null,model:null},decision:{provider:null,model:null}}});

async function fixture(t) {
  const { synchronize } = await import('../lib/sync.mjs');
  const dir = await mkdtemp(path.join(tmpdir(),'nowledge-agent-test-'));
  let config=initial();
  let autoActivate=false;
  const calls=[];
  let failPurpose=null;
  const server=createServer(async(req,res)=>{
    let body='';for await (const c of req) body+=c;
    const data=body?JSON.parse(body):null;
    calls.push({method:req.method,url:req.url,body:data,auth:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(req.method==='GET'&&req.url==='/remote-llm/config') return res.end(JSON.stringify(config));
    if(req.url==='/remote-llm/config'&&req.method==='POST') {
      assert.equal(data.extra_params.no_activate,true);
      assert.equal(data.extra_params.preserve_enabled,true);
      config.providers[data.provider]={...data,has_api_key:!!data.api_key};delete config.providers[data.provider].api_key;
      if((autoActivate&&!config.active_provider)||config.active_provider===data.provider){config.active_provider=data.provider;config.provider=data.provider;config.model=data.model;config.purposes.default={provider:data.provider,model:data.model};}
    } else if(req.url==='/remote-llm/purpose') {
      if(data.purpose==='default'&&!data.provider){res.statusCode=400;return res.end('{"detail":"default purpose requires provider"}');}
      if(failPurpose===data.purpose){failPurpose=null;res.statusCode=503;return res.end('{"error":"retry"}');}
      config.purposes[data.purpose]={provider:data.provider??null,model:data.model??null};
      if(data.purpose==='default'){config.active_provider=data.provider??'';config.provider=data.provider??'';config.model=data.model??'';}
    } else if(req.url==='/remote-llm/enabled') config.enabled=data.enabled;
    else if(req.url==='/remote-llm/activate') {config.active_provider=data.provider??'';config.provider=data.provider??'';}
    else if(req.url==='/remote-llm/provider/remove') {
      delete config.providers[data.provider];
      if(config.active_provider===data.provider){config.active_provider='';config.provider='';config.model='';config.purposes.default={provider:null,model:null};}
    }
    else {res.statusCode=404;return res.end('{}');}
    res.end(JSON.stringify(config));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const options={apiUrl:`http://127.0.0.1:${server.address().port}`, apiKey:'backend-secret', stateFile:path.join(dir,'state.json')};
  return {dir,calls,options,sync:(selection)=>synchronize(selection,options),get config(){return config;},fail:(p)=>failPurpose=p,empty(){config=initial();config.providers={};config.active_provider='';config.provider='';config.model='';config.purposes.default={provider:null,model:null};config.purposes.background={provider:null,model:null};autoActivate=true;}};
}

test('connect manages three purposes with separate backend and gateway keys',async t=>{
  const f=await fixture(t);await f.sync(pick());
  for(const purpose of ['default','ai_now','background']) assert.deepEqual(f.config.purposes[purpose],{provider:ID,model:'vendor/model-1'});
  assert.deepEqual(f.config.purposes.ocr,initial().purposes.ocr);
  assert.equal(f.config.enabled,true);
  const created=f.calls.find(c=>c.method==='POST'&&c.url==='/remote-llm/config');
  assert.equal(created.body.api_key,'gateway-secret');assert.equal(created.auth,'Bearer backend-secret');
  assert.equal(created.body.provider_type,'magpie');assert.equal(created.body.context_window,65536);
  assert.equal((await stat(f.options.stateFile)).mode&0o777,0o600);
});

test('switch is idempotent and disconnect restores original assignments and mode',async t=>{
  const f=await fixture(t);await f.sync(pick());await f.sync(pick('group/fallback'));
  const before=f.calls.filter(c=>c.method==='POST').length;await f.sync(pick('group/fallback'));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,before);
  await f.sync(null);
  for(const p of ['default','ai_now','background']) assert.deepEqual(f.config.purposes[p],{provider:initial().purposes[p].provider,model:initial().purposes[p].model});
  assert.equal(f.config.enabled,false);assert.equal(f.config.providers[ID],undefined);
  assert.equal(f.config.providers.old.has_api_key,true);
  await assert.rejects(readFile(f.options.stateFile),{code:'ENOENT'});
});

test('manual purpose edits are preserved during updates and disconnection',async t=>{
  const f=await fixture(t);await f.sync(pick());
  f.config.purposes.ai_now={provider:'old',model:'hand-picked'};
  const result=await f.sync(pick('vendor/model-2'));
  assert.ok(result.conflicts.includes('ai_now'));
  assert.deepEqual(f.config.purposes.ai_now,{provider:'old',model:'hand-picked'});
  await f.sync(null);assert.equal(f.config.purposes.ai_now.model,'hand-picked');
});

test('failed partial connect retains original snapshot and can resume then restore',async t=>{
  const f=await fixture(t);f.fail('ai_now');
  await assert.rejects(f.sync(pick()));
  assert.ok(JSON.parse(await readFile(f.options.stateFile,'utf8')).original);
  await f.sync(pick());await f.sync(null);
  assert.equal(f.config.purposes.default.provider,'old');assert.equal(f.config.purposes.background.model,'background-model');
});

test('existing provider instance is never overwritten',async t=>{
  const f=await fixture(t);f.config.providers[ID]={model:'user-provider',has_api_key:true};
  await assert.rejects(f.sync(pick()),/already exists|已存在/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('changed provider and external references survive disconnect',async t=>{
  const f=await fixture(t);await f.sync(pick());
  f.config.providers[ID].api_base='http://127.0.0.1:5555/v1';
  f.config.purposes.ocr={provider:ID,model:'vision-model'};
  await f.sync(null);
  assert.ok(f.config.providers[ID]);assert.equal(f.config.purposes.ocr.model,'vision-model');
});

test('invalid selection cannot be treated as a disconnect',async t=>{
  const f=await fixture(t);await f.sync(pick());
  await assert.rejects(f.sync({model:'x',gateway:{}}));
  assert.equal(f.config.purposes.default.provider,ID);
});

test('a journal cannot be replayed against a different backend',async t=>{
  const f=await fixture(t);await f.sync(pick());
  const {synchronize}=await import('../lib/sync.mjs');
  await assert.rejects(synchronize(null,{...f.options,apiUrl:'http://127.0.0.1:9'}),/backend|后端/);
});

test('first provider auto-activation is owned and an empty default restores by removal',async t=>{
  const f=await fixture(t);f.empty();await f.sync(pick());
  assert.equal(f.config.purposes.default.provider,ID);
  await f.sync(null);assert.equal(f.config.active_provider,'');assert.equal(f.config.enabled,false);
  assert.equal(f.config.providers[ID],undefined);
  assert.ok(!f.calls.some(c=>c.url==='/remote-llm/purpose'&&c.body?.purpose==='default'&&!c.body.provider));
});

test('an interrupted restore must finish before a new connection',async t=>{
  const f=await fixture(t);await f.sync(pick());f.fail('background');
  await assert.rejects(f.sync(null));
  await assert.rejects(f.sync(pick('vendor/next')),/restor|recover/i);
  await f.sync(null);assert.equal(f.config.purposes.background.model,'background-model');
});

test('remote mode write is recovered even if its success was not journaled',async t=>{
  const f=await fixture(t);await f.sync(pick());
  const state=JSON.parse(await readFile(f.options.stateFile,'utf8'));
  state.enabled.applied=null;state.enabled.pending=true;await writeFile(f.options.stateFile,JSON.stringify(state));
  await f.sync(null);assert.equal(f.config.enabled,false);
});

test('provider update cannot undo a manual default model on the managed instance',async t=>{
  const f=await fixture(t);await f.sync(pick());
  f.config.purposes.default={provider:ID,model:'user-model'};
  await assert.rejects(f.sync(pick('vendor/next')),/manual|disconnect/i);
  assert.equal(f.config.purposes.default.model,'user-model');
});

test('an empty legacy placeholder is preserved when no default is configured',async t=>{
  const f=await fixture(t);f.empty();f.config.providers.openai={model:'',has_api_key:false,api_base:null};
  const placeholder=structuredClone(f.config.providers.openai);
  await f.sync(pick());await f.sync(null);
  assert.deepEqual(f.config.providers,{openai:placeholder});assert.equal(f.config.active_provider,'');
});

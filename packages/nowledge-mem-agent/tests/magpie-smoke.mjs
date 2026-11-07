// Opt-in: MAGPIE_BIN=/path/to/magpie node tests/magpie-smoke.mjs
// Separate Magpie registry, copied plugin with a temporary selection path,
// fake Nowledge API, fake vendor. Never invokes a paid model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {sandboxEnvironment,assertSandboxEnvironment} from './sandbox.mjs';

const bin=process.env.MAGPIE_BIN;
if(!bin)throw Error('Set MAGPIE_BIN to the installed Magpie executable.');
const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-magpie-smoke-'));
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const plugin=path.join(dir,'plugin');
const selectionFile=path.join(dir,'home','.config','magpie-nowledge-mem','selection.json');
const config={enabled:false,provider:'',active_provider:'',model:'',providers:{},purposes:Object.fromEntries(['default','ai_now','background','ocr','embedding','decision'].map(p=>[p,{provider:null,model:null}]))};
const original=structuredClone(config);
let modelCalls=0,service,logs='';
const backend=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):null;
  if(req.url==='/v1/models')return res.end(JSON.stringify({object:'list',data:['one','two'].map(id=>({id,object:'model',context_window:65536,max_output_tokens:8192}))}));
  if(req.url==='/v1/chat/completions'){modelCalls++;res.statusCode=500;return res.end('{}');}
  if(req.url==='/remote-llm/config'&&body){
    config.providers[body.provider]={...body,has_api_key:true};delete config.providers[body.provider].api_key;
    if(!config.active_provider){config.active_provider=body.provider;config.provider=body.provider;config.model=body.model;config.purposes.default={provider:body.provider,model:body.model};}
  } else if(req.url==='/remote-llm/purpose') {
    if(body.purpose==='default'&&!body.provider){res.statusCode=400;return res.end('{}');}
    config.purposes[body.purpose]={provider:body.provider??null,model:body.model??null};
    if(body.purpose==='default'){config.active_provider=body.provider;config.provider=body.provider;config.model=body.model;}
  } else if(req.url==='/remote-llm/enabled')config.enabled=body.enabled;
  else if(req.url==='/remote-llm/provider/remove'){
    delete config.providers[body.provider];
    if(config.active_provider===body.provider){config.active_provider='';config.provider='';config.model='';config.purposes.default={provider:null,model:null};}
  } else if(req.url!=='/remote-llm/config'){res.statusCode=404;return res.end('{}');}
  res.end(JSON.stringify(config));
});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${backend.address().port}`;
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const env={...sandboxEnvironment(dir),MAGPIE_NOWLEDGE_CONFIG:path.join(dir,'adapter.json'),MAGPIE_ADDR:`127.0.0.1:${port}`};
const command=(...args)=>new Promise((resolve,reject)=>{
  assertSandboxEnvironment(env,dir);
  const child=spawn(bin,args,{env,stdio:['ignore','pipe','pipe']});let text='';
  child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);
  const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
  child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(text);else reject(Error(`magpie ${args.slice(0,2).join(' ')} exited ${code}: ${text.slice(-2000)}`));});
});
async function until(predicate,label){const end=Date.now()+20000;while(Date.now()<end){if(predicate())return;await delay(200);}throw Error(`Timed out: ${label}\n${logs.slice(-3000)}`);}

try {
  await fs.mkdir(plugin,{recursive:true});
  await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
  for(const name of ['package.json','nowledge-mem.agent.js','index.mjs','lib'])await fs.cp(path.join(root,name),path.join(plugin,name),{recursive:true});
  await fs.writeFile(env.MAGPIE_NOWLEDGE_CONFIG,JSON.stringify({selectionFile,apiUrl:url,pollMs:500}));
  await command('plugin','add',plugin);
  await command('plugin','options',plugin,JSON.stringify({selectionFile,apiUrl:url,pollMs:500}));
  await command('provider','add','smoke',`url=${url}/v1`,'key=smoke-only','models=one,two','context=65536');
  // Gateway's persisted port is documented in settings.json, but is not a
  // writable key in the CLI's `settings set` subset on 0.1.3212.
  const settingsFile=path.join(env.XDG_CONFIG_HOME,'magpie','settings.json');
  let settings={};try{settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.dirname(settingsFile),{recursive:true});
  await fs.writeFile(settingsFile,JSON.stringify({...settings,port}));
  const agents=await command('agents');assert.ok(agents.includes('Nowledge Mem / AI Now'),'Agent row missing');
  assertSandboxEnvironment(env,dir);
  service=spawn(bin,['serve'],{env,stdio:['ignore','pipe','pipe']});
  service.stdout.on('data',b=>logs+=b);service.stderr.on('data',b=>logs+=b);
  await command('nowledge-mem','smoke/one');
  await until(()=>['default','ai_now','background'].every(p=>config.purposes[p].model==='smoke/one'),'first model synchronization');
  const picked=JSON.parse(await fs.readFile(selectionFile,'utf8'));assert.ok(picked.gateway.key);assert.equal(picked.gateway.baseURL,`http://127.0.0.1:${port}/v1`);
  assert.equal((await fs.stat(selectionFile)).mode&0o077,0,'Agent gateway key file must be private');
  await command('nowledge-mem','smoke/two');
  await until(()=>['default','ai_now','background'].every(p=>config.purposes[p].model==='smoke/two'),'model change');
  await command('nowledge-mem','default');
  await until(()=>!config.providers['magpie:nowledge-agent']&&!config.enabled,'disconnect restoration');
  assert.deepEqual(config,original);assert.equal(modelCalls,0);
  console.log('PASS: actual Magpie Agent load, dynamic gateway/key, Bun host sync, model change, disconnect restoration; zero model calls.');
} finally {
  if(service){service.kill('SIGTERM');await new Promise(resolve=>{service.once('close',resolve);setTimeout(()=>{service.kill('SIGKILL');resolve();},2000).unref();});}
  await new Promise(resolve=>backend.close(resolve));
  await fs.rm(dir,{recursive:true,force:true});
}

import {test,afterEach} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { selectionFrom } from './lib/selection.mjs';
import { runOnce, selectionText } from './lib/runtime.mjs';
import { withLock, writeJSON, readJSON } from './lib/files.mjs';
import { createAPI } from './lib/api.mjs';
import {createServer} from 'node:http';
import {startAdapter} from './lib/runtime.mjs';

const cleanups=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});

test('Magpie empty parent objects after disconnect are understood',()=>{
  assert.equal(selectionFrom({gateway:{},metadata:{context:null,output:null}}),null);
  assert.throws(()=>selectionFrom({gateway:{key:'secret'}}),/Incomplete/);
});

test('restore pauses stale selection and sync explicitly resumes it',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-runtime-'));
  cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const config={selectionFile:path.join(dir,'selection.json'),stateFile:path.join(dir,'state.json'),pauseFile:path.join(dir,'paused.json'),statusFile:path.join(dir,'status.json'),apiUrl:'http://127.0.0.1:9'};
  await writeJSON(config.selectionFile,{model:'x',gateway:{baseURL:'http://127.0.0.1:3425/v1',key:'secret'}});
  assert.equal((await runOnce(config,{restore:true})).status,'disconnected');
  assert.equal((await runOnce(config)).status,'paused');
  await assert.rejects(runOnce(config,{resume:true}));
  assert.equal(await readJSON(config.pauseFile),null);
});

test('lock prevents concurrent processes from owning one journal',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-lock-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');
  await withLock(file,async()=>{await assert.rejects(withLock(file,async()=>{}),/Another/);});
  await withLock(file,async()=>{});
});

test('private atomic writes and malformed JSON are not mistaken for missing files',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-files-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'x.json');assert.equal(await selectionText(file),'');
  await writeJSON(file,{a:1});assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.chmod(file,0o644);await selectionText(file);assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.writeFile(file,'{"apiKey":"secret",');await assert.rejects(readJSON(file),SyntaxError);
});

test('backend credentials cannot be redirected or sent over remote HTTP',()=>{
  assert.throws(()=>createAPI({apiUrl:'http://example.com',apiKey:'secret'}),/HTTPS/);
  assert.throws(()=>createAPI({apiUrl:'https://user:secret@example.com'}),/credentials/);
});

test('redirected backend requests fail before contacting the second host',async()=>{
  let leaked,visits=0;
  const destination=createServer((req,res)=>{visits++;leaked=req.headers.authorization;res.setHeader('content-type','application/json');res.end('{}');});
  await new Promise(r=>destination.listen(0,r));
  cleanups.push(()=>new Promise(r=>destination.close(r)));
  const target=`http://localhost:${destination.address().port}/target`;
  const redirector=createServer((req,res)=>{res.writeHead(302,{location:target});res.end();});
  await new Promise(r=>redirector.listen(0,'127.0.0.1',r));
  cleanups.push(()=>new Promise(r=>redirector.close(r)));
  const api=createAPI({apiUrl:`http://127.0.0.1:${redirector.address().port}`,apiKey:'redirect-test-key'});
  await assert.rejects(api('/remote-llm/config'));
  assert.equal(visits,0);assert.equal(leaked,undefined);
});

test('polling waits for one unchanged selection before syncing',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-clock-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const tasks=[],synced=[];let text='first selection';
  const config={selectionFile:path.join(dir,'selection.json'),apiUrl:'http://127.0.0.1:9',pollMs:500};
  const dependencies={settings:async()=>config,selectionText:async()=>text,runOnce:async()=>{synced.push(text);return {status:'connected',conflicts:[]};},setTimeout:(fn,ms)=>{const task={fn,ms,unref(){}};tasks.push(task);return task;},clearTimeout:task=>{task.cancelled=true;},now:()=>0};
  const stop=await startAdapter({},config,dependencies);
  try{
    assert.equal(tasks.length,1);
    await tasks.shift().fn();assert.deepEqual(synced,[]);
    text='new selection';await tasks.shift().fn();assert.deepEqual(synced,[]);
    await tasks.shift().fn();assert.deepEqual(synced,['new selection']);
  }finally{stop();}
  assert.equal(tasks.at(-1).cancelled,true);
});

test('remote API polling backs off while local selection changes still synchronize promptly',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-backoff-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const tasks=[],synced=[];let clock=0,text='first';
  const config={selectionFile:path.join(dir,'selection.json'),apiUrl:'https://mem.example.test',pollMs:500};
  const deps={settings:async()=>config,selectionText:async()=>text,runOnce:async()=>{synced.push(text);return {status:'connected',conflicts:[]};},setTimeout:fn=>{const timer={fn,unref(){}};tasks.push(timer);return timer;},clearTimeout:()=>{},now:()=>clock};
  const stop=await startAdapter({},config,deps);
  try{
    await tasks.shift().fn();clock=500;await tasks.shift().fn();clock=1000;await tasks.shift().fn();
    clock=1500;await tasks.shift().fn();assert.equal(synced.length,2);
    text='changed';clock=1600;await tasks.shift().fn();clock=1700;await tasks.shift().fn();
    assert.deepEqual(synced,['first','first','changed']);
  }finally{stop();}
});

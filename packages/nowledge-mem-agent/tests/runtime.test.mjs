import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { selectionFrom } from '../lib/selection.mjs';
import { runOnce, selectionText } from '../lib/runtime.mjs';
import { withLock, writeJSON, readJSON } from '../lib/files.mjs';
import { createAPI } from '../lib/api.mjs';

test('Magpie empty parent objects after disconnect are understood',()=>{
  assert.equal(selectionFrom({gateway:{},metadata:{context:null,output:null}}),null);
  assert.throws(()=>selectionFrom({gateway:{key:'secret'}}),/Incomplete/);
});

test('restore pauses stale selection and sync explicitly resumes it',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-runtime-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const config={selectionFile:path.join(dir,'selection.json'),stateFile:path.join(dir,'state.json'),pauseFile:path.join(dir,'paused.json'),statusFile:path.join(dir,'status.json'),apiUrl:'http://127.0.0.1:9'};
  await writeJSON(config.selectionFile,{model:'x',gateway:{baseURL:'http://127.0.0.1:3425/v1',key:'secret'}});
  assert.equal((await runOnce(config,{restore:true})).status,'disconnected');
  assert.equal((await runOnce(config)).status,'paused');
  await assert.rejects(runOnce(config,{resume:true}));
  assert.equal(await readJSON(config.pauseFile),null);
});

test('lock prevents concurrent processes from owning one journal',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');
  await withLock(file,async()=>{await assert.rejects(withLock(file,async()=>{}),/Another/);});
  await withLock(file,async()=>{});
});

test('private atomic writes and malformed JSON are not mistaken for missing files',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nowledge-files-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'x.json');assert.equal(await selectionText(file),'');
  await writeJSON(file,{a:1});assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.chmod(file,0o644);await selectionText(file);assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.writeFile(file,'{"apiKey":"secret",');await assert.rejects(readJSON(file),SyntaxError);
});

test('backend credentials cannot be redirected or sent over remote HTTP',()=>{
  assert.throws(()=>createAPI({apiUrl:'http://example.com',apiKey:'secret'}),/HTTPS/);
  assert.throws(()=>createAPI({apiUrl:'https://user:secret@example.com'}),/credentials/);
});

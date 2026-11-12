import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('Agent assignments follow the installed plugin path, not its folder basename',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'search-agent-owner-'));
 const moduleURL=new URL('../agents.mjs',import.meta.url).href;
 const installed=fileURLToPath(new URL('../',import.meta.url));
 try {
  fs.writeFileSync(path.join(root,'library.json'),JSON.stringify({mcp:[
   {name:'magpie-search-center',plugin:path.join(root,'other-copy'),agents:['claude']},
   {name:'renamed-search',plugin:installed,agents:['codex']},
  ],applied:{codex:{}}}));
  const code=`import {agentView} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(agentView().filter(x=>x.selected).map(x=>x.id)))`;
  const result=spawnSync('node',['--input-type=module','-e',code],{env:{...process.env,MAGPIE_HOME:root},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),['codex']);
 } finally {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  fs.rmSync(root,{recursive:true,force:true});
 }
});

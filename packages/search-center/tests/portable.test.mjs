import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {Center} from '../center.mjs';
import {hooks} from '../adapter.mjs';
import {commandFor} from '../credentials.mjs';

test('fresh install lists public channels without contacting old MCP',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'search-portable-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const c=new Center({store:new Store(root)});
 const caps=await c.publicCapabilities();
 assert.deepEqual(Object.entries(caps.channels).filter(([,v])=>v.available).map(([id])=>id),['you','github','arxiv','crossref']);
 assert.equal(caps.channels.grok.configured,false);
 assert.equal(caps.models.default_search_mode,'both');
 assert.equal(Object.keys(hooks().search).length,14);
 assert.deepEqual(Object.keys(hooks().tool),['search','capabilities']);
});
test('worker and secret-run command use portable runtime and no shell',()=>{
 const plain=commandFor('grok',null);
 assert.ok(plain.args.at(-1).endsWith('worker.py'));
 const protectedCmd=commandFor('grok',{ref:'bw://test/api_key'});
 assert.equal(protectedCmd.file,'secret-run');
 assert.ok(protectedCmd.args.includes('GROK_API_KEY=bw://test/api_key'));
});

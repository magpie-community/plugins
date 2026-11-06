import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, readdir, rm, stat, utimes} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {onRequest as hook, onResponse} from './provenance.hooks.mjs';
import {onRequest as middleware} from './compat.middleware.js';
import {DEFAULT_TARGETS} from './common.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-compat-test-'));
const digest = text => createHash('sha256').update(text).digest('hex');
const call = message => ({type:'function_call',namespace:'agents',name:'spawn_agent',arguments:JSON.stringify({message}),encrypted_function_args:[]});
const agent = text => ({type:'agent_message',author:'/root',recipient:'/root/probe',content:[{type:'encrypted_content',encrypted_content:text}]});
const body = item => ({model:'cpa/gemini-test',input:[structuredClone(item)]});
const ctx = (options = {}) => ({protocol:'responses',origin:'local',options:{targets:['cpa/gemini-*'],ledgerPath:path.join(dir,'hashes.json'),...options},reports:[],report(code){this.reports.push(code);},reject(){assert.fail('must not pre-empt core');}});
const capture = (text,c) => onResponse({output:[call(text)]},{...c,success:true});
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('ok', name); }
try {
  await check('opt-in defaults and no IO', async () => {
    assert.deepEqual(DEFAULT_TARGETS,[]);
    const pkg=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
    assert.deepEqual(pkg.magpie.options.targets,[]);
    for (const targets of [undefined,[],null]) {
      const c=ctx({targets,ledgerPath:path.join(dir,'disabled.json')});
      await capture('disabled',c); assert.equal(await hook(body(call('disabled')),c),undefined);
      assert.equal(middleware(body({...agent('x'),content:[{type:'input_text',text:'x'}]}),c),undefined);
    }
    assert.deepEqual(await readdir(dir),[]);
  });
  await check('capture precedes restoration deterministically',async()=>{
    const c=ctx(); assert.equal(await hook(body(agent('task')),c),undefined);
    await capture('task',c);
    const restored=await hook(body(agent('task')),c);
    assert.equal(restored.input[0].content[0].text,'task');
    assert.equal(middleware(restored,c).input[0].content[0].text,'From /root to /root/probe\n\n');
    assert.equal((await readFile(c.options.ledgerPath,'utf8')).includes('task'),false);
  });
  await check('parent route captures without transforming',async()=>{
    const b={...body(call('parent')),model:'other/native'}; assert.equal(await hook(b,ctx()),undefined);
    assert.equal((await hook(body(agent('parent')),ctx())).input[0].content[0].text,'parent');
    assert.equal(middleware({...body(agent('parent')),model:'other/native'},ctx()),undefined);
  });
  await check('origin protocol success and encrypted-argument guards',async()=>{
    for (const override of [{origin:'remote'},{protocol:'chat'},{success:false}]) {
      await onResponse({output:[call('guard')]},{...ctx(),success:true,...override});
    }
    for (const encrypted_function_args of [undefined,['message']]) await onResponse({output:[{...call('guard'),encrypted_function_args}]},{...ctx(),success:true});
    assert.equal(await hook(body(agent('guard')),ctx()),undefined);
    assert.equal(await hook(body(agent('task')),{...ctx(),origin:'remote'}),undefined);
  });
  await check('sealed mixed unsupported empty remain untouched',async()=>{
    const items=[agent('gAAAA-ciphertext'),{...agent('task'),encrypted_content:'seal'},
      {...agent('task'),content:[...agent('task').content,...agent('unknown').content]},
      {...agent('task'),content:[...agent('task').content,{type:'future_content'}]},
      {...agent('task'),content:[]},{...agent('task'),content:[{type:'input_text',text:''}]},
      {...agent('task'),content:[{type:'input_text',text:'x',encrypted_content:'seal'}]}];
    for (const item of items) {const b=body(item),copy=structuredClone(b);assert.equal(await hook(b,ctx()),undefined);assert.equal(middleware(b,ctx()),undefined);assert.deepEqual(b,copy);}
  });
  await check('core headers images ordering and idempotence',async()=>{
    for (const [author,recipient,header] of [['A','B','From A to B\n\n'],['A','','From A\n\n'],['','B','To B\n\n'],['','','']]) {
      const a={type:'agent_message',author,recipient,content:[{type:'input_text',text:'hello'},{type:'input_image',image_url:'data:image/png;base64,fixture'}]};
      const b=body(a);b.input.unshift({type:'message',role:'user',content:'before'});
      const out=middleware(b,ctx());assert.equal(out.input[0],b.input[0]);
      assert.equal(out.input[1].content[0].text,header||'hello');assert.deepEqual(out.input[1].content.slice(header?1:0),a.content);
      assert.equal(middleware(out,ctx()),undefined);assert.equal(await hook(out,ctx()),undefined);
    }
  });
  await check('age cap legacy load and save pruning',async()=>{
    const file=path.join(dir,'bounded.json'), now=Date.now();
    await writeFile(file,JSON.stringify({entries:[{hash:digest('old'),verifiedAt:now-31*86400000},{hash:digest('legacy'),expires:now-1000},{hash:digest('new'),verifiedAt:now}]}));
    const c=ctx({ledgerPath:file,ledgerMaxEntries:1});
    assert.equal(await hook(body(agent('old')),c),undefined);assert.equal(await hook(body(agent('legacy')),c),undefined);
    assert.ok(await hook(body(agent('new')),c));await capture('latest',c);
    const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.entries.length,1);assert.equal(saved.entries[0].hash,digest('latest'));
    const legacy=ctx({ledgerPath:file,provenanceRevision:'legacy'});
    await writeFile(file,JSON.stringify({entries:[{hash:digest('legacy'),expires:now}]}));assert.ok(await hook(body(agent('legacy')),legacy));
  });
  await check('invalid options fallback and bounds',async()=>{
    const c=ctx({ledgerPath:path.join(dir,'clamp.json'),ledgerMaxEntries:0,ledgerMaxAgeDays:'bad'});
    await capture('one',c);await capture('two',c);assert.equal(JSON.parse(await readFile(c.options.ledgerPath,'utf8')).entries.length,1);
  });
  await check('known replay leaves ledger unchanged without timers',async()=>{
    const c=ctx({ledgerPath:path.join(dir,'replay.json')});await capture('repeat',c);
    const fixed=new Date('2000-01-01T00:00:00Z');await utimes(c.options.ledgerPath,fixed,fixed);
    const before=await stat(c.options.ledgerPath);await capture('repeat',c);await hook(body(call('repeat')),c);
    assert.equal((await stat(c.options.ledgerPath)).mtimeMs,before.mtimeMs);
  });
  await check('age expires independently of cap and can be reverified',async()=>{
    const file=path.join(dir,'age-only.json'),now=Date.now();
    await writeFile(file,JSON.stringify({entries:[{hash:digest('expired'),verifiedAt:now-31*86400000},{hash:digest('recent'),verifiedAt:now}]}));
    const c=ctx({ledgerPath:file,ledgerMaxEntries:2048});
    assert.equal(await hook(body(agent('expired')),c),undefined);assert.ok(await hook(body(agent('recent')),c));
    await capture('trigger-prune',c);assert.equal(JSON.parse(await readFile(file,'utf8')).entries.some(e=>e.hash===digest('expired')),false);
    await capture('expired',c);assert.ok(await hook(body(agent('expired')),c));
    assert.ok(JSON.parse(await readFile(file,'utf8')).entries.find(e=>e.hash===digest('expired')).verifiedAt>=now);
  });
  await check('corrupt ledger reports preserves and recovers',async()=>{
    const file=path.join(dir,'corrupt.json');await writeFile(file,'{broken');const c=ctx({ledgerPath:file});
    await capture('recovered',c);assert.ok(c.reports.includes('invalid'));
    const backup=(await readdir(dir)).find(n=>n.startsWith('corrupt.json.corrupt.'));assert.equal(await readFile(path.join(dir,backup),'utf8'),'{broken');
    assert.ok(await hook(body(agent('recovered')),c));
  });
  await check('IO errors report unavailable without request rejection',async()=>{
    const c=ctx({ledgerPath:dir});await capture('failed',c);assert.ok(c.reports.includes('unavailable'));assert.equal(await hook(body(agent('task')),c),undefined);
  });
  await check('write failure reports unavailable',async()=>{
    const parent=path.join(dir,'blocked');const c=ctx({ledgerPath:path.join(parent,'ledger.json')});
    assert.equal(await hook(body(agent('absent')),c),undefined);
    await writeFile(parent,'not a directory');await capture('write-fails',c);assert.ok(c.reports.includes('unavailable'));
  });
  console.log(JSON.stringify({checks,passed:checks}));
} finally {await rm(dir,{recursive:true,force:true});}

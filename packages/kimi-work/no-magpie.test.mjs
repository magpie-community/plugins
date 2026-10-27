// magpie-community/plugins#353: every request to Kimi went out with the
// User-Agent "Magpie Kimi Work provider/<version>". Nothing sent names the
// app now: agent-gw gets the headers Kimi's own Work client (the daimon)
// sends, and the membership read the same User-Agent.
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_internal as I} from './index.mjs';

const account={type:'oauth',source:'kimi-work-desktop',uid:'fixture-account'};
const session={uid:'fixture-account',workToken:'synthetic-work-token',webToken:'synthetic-web-token',deviceId:'0f8fad5b-d9cb-469f-a165-70867728950e'};

function record() {
  const sent=[];
  const fetchImpl=async(url,init={})=>{
    const headers=Object.fromEntries(new Headers(init.headers));
    sent.push({url:String(url),headers,body:typeof init.body==='string'?init.body:''});
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'k3-agent',context_length:262144}]});
    // a menu with models: an empty one is asked again without the sign-in
    if(String(url).includes('DescribeKimiWorkConfig'))return new Response(fs.readFileSync(new URL('./tests/fixtures/work-config.mac.json',import.meta.url)),{headers:{'Content-Type':'application/json'}});
    if(String(url).includes('GetSubscriptionStats'))return Response.json({subscriptionBalance:{amountUsedRatio:0.25}});
    return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  return {sent,fetchImpl};
}

test('no request to Kimi names magpie: models, the Work menu, chat and membership',async()=>{
  const {sent,fetchImpl}=record();
  const p=I.createPlugin({readSession:()=>session,fetchImpl});
  const loader=await p.auth.loader(async()=>account);
  await p.provider.models({models:{}},{auth:account});
  await (await loader.fetch(I.BASE+'/chat/completions',{method:'POST',
    headers:{'User-Agent':'magpie/1.0','x-magpie-work-dir':'/w'},
    body:JSON.stringify({model:'k3-agent',stream:true,messages:[{role:'user',content:'hi'}]})})).text();
  await p.auth.usage(async()=>account);
  expect(sent.length).toBe(4);
  for(const s of sent)expect(JSON.stringify(s)).not.toMatch(/magpie/i);
  for(const s of sent.filter(s=>s.url.startsWith(I.BASE))){
    expect(s.headers['user-agent']).toBe('kimi-code-cli/0.36.0');
    expect(s.headers['x-msh-platform']).toBe('kimi-code-cli');
    expect(s.headers['x-msh-version']).toBe('0.36.0');
    expect(s.headers['x-msh-device-id']).toBe(session.deviceId);
  }
});

test("the device id is the daimon's own, read and never written",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kimi-work-device-'));
  try{
    const file=path.join(dir,'config.json');
    expect(I.readDeviceId(file)).toBeUndefined();
    expect(fs.existsSync(path.join(dir,'runtime'))).toBe(false);
    expect(I.workHeaders(undefined)).not.toHaveProperty('X-Msh-Device-Id');
    fs.mkdirSync(path.join(dir,'runtime','kimi-code','home'),{recursive:true});
    fs.writeFileSync(path.join(dir,'runtime','kimi-code','home','device_id'),'0f8fad5b-d9cb-469f-a165-70867728950e\n');
    expect(I.readDeviceId(file)).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

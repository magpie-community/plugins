import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_internal as I} from '../index.mjs';

const session={uid:'fixture-account',workToken:'synthetic-work-token',webToken:'synthetic-web-token'};
const account={source:'kimi-work-desktop',uid:session.uid};
const json=x=>Response.json(x);
const modelPayload={data:[{id:'k3-agent',display_name:'K3',context_length:1000000,supports_image_in:true,
  supports_reasoning:true,reasoningEffortOptions:[{effort:'REASONING_EFFORT_HIGH'}]}]};

test('desktop import reads only the Work credential origin and supports a redirected agent configuration',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kimi-work-fixture-'));
  const file=path.join(dir,'config.json');
  const doc={credentials:{kimiCode:{apiKey:'synthetic-work',baseUrl:I.BASE},kimiWeb:{accessToken:'synthetic-web',userId:'fixture-user'}},
    model:{providers:{'daimon-kimi-code':{baseUrl:'http://127.0.0.1:1234/v1'}}}};
  try{
    fs.writeFileSync(file,JSON.stringify(doc));const raw=fs.readFileSync(file);
    expect(I.readDesktop(file).workToken).toBe('synthetic-work');
    expect(fs.readFileSync(file)).toEqual(raw);
    doc.credentials.kimiCode.baseUrl='https://api.kimi.com/coding/v1';fs.writeFileSync(file,JSON.stringify(doc));
    expect(()=>I.readDesktop(file)).toThrow();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('sign-in persists an account reference without either actual token',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>json(modelPayload)});
  const flow=await p.auth.methods[0].authorize(),auth=await flow.callback();
  expect(auth).toMatchObject({type:'success',source:'kimi-work-desktop',uid:session.uid});
  expect(JSON.stringify(auth)).not.toContain(session.workToken);
  expect(JSON.stringify(auth)).not.toContain(session.webToken);
});

for (const status of [429, 503]) test('sign-in preserves an upstream HTTP '+status+' instead of reporting missing credentials',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>new Response('{}',{status})});
  const result=await (await p.auth.methods[0].authorize()).callback();
  expect(result.type).toBe('failed');
  expect(result.error).toContain('HTTP '+status);
  expect(result.error).not.toContain('没有可用的本机');
  expect(result.error).not.toContain('登录已失效');
  expect(result).not.toHaveProperty('access');
  expect(result).not.toHaveProperty('refresh');
});

test('sign-in preserves network and timeout diagnostics without requesting a new desktop login',async()=>{
  for (const error of [Error('fetch failed',{cause:{code:'ECONNRESET'}}),new DOMException('Synthetic timeout','TimeoutError')]) {
    const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>{throw error;}});
    const result=await (await p.auth.methods[0].authorize()).callback();
    expect(result.type).toBe('failed');
    expect(result.error).toContain(error.cause?.code||error.message);
    expect(result.error).not.toContain('没有可用的本机');
    expect(result.error).not.toContain('登录已失效');
  }
});

test('sign-in still distinguishes missing desktop credentials and a rejected token',async()=>{
  let calls=0;
  const missing=I.createPlugin({readSession:()=>{throw Error('synthetic missing config');},fetchImpl:async()=>{calls++;return json({});}});
  const absent=await (await missing.auth.methods[0].authorize()).callback();
  expect(absent).toMatchObject({type:'failed'});
  expect(absent.error).toContain('没有可用的本机');
  expect(calls).toBe(0);
  const rejected=I.createPlugin({readSession:()=>session,fetchImpl:async()=>new Response('{}',{status:401})});
  const expired=await (await rejected.auth.methods[0].authorize()).callback();
  expect(expired.type).toBe('failed');
  expect(expired.error).toContain('登录已失效');
});

test('inference always uses the Work gateway and live Work credential, preserving stream, tools and cancellation',async()=>{
  const calls=[];let live={...session};
  const sse='data: {"choices":[{"delta":{"tool_calls":[{"id":"fixture","function":{"name":"Read","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  const p=I.createPlugin({readSession:()=>live,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(sse,{headers:{'Content-Type':'text/event-stream'}});}});
  const loader=await p.auth.loader(async()=>account),signal=new AbortController().signal;
  const body=JSON.stringify({model:'k3-agent',stream:true,messages:[{role:'user',content:'fixture'}],tools:[{type:'function',function:{name:'Read'}}]});
  const init={method:'POST',body,signal,headers:{Authorization:'Bearer synthetic-code-key','x-api-key':'synthetic-other-key',cookie:'synthetic-cookie'}};
  expect(await (await loader.fetch(I.BASE+'/chat/completions',init)).text()).toBe(sse);
  expect(calls[0].url).toBe(I.BASE+'/chat/completions');
  expect(calls[0].init.headers.get('authorization')).toBe('Bearer '+session.workToken);
  expect(calls[0].init.headers.get('x-api-key')).toBeNull();expect(calls[0].init.headers.get('cookie')).toBeNull();
  expect(calls[0].init.headers.get('user-agent')).toBe(I.UA);
  expect(calls[0].init.body).toBe(body);expect(calls[0].init.signal).toBe(signal);expect(calls[0].init.redirect).toBe('error');
  live={...live,workToken:'synthetic-rotated-work-token'};await loader.fetch(I.BASE+'/chat/completions',init);
  expect(calls[1].init.headers.get('authorization')).toBe('Bearer synthetic-rotated-work-token');
});

test('refuses foreign URLs and changed desktop accounts before sending credentials',async()=>{
  let calls=0,live={...session};const p=I.createPlugin({readSession:()=>live,fetchImpl:async()=>{calls++;return json({});}});
  const loader=await p.auth.loader(async()=>account);
  await expect(loader.fetch('https://example.invalid/chat/completions',{method:'POST'})).rejects.toThrow();
  live={...session,uid:'different-fixture-account'};
  await expect(loader.fetch(I.BASE+'/chat/completions',{method:'POST'})).rejects.toMatchObject({signIn:'expired'});
  expect(calls).toBe(0);
});

test('models come from Work; usage reports only the shared membership allowance',async()=>{
  const calls=[];const p=I.createPlugin({readSession:()=>session,fetchImpl:async(url,init)=>{
    calls.push({url,init});return url.endsWith('/models')?json(modelPayload):json({subscriptionBalance:{amountUsedRatio:0.42,expireTime:'2030-01-01T00:00:00Z'},ratelimitCode5h:{ratio:1},ratelimitCode7d:{ratio:1}});
  }});
  const models=await p.provider.models({models:{}},{auth:account});
  expect(Object.keys(models)).toEqual(['k3-agent']);expect(models['k3-agent'].limit.context).toBe(262144);
  expect(models['k3-agent'].capabilities.input.image).toBe(true);
  const usage=await p.auth.usage(async()=>account);expect(usage.windows).toHaveLength(1);expect(usage.windows[0].used).toBe(42);
  expect(usage.windows[0]).not.toHaveProperty('resetsAt');
  expect(usage.windows[0].name).toBe('会员共享额度');
  expect(calls[1].init.headers.Authorization).toBe('Bearer '+session.webToken);
  expect(calls.every(x=>!x.url.includes('api.kimi.com'))).toBe(true);
});

test('an upstream usage refusal does not incorrectly invalidate the desktop sign-in',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>new Response('{}',{status:403})});
  try{await p.auth.usage(async()=>account);throw Error('expected upstream refusal');}
  catch(error){expect(error.signIn).toBeUndefined();expect(error.message).toContain('403');}
});

test('the real redacted catalog and additional advertised reasoning levels are preserved',()=>{
  const payload=JSON.parse(fs.readFileSync(new URL('./fixtures/work-models.redacted.json',import.meta.url),'utf8'));
  const rows=I.modelRows(payload);
  for(const m of payload.data) {
    expect(Object.keys(rows[m.id].variants)).toEqual(m.reasoningEffortOptions.map(x=>x.effort.replace('REASONING_EFFORT_','').toLowerCase()));
  }
  const additional={...payload.data[0],reasoningEffortOptions:[
    {effort:'REASONING_EFFORT_STANDARD'},{effort:'REASONING_EFFORT_ULTRA'},
  ]};
  expect(I.modelRows({data:[additional]})[additional.id].variants).toEqual({
    standard:{reasoningEffort:'standard'},ultra:{reasoningEffort:'ultra'},
  });
});

test('Request inputs preserve body, safe headers and cancellation while replacing desktop credentials',async()=>{
  const calls=[];
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async(url,init)=>{
    calls.push({url,init,body:await new Response(init.body).text()});return json({choices:[]});
  }});
  const loader=await p.auth.loader(async()=>account),abort=new AbortController();
  const body=JSON.stringify({model:'k3-agent',messages:[{role:'user',content:'synthetic Request'}],stream:true});
  const request=new Request(I.BASE+'/chat/completions',{method:'POST',body,signal:abort.signal,
    headers:{Authorization:'Bearer synthetic-wrong-key',Cookie:'synthetic-cookie','X-Request-Tag':'synthetic-tag'}});
  await loader.fetch(request);
  expect(calls[0].url).toBe(I.BASE+'/chat/completions');
  expect(calls[0].body).toBe(body);
  expect(calls[0].init.headers.get('authorization')).toBe('Bearer '+session.workToken);
  expect(calls[0].init.headers.get('cookie')).toBeNull();
  expect(calls[0].init.headers.get('x-request-tag')).toBe('synthetic-tag');
  abort.abort();expect(calls[0].init.signal.aborted).toBe(true);
  await expect(loader.fetch(new Request('https://example.invalid/chat/completions',{method:'POST',body:'{}'}))).rejects.toThrow();
  await expect(loader.fetch(new Request(I.BASE+'/chat/completions',{method:'GET'}))).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

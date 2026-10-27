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
  expect(calls[0].init.headers.get('user-agent')).toBe('kimi-code-cli/0.36.0');
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
  expect(calls.find(x=>x.url.endsWith('GetSubscriptionStats')).init.headers.Authorization).toBe('Bearer '+session.webToken);
  expect(calls.every(x=>!x.url.includes('api.kimi.com'))).toBe(true);
});

test('an upstream usage refusal does not incorrectly invalidate the desktop sign-in',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>new Response('{}',{status:403})});
  const u=await p.auth.usage(async()=>account);
  expect(u.signIn).toBe('kept');expect(u.windows).toEqual([]);expect(u.error).toContain('403');
});

// www.kimi.com's literal answer to a web token it no longer takes (10-25,
// curl, signed out and with a stale token alike).
const sessionExpired={"code":"unauthenticated","details":[{"type":"common.error.v1.ErrorDetail","value":"CGQSLgoFZW4tVVMSJVNlc3Npb24gZXhwaXJlZC4gUGxlYXNlIGxvZyBpbiBhZ2Fpbi4","debug":{"reason":"REASON_INVALID_AUTH_TOKEN","localizedMessage":{"locale":"en-US","message":"Session expired. Please log in again."}}}]};

test('a stale web sign-in is said on the card and keeps the Work sign-in',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>Response.json(sessionExpired,{status:401})});
  const u=await p.auth.usage(async()=>account);
  expect(u.windows).toEqual([]);expect(u.signIn).toBe('kept');
  expect(u.error).toContain('Kimi 网页登录已过期');
  // magpie's signInGone would mark the account signed out on these words
  expect(u.error).not.toMatch(/sign-in has (expired|lapsed)|sign in again/i);
  expect(u.error).not.toContain(session.webToken);
});

test('a balance with nothing used, its zero left out, reads 0%; no balance is said',async()=>{
  let reply={subscriptionBalance:{expireTime:'2030-01-01T00:00:00Z'}};
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>Response.json(reply)});
  expect((await p.auth.usage(async()=>account)).windows).toEqual([{name:'会员共享额度',used:0}]);
  reply={subscription_balance:{amount_used_ratio:0.5}};
  expect((await p.auth.usage(async()=>account)).windows).toEqual([{name:'会员共享额度',used:50}]);
  reply={overdrawn:false};
  const u=await p.auth.usage(async()=>account);
  expect(u.windows).toEqual([]);expect(u.error).toContain('subscriptionBalance');
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

test('one model with effort levels in an unseen shape does not cost the account its catalog',()=>{
  const payload=JSON.parse(fs.readFileSync(new URL('./fixtures/work-models.redacted.json',import.meta.url),'utf8'));
  const odd=[
    {...payload.data[0],id:'synthetic-no-effort',reasoningEffortOptions:[{displayName:'Max'},null,{effort:'REASONING_EFFORT_MAX'}]},
    {...payload.data[0],id:'synthetic-object-efforts',reasoningEffortOptions:{low:true}},
    null,'k3-agent',
  ];
  const rows=I.modelRows({data:[...payload.data,...odd]});
  expect(Object.keys(rows)).toEqual(['k3-agent','k2d8-preview','synthetic-no-effort','synthetic-object-efforts']);
  expect(rows['synthetic-no-effort'].variants).toEqual({max:{reasoningEffort:'max'}});
  expect(rows['synthetic-object-efforts'].variants).toEqual({});
  expect(Object.keys(rows['k2d8-preview'].variants)).toEqual(['low','high','max']);
});

test('before the account list is read, both models Work has listed are offered',async()=>{
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>{throw Error('no network in tests');}});
  const cfg={};await p.config(cfg);
  expect(Object.keys(cfg.provider['kimi-work'].models)).toEqual(['k3-agent','k2d8-preview']);
  const payload=JSON.parse(fs.readFileSync(new URL('./fixtures/work-models.redacted.json',import.meta.url),'utf8'));
  expect(Object.keys(cfg.provider['kimi-work'].models)).toEqual(payload.data.map(m=>m.id));
});

const workConfig=JSON.parse(fs.readFileSync(new URL('./fixtures/work-config.shape.json',import.meta.url),'utf8'));
const snake=x=>Array.isArray(x)?x.map(snake):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),snake(v)])):x;

test('the desktop menu\'s models are listed: a tier model /models leaves out shows under its own id',async()=>{
  const calls=[];const p=I.createPlugin({readSession:()=>session,fetchImpl:async(url,init)=>{
    calls.push({url,init});return url===I.CONFIG?json(workConfig):json(modelPayload);}});
  const models=await p.provider.models({models:{}},{auth:account});
  expect(Object.keys(models)).toEqual(['k3-agent','k3d1-pro','k2d8-preview']);
  expect(models['k3d1-pro']).toMatchObject({id:'k3d1-pro',name:'Kimi K3.1 Pro',api:{id:'k3d1-pro',url:I.BASE},limit:{context:262144}});
  expect(models['k3d1-pro'].capabilities).toMatchObject({reasoning:true,attachment:true});
  // supportEfforts' "off" is the desktop's REASONING_EFFORT_NONE.
  expect(Object.keys(models['k3d1-pro'].variants)).toEqual(['none','high','max']);
  expect(models['k2d8-preview'].name).toBe('K2.8 Preview');
  // An id both list keeps /models' row under the menu's name.
  expect(models['k3-agent']).toMatchObject({name:'K3',variants:{high:{reasoningEffort:'high'}}});
  const c=calls.find(x=>x.url===I.CONFIG);
  expect(c.init).toMatchObject({method:'POST',body:'{}'});
  expect(c.init.headers).toMatchObject({Authorization:'Bearer '+session.webToken,'Connect-Protocol-Version':'1','Content-Type':'application/json'});
  expect(calls.find(x=>x.url===I.BASE+'/models').init.headers.Authorization).toBe('Bearer '+session.workToken);
});

test('the menu is read in the proto\'s own field names too',()=>{
  expect(Object.keys(I.workConfigRows(snake(workConfig)))).toEqual(['k3-agent','k3d1-pro','k2d8-preview']);
  expect(I.workConfigRows(snake(workConfig))['k3d1-pro'].name).toBe('Kimi K3.1 Pro');
});

test('either list failing leaves the other; both failing throws so the last good list stays',async()=>{
  const run=f=>I.createPlugin({readSession:()=>session,fetchImpl:f}).provider.models({models:{}},{auth:account});
  expect(Object.keys(await run(async url=>url===I.CONFIG?new Response('{}',{status:500}):json(modelPayload)))).toEqual(['k3-agent']);
  expect(Object.keys(await run(async url=>url===I.CONFIG?json(workConfig):new Response('{}',{status:502})))).toEqual(['k3-agent','k3d1-pro','k2d8-preview']);
  await expect(run(async()=>new Response('{}',{status:502}))).rejects.toThrow();
  await expect(run(async url=>url===I.CONFIG?json({models:[]}):new Response('{}',{status:502}))).rejects.toThrow();
});

// DescribeKimiWorkConfig's literal replies, captured 2026-10-24 from
// www.kimi.com without a sign-in: the desktop's menu (x-msh-platform: mac;
// "windows" answers the same) and the web's (x-msh-platform: web, or none).
// Only the desktop's has K3.1 Pro, k3d1-agent (泠夜Soul's 99 plan, Discord).
const fixture=name=>JSON.parse(fs.readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
const deskMenu=fixture('work-config.mac.json'),webMenu=fixture('work-config.web.json');
test('the menu is asked as the desktop asks it, so K3.1 Pro (k3d1-agent) is listed',async()=>{
  for(const [platform,said] of [['darwin','mac'],['win32','windows']]) {
    const seen=[];
    // Answers as www.kimi.com does: the desktop's menu only for its platforms.
    const p=I.createPlugin({platform,readSession:()=>session,fetchImpl:async(url,init)=>{
      if(url!==I.CONFIG)return json(modelPayload);
      const h=init.headers['x-msh-platform'];seen.push(init.headers);
      return json(h==='mac'||h==='windows'?deskMenu:webMenu);}});
    const models=await p.provider.models({models:{}},{auth:account});
    expect(Object.keys(models)).toEqual(['k3d1-agent','k2d8-preview','k3-agent']);
    expect(models['k3d1-agent']).toMatchObject({id:'k3d1-agent',name:'K3.1 Pro',api:{id:'k3d1-agent',url:I.BASE},
      limit:{context:262144,output:32768},capabilities:{reasoning:true,attachment:true}});
    expect(Object.keys(models['k3d1-agent'].variants)).toEqual(['low','high','max']);
    expect(seen[0]).toMatchObject({'x-msh-platform':said,'x-msh-version':'3.2.20',Authorization:'Bearer '+session.webToken});
  }
});

test('the platform is the desktop\'s on macOS and Windows, and agent-gw gets none of the web headers',()=>{
  expect(I.webHeaders('darwin')['x-msh-platform']).toBe('mac');
  expect(I.webHeaders('win32')['x-msh-platform']).toBe('windows');
  expect(I.webHeaders('linux')['x-msh-platform']).toBe('web');
  expect(I.workHeaders('d')).not.toHaveProperty('x-msh-version');
  expect(I.workHeaders('d')['X-Msh-Platform']).toBe('kimi-code-cli');
  // The web menu, as a reply without the platform is, has no K3.1 Pro.
  expect(Object.keys(I.workConfigRows(webMenu))).toEqual(['k3-agent','k3-agent-swarm','k2d8-preview']);
});

// www.kimi.com's literal answer to a web sign-in it no longer takes (seen
// 2026-10-24 with a token it can't verify): 401, Connect "unauthenticated".
const staleToken={code:'unauthenticated',message:'invalid user token: token signature is invalid: signature is invalid',
  details:[{type:'common.error.v1.ErrorDetail',value:'CGQSLgoFZW4tVVMSJVNlc3Npb24gZXhwaXJlZC4gUGxlYXNlIGxvZyBpbiBhZ2Fpbi4',debug:{reason:'REASON_INVALID_AUTH_TOKEN'}}]};
test('a menu the web sign-in can\'t get is asked again without it, so K3.1 Pro is still listed, and the failure is logged',async()=>{
  const seen=[],logged=[];const warn=console.warn;console.warn=(...x)=>logged.push(x.join(' '));
  try {
    for(const reply of [()=>Response.json(staleToken,{status:401}),()=>new Response('',{status:503}),()=>json({models:[]})]) {
      seen.length=0;logged.length=0;
      // Answers as www.kimi.com does: the sign-in refused, the menu given
      // to the desktop without one.
      const p=I.createPlugin({platform:'darwin',readSession:()=>session,fetchImpl:async(url,init)=>{
        if(url!==I.CONFIG)return json(modelPayload);
        seen.push(init.headers);
        return init.headers.Authorization?reply():json(deskMenu);}});
      const models=await p.provider.models({models:{}},{auth:account});
      expect(Object.keys(models)).toEqual(['k3d1-agent','k2d8-preview','k3-agent']);
      expect(models['k3d1-agent'].name).toBe('K3.1 Pro');
      expect(seen.map(h=>h.Authorization)).toEqual(['Bearer '+session.webToken,undefined]);
      expect(seen[1]).toMatchObject({'x-msh-platform':'mac','x-msh-version':'3.2.20'});
      expect(logged.join('\n')).toContain('DescribeKimiWorkConfig');
      expect(logged.join('\n')).not.toContain(session.webToken);
    }
    // A sign-in it takes is asked once, and nothing is logged.
    seen.length=0;logged.length=0;
    await I.createPlugin({platform:'darwin',readSession:()=>session,fetchImpl:async(url,init)=>{
      if(url!==I.CONFIG)return json(modelPayload);seen.push(init.headers);return json(deskMenu);}}).provider.models({models:{}},{auth:account});
    expect(seen.length).toBe(1);expect(logged).toEqual([]);
  } finally {console.warn=warn;}
});

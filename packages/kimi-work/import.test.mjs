import {test,expect} from 'bun:test';
import {_internal as I} from './index.mjs';

const NOW=1900000000000;
const jwt=(sub,exp,tag='fixture')=>'fixture.'+Buffer.from(JSON.stringify({sub,exp:exp/1000,tag})).toString('base64url')+'.fixture';
const userId='synthetic-user';
const workToken='synthetic-imported-work-key';
const webToken=jwt(userId,NOW+3600000);
const file=({refresh='synthetic-membership-refresh',origin=I.BASE}={})=>JSON.stringify({credentials:{
  kimiCode:{apiKey:workToken,baseUrl:origin},
  kimiWeb:{accessToken:webToken,refreshToken:refresh,userId},
}});
const menu={models:[{requestParams:{modelId:'k3-agent',maxTokens:32768},display:{displayName:'K3'},daimonModelConfig:{maxContextSize:262144}}]};
const catalog={data:[{id:'k3-agent',display_name:'K3',context_length:262144}]};
const stats={subscriptionBalance:{amountUsedRatio:0.25}};
function fixture(fetchImpl) {
  let desktopReads=0;
  const p=I.createPlugin({now:()=>NOW,fetchImpl,readSession:()=>{desktopReads++;throw Error('desktop files must not be read');}});
  return {p,desktopReads:()=>desktopReads};
}
const chat=loader=>loader.fetch(I.BASE+'/chat/completions',{method:'POST',body:'{"model":"k3-agent","messages":[]}'});

test('magpie offers a guided config.json import in every window language',async()=>{
  const {p}=fixture(async()=>{throw Error('no network expected');});
  expect(typeof p.auth.import).toBe('function');
  expect(p.auth.importFrom).toContain('daimon/config.json');
  for(const lang of ['zh','zh-TW','ja','de'])expect(p.auth.importFroms[lang]).toContain('daimon/config.json');
  expect(p.auth.methods).toHaveLength(2);
  expect(p.auth.methods[1]).toMatchObject({type:'oauth',label:'导入 Kimi Work 凭据（粘贴 config.json）'});
  expect(p.auth.methods[1].prompts[0]).toMatchObject({type:'password',key:'config'});
  expect(p.auth.methods[1].prompts[0].message).toContain('%APPDATA%\\kimi-desktop\\daimon-share\\daimon\\config.json');
  expect(p.auth.methods[1].prompts[0].message).toContain('%APPDATA%\\kimi-desktop\\daimon-storage.json');
  expect(p.auth.methods[1].prompts[0].message).toContain('shareDir');
  expect(p.auth.methods[1].prompts[0].validate('')).toBeTruthy();
  expect(p.auth.methods[1].prompts[0].validate(file())).toBeUndefined();
});

test('the sign-in menu also accepts pasted config.json content without reading the desktop',async()=>{
  const {p,desktopReads}=fixture(async(url,init)=>{
    expect(url).toBe(I.BASE+'/models');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+workToken);
    return Response.json(catalog);
  });
  const flow=await p.auth.methods[1].authorize({config:file()});
  expect(flow).toMatchObject({url:'',method:'auto'});
  const auth=await flow.callback();
  expect(auth).toMatchObject({type:'success',imported:true,workToken,access:webToken});
  expect(desktopReads()).toBe(0);
});

test('a selected config.json is validated and explicitly imports both Work and membership credentials',async()=>{
  const calls=[];
  const {p,desktopReads}=fixture(async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers)});
    return Response.json(catalog);
  });
  const [auth]=await p.auth.import(['\uFEFF'+file()]);
  expect(auth).toMatchObject({type:'success',source:'kimi-work-desktop',imported:true,workToken,
    access:webToken,refresh:'synthetic-membership-refresh',expires:NOW+3600000});
  expect(auth.accountId).toMatch(/^Kimi Work · [0-9a-f]{6}$/);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(I.BASE+'/models');
  expect(calls[0].headers.get('authorization')).toBe('Bearer '+workToken);
  expect(desktopReads()).toBe(0);
});

test('an imported account lists models, reads usage and chats without any desktop file or device id',async()=>{
  const calls=[];
  const {p,desktopReads}=fixture(async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers)});
    if(url===I.BASE+'/models')return Response.json(catalog);
    if(url===I.CONFIG)return Response.json(menu);
    if(url===I.MEMBER+'GetSubscriptionStats')return Response.json(stats);
    if(url===I.BASE+'/chat/completions')return Response.json({choices:[]});
    throw Error('unexpected request '+url);
  });
  const [auth]=await p.auth.import([file()]);
  calls.length=0;
  expect(await p.auth.refresh(auth)).toBeUndefined();
  const models=await p.provider.models({models:{}},{auth});
  expect(Object.keys(models)).toEqual(['k3-agent']);
  expect(await p.auth.usage(async()=>auth)).toEqual({plan:'月度共享额度',windows:[{name:'本月',used:25}]});
  expect((await chat(await p.auth.loader(async()=>auth))).status).toBe(200);
  expect(desktopReads()).toBe(0);
  expect(calls.find(c=>c.url===I.CONFIG).headers.get('authorization')).toBe('Bearer '+webToken);
  expect(calls.find(c=>c.url===I.MEMBER+'GetSubscriptionStats').headers.get('authorization')).toBe('Bearer '+webToken);
  for(const c of calls.filter(c=>c.url.startsWith(I.BASE))) {
    expect(c.headers.get('authorization')).toBe('Bearer '+workToken);
    expect(c.headers.has('x-msh-device-id')).toBe(false);
  }
});

test('a config.json without a membership refresh token still works independently as an access-only import',async()=>{
  const sent=[];
  const {p,desktopReads}=fixture(async(url,init)=>{
    sent.push({url:String(url),authorization:new Headers(init.headers).get('authorization')});
    return Response.json(url===I.BASE+'/models'?catalog:stats);
  });
  const [auth]=await p.auth.import([file({refresh:''})]);
  expect(auth).toMatchObject({type:'success',imported:true,workToken,access:webToken,refresh:''});
  expect(await p.auth.refresh(auth)).toBeUndefined();
  expect((await p.auth.usage(async()=>auth)).windows[0].used).toBe(25);
  expect((await chat(await p.auth.loader(async()=>auth))).status).toBe(200);
  expect(sent.at(-1).authorization).toBe('Bearer '+workToken);
  expect(desktopReads()).toBe(0);
});

test('bad JSON, missing credentials and a non-Work origin are refused without a request or secret leakage',async()=>{
  let calls=0;
  const {p,desktopReads}=fixture(async()=>{calls++;return Response.json(catalog);});
  const results=await p.auth.import(['not json','{}',file({origin:'https://api.kimi.com/coding/v1'})]);
  expect(results.map(r=>r.type)).toEqual(['failed','failed','failed']);
  for(const r of results)expect(r.error).toContain('daimon/config.json');
  expect(JSON.stringify(results)).not.toContain(workToken);
  expect(JSON.stringify(results)).not.toContain(webToken);
  expect(calls).toBe(0);
  expect(desktopReads()).toBe(0);
});

test('a Work key refused during import fails sign-in and names the fresh file to choose',async()=>{
  const {p,desktopReads}=fixture(async()=>new Response('{}',{status:401}));
  const [auth]=await p.auth.import([file()]);
  expect(auth.type).toBe('failed');
  expect(auth.error).toContain('新的 config.json');
  expect(auth.error).not.toContain(workToken);
  expect(desktopReads()).toBe(0);
});

test('a Work 401 after import asks for reimport instead of a desktop path or membership renewal',async()=>{
  const {p,desktopReads}=fixture(async url=>String(url)===I.BASE+'/models'?Response.json(catalog):new Response('{}',{status:401}));
  const [auth]=await p.auth.import([file()]);
  const error=await chat(await p.auth.loader(async()=>auth)).catch(error=>error);
  expect(error).toMatchObject({signIn:'expired',code:'kimi_work_login_expired'});
  expect(error.message).toContain('重新选择');
  expect(error.message).toContain('daimon/config.json');
  expect(error.message).not.toContain('magpie plugin login');
  expect(desktopReads()).toBe(0);
});

test('membership renewal changes only the membership pair and preserves the imported Work key',async()=>{
  const calls=[];
  const {p,desktopReads}=fixture(async(url,init)=>{
    calls.push({url:String(url),init});
    if(url===I.BASE+'/models')return Response.json(catalog);
    if(url===I.REFRESH)return Response.json({access_token:jwt(userId,NOW+7200000,'rotated'),refresh_token:'synthetic-rotated-refresh'});
    if(url===I.BASE+'/chat/completions')return Response.json({choices:[]});
    throw Error('unexpected request '+url);
  });
  const expiredFile=file().replace(webToken,jwt(userId,NOW-1000));
  const [auth]=await p.auth.import([expiredFile]);
  const rotated=await p.auth.refresh(auth);
  expect(rotated).toMatchObject({refresh:'synthetic-rotated-refresh',expires:NOW+7200000});
  const saved={...auth,...rotated};
  expect(saved.workToken).toBe(workToken);
  expect(saved.imported).toBe(true);
  await chat(await p.auth.loader(async()=>saved));
  const work=calls.at(-1);
  expect(new Headers(work.init.headers).get('authorization')).toBe('Bearer '+workToken);
  expect(desktopReads()).toBe(0);
});

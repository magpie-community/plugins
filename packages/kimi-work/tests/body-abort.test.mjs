import {test,expect} from 'bun:test';
import {_internal as I} from '../index.mjs';

const session={uid:'synthetic-account',workToken:'synthetic-work',webToken:'synthetic-web'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

for(const kind of ['stream','request'])test('aborting a buffered '+kind+' ends the read without sending the request',async()=>{
  let calls=0,producer,cancelled;
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>{calls++;return new Response('{}');}});
  const loader=await p.auth.loader(async()=>({source:'kimi-work-desktop',uid:session.uid}));
  const abort=new AbortController();
  const body=new ReadableStream({start(c){producer=c;c.enqueue(new TextEncoder().encode('{"messages":['));},
    cancel(reason){cancelled=reason;}});
  const init={method:'POST',body,signal:abort.signal,duplex:'half'};
  const pending=(kind==='request'?loader.fetch(new Request(I.BASE+'/chat/completions',init))
    :loader.fetch(I.BASE+'/chat/completions',init)).then(value=>({value}),error=>({error}));
  // Let the initial chunk be consumed, leaving the next read waiting.
  await tick();await tick();
  const reason=kind==='stream'?Error('synthetic custom cancellation'):new DOMException('synthetic cancellation','AbortError');
  abort.abort(reason);
  let timer;
  const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),250);})]);
  clearTimeout(timer);
  if(result.timedOut){producer.close();await pending;}
  expect(result.timedOut).toBeUndefined();
  expect(result.error).toBe(reason);
  expect(calls).toBe(0);
  // Request's stream wrapper may defer source cancellation across runtimes.
  if(kind==='stream')expect(cancelled).toBe(reason);
});

test('a previously cancelled body retains the abort reason and is not sent',async()=>{
  let calls=0;
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async()=>{calls++;return new Response('{}');}});
  const loader=await p.auth.loader(async()=>({source:'kimi-work-desktop',uid:session.uid}));
  const abort=new AbortController(),reason=Error('synthetic early cancellation');
  abort.abort(reason);
  await expect(loader.fetch(I.BASE+'/chat/completions',{method:'POST',body:'{"messages":[]}',signal:abort.signal})).rejects.toBe(reason);
  expect(calls).toBe(0);
});

test('a buffered UTF-8 body keeps characters split between chunks',async()=>{
  const original=JSON.stringify({messages:[{role:'user',content:'中文 🐦'}]});
  const bytes=new TextEncoder().encode(original);let sent;
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async(url,init)=>{sent=init.body;return new Response('{}');}});
  const loader=await p.auth.loader(async()=>({source:'kimi-work-desktop',uid:session.uid}));
  await loader.fetch(I.BASE+'/chat/completions',{method:'POST',body});
  expect(sent).toBe(original);
});

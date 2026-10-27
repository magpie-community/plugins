import { test, expect } from 'bun:test';
import vm from 'node:vm';
import { _internal } from './index.mjs';
function guide(fail=false){
 const html=_internal.guidePageHtml('google');
 const start=html.indexOf('let leavingForAuthorization');
 const at=html.indexOf('document.getElementById("goBtn").addEventListener');
 const script=html.slice(start>=0?start:at,html.indexOf('boot().catch'));
 const listeners={},elements=new Map(),sent=[];
 const ctx={Blob,document:{getElementById(id){if(!elements.has(id))elements.set(id,{style:{},addEventListener(type,fn){listeners[id+':'+type]=fn}});return elements.get(id)}},window:{addEventListener(type,fn){listeners[type]=fn}},navigator:{sendBeacon(url){sent.push(url)}},fetch:async()=>{if(fail)throw Error('connection refused');return{json:async()=>({url:'https://accounts.google.test/authorize'})}},msg(){},setTimeout(fn){fn()},location:{}};
 Object.defineProperty(ctx.location,'href',{set(){listeners.beforeunload?.()}});
 vm.runInNewContext(script,ctx);
 return{sent,listeners,elements};
}
test('leaving the guide for authorization must not abort the localhost callback',async()=>{
 const x=guide();await x.listeners['goBtn:click']();expect(x.sent).toEqual([]);
});
test('closing a guide before authorization still cancels its own session',()=>{
 const x=guide();x.listeners.beforeunload();expect(x.sent).toEqual(['/abort']);
});
test('an expired or disconnected guide restores its action instead of navigating',async()=>{
 const x=guide(true);await x.listeners['goBtn:click']();expect(x.elements.get('goBtn').disabled).toBe(false);expect(x.sent).toEqual([]);
});

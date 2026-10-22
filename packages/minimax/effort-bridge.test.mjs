import './nonet.mjs';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {onRequest,restoreEffort} from './effort-bridge.mjs';
test('five native efforts survive conversion, interleaving, escaping and retries', () => {
const levels=['low','medium','high','xhigh','max'];
const cases=[];
for(const provider of ['minimax-code','minimax-code-global'])for(const protocol of ['responses','chat'])for(const effort of levels){
 const input={model:provider+'/MiniMax-M3.1-Flash',instructions:'Original system\n',messages:[{role:'user',content:'Hello'}],reasoning:{effort},reasoning_effort:effort};
 const marked=onRequest(input,{protocol,path:protocol==='chat'?'/v1/chat/completions':'/v1/responses'});
 const system=protocol==='responses'?marked.instructions:marked.messages[0].content;
 cases.push({effort,body:JSON.stringify({model:'MiniMax-M3.1-Flash',system:[{type:'text',text:system}],thinking:{type:'enabled',budget_tokens:7168},output_config:{format:{type:'json_schema'}},messages:[{role:'user',content:'Hello'}]})});
 assert.equal(input.instructions,'Original system\n');assert.equal(input.messages.length,1);
}
for(const c of cases.reverse())for(let retry=0;retry<2;retry++){
 const wire = retry === 0 ? c.body : c.body.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
 const out=restoreEffort(wire);assert(!out.includes('magpie-minimax-effort'));const b=JSON.parse(out);assert.equal(b.output_config.effort,c.effort);assert(!Object.hasOwn(b,'thinking'));assert.deepEqual(b.messages,[{role:'user',content:'Hello'}]);assert.equal(b.output_config.format.type,'json_schema');
}
for(const model of ['minimax-code/MiniMax-M3','other/MiniMax-M3.1-Flash']){const b={model,reasoning:{effort:'max'}};assert.equal(onRequest(b,{protocol:'responses'}),b);}
assert.equal(restoreEffort('{"model":"x"}'),'{"model":"x"}');
assert.throws(()=>restoreEffort(JSON.stringify({model:'MiniMax-M3.1-Flash',system:'<magpie-minimax-effort:00000000-0000-0000-0000-000000000000>'})),/missing or expired/);
console.log('PASS: 20 interleaved request contexts, 40 restore/retry checks, scope and invalid context checks');

for(const effort of levels) for(const suffix of ['', '-Preview']) {
 const original={model:'minimax-code/MiniMax-M3.1-Flash'+suffix,thinking:{type:'adaptive'},output_config:{effort}};
 const patched=onRequest(original,{protocol:'anthropic',path:'/v1/messages'});
 assert(!Object.hasOwn(patched,'thinking'));assert.equal(patched.output_config.effort,effort);assert(Object.hasOwn(original,'thinking'));
 const wire=restoreEffort(JSON.stringify({...original,model:'MiniMax-M3.1-Flash'+suffix}));assert(!Object.hasOwn(JSON.parse(wire),'thinking'));
}
console.log('PASS: native Messages and Preview omit thinking for all five efforts');

});

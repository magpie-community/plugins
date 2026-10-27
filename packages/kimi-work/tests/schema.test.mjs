// #287: Kimi Work refused every Codex request, 400 "tools.function.parameters
// is not a valid moonshot flavored json schema, details: <At path
// '$defs.__schema20': when using $ref, type should be defined in the
// referenced schema instead of the parent schema>".
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {_internal as I} from '../index.mjs';

const fixture=name=>JSON.parse(fs.readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
// zod 4.6.7's toJSONSchema({reused:'ref'}) of a tool whose z.number().min(0)
// is reused and then derived with .int(), itself reused: $defs.__schema1 is
// {"type":"integer",…,"$ref":"#/$defs/__schema0"}, the shape refused.
const zodDerived=fixture('zod-derived-refs.json');
// Codex App's automation_update parameters (magpie's testdata).
const automation=fixture('codex-automation-update.json');

const SUB=['items','additionalProperties','contains','propertyNames','not','if','then','else','allOf','anyOf','oneOf','prefixItems','unevaluatedProperties','unevaluatedItems','contentSchema'];
const MAP=['properties','$defs','definitions','dependentSchemas','patternProperties'];
// the rules Kimi has been seen to refuse, as paths a refusal would name
function refusals(root) {
  const out=[];
  const walk=(s,at)=>{
    if(Array.isArray(s)){s.forEach((v,i)=>walk(v,at+'.'+i));return;}
    if(!s||typeof s!=='object')return;
    if('$ref' in s&&'type' in s)out.push(at+': type beside $ref');
    if('anyOf' in s&&'type' in s)out.push(at+': type beside anyOf');
    if((Array.isArray(s.enum)||'const' in s)&&!('type' in s))out.push(at+': enum without type');
    if(typeof s.$ref==='string'&&s.$ref.startsWith('#/')) {
      const t=s.$ref.split('/').slice(1).reduce((c,k)=>c?.[k],root);
      if(t&&typeof t==='object'&&!('type' in t)&&!('anyOf' in t)&&!('$ref' in t)&&Object.keys(t).length)out.push(at+': untyped $ref target');
    }
    for(const k of MAP)if(s[k]&&typeof s[k]==='object')for(const [n,v] of Object.entries(s[k]))walk(v,(at?at+'.':'')+k+'.'+n);
    for(const k of SUB)if(k in s)walk(s[k],(at?at+'.':'')+k);
  };
  walk(root,'');
  return out;
}
const bodyOf=parameters=>JSON.stringify({model:'k3-agent',stream:true,messages:[{role:'user',content:'hi'}],
  tools:[{type:'function',function:{name:'tool',description:'d',parameters}}]});
const sent=body=>JSON.parse(I.moonshotTools(body)).tools[0].function.parameters;

test('the fixtures have the shapes Kimi refuses',()=>{
  expect(refusals(zodDerived)).toContain('$defs.__schema1: type beside $ref');
  expect(refusals(zodDerived)).toContain('properties.runId: type beside $ref');
});

test("zod's derived $refs go with the target written in, and nothing Kimi refuses is left",()=>{
  const p=sent(bodyOf(zodDerived));
  expect(refusals(p)).toEqual([]);
  // .int() of z.number().min(0): both constraints kept, the derived type wins
  expect(p.$defs.__schema1).toEqual({type:'integer',minimum:0,maximum:9007199254740991});
  expect(p.properties.runId).toMatchObject({type:'string',minLength:1,format:'uuid',description:'run'});
  expect(p.properties.runId.$ref).toBeUndefined();
  // a $ref with only notes or keywords beside it is as zod wrote it
  expect(p.properties.pageSize).toEqual(zodDerived.properties.pageSize);
  expect(p.properties.offset).toEqual({$ref:'#/$defs/__schema0'});
});

test('a $ref beside a type whose target has refs of its own keeps the ref and loses the type',()=>{
  const schema={type:'object',properties:{n:{type:'object',$ref:'#/$defs/node'}},
    $defs:{node:{type:'object',properties:{next:{$ref:'#/$defs/node'}}}}};
  const p=sent(bodyOf(schema));
  expect(p.properties.n).toEqual({$ref:'#/$defs/node'});
  expect(refusals(p)).toEqual([]);
});

test("Codex App's automation_update goes with nothing Kimi refuses added, such as a type beside its format-and-$ref defs",()=>{
  const p=sent(bodyOf(automation));
  expect(refusals(p)).toEqual([]);
});

test('a type beside an anyOf, an untyped enum and an untyped oneOf target are given what Kimi takes',()=>{
  const schema={type:'object',properties:{
    a:{type:'string',anyOf:[{type:'string'},{type:'null'}]},
    b:{enum:['x','y']},c:{enum:['x',null]},d:{const:3},
    e:{$ref:'#/$defs/__schema0'},f:{$ref:'#/$defs/__schema1'}},
    $defs:{__schema0:{oneOf:[{type:'string'},{type:'number'}]},__schema1:{description:'anything'}}};
  const p=sent(bodyOf(schema));
  expect(p.properties.a).toEqual({anyOf:[{type:'string'},{type:'null'}]});
  expect(p.properties.b).toEqual({type:'string',enum:['x','y']});
  expect(p.properties.c).toEqual({type:['string','null'],enum:['x',null]});
  expect(p.properties.d).toEqual({type:'integer',const:3});
  expect(p.$defs.__schema0.type).toEqual(['string','number']);
  expect(p.$defs.__schema1.type).toEqual(['string','number','integer','boolean','object','array','null']);
  expect(refusals(p)).toEqual([]);
});

test('a body Kimi takes goes byte for byte, and a rewrite is the same each time',()=>{
  const ok=bodyOf({type:'object',properties:{a:{type:'string'},b:{$ref:'#/$defs/x'}},$defs:{x:{type:'number'}}});
  expect(I.moonshotTools(ok)).toBe(ok);
  const bad=bodyOf(zodDerived);
  expect(I.moonshotTools(bad)).toBe(I.moonshotTools(bad));
  for(const b of ['', 'not json', '{"tools":"x"}', JSON.stringify({messages:[]})])expect(I.moonshotTools(b)).toBe(b);
});

test('the request Kimi Work is sent carries the rewritten tools, from a string or a Request',async()=>{
  const session={uid:'fixture-account',workToken:'synthetic-work-token',webToken:'synthetic-web-token'};
  const bodies=[];
  const p=I.createPlugin({readSession:()=>session,fetchImpl:async(url,init)=>{bodies.push(init.body);return new Response('{}');}});
  const loader=await p.auth.loader(async()=>({source:'kimi-work-desktop',uid:session.uid}));
  const body=bodyOf(zodDerived);
  await loader.fetch(I.BASE+'/chat/completions',{method:'POST',body});
  await loader.fetch(new Request(I.BASE+'/chat/completions',{method:'POST',body}));
  await loader.fetch(I.BASE+'/chat/completions',{method:'POST',body:new TextEncoder().encode(body)});
  expect(bodies.length).toBe(3);
  for(const b of bodies) {
    expect(typeof b).toBe('string');
    expect(refusals(JSON.parse(b).tools[0].function.parameters)).toEqual([]);
  }
});

import { afterAll, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScanner } from "./lib/scan.mjs"

const roots=[]
const tmp=()=>{const root=mkdtempSync(join(tmpdir(),"office-cold-"));roots.push(root);return root}
afterAll(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true})})
const now=Date.now(),timestamp=new Date(now).toISOString()
const line=record=>JSON.stringify(record)+"\n"
const user=text=>({type:"user",timestamp,message:{role:"user",content:text}})
const scanner=root=>createScanner({sources:[{root,kind:"claude",agent:"claude",depth:0,match:name=>name.endsWith(".jsonl")}]})
// framePart walks characters with String's iterator. Count actual large
// string traversal, rather than asserting a machine-dependent time limit.
// JSON.parse handles completed lines natively and does not use this hook.
function traversal(run) {
 const original=String.prototype[Symbol.iterator]
 let chars=0
 String.prototype[Symbol.iterator]=function(){const text=String(this);if(text.length>=512)chars+=text.length;return original.call(this)}
 try{return {result:run(),get chars(){return chars}}}finally{String.prototype[Symbol.iterator]=original}
}

test("cold image records spanning read chunks skip lexical character traversal",()=>{
 const root=tmp(),path=join(root,"cold.jsonl")
 const image=line({type:"assistant",timestamp,message:{role:"assistant",content:[{type:"image",source:{type:"base64",data:"A".repeat(1024*1024)}}],stop_reason:"end_turn"}})
 writeFileSync(path,line(user("cold image work"))+image.repeat(4))
 const sc=scanner(root)
 const measured=traversal(()=>sc.scan(now)[0])
 expect(measured.result).toMatchObject({query:"cold image work",turns:1,phase:"done"})
 expect(measured.chars).toBe(0)
 expect(sc.files.get(path).cursor.parts).toHaveLength(0)
 expect(sc.files.get(path).cursor.framedParts).toBe(0)
})

test("only the EOF fragment is framed and existing fragments are not walked on later ticks",()=>{
 const root=tmp(),path=join(root,"tail.jsonl")
 const image=line({type:"padding",data:"A".repeat(1024*1024)})
 const tail='{"type":"padding","text":"'+"q".repeat(10000)
 writeFileSync(path,image+tail)
 const sc=scanner(root)
 const first=traversal(()=>sc.scan(now))
 expect(first.chars).toBe(tail.length)
 const unchanged=traversal(()=>sc.scan(now))
 expect(unchanged.chars).toBe(0)
 const more="x".repeat(1000)+"}"
 appendFileSync(path,more)
 const appended=traversal(()=>sc.scan(now))
 expect(appended.chars).toBe(more.length)
 appendFileSync(path,'"}\n'+line(user("after image")))
 const completed=traversal(()=>sc.scan(now)[0])
 expect(completed.result).toMatchObject({query:"after image",turns:1})
 expect(completed.chars).toBe(0)
 expect(sc.files.get(path).cursor.parts).toHaveLength(0)
})

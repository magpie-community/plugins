import { afterAll, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScanner } from "./lib/scan.mjs"

const roots=[]
const tmp=()=>{const root=mkdtempSync(join(tmpdir(),"office-incremental-"));roots.push(root);return root}
afterAll(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true})})
const line=x=>JSON.stringify(x)+"\n"
const time=Date.now(), stamp=new Date(time).toISOString()
const user=text=>({type:"user",timestamp:stamp,cwd:"/fixture",message:{role:"user",content:text}})
const done=(id="r1",output=10)=>({type:"assistant",timestamp:stamp,message:{id,role:"assistant",stop_reason:"end_turn",usage:{input_tokens:100,output_tokens:output},content:[{type:"text",text:"done"}]}})
const source=(root,kind="claude",extra={})=>({root,kind,agent:kind,depth:0,match:n=>n.endsWith(".jsonl"),...extra})
function tracked(sources) {
 const reads=[]
 const scanner=createScanner({sources,readSync(fd,buf,offset,length,position){const n=readSync(fd,buf,offset,length,position);reads.push({position,length,n});return n}})
 return {scanner,reads,bytes:()=>reads.reduce((sum,r)=>sum+r.n,0),reset:()=>{reads.length=0}}
}

test("a one-line append to a 100 MiB session reads the line plus at most 128 guard bytes",()=>{
 const root=tmp(),path=join(root,"large.jsonl")
 const padding=line({type:"padding",text:"x".repeat(4000)})
 writeFileSync(path,line(user("old"))+padding.repeat(Math.ceil(100*1024*1024/Buffer.byteLength(padding)))+line(done()))
 const {scanner,reads,bytes,reset}=tracked([source(root)])
 const size=statSync(path).size
 expect(size).toBeGreaterThanOrEqual(100*1024*1024)
 expect(scanner.scan(time)[0]).toMatchObject({turns:1,tokensToday:110,phase:"done"})
 expect(bytes()).toBe(size)
 const reader=scanner.files.get(path).reader
 const appended=line(user("new work"))
 appendFileSync(path,appended)
 reset()
 expect(scanner.scan(time)[0]).toMatchObject({turns:2,query:"new work",tokensToday:110,phase:"thinking"})
 expect(scanner.files.get(path).reader).toBe(reader)
 expect(bytes()).toBe(Buffer.byteLength(appended)+128)
 expect(reads.at(-1).position).toBe(size)
 reset();scanner.scan(time);expect(bytes()).toBe(0)
},15000)

test("UTF-8 and JSON split between scan ticks are carried without replay or duplicate turns",()=>{
 const root=tmp(),path=join(root,"partial.jsonl")
 const record=Buffer.from(line(user("hello 世界 🌍")))
 const split=record.indexOf(Buffer.from("世"))+1
 writeFileSync(path,record.subarray(0,split))
 const {scanner,bytes,reset}=tracked([source(root)])
 expect(scanner.scan(time)[0].turns).toBe(0)
 reset();appendFileSync(path,record.subarray(split))
 expect(scanner.scan(time)[0]).toMatchObject({turns:1,query:"hello 世界 🌍",phase:"thinking"})
 expect(bytes()).toBe(record.length-split+128)
 const tool=line({type:"assistant",timestamp:stamp,message:{role:"assistant",stop_reason:"tool_use",content:[{type:"tool_use",id:"tool",name:"Bash",input:{command:"test"}}]}})
 appendFileSync(path,tool)
 expect(scanner.scan(time)[0]).toMatchObject({phase:"tool",pending:[{id:"tool"}]})
 appendFileSync(path,line({type:"user",timestamp:stamp,message:{role:"user",content:[{type:"tool_result",tool_use_id:"tool",content:"ok"}]}}))
 expect(scanner.scan(time)[0]).toMatchObject({turns:1,phase:"thinking",pending:[]})
})

test("a complete record flushed before its newline is applied exactly once",()=>{
 const root=tmp(),path=join(root,"eof.jsonl")
 writeFileSync(path,JSON.stringify(user("once")))
 const {scanner,bytes,reset}=tracked([source(root)])
 expect(scanner.scan(time)[0].turns).toBe(1)
 reset();appendFileSync(path,"\r\n")
 expect(scanner.scan(time)[0].turns).toBe(1)
 expect(bytes()).toBe(2+128)
 appendFileSync(path,JSON.stringify(done("response",10)))
 expect(scanner.scan(time)[0].tokensToday).toBe(110)
 appendFileSync(path,"\n"+line(done("response",30)))
 expect(scanner.scan(time)[0]).toMatchObject({turns:1,tokensToday:130})
})

test("non-whitespace extending an EOF-committed record replays the invalidated line",()=>{
 const root=tmp(),path=join(root,"extended-eof.jsonl")
 writeFileSync(path,line(user("before"))+JSON.stringify(done("speculative",30)))
 const {scanner,reads,reset}=tracked([source(root)])
 expect(scanner.scan(time)[0]).toMatchObject({turns:1,tokensToday:130,phase:"done"})
 const reader=scanner.files.get(path).reader
 // The previously valid JSON now has trailing junk before its first newline.
 // Fresh parsing must discard that entire line, including its usage/phase.
 appendFileSync(path,"invalid extension\n"+line(user("after")))
 reset()
 const actual=scanner.scan(time)[0]
 expect(actual).toEqual(createScanner({sources:[source(root)]}).scan(time)[0])
 expect(actual).toMatchObject({turns:2,tokensToday:0,query:"after",phase:"thinking"})
 expect(scanner.files.get(path).reader).not.toBe(reader)
 expect(reads.filter(r=>r.position===0)).toHaveLength(2) // prefix probe, then fresh replay
})

test("inode replacement resets even when both append witnesses are identical",()=>{
 const root=tmp(),path=join(root,"identity.jsonl"),replacement=join(root,"replacement.tmp")
 const prefix=line({type:"padding",text:"p".repeat(256)})
 const suffix=line({type:"padding",text:"s".repeat(256)})
 const initial=Buffer.from(prefix+line(user("OLD middle"))+suffix)
 const replaced=Buffer.from(prefix+line(user("NEW middle"))+suffix+line(done("replacement",20)))
 writeFileSync(path,initial)
 const {scanner,reads,reset}=tracked([source(root)])
 expect(scanner.scan(time)[0]).toMatchObject({query:"OLD middle",turns:1})
 const reader=scanner.files.get(path).reader,identity=statSync(path)
 expect(replaced.length).toBeGreaterThan(initial.length)
 expect(replaced.subarray(0,64)).toEqual(initial.subarray(0,64))
 expect(replaced.subarray(initial.length-64,initial.length)).toEqual(initial.subarray(-64))
 writeFileSync(replacement,replaced);renameSync(replacement,path)
 expect(statSync(path).ino).not.toBe(identity.ino)
 reset()
 const actual=scanner.scan(time)[0]
 expect(actual).toEqual(createScanner({sources:[source(root)]}).scan(time)[0])
 expect(actual).toMatchObject({query:"NEW middle",turns:1,tokensToday:120})
 expect(scanner.files.get(path).reader).not.toBe(reader)
 expect(reads[0].position).toBe(0)
 expect(reads.reduce((sum,r)=>sum+r.n,0)).toBe(replaced.length)
})

test("a partially written large image record reads new bytes plus bounded guards",()=>{
 const root=tmp(),path=join(root,"image.jsonl")
 writeFileSync(path,line(user("before image")))
 const record=Buffer.from(line({type:"assistant",timestamp:stamp,message:{role:"assistant",content:[{type:"image",source:{type:"base64",data:"A".repeat(2*1024*1024)}}],stop_reason:"end_turn"}}))
 const {scanner,bytes,reset}=tracked([source(root)])
 scanner.scan(time)
 for(let at=0;at<record.length;at+=131071) {
  const part=record.subarray(at,at+131071)
  appendFileSync(path,part);reset();scanner.scan(time)
  expect(bytes()).toBe(part.length+128)
 }
 expect(scanner.scan(time)[0]).toMatchObject({phase:"done",query:"before image",turns:1})
})

test("truncation, inode replacement and same-size edits reset parsing state",()=>{
 const root=tmp(),path=join(root,"rotate.jsonl")
 writeFileSync(path,line(user("original long query"))+line(done()))
 const {scanner,reads,reset}=tracked([source(root)])
 scanner.scan(time)
 writeFileSync(path,line(user("AA")))
 reset();expect(scanner.scan(time)[0]).toMatchObject({query:"AA",turns:1,tokensToday:0})
 expect(reads[0].position).toBe(0)
 const original=statSync(path)
 const replacement=join(root,"replacement.tmp")
 writeFileSync(replacement,line(user("BB replacement"))+line(done("replacement",20)))
 renameSync(replacement,path)
 expect(statSync(path).ino).not.toBe(original.ino)
 reset();expect(scanner.scan(time)[0]).toMatchObject({query:"BB replacement",turns:1,tokensToday:120})
 expect(reads[0].position).toBe(0)
 const size=statSync(path).size
 writeFileSync(path,line(user("CC replacement"))+line(done("replacement",20)))
 expect(statSync(path).size).toBe(size)
 utimesSync(path,(time+1000)/1000,(time+1000)/1000)
 reset();expect(scanner.scan(time)[0].query).toBe("CC replacement")
 expect(reads[0].position).toBe(0)
})

test("midnight and metadata-only changes do not read JSONL again",()=>{
 const root=tmp(),path=join(root,"updates.jsonl"),usage=join(root,"usage.json"),meta=join(root,"summary.json")
 const before=new Date(2026,9,30,23,59,10).getTime(),after=new Date(2026,9,31,0,1).getTime()
 writeFileSync(path,line({timestamp:before/1000,params:{update:{sessionUpdate:"user_message_chunk",content:{text:"work"}}}}))
 utimesSync(path,before/1000,before/1000)
 const use=tokens=>({turns:[{endedAt:new Date(before).toISOString(),inputTokens:tokens,outputTokens:10}]})
 writeFileSync(usage,JSON.stringify(use(100)));writeFileSync(meta,JSON.stringify({title:"old title"}))
 const {scanner,bytes,reset}=tracked([source(root,"grok",{usage:()=>usage,meta:()=>meta})])
 expect(scanner.scan(before)[0]).toMatchObject({title:"old title",tokensToday:110,turnsToday:1})
 reset();expect(scanner.scan(after)[0]).toMatchObject({tokensToday:0,turnsToday:0})
 expect(bytes()).toBe(0)
 writeFileSync(meta,JSON.stringify({title:"new title",summaryCacheProbe:"summary-cache-marker"}));writeFileSync(usage,JSON.stringify(use(200)))
 reset();expect(scanner.scan(before)[0]).toMatchObject({title:"new title",tokensToday:210,turnsToday:1})
 expect(bytes()).toBe(0)
 const original=JSON.parse
 let usageParses=0,summaryParses=0
 JSON.parse=function(text,...args){
  if(String(text).includes('"endedAt"'))usageParses++
  if(String(text).includes('"summaryCacheProbe"'))summaryParses++
  return original.call(this,text,...args)
 }
 try {
  appendFileSync(path,line({timestamp:before/1000,params:{update:{sessionUpdate:"agent_message_chunk",content:{text:"hello"}}}}))
  expect(scanner.scan(before)[0]).toMatchObject({tokensToday:210,title:"new title"})
  expect(usageParses).toBe(0)
  expect(summaryParses).toBe(0)
  expect(scanner.files.get(path)).not.toHaveProperty("usageValue")
  writeFileSync(meta,JSON.stringify({title:"changed summary title",summaryCacheProbe:"summary-cache-marker"}))
  reset();expect(scanner.scan(before)[0].title).toBe("changed summary title")
  expect(summaryParses).toBe(1)
  expect(usageParses).toBe(0)
  expect(bytes()).toBe(0)
 }finally{JSON.parse=original}
 rmSync(meta)
 reset();expect(scanner.scan(before)[0]).toMatchObject({title:"work",cwd:"",model:"",subagent:false,tokensToday:210})
 expect(bytes()).toBe(0)
})

test("changing sources releases cursors and accumulated sessions",()=>{
 const root=tmp(),other=tmp(),path=join(root,"one.jsonl")
 writeFileSync(path,line(user("first")))
 writeFileSync(join(other,"two.jsonl"),line(user("second")))
 const {scanner,reads,reset}=tracked([source(root)])
 scanner.scan(time)
 scanner.setSources([source(other)]);reset()
 expect(scanner.scan(time)[0]).toMatchObject({query:"second",turns:1})
 expect(scanner.files.has(path)).toBe(false)
 expect(reads[0].position).toBe(0)
})

test("truncate-and-regrow between ticks resets when the prefix or previous end changes",()=>{
 for(const leading of ["",line({type:"padding",text:"constant".repeat(40)})]) {
  const root=tmp(),path=join(root,"regrow.jsonl")
  writeFileSync(path,leading+line(user("OLD")))
  const {scanner}=tracked([source(root)])
  scanner.scan(time)
  const old=scanner.files.get(path).reader,size=statSync(path).size
  writeFileSync(path,leading+line(user("NEW LONGER QUERY after truncate")))
  expect(statSync(path).size).toBeGreaterThan(size)
  expect(scanner.scan(time)[0]).toMatchObject({query:"NEW LONGER QUERY after truncate",turns:1})
  expect(scanner.files.get(path).reader).not.toBe(old)
 }
})

test("an unfinished quoted brace never reparses its buffered history",()=>{
 const root=tmp(),path=join(root,"quoted.jsonl")
 writeFileSync(path,'{"type":"padding","text":"')
 const {scanner,bytes,reset}=tracked([source(root)])
 const original=JSON.parse
 let parseChars=0,calls=0
 JSON.parse=function(text,...args){parseChars+=String(text).length;calls++;return original.call(this,text,...args)}
 try {
  scanner.scan(time)
  for(let i=0;i<64;i++) {
   const part="x".repeat(16383)+"}"
   appendFileSync(path,part);reset();scanner.scan(time)
   expect(bytes()).toBeLessThanOrEqual(Buffer.byteLength(part)+128)
  }
  expect(calls).toBe(0)
  expect(parseChars).toBe(0)
  appendFileSync(path,'"}\n'+line(user("complete")))
  expect(scanner.scan(time)[0].query).toBe("complete")
  expect(calls).toBe(2)
  expect(parseChars).toBeLessThan(2*1024*1024)
 }finally{JSON.parse=original}
})

test("Codex thread titles also reuse an append cursor",()=>{
 const root=tmp(),sessions=join(root,"sessions"),index=join(root,"session_index.jsonl")
 mkdirSync(sessions)
 const id="019a0000-0000-7000-8000-000000000001",path=join(sessions,`rollout-${id}.jsonl`)
 writeFileSync(path,line({timestamp:stamp,type:"session_meta",payload:{id,cwd:"/fixture"}}))
 writeFileSync(index,line({id,thread_name:"old title"})+Array.from({length:1024},(_,i)=>line({id:`unrelated-${i}`,thread_name:"padding "+"x".repeat(256)})).join(""))
 const indexSize=statSync(index).size
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=root
 try {
  const {scanner,reads,bytes,reset}=tracked([source(sessions,"codex")])
  const sessionSize=statSync(path).size
  expect(scanner.scan(time)[0].title).toBe("old title")
  expect(bytes()).toBe(sessionSize+indexSize)
  reset();scanner.scan(time);expect(bytes()).toBe(0)
  const more=line({timestamp:stamp,type:"event_msg",payload:{type:"task_complete"}})
  const title=line({id,thread_name:"new title"})
  appendFileSync(path,more);appendFileSync(index,title);reset()
  expect(scanner.scan(time)[0].title).toBe("new title")
  expect(bytes()).toBe(Buffer.byteLength(more+title)+256)
  expect(reads.map(r=>({position:r.position,n:r.n}))).toEqual([
   {position:0,n:64},{position:sessionSize-64,n:64},{position:sessionSize,n:Buffer.byteLength(more)},
   {position:0,n:64},{position:indexSize-64,n:64},{position:indexSize,n:Buffer.byteLength(title)},
  ])
  reset();expect(scanner.scan(time)[0].title).toBe("new title");expect(bytes()).toBe(0)
  writeFileSync(index,line({id,thread_name:"alt title"}))
  utimesSync(index,(time+1000)/1000,(time+1000)/1000)
  expect(scanner.scan(time)[0].title).toBe("alt title")
 }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous}
})


test("a transient read failure resumes completed cursor progress without double counting",()=>{
 const root=tmp(),path=join(root,"retry.jsonl")
 writeFileSync(path,line(user("initial")))
 const start=statSync(path).size
 let fail=false,failed=false
 const reads=[]
 const scanner=createScanner({sources:[source(root)],readSync(fd,buf,offset,length,position){
  if(fail&&!failed&&position>=start+65536){failed=true;throw new Error("synthetic read interruption")}
  const n=readSync(fd,buf,offset,length,position);reads.push({position,n});return n
 }})
 scanner.scan(time)
 const rows=Array.from({length:80},(_,i)=>line(user(`task ${i} `+"q".repeat(1800)))).join("")
 appendFileSync(path,rows);fail=true
 expect(scanner.scan(time)).toHaveLength(1)
 expect(failed).toBe(true)
 const progress=scanner.files.get(path).cursor.offset
 expect(progress).toBeGreaterThan(start)
 reads.length=0
 const result=scanner.scan(time)[0]
 expect(result.turns).toBe(81)
 expect(result).toMatchObject({query:(`task 79 `+"q".repeat(1800)).slice(0,199)+"…",phase:"thinking"})
 expect(reads.some(r=>r.position===progress)).toBe(true)
 expect(reads.reduce((n,r)=>n+r.n,0)).toBe(statSync(path).size-progress+128)
 expect(result).toMatchObject(createScanner({sources:[source(root)]}).scan(time)[0])
})

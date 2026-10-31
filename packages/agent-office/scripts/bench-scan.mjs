// Synthetic, local-only scan benchmark; no real agent logs or model calls.
// bun scripts/bench-scan.mjs [size-in-MiB=100] [session-count=1] [image-MiB-per-30-lines=0]
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { createScanner } from "../lib/scan.mjs"
const mib=Number(process.argv[2]||100),count=Number(process.argv[3]||1),imageMiB=Number(process.argv[4]||0)
if(!Number.isInteger(mib)||mib<1||mib>512||!Number.isInteger(count)||count<1||count>8||!Number.isInteger(imageMiB)||imageMiB<0||imageMiB>16)throw new Error("Use 1..512 MiB, 1..8 sessions and 0..16 MiB images")
const root=mkdtempSync(join(tmpdir(),"office-scan-bench-")),paths=[]
let bytes=0,calls=0
const iso=new Date().toISOString(),json=x=>JSON.stringify(x)+"\n"
const body=json({type:"assistant",timestamp:iso,message:{role:"assistant",content:[{type:"text",text:"x".repeat(3950)}],stop_reason:"end_turn"}})
const image=imageMiB?json({type:"assistant",timestamp:iso,message:{role:"assistant",content:[{type:"image",source:{type:"base64",data:"A".repeat(imageMiB*1024*1024)}}],stop_reason:"end_turn"}}):""
const block=Buffer.from(imageMiB?body.repeat(30)+image:body.repeat(64))
try {
 for(let i=0;i<count;i++) {
  const path=join(root,`session-${i}.jsonl`),fd=openSync(path,"w")
  try {for(let size=0;size<mib*1024*1024;size+=writeSync(fd,block)) {}}finally{closeSync(fd)}
  paths.push(path)
 }
 const scanner=createScanner({sources:[{agent:"claude",kind:"claude",root,depth:0,match:n=>n.endsWith(".jsonl")}],readSync(fd,b,o,l,p){const n=readSync(fd,b,o,l,p);bytes+=n;calls++;return n}})
 const sample=()=>{bytes=0;calls=0;const t=performance.now();const sessions=scanner.scan();return {ms:+(performance.now()-t).toFixed(3),bytes,calls,sessions:sessions.length}}
 const initial=sample(),unchanged=sample(),appends=[]
 for(let i=0;i<5;i++) {
  let expectedBytes=0
  for(const path of paths){const next=json({type:"user",timestamp:iso,message:{role:"user",content:`append-${i} `+"q".repeat(3900)}});appendFileSync(path,next);expectedBytes+=Buffer.byteLength(next)}
  const observed=sample();if(observed.bytes<expectedBytes||observed.bytes>expectedBytes+128*count)throw new Error(`Append read ${observed.bytes}, expected ${expectedBytes} + bounded guards`)
  appends.push({...observed,appendedBytes:expectedBytes,guardBytes:observed.bytes-expectedBytes})
 }
 console.log(JSON.stringify({sizeMiB:mib,sessionCount:count,imageMiB,totalBytes:paths.reduce((n,p)=>n+statSync(p).size,0),initial,unchanged,appends},null,2))
} finally {
 const target=resolve(root),prefix=resolve(tmpdir())+"/office-scan-bench-"
 if(!target.startsWith(prefix))throw new Error("Unexpected benchmark cleanup path")
 rmSync(target,{recursive:true,force:true})
}

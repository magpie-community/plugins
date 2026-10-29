import { test } from "node:test";
import assert from "node:assert/strict";
import { GoAnyAPITools } from "../index.mjs";

function fixture() {
  let catalog = [{id:"traffic",method:"GET",path:"/api/v1/traffic",mcpName:"goanyapi_traffic",description:"Traffic",readOnly:true,inputSchema:{type:"object",properties:{domain:{type:"string"}},required:["domain"],additionalProperties:false}}];
  const calls = [];
  const fetcher = async (input, init={}) => {
    const url = new URL(input);
    if (url.pathname === "/api/v1/mcp/catalog") return Response.json({code:"ok",data:{schemaVersion:1,apis:catalog}});
    calls.push({url:url.href,init});
    return Response.json({code:"ok",domain:url.searchParams.get("domain")});
  };
  return {calls,fetcher,get catalog(){return catalog},set catalog(value){catalog=value}};
}
test("every catalog tool is mapped and API key goes to REST", async () => {
 const f = fixture(); const previous = globalThis.fetch; globalThis.fetch=f.fetcher;
 try {
  const plugin=await GoAnyAPITools({directory:"/tmp",client:{auth:{set:async()=>{}}}}, {apiKey:"private-test",baseUrl:"http://127.0.0.1:9091"});
  assert.ok(plugin.tool.traffic);assert.ok(plugin.tool.catalog);assert.ok(plugin.tool.call_dynamic);
  const output=await plugin.tool.traffic.execute({domain:"example.com"}, {abort:new AbortController().signal});
  assert.equal(output.domain,"example.com"); assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.headers.authorization,"Bearer private-test");
  await assert.rejects(()=>plugin.tool.traffic.execute({other:"x"}, {abort:new AbortController().signal}), /Missing required|Unknown argument/);
  assert.ok(!JSON.stringify(output).includes("private-test"));
 } finally {globalThis.fetch=previous}
});
test("new tools become available through live catalog without a PR", async()=>{
 const f=fixture();const previous=globalThis.fetch;globalThis.fetch=f.fetcher;
 try {
  const plugin=await GoAnyAPITools({directory:"/tmp",client:{auth:{set:async()=>{}}}},{apiKey:"private-test",baseUrl:"http://127.0.0.1:9092"});
  f.catalog=[...f.catalog,{id:"new",method:"GET",path:"/api/v1/new",mcpName:"goanyapi_new",description:"New",readOnly:true,inputSchema:{type:"object",properties:{},required:[],additionalProperties:false}}];
  const names=await plugin.tool.catalog.execute({});
  assert.equal(names.length,2); assert.equal(plugin.tool.new,undefined);
  await plugin.tool.call_dynamic.execute({name:"goanyapi_new",arguments:{}},{abort:new AbortController().signal});
  assert.ok(f.calls.some(c=>c.url.includes("/api/v1/new")));
  await assert.rejects(()=>plugin.tool.call_dynamic.execute({name:"goanyapi_hidden",arguments:{}},{abort:new AbortController().signal}), /not published/);
 } finally{globalThis.fetch=previous}
});

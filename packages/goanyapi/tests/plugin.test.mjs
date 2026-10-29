import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoAnyAPITools } from "../index.mjs";
import { clearCatalogCache, fallbackCatalog } from "../src/catalog.ts";

const traffic = {id:"traffic",method:"GET",path:"/api/v1/traffic",mcpName:"goanyapi_traffic",description:"Traffic",readOnly:true,inputSchema:{type:"object",properties:{domain:{type:"string"}},required:["domain"],additionalProperties:false}};
const added = {id:"new",method:"GET",path:"/api/v1/new",mcpName:"goanyapi_new",description:"New",readOnly:true,inputSchema:{type:"object",properties:{},required:[],additionalProperties:false}};

const dirs = [];
const previous = globalThis.fetch;
function home() { const d = mkdtempSync(join(tmpdir(), "goanyapi-")); dirs.push(d); return d; }
function input(directory = home()) { return {directory,client:{auth:{set:async()=>{}}}}; }
const ctx = () => ({abort:new AbortController().signal});
afterEach(() => { globalThis.fetch = previous; clearCatalogCache(); for (const d of dirs.splice(0)) rmSync(d, {recursive:true,force:true}); });

function fixture() {
  let catalog = [traffic];
  const calls = [];
  let catalogReads = 0;
  const fetcher = async (input, init={}) => {
    const url = new URL(input);
    if (url.pathname === "/api/v1/mcp/catalog") { catalogReads++; return Response.json({code:"ok",data:{schemaVersion:1,apis:catalog}}); }
    calls.push({url:url.href,init});
    return Response.json({code:"ok",domain:url.searchParams.get("domain")});
  };
  globalThis.fetch = fetcher;
  return {calls,get catalogReads(){return catalogReads},get catalog(){return catalog},set catalog(value){catalog=value}};
}
// the background read that loading starts
const settle = () => new Promise(r => setTimeout(r, 20));

test("every catalog tool is mapped and API key goes to REST", async () => {
  const f = fixture();
  const plugin = await GoAnyAPITools(input(), {apiKey:"private-test",baseUrl:"http://127.0.0.1:9091"});
  assert.ok(plugin.tool.traffic);assert.ok(plugin.tool.catalog);assert.ok(plugin.tool.call_dynamic);
  const output = await plugin.tool.traffic.execute({domain:"example.com"}, ctx());
  assert.equal(output.domain,"example.com"); assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.headers.authorization,"Bearer private-test");
  assert.match(f.calls[0].init.headers["User-Agent"], /^goanyapi-magpie\//);
  await assert.rejects(()=>plugin.tool.traffic.execute({other:"x"}, ctx()), /Missing required|Unknown argument/);
  assert.ok(!JSON.stringify(output).includes("private-test"));
});

test("new tools become available through live catalog without a PR", async () => {
  const f = fixture();
  const plugin = await GoAnyAPITools(input(), {apiKey:"private-test",baseUrl:"http://127.0.0.1:9092"});
  await settle();
  f.catalog = [...f.catalog, added];
  const names = await plugin.tool.catalog.execute({});
  assert.equal(names.length,2); assert.equal(plugin.tool.new,undefined);
  await plugin.tool.call_dynamic.execute({name:"goanyapi_new",arguments:{}},ctx());
  assert.ok(f.calls.some(c=>c.url.includes("/api/v1/new")));
  await assert.rejects(()=>plugin.tool.call_dynamic.execute({name:"goanyapi_hidden",arguments:{}},ctx()), /not published/);
});

test("loading never waits on the catalog read", async () => {
  globalThis.fetch = (_url, init={}) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  const started = Date.now();
  const plugin = await GoAnyAPITools(input(), {apiKey:"k",baseUrl:"http://127.0.0.1:9093"});
  assert.ok(Date.now() - started < 1000, "load waited on the network");
  // the named tools are the bundled catalog's
  assert.equal(Object.keys(plugin.tool).length, fallbackCatalog.length + 2);
});

test("the last live catalog is kept on disk and named at the next load", async () => {
  const f = fixture();
  const directory = home();
  f.catalog = [traffic, added];
  await GoAnyAPITools(input(directory), {apiKey:"k",baseUrl:"http://127.0.0.1:9094"});
  await settle();
  const kept = JSON.parse(readFileSync(join(directory, "goanyapi-catalog.json"), "utf8"));
  assert.equal(kept.apis.length, 2);
  clearCatalogCache();
  globalThis.fetch = async () => { throw new Error("offline"); };
  const plugin = await GoAnyAPITools(input(directory), {apiKey:"k",baseUrl:"http://127.0.0.1:9094"});
  assert.ok(plugin.tool.new);
  // another base doesn't take this one's catalog
  const other = await GoAnyAPITools(input(directory), {apiKey:"k",baseUrl:"http://127.0.0.1:9095"});
  assert.equal(other.tool.new, undefined);
});

test("a failed read is not retried by every call for a minute", async () => {
  let reads = 0;
  globalThis.fetch = async () => { reads++; throw new Error("offline"); };
  const plugin = await GoAnyAPITools(input(), {apiKey:"k",baseUrl:"http://127.0.0.1:9096"});
  await settle();
  const list = await plugin.tool.catalog.execute({});
  await plugin.tool.catalog.execute({});
  assert.equal(reads, 1);
  assert.equal(list.length, fallbackCatalog.length);
});

test("one invalid entry drops that entry, not the catalog", async () => {
  const f = fixture();
  f.catalog = [traffic, added, {...added, mcpName:"bad name"}];
  const plugin = await GoAnyAPITools(input(), {apiKey:"k",baseUrl:"http://127.0.0.1:9097"});
  const names = await plugin.tool.catalog.execute({});
  assert.deepEqual(names.map(n => n.name), ["goanyapi_traffic","goanyapi_new"]);
});

test("the bundled catalog passes the same checks as a live one", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const plugin = await GoAnyAPITools(input(), {apiKey:"k",baseUrl:"http://127.0.0.1:9098"});
  for (const def of fallbackCatalog) assert.ok(plugin.tool[def.mcpName.slice("goanyapi_".length)], def.mcpName);
});

test("an MCP tool result marked isError fails the call", async () => {
  const directory = home();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(directory, "plugin-auth.json"), JSON.stringify({goanyapi:{type:"oauth",access:"a",refresh:"r",expires:Date.now()+3600e3,clientId:"c",tokenEndpoint:"https://mcp.goanyapi.com/token",issuer:"https://mcp.goanyapi.com"}}));
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/mcp/catalog") return Response.json({code:"ok",data:{schemaVersion:1,apis:[traffic]}});
    return Response.json({jsonrpc:"2.0",id:1,result:{isError:true,content:[{type:"text",text:"Insufficient credits"}]}});
  };
  const plugin = await GoAnyAPITools(input(directory), {baseUrl:"http://127.0.0.1:9099",mcpBaseUrl:"http://127.0.0.1:9100"});
  await assert.rejects(() => plugin.tool.traffic.execute({domain:"example.com"}, ctx()), /GoAnyAPI tool failed: Insufficient credits/);
});

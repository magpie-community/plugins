import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const app = process.env.MINIMAX_APP
if (!app) throw new Error("Set MINIMAX_APP for native MCP validation.")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-native-mcp-"))
const source = fs.readFileSync(path.join(app, "Contents/Resources/gateway/dist/main.js"), "utf8")
const bootstrap = source.lastIndexOf("bootstrap().catch(")
assert.ok(bootstrap > 0)
const archive = fs.readFileSync(path.join(app, "Contents/Resources/app.asar"))
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)))
const archiveBase = 8 + archive.readUInt32LE(4)
const validation = Object.values(header.files.out.files.main.files.chunks.files).map((entry) =>
  archive.subarray(archiveBase + Number(entry.offset), archiveBase + Number(entry.offset) + entry.size).toString())
  .find((chunk) => chunk.includes("function normalizeCustomMcpServerInput("))
assert.ok(validation, "Installed Design MCP projection is unavailable.")
const normalization = validation.slice(validation.indexOf("var COMMAND_PATH="), validation.indexOf("var CUSTOM_MCP_ENV_MARKER="))
const driver = `
{
const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const { default: vm } = await import("node:vm");
const { createServer } = await import("node:http");
const { createMcpBridge } = await import(${JSON.stringify(new URL("./mcp-sync.mjs", import.meta.url).href)});
const { readMcpVault, syncMcpStore } = await import(${JSON.stringify(new URL("./mcp-store.mjs", import.meta.url).href)});
const savedNative = vm.runInNewContext(${JSON.stringify(normalization + "\n({ toConnectorProxyConfig })")}, {
  createDecorator:()=>({}), mcpNameIdentity:name=>name.replaceAll(".","_").toLowerCase(),
});
let calls = 0;
let delayNextList = false;
const slowListMs = Number(process.env.MINIMAX_MCP_LIST_DELAY_MS ?? 0);
const fixture = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (body.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (body.method === "tools/list") {
    if (delayNextList) {
      delayNextList = false;
      await new Promise(resolve => setTimeout(resolve, slowListMs));
    }
    result = { tools: [{ name: "probe", description: "read-only native fixture", inputSchema: { type: "object", properties: {} } }] };
  }
  else if (body.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "design-v3-mcp-ok" }] }; }
  else result = {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const proxy = new ConnectorToolProxyService();
const workspace = { baseDir: ${JSON.stringify(root)} };
const runtime = {
  getSession: async () => ({ directory: workspace.baseDir }),
  getConnectorInventory: async () => { await proxy.warm(5000); return proxy.inventory(); },
};
const token = { getUserID: () => "fixture-user" };
const market = { getDiscoveryCatalog: async () => ({ available: true, summaries: [], catalog: { version: "fixture", connectors: [] } }) };
const capabilities = new ConnectorCapabilityService(runtime, { findClientByUiSessionId: () => undefined }, workspace, token, undefined, undefined, undefined, market, proxy);
await assert.rejects(capabilities.callConnectorTool("fixture-session", { capabilityId: "connector:custom.probe/probe", arguments: {} }), /not connected/);
const file = ${JSON.stringify(path.join(root, "opencode.json"))};
const server = { type: "remote", url: "http://127.0.0.1:" + fixture.address().port + "/mcp" };
fs.writeFileSync(file, JSON.stringify({ mcp: { probe: server } }));
const bridge = createMcpBridge({ file, serverUrl: "http://127.0.0.1:4321", env: {
  GATEWAY_URL: "http://127.0.0.1:8002", HILO_WORKSPACE_CLAIM: "fixture",
  HILO_WORKSPACE_INSTANCE_ID: "fixture", HILO_WORKSPACE_GENERATION: "1",
}, request: async (url, options) => {
  if (url.pathname.endsWith("proxy-status")) return Response.json(await capabilities.proxyStatus());
  const body = JSON.parse(options.body);
  return Response.json({ status: await proxy.apply(body.name, body.config) });
}});
await bridge.sync();
assert.equal((await capabilities.catalog()).connectors.find(item => item.connectorId === "custom.probe").state, "connected");
assert.equal((await capabilities.connectorTools("fixture-session")).tools[0].capabilityId, "connector:custom.probe/probe");
const result = await capabilities.callConnectorTool("fixture-session", { capabilityId: "connector:custom.probe/probe", arguments: {} });
assert.equal(result.isError, false);
assert.equal(result.content[0].text, "design-v3-mcp-ok");
assert.equal(calls, 1);
console.log("PASS: installed Design V3 discovers and calls a Library tool through its native connector capability layer");
fs.writeFileSync(file, JSON.stringify({ mcp: { probe: { ...server, enabled: false } } }));
await bridge.sync();
assert.equal((await capabilities.connectorTools("fixture-session")).tools.length, 0);
await assert.rejects(capabilities.callConnectorTool("fixture-session", { capabilityId: "connector:custom.probe/probe", arguments: {} }), /not connected/);
console.log("PASS: disabled Library MCP is no longer callable");
fs.writeFileSync(file, JSON.stringify({ mcp: { probe: server } }));
await bridge.sync();
fs.writeFileSync(file, JSON.stringify({ mcp: {} }));
await bridge.sync();
assert.equal((await capabilities.connectorTools("fixture-session")).tools.length, 0);
const control = ${JSON.stringify(path.join(root, "hub-config.json"))};
const staging = ${JSON.stringify(path.join(root, "library-mcp.json"))};
fs.writeFileSync(control, JSON.stringify({customMcpVault:""}));
fs.writeFileSync(${JSON.stringify(path.join(root, ".token-key"))}, Buffer.alloc(32, 9));
fs.writeFileSync(staging, JSON.stringify({mcp:{saved:server}}));
syncMcpStore({control}, {isRunning:false});
const saved = readMcpVault(control).servers.saved;
const projected = savedNative.toConnectorProxyConfig(saved);
assert.equal(projected.timeout, 60000);
await capabilities.proxySync({servers:{saved:projected}});
assert.equal((await capabilities.proxyStatus()).servers.saved.status, "connected");
delayNextList = slowListMs > 0;
assert.ok((await capabilities.connectorTools("fixture-session")).tools.some(tool => tool.capabilityId === "connector:custom.saved/probe"));
const savedResult = await capabilities.callConnectorTool("fixture-session", {capabilityId:"connector:custom.saved/probe",arguments:{}});
assert.equal(savedResult.content[0].text, "design-v3-mcp-ok");
const disabled = savedNative.toConnectorProxyConfig({...saved,enabled:false});
await capabilities.proxySync({servers:{saved:disabled}});
assert.equal((await capabilities.connectorTools("fixture-session")).tools.length,0);
await assert.rejects(capabilities.callConnectorTool("fixture-session", {capabilityId:"connector:custom.saved/probe",arguments:{}}), /not connected/);
await capabilities.proxySync({servers:{}});
assert.deepEqual((await capabilities.proxyStatus()).servers,{});
console.log("PASS: encrypted saved MCP → installed native projection → V3 proxy → tool discovery/call/disable/withdrawal" + (slowListMs ? " with slow tools/list " + slowListMs + "ms" : ""));
if (process.env.MINIMAX_MCP_LIVE_URL) {
  const live = {name:"live",enabled:true,config:{transport:"http",url:process.env.MINIMAX_MCP_LIVE_URL,timeoutMs:60000}};
  await capabilities.proxySync({servers:{live:savedNative.toConnectorProxyConfig(live)}});
  const tools = (await capabilities.connectorTools("fixture-session")).tools;
  assert.ok(tools.some(tool=>tool.capabilityId==="connector:custom.live/call_tool"));
  console.log("PASS: actual Magpie router tools are discovered through installed Design V3 proxy");
  const result = await capabilities.callConnectorTool("fixture-session", {
    capabilityId:"connector:custom.live/call_tool",
    arguments:{name:"davinci-resolve__get_resolve_status",arguments:{}},
  });
  assert.equal(result.isError,false,JSON.stringify(result.content).slice(0,300));
  const text = result.content.filter(item=>item.type==="text").map(item=>item.text).join("\\n");
  const status = JSON.parse(text);
  assert.equal(status.running,true);
  assert.equal(typeof status.version,"string");
  console.log("PASS: actual Magpie → DaVinci Resolve read-only status through installed Design V3 proxy");
}
await proxy.onModuleDestroy();
fixture.close();
console.log("PASS: withdrawing a Library MCP removes its native callable grant");
process.exit(0);
}
`
const program = path.join(root, "native-runtime.mjs")
fs.symlinkSync(path.join(app, "Contents/Resources/gateway/node_modules"), path.join(root, "node_modules"), "dir")
fs.writeFileSync(program, source.slice(0, bootstrap) + driver)
const result = await promisify(execFile)(path.join(app, "Contents/MacOS/MiniMax Design"), [program], {
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production", HILO_RELEASE_REGION: "domestic", HILO_RELEASE_CHANNEL: "prod", HILO_AGENT_PROFILE_VERSION: "3" },
  timeout: process.env.MINIMAX_MCP_LIVE_URL ? 180000 : 90000, maxBuffer: 2 << 20,
})
console.log(result.stdout)
console.log(`Native MCP validation passed. Sandbox: ${root}`)

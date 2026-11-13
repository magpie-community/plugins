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
const driver = `
{
const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const { createServer } = await import("node:http");
const { createMcpBridge } = await import(${JSON.stringify(new URL("./mcp-sync.mjs", import.meta.url).href)});
let calls = 0;
const fixture = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (body.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (body.method === "tools/list") result = { tools: [{ name: "probe", description: "read-only native fixture", inputSchema: { type: "object", properties: {} } }] };
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
  timeout: 60000, maxBuffer: 2 << 20,
})
console.log(result.stdout)
console.log(`Native MCP validation passed. Sandbox: ${root}`)

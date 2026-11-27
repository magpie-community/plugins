// The plugin as magpie's host loads it, with no OpenCode package anywhere:
// what it exports, that every tool has args, and that a tool only reads.
// Nothing is downloaded and no frpc runs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// the plugin's own folder is writable here; its state goes to a temp one
const base = fs.mkdtempSync(path.join(os.tmpdir(), "frp-connect-tools-"));
process.env.MAGPIE_FRP_DIR = base;

const plugin = (await import("../index.mjs")).default;
// the control API the plugin starts listens until the process ends, as in
// magpie's host: the last test here closes it
const hooks = await plugin.server({ directory: os.tmpdir() }, {
  frpcBinary: "local",
  frpcPath: "/nonexistent/frpc",
  serverAddr: "frp.example.com",
  serverPort: 7000,
  authToken: "s3cret",
  proxies: [{ name: "magpie", type: "tcp", localIP: "127.0.0.1", localPort: 3425, remotePort: 6000 }],
});

test("the plugin is an OpenCode plugin of no package of its own", () => {
  assert.equal(plugin.id, "frp-connect");
  assert.equal(typeof plugin.server, "function");
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../index.mjs"), "utf8");
  assert.ok(!/from "@opencode-ai|from 'opencode|@opencode-ai\/plugin/.test(src), "no OpenCode import");
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "no dependency to install");
  assert.equal(pkg.main, "./index.mjs");
});

test("every tool has a JSON Schema for its args", () => {
  const tools = hooks.tool;
  assert.ok(Object.keys(tools).length > 0);
  for (const [name, def] of Object.entries(tools)) {
    assert.equal(typeof def.execute, "function", `${name} runs`);
    assert.ok(def.args && typeof def.args === "object" && !Array.isArray(def.args), `${name} has args`);
    assert.equal(def.args.type, "object", `${name}'s args are an object`);
    assert.match(def.description, /\S/);
  }
});

test("the tools are read-only", () => {
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["generate", "logs", "state", "verify"]);
});

test("state reads out, with no frpc running", async () => {
  const s = await hooks.tool.state.execute({});
  assert.equal(s.on, true);
  assert.equal(s.running, false);
  assert.equal(s.pinnedVersion, "0.71.1");
  // the token is never handed to an agent
  assert.equal(s.options.authToken, "(set)");
  assert.ok(!JSON.stringify(s).includes("s3cret"));
});

test("generate is the file frpc would run", async () => {
  const g = await hooks.tool.generate.execute({});
  assert.equal(g.ok, true);
  assert.match(g.toml, /^loginFailExit = false$/m);
  assert.match(g.toml, /^serverAddr = "frp\.example\.com"$/m);
  assert.match(g.toml, /^remotePort = 6000$/m);
  // and it wrote nothing and started nothing
  assert.equal(fs.existsSync(path.join(base, "frpc.toml")), false);
});

test("verify says what it knows without downloading or running frpc", async () => {
  const v = await hooks.tool.verify.execute({});
  assert.equal(v.ok, true);
  assert.equal(v.pinnedVersion, "0.71.1");
  assert.equal(v.frpc.source, "local");
  assert.match(v.note, /frpc verify/);
  const missing = await hooks.tool.verify.execute({ frpcBinary: "local", configMode: "form" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /isn't configured/);
});

test("logs reads the log's end", async () => {
  const l = await hooks.tool.logs.execute({});
  assert.ok(l.logPath.startsWith(base));
  assert.equal(l.log, "");
});

test("an event never starts a tunnel", async () => {
  // the only thing an event does is start with the user's Auto-start, and
  // this one has none
  await hooks.event({ event: { type: "started" } });
  const s = await hooks.tool.state.execute({});
  assert.equal(s.running, false);
});

test("the page's control API is on this computer, at the port the package names", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  const port = pkg.magpie.page.service.port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: "null" } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /FRP Connect/);
  // and it asks for its key: the page's scripts alone can't start a tunnel
  const denied = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(denied.status, 403);
  stop();
});

// stop ends this test process, and the part with it: in magpie the host's
// own end is what ends it, and there is no hook to ask for one here
function stop() {
  setImmediate(() => process.exit(0));
}

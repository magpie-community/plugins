// The frpc.toml the options make, read back, and the page's own copy of
// the same lines: the preview is the file that runs, both ways.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { options } from "../lib/options.mjs";
import { check } from "../lib/config.mjs";
import { parse, toml } from "../lib/toml.mjs";

const SAMPLE = {
  serverAddr: "frp.example.com",
  serverPort: 7000,
  authMethod: "token",
  authToken: "s3cret",
  transport: "kcp",
  proxies: [
    { name: "magpie", type: "http", localIP: "127.0.0.1", localPort: 3425, customDomains: "office.example.com, home.example.com" },
    { name: "ssh", type: "tcp", localIP: "127.0.0.1", localPort: 22, remotePort: 6000 },
  ],
};

test("the form's frpc.toml is what frpc runs", () => {
  const cfg = options(SAMPLE);
  const built = toml(cfg);
  // the server adds loginFailExit so a server that isn't up yet is retried
  assert.match(built, /^loginFailExit = false$/m);
  assert.match(built, /^serverAddr = "frp.example.com"$/m);
  assert.match(built, /^auth\.token = "s3cret"$/m);
  assert.match(built, /^transport\.protocol = "kcp"$/m);
  assert.equal((built.match(/^\[\[proxies\]\]$/gm) || []).length, 2);
  assert.match(built, /^customDomains = \["office\.example\.com", "home\.example\.com"\]$/m);
  assert.match(built, /^remotePort = 6000$/m);
});

test("a pasted frpc.toml is used as it is", () => {
  const pasted = '# mine\nserverAddr = "a.example"\nserverPort = 7001\n[[proxies]]\nname = "x"\ntype = "tcp"\nlocalPort = 80\n';
  const v = check(options({ configMode: "toml", frpcToml: pasted }));
  assert.equal(v.ok, true);
  assert.equal(v.toml, pasted);
});

test("an empty frpc.toml, or a form with nothing to run, is refused", () => {
  assert.equal(check(options({ configMode: "toml", frpcToml: "  " })).ok, false);
  const empty = check(options({}));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /isn't configured/);
  const noProxy = check(options({ serverAddr: "h" }));
  assert.equal(noProxy.ok, false);
  assert.match(noProxy.error, /proxy/);
  assert.equal(check(options({ serverAddr: "h", serverPort: 70000 })).ok, false);
});

test("the two modes hand each other the same settings", () => {
  const cfg = options(SAMPLE);
  const back = parse(toml(cfg));
  assert.equal(back.serverAddr, "frp.example.com");
  assert.equal(Number(back.serverPort), 7000);
  assert.equal(back.authToken, "s3cret");
  assert.equal(back.transport, "kcp");
  assert.equal(back.proxies.length, 2);
  assert.equal(back.proxies[1].remotePort, 6000);
  assert.equal(toml(options({ ...SAMPLE, ...back })), toml(cfg));
});

test("the page's own copy of the builder makes the same file", async () => {
  // app.js is the page's: a browser script, so it is read and run here
  // with just enough of a document for its top-level code
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../page/app.js"), "utf8");
  const start = src.indexOf("const q = (v) =>");
  const end = src.indexOf("function unquote(v)");
  assert.ok(start > 0 && end > start, "the page still builds the frpc.toml");
  const body = src.slice(start, end);
  const f = new Function(`${body}\nreturn buildToml;`)();
  assert.equal(f(SAMPLE), toml(options(SAMPLE)));
});

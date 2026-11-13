// No network, no real generation: hook shape, config/model discovery,
// auth validation and fetch interception are checked with a fake Python
// bridge child. The child sees cookies only on stdin, never in argv.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GflowPlugin } from "./index.mjs";
import { extractJson } from "./gflow.mjs";

const COOKIES = "SID=synthetic; HSID=synthetic; SAPISID=synthetic";
const testDir = await mkdtempSync(join(tmpdir(), "gflow-plugin-test-"));
const fakeBridge = join(testDir, "fake_bridge.py");
const fakePython = join(testDir, "fake-python");
writeFileSync(fakeBridge, `import json, sys, base64, os, time
req = json.load(sys.stdin)
command = req["command"]
log = os.environ.get("GFLOW_REQUEST_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "command": command,
            "account": req.get("account"),
            "state_dir": req.get("state_dir"),
            "home": req.get("home"),
            "model": req.get("model"),
            "cookie_header": bool((req.get("headers") or {}).get("x-gflow-cookies")),
            "prompt": req.get("prompt"),
            "aspect_ratio": req.get("aspect_ratio"),
            "seed": req.get("seed"),
            "media_id": req.get("media_id"),
            "timeout": req.get("timeout"),
        }, sort_keys=True) + "\\n")
if command == "usage" and os.environ.get("GFLOW_USAGE_DELAY"):
    time.sleep(float(os.environ["GFLOW_USAGE_DELAY"]))
if command == "usage" and os.environ.get("GFLOW_USAGE_FAIL"):
    print(json.dumps({"error": "Flow account shell did not include an authenticated session token"}))
    raise SystemExit(1)
if command in ("validate", "usage", "image", "video", "extend_video"):
    assert req["headers"]["x-gflow-cookies"] == ${JSON.stringify(COOKIES)}
if command == "validate":
    print(json.dumps({"authenticated": True, "email": "a@example.test", "name": "Account A", "credits": 42}))
elif command == "identity":
    print(json.dumps({"authenticated": True, "email": "a@example.test", "name": "Account A"}))
elif command == "usage":
    print(json.dumps({"authenticated": True, "email": "a@example.test", "credits": 42}))
elif command == "image":
    assert req["prompt"] == "a fox" and req["n"] == 2
    print(json.dumps({"data": [{"b64_json": "ZmFrZS1wbmc="}], "created": 123}))
elif command in ("video", "extend_video"):
    print(json.dumps({
        "saved_files": ["/tmp/gflow-extend.mp4"] if req.get("wait") is not False else [],
        "operations": ["media-1"], "media_ids": ["media-1"],
        "new_media_ids": ["media-1"], "videos": [{"id": "media-1"}],
        "waited": req.get("wait") is not False, "workflow_id": "workflow-1",
    }))
elif command == "browser_login_start":
    print(json.dumps({"url": "https://flow.google.com/", "cdp_port": 9222, "opened": True}))
elif command == "browser_login_wait":
    print(json.dumps({"authenticated": True, "cookies": ${JSON.stringify(COOKIES)}, "email": "a@example.test", "name": "Account A"}))
else:
    raise SystemExit(2)
`);
writeFileSync(fakePython, `#!/bin/sh
# Emulate Python for both the capability probe and the -I -c bridge bootstrap.
if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then
  case "$3" in
    *runpy.run_module*) exec python3 -I ${JSON.stringify(fakeBridge)} ;;
    *) printf '%s\\n' '{"ok":true,"version":"3.12.12","python":"fake-python","cwd":"test"}' ; exit 0 ;;
  esac
fi
exec python3 -I ${JSON.stringify(fakeBridge)} "$@"
`);
chmodSync(fakePython, 0o700);

function inputFor(python = fakePython, stateDir = join(tmpdir(), "gflow-plugin-state"), magpie = {}, bridgeEnv = {}, client = {}) {
  return { options: { python, stateDir, bridgeEnv }, magpie, client };
}

function requestLog() {
  return join(testDir, `requests-${process.pid}-${testCounter++}.jsonl`);
}
let testCounter = 0;

test("exports one plugin function with all four hooks", async () => {
  const mod = await import("./index.mjs");
  assert.deepEqual(Object.keys(mod), ["GflowPlugin"]);
  const hooks = await GflowPlugin(inputFor());
  assert.deepEqual(Object.keys(hooks).sort(), ["auth", "config", "provider", "tool"]);
  assert.equal(hooks.auth.provider, "gflow");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(hooks.provider.id, "gflow");
});

test("auth.usage maps Flow credits into magpie's Usage page fields", async () => {
  const hooks = await GflowPlugin(inputFor());
  const usage = await hooks.auth.usage(async () => ({
    type: "api", key: COOKIES, metadata: { email: "a@example.test" },
  }), { id: "gflow" });
  assert.equal(usage.user, "a@example.test");
  assert.equal(usage.balance, "42 credits");
  assert.equal(usage.windows[0].balance, 42);
  assert.equal(usage.windows[0].used, undefined);
  assert.equal(usage.windows[0].unit, "credits");
});

test("auth.usage repairs an old account's empty metadata.email", async () => {
  const saved = [];
  const client = { auth: { set: async (opts) => { saved.push(opts); return { data: true }; } } };
  const hooks = await GflowPlugin(inputFor(undefined, undefined, {}, {}, client));
  const usage = await hooks.auth.usage(async () => ({
    type: "api", key: COOKIES, metadata: { email: "", gflowAccount: "gflow" },
  }), { id: "gflow" });
  assert.equal(usage.user, "a@example.test");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path.id, "gflow");
  assert.equal(saved[0].body.metadata.email, "a@example.test");
  assert.equal(saved[0].body.metadata.gflowAccount, "gflow");
  assert.equal(saved[0].body.key, COOKIES);
});

test("auth.usage keeps the account user when the bridge quota read fails", async () => {
  const hooks = await GflowPlugin(inputFor(undefined, undefined, {}, {
    GFLOW_USAGE_FAIL: "1",
  }, {
    auth: { set: async () => ({ data: true }) },
  }));
  const usage = await hooks.auth.usage(async () => ({
    type: "api", key: COOKIES, metadata: { email: "" },
  }), { id: "gflow" });
  assert.equal(usage.user, "a@example.test");
  assert.match(usage.error, /gflow bridge exited 1/);
});

test("auth.usage shares one deadline and keeps the stored account on timeout", async () => {
  const log = join(testDir, "usage-timeout.jsonl");
  const input = inputFor(fakePython, join(testDir, "usage-state"), {}, {
    GFLOW_REQUEST_LOG: log, GFLOW_USAGE_DELAY: "2",
  });
  input.options.usageTimeoutMs = 500;
  const hooks = await GflowPlugin(input);
  const result = await hooks.auth.usage(async () => ({
    type: "api", key: COOKIES, metadata: { email: "saved@example.test" },
  }), { id: "gflow" });
  assert.equal(result.user, "saved@example.test");
  assert.match(result.error, /timed out/);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).command), ["usage"]);
});

test("auth.usage includes Python probing in its deadline", async () => {
  const slow = join(testDir, "slow-probe-python");
  writeFileSync(slow, `#!/usr/bin/env python3
import json, os, sys, time
if "runpy.run_module" not in sys.argv[-1]:
    time.sleep(2)
    print(json.dumps({"ok": True}))
else:
    os.execvp("python3", ["python3", "-I", ${JSON.stringify(fakeBridge)}])
`);
  chmodSync(slow, 0o700);
  const input = inputFor(slow);
  input.options.usageTimeoutMs = 500;
  const hooks = await GflowPlugin(input);
  const result = await hooks.auth.usage(async () => ({
    type: "api", key: COOKIES, metadata: { email: "saved@example.test" },
  }), { id: "gflow" });
  assert.equal(result.user, "saved@example.test");
  assert.match(result.error, /timed out/);
});

test("auth.usage reports a clean error when no account is signed in", async () => {
  const hooks = await GflowPlugin(inputFor());
  const usage = await hooks.auth.usage(async () => null, { id: "gflow" });
  assert.match(usage.error, /No Google Flow account/);
});

test("config and provider.models declare three native image-only OpenAI-compatible models", async () => {
  const hooks = await GflowPlugin(inputFor());
  const config = await hooks.config({});
  const p = config.provider.gflow;
  assert.equal(p.npm, "@ai-sdk/openai-compatible");
  assert.equal(p.api, "plugin://gflow/v1");
  assert.deepEqual(Object.keys(p.models).sort(),
    ["nano-banana-2-lite", "nano-banana-2.1", "nano-banana-pro"]);
  const models = hooks.provider.models;
  assert.equal(typeof models, "function");
  const listed = await models({ models: {} });
  assert.deepEqual(Object.keys(listed).sort(),
    ["nano-banana-2-lite", "nano-banana-2.1", "nano-banana-pro"]);
  for (const [id, m] of Object.entries(listed)) {
    assert.equal(m.id, id, `${id}: id matches key`);
    assert.equal(m.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(m.api.url, "plugin://gflow/v1");
    assert.equal(m.api.id, id);
    assert.equal(m.capabilities.output.image, true);
    assert.equal(m.capabilities.output.text, false);
    assert.equal(m.capabilities.input.text, true);
    assert.equal(m.capabilities.input.image, false);
    assert.deepEqual(m.modalities.output, ["image"]);
  }
});

test("config does not overwrite an existing user provider", async () => {
  const hooks = await GflowPlugin(inputFor());
  const config = { provider: { gflow: { name: "My Flow", models: {} } } };
  await hooks.config(config);
  assert.equal(config.provider.gflow.name, "My Flow");
  assert.deepEqual(config.provider.gflow.models, {});
});

test("authorize validates cookies and returns magpie account metadata", async () => {
  const hooks = await GflowPlugin(inputFor());
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  assert.equal(method.keyless, true);
  assert.equal(method.prompts[0].type, "password");
  const ok = await method.authorize({ cookies: COOKIES });
  assert.deepEqual(ok, {
    type: "success",
    key: COOKIES,
    metadata: {
      email: "a@example.test",
      name: "Account A",
      gflowAccount: "gflow",
      cookies: "",
    },
  });
  const bad = await method.authorize({ cookies: "no-equals" });
  assert.equal(bad.type, "failed");
  // Older hosts may inject the API key into inputs.key.
  const viaKeyField = await method.authorize({ key: COOKIES });
  assert.equal(viaKeyField.type, "success");
  assert.equal(viaKeyField.key, COOKIES);
});

test("login button opens Flow once and captures cookies through its callback", async () => {
  const hooks = await GflowPlugin(inputFor());
  assert.equal(hooks.auth.methods.length, 2);
  const button = hooks.auth.methods[1];
  assert.equal(button.type, "oauth");
  assert.match(button.label, /Google Flow/);
  const started = await button.authorize(undefined, {});
  assert.equal(started.url, "");
  assert.equal(started.method, "auto");
  assert.equal(started.opened, true);
  assert.match(started.instructions, /Chrome/);
  assert.equal(typeof started.callback, "function");
  const saved = await started.callback(undefined, {});
  assert.deepEqual(saved, {
    type: "success",
    key: COOKIES,
    metadata: {
      email: "a@example.test",
      name: "Account A",
      gflowAccount: "gflow",
    },
  });
});

test("explicit Python is rejected when it cannot import the gflow bridge", async () => {
  const badPython = join(testDir, "bad-python");
  const log = join(testDir, "bad-python.log");
  writeFileSync(badPython, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(log)}
if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then
  printf '%s\\n' '{"ok":false,"version":"3.9.0","python":"bad-python","cwd":"test","reason":"TypeError: unsupported operand"}'
  exit 0
fi
exit 1
`);
  chmodSync(badPython, 0o700);
  const hooks = await GflowPlugin(inputFor(badPython));
  const result = await hooks.auth.methods[0].authorize({ cookies: COOKIES });
  assert.equal(result.type, "failed");
  assert.match(result.error, /Configured Python cannot import gflow\/requests\/pydantic\/websocket/);
});

test("Python bridge uses a sys.path bootstrap instead of -m", async () => {
  const spyPython = join(testDir, "spy-python");
  const log = join(testDir, "spy-python.log");
  writeFileSync(spyPython, `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then
  case "$3" in
    *runpy.run_module*) exec python3 -I ${JSON.stringify(fakeBridge)} ;;
    *) printf '%s\\n' '{"ok":true,"version":"3.12.12","python":"fake-python","cwd":"test"}' ; exit 0 ;;
  esac
fi
exec python3 -I ${JSON.stringify(fakeBridge)} "$@"
`);
  chmodSync(spyPython, 0o700);
  const hooks = await GflowPlugin(inputFor(spyPython));
  const ok = await hooks.auth.methods[0].authorize({ cookies: COOKIES });
  assert.equal(ok.type, "success");
  const argv = readFileSync(log, "utf8");
  assert.match(argv, /^-I\n-c\n/);
  assert.match(argv, /sys\.path\.insert\(0/);
  assert.match(argv, /runpy\.run_module\('gflow\.magpie_bridge'/);
  assert.doesNotMatch(argv, /^-I\n-m\ngflow\.magpie_bridge$/m);
  assert.doesNotMatch(argv, /gflow\.magpie_bridge\n$/);
  assert.doesNotMatch(argv, new RegExp(COOKIES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("login methods use only host-projected fields and clear labels", async () => {
  const hooks = await GflowPlugin(inputFor());
  assert.equal(hooks.auth.single, undefined);
  assert.equal(hooks.auth.methods.length, 2);
  for (const key of ["default", "priority", "icon", "description", "instructions"]) {
    for (const method of hooks.auth.methods) assert.equal(method[key], undefined);
  }
  const [manual, browser] = hooks.auth.methods;
  assert.match(manual.label, /手动/);
  assert.match(manual.labels.zh, /手动/);
  assert.equal(manual.prompts[0].type, "password");
  assert.match(browser.label, /推荐/);
  assert.match(browser.labels.en, /recommended/);
  assert.notEqual(manual.label, browser.label);
});

test("manual and browser sign-in use the host account key for CDP state", async () => {
  const log = requestLog();
  const fakeAccount = "gflow#acct-fake";
  const input = inputFor(fakePython, join(testDir, "state"),
    { account: () => fakeAccount }, { GFLOW_REQUEST_LOG: log });
  const hooks = await GflowPlugin(input);
  const manual = await hooks.auth.methods[0].authorize({ cookies: COOKIES });
  assert.equal(manual.metadata.gflowAccount, fakeAccount);
  const started = await hooks.auth.methods[1].authorize(undefined, {});
  const saved = await started.callback(undefined, {});
  assert.equal(saved.metadata.gflowAccount, fakeAccount);
  assert.equal(saved.accountId, undefined);
  const loader = await hooks.auth.loader(async () => ({
    type: "api", key: COOKIES, metadata: saved.metadata,
  }));
  const response = await loader.fetch("https://gflow.invalid/v1/images/generations", {
    body: JSON.stringify({ model: "gflow/nano-banana-pro", prompt: "a fox", n: 2 }),
  });
  assert.equal(response.status, 200);
  const rows = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.command), ["validate", "browser_login_start", "browser_login_wait", "image"]);
  assert.equal(rows[3].model, "nano-banana-pro");
  assert.ok(rows.every((r) => r.account === fakeAccount));
  assert.ok(rows.every((r) => r.state_dir === join(testDir, "state")));
  assert.ok(rows.every((r) => r.cookie_header === (r.command !== "browser_login_start" && r.command !== "browser_login_wait")));
});

test("images/generations body cannot override bridge control fields", async () => {
  const log = requestLog();
  const hooks = await GflowPlugin(inputFor(fakePython, join(testDir, "state"), {}, { GFLOW_REQUEST_LOG: log }));
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: COOKIES }));
  const body = {
    model: "nano-banana-2.1", prompt: "a fox", n: 1,
    home: "/tmp/shared", account: "evil", state_dir: "/tmp/evil",
    headers: { "x-gflow-cookies": "SID=attacker" },
    cookies: "SID=attacker", command: "browser_login_start",
  };
  const response = await loaded.fetch("https://gflow.invalid/v1/images/generations", {
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /reserved fields/);
  const exists = (() => { try { return readFileSync(log, "utf8"); } catch { return ""; } })();
  assert.equal(exists, "");
});

test("loader intercepts /images/generations with mocked Python bridge", async () => {
  const hooks = await GflowPlugin(inputFor());
  const auth = { type: "api", key: COOKIES, accountId: "gflow#acct1" };
  const loaded = await hooks.auth.loader(async () => auth);
  assert.equal(loaded.apiKey, "gflow");
  assert.equal(loaded.headers["x-gflow-cookies"], COOKIES);
  const req = {
    url: "https://gflow.invalid/v1/images/generations",
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  const init = { method: "POST", body: JSON.stringify({ model: "nano-banana-2-lite", prompt: "a fox", n: 2 }) };
  const res = await loaded.fetch(req, init);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 123);
  assert.equal(body.data[0].b64_json, "ZmFrZS1wbmc=");
  const unsupported = await loaded.fetch("https://gflow.invalid/v1/chat/completions", init);
  assert.equal(unsupported.status, 404);
});

test("loader rejects unknown model and forwards each registered model id", async () => {
  const hooks = await GflowPlugin(inputFor(fakePython, join(testDir, "state"), {}, {}));
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: COOKIES }));
  const bad = await loaded.fetch("https://gflow.invalid/v1/images/generations", {
    body: JSON.stringify({ model: "imagen-4", prompt: "a fox", n: 2 }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /unknown gflow image model/);

  for (const id of ["nano-banana-pro", "nano-banana-2.1", "nano-banana-2-lite"]) {
    const log = requestLog();
    const scoped = await GflowPlugin(inputFor(fakePython, join(testDir, "state"), {},
      { GFLOW_REQUEST_LOG: log }));
    const scopedLoader = await scoped.auth.loader(async () => ({ type: "api", key: COOKIES }));
    const res = await scopedLoader.fetch("https://gflow.invalid/v1/images/generations", {
      body: JSON.stringify({ model: `gflow/${id}`, prompt: "a fox", n: 2 }),
    });
    assert.equal(res.status, 200, `${id}: bridge accepts request`);
    const imageRow = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      .map(JSON.parse).find((r) => r.command === "image");
    assert.equal(imageRow.model, id);
  }
});

test("loader rejects missing account and malformed body", async () => {
  const hooks = await GflowPlugin(inputFor());
  await assert.rejects(() => hooks.auth.loader(async () => ({ type: "api", key: "" })), /No Google Flow account/);
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: COOKIES }));
  const res = await loaded.fetch("https://gflow.invalid/v1/images/generations", { body: "not json" });
  assert.equal(res.status, 400);
});

test("video tools remain MCP tools; legacy image tool is absent", async () => {
  const hooks = await GflowPlugin(inputFor());
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["gflow_auth_status", "gflow_extend_video", "gflow_generate_video"]);
  assert.deepEqual(hooks.tool.gflow_generate_video.args.required, ["prompt"]);
  assert.deepEqual(hooks.tool.gflow_extend_video.args.required.sort(), ["media_id", "prompt"]);
  await assert.rejects(
    () => hooks.tool.gflow_generate_video.execute({ prompt: "x", aspect_ratio: "wide" }),
    /Unsupported argument value: aspect_ratio/,
  );
});

test("auth_status never prints cookies and reads magpie account count", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "gflow-magpie-auth-"));
  const authFile = join(dir, "plugin-auth.json");
  writeFileSync(authFile, JSON.stringify({ gflow: { key: COOKIES }, "gflow#two": { key: COOKIES }, other: {} }));
  process.env.GFLOW_MAGPIE_AUTH_PATH = authFile;
  process.env.GFLOW_BIN = "/nonexistent/gflow-for-test";
  try {
    const hooks = await GflowPlugin(inputFor());
    const status = await hooks.tool.gflow_auth_status.execute({});
    assert.equal(status.magpie_accounts, 2);
    assert.deepEqual(status.native_models, [
      "gflow/nano-banana-pro", "gflow/nano-banana-2.1", "gflow/nano-banana-2-lite",
    ]);
    assert.equal(status.native_model, undefined);
    assert.equal(JSON.stringify(status).includes(COOKIES), false);
  } finally {
    delete process.env.GFLOW_MAGPIE_AUTH_PATH;
    delete process.env.GFLOW_BIN;
  }
});

test("extractJson still parses CLI output", async () => {
  const out = "[green]Saved:[/green] gflow-image-0.png\n{\"images\": [], \"saved_files\": [\"gflow-image-0.png\"]}";
  assert.deepEqual(extractJson(out, "generate-image"), { images: [], saved_files: ["gflow-image-0.png"] });
});

test("package.json advertises provider discovery and includes all runtime files", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "./opencode.mjs");
  assert.deepEqual(pkg.exports, { ".": "./opencode2.mjs" });
  assert.equal(pkg.magpie.name, "Google Flow");
  assert.equal(typeof pkg.magpie.summary.zh, "string");
  assert.ok(pkg.keywords.includes("magpie"));
  for (const f of ["index.mjs", "gflow.mjs", "opencode.mjs", "opencode2.mjs", "README.md", "LICENSE"])
    assert.ok(pkg.files.includes(f), `${f} is not in files`);
});

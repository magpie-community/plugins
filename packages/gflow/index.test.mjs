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
            "size": req.get("size"),
            "seconds": req.get("seconds"),
            "seed": req.get("seed"),
            "media_id": req.get("media_id"),
            "video_id": req.get("video_id"),
            "timeout": req.get("timeout"),
        }, sort_keys=True) + "\\n")
if command == "usage" and os.environ.get("GFLOW_USAGE_DELAY"):
    time.sleep(float(os.environ["GFLOW_USAGE_DELAY"]))
if command == "usage" and os.environ.get("GFLOW_USAGE_FAIL"):
    print(json.dumps({"error": "Flow account shell did not include an authenticated session token"}))
    raise SystemExit(1)
if command in ("validate", "usage", "image", "video", "extend_video", "video_start", "video_status", "video_content"):
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
elif command == "video_start":
    print(json.dumps({
        "id": "media-vid-1",
        "object": "video",
        "created_at": 1700000000,
        "status": "in_progress",
        "progress": 0,
        "model": req.get("model") or "veo-3.1",
        "prompt": req.get("prompt") or "",
    }))
elif command == "video_status":
    vid = req.get("video_id")
    if vid == "missing-id":
        print(json.dumps({"error": {"message": "video 'missing-id' not found", "type": "bridge_error", "status": 404}}))
        raise SystemExit(1)
    st = os.environ.get("GFLOW_VIDEO_STATUS", "completed")
    body = {
        "id": vid,
        "object": "video",
        "created_at": 1700000000,
        "status": st,
        "progress": 100 if st == "completed" else 25,
        "model": "veo-3.1",
    }
    if st == "failed":
        body["progress"] = 0
        body["error"] = {"code": "video_generation_failed", "message": "safety filter"}
    print(json.dumps(body))
elif command == "video_content":
    vid = req.get("video_id")
    out_dir = req.get("state_dir") or ${JSON.stringify(testDir)}
    os.makedirs(out_dir, exist_ok=True)
    mp4 = os.path.join(out_dir, f"{vid}.mp4")
    payload = b"\\x00\\x00\\x00\\x18ftypmp42fake-veo-bytes"
    with open(mp4, "wb") as f:
        f.write(payload)
    print(json.dumps({"id": vid, "path": mp4, "content_type": "video/mp4", "bytes": len(payload)}))
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

test("config and provider.models declare native image and video OpenAI-compatible models", async () => {
  const hooks = await GflowPlugin(inputFor());
  const config = await hooks.config({});
  const p = config.provider.gflow;
  assert.equal(p.npm, "@ai-sdk/openai-compatible");
  assert.equal(p.api, "plugin://gflow/v1");
  assert.deepEqual(Object.keys(p.models).sort(), [
    "nano-banana-2-lite", "nano-banana-2.1", "nano-banana-pro",
    "veo-3.1", "veo-3.1-lite", "veo-3.1-quality",
  ]);
  assert.deepEqual(p.models["veo-3.1"].modalities, { input: ["text"], output: ["video"] });
  assert.deepEqual(p.models["veo-3.1-quality"].modalities, { input: ["text"], output: ["video"] });
  assert.deepEqual(p.models["veo-3.1-lite"].modalities, { input: ["text"], output: ["video"] });
  const models = hooks.provider.models;
  assert.equal(typeof models, "function");
  const listed = await models({ models: {} });
  assert.deepEqual(Object.keys(listed).sort(), [
    "nano-banana-2-lite", "nano-banana-2.1", "nano-banana-pro",
    "veo-3.1", "veo-3.1-lite", "veo-3.1-quality",
  ]);
  for (const [id, m] of Object.entries(listed)) {
    assert.equal(m.id, id, `${id}: id matches key`);
    assert.equal(m.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(m.api.url, "plugin://gflow/v1");
    assert.equal(m.api.id, id);
    assert.equal(m.capabilities.output.text, false);
    assert.equal(m.capabilities.input.text, true);
    assert.equal(m.capabilities.input.image, false);
    if (id.startsWith("veo-")) {
      assert.equal(m.capabilities.output.video, true);
      assert.equal(m.capabilities.output.image, false);
      assert.deepEqual(m.modalities.output, ["video"]);
    } else {
      assert.equal(m.capabilities.output.image, true);
      assert.equal(m.capabilities.output.video, false);
      assert.deepEqual(m.modalities.output, ["image"]);
    }
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
      "gflow/veo-3.1", "gflow/veo-3.1-quality", "gflow/veo-3.1-lite",
    ]);
    assert.equal(status.native_model, undefined);
    assert.equal(JSON.stringify(status).includes(COOKIES), false);
  } finally {
    delete process.env.GFLOW_MAGPIE_AUTH_PATH;
    delete process.env.GFLOW_BIN;
  }
});

test("loader handles async /videos create, /videos/:id poll, and /videos/:id/content binary stream", async () => {
  const log = requestLog();
  const fakeAccount = "gflow#video-acct";
  const stateDir = join(testDir, "video-state");
  const hooks = await GflowPlugin(inputFor(
    fakePython, stateDir, { account: () => fakeAccount }, { GFLOW_REQUEST_LOG: log },
  ));
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: COOKIES }));

  const createdRes = await loaded.fetch("https://gflow.invalid/v1/videos", {
    method: "POST",
    body: JSON.stringify({ model: "gflow/veo-3.1", prompt: "ocean waves at dusk", size: "1280x720", seconds: "8", seed: 7 }),
  });
  assert.equal(createdRes.status, 200);
  const created = await createdRes.json();
  assert.equal(created.id, "media-vid-1");
  assert.equal(created.object, "video");
  assert.equal(created.status, "in_progress");
  // Must stay a bare model id so magpie's asOurs prefixes "gflow/" once.
  assert.equal(created.model, "veo-3.1");

  const statusRes = await loaded.fetch("https://gflow.invalid/v1/videos/media-vid-1", { method: "GET" });
  assert.equal(statusRes.status, 200);
  const polled = await statusRes.json();
  assert.equal(polled.id, "media-vid-1");
  assert.equal(polled.object, "video");
  assert.equal(polled.status, "completed");
  assert.equal(polled.progress, 100);
  assert.equal(polled.model, "veo-3.1");

  const missingRes = await loaded.fetch("https://gflow.invalid/v1/videos/missing-id", { method: "GET" });
  assert.equal(missingRes.status, 404);

  const contentRes = await loaded.fetch("https://gflow.invalid/v1/videos/media-vid-1/content", { method: "GET" });
  assert.equal(contentRes.status, 200);
  assert.equal(contentRes.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await contentRes.arrayBuffer());
  assert.equal(Number(contentRes.headers.get("content-length")), bytes.length);
  assert.ok(bytes.includes(Buffer.from("ftypmp42fake-veo-bytes")));

  const rows = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.command), ["video_start", "video_status", "video_status", "video_content"]);
  assert.equal(rows[0].model, "veo-3.1");
  assert.equal(rows[0].size, "1280x720");
  assert.equal(rows[0].seconds, "8");
  assert.equal(rows[0].seed, 7);
  assert.equal(rows[1].video_id, "media-vid-1");
  assert.equal(rows[3].video_id, "media-vid-1");
  assert.ok(rows.every((r) => r.account === fakeAccount && r.cookie_header === true));
});

test("loader /videos rejects unknown models, reserved keys, traversal ids, and image-to-video inputs", async () => {
  const log = requestLog();
  const hooks = await GflowPlugin(inputFor(fakePython, join(testDir, "video-guard-state"), {}, { GFLOW_REQUEST_LOG: log }));
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: COOKIES }));

  const unknownModel = await loaded.fetch("https://gflow.invalid/v1/videos", {
    method: "POST",
    body: JSON.stringify({ model: "gflow/sora-2", prompt: "waves" }),
  });
  assert.equal(unknownModel.status, 400);
  assert.match((await unknownModel.json()).error.message, /unknown gflow video model/);

  const reservedBody = await loaded.fetch("https://gflow.invalid/v1/videos", {
    method: "POST",
    body: JSON.stringify({ model: "veo-3.1", prompt: "waves", command: "browser_login_start", cookies: "SID=evil" }),
  });
  assert.equal(reservedBody.status, 400);
  assert.match((await reservedBody.json()).error.message, /reserved fields/);

  const imageInput = await loaded.fetch("https://gflow.invalid/v1/videos", {
    method: "POST",
    body: JSON.stringify({ model: "veo-3.1", prompt: "waves", input_reference: "data:image/png;base64,AAAA" }),
  });
  assert.equal(imageInput.status, 400);
  assert.match((await imageInput.json()).error.message, /input_reference/);

  const badId = await loaded.fetch("https://gflow.invalid/v1/videos/..%2Fsecret", { method: "GET" });
  assert.equal(badId.status, 400);

  const exists = (() => { try { return readFileSync(log, "utf8"); } catch { return ""; } })();
  assert.equal(exists, "");
});

test("magpie_bridge.py persists project_id across processes for video_start, video_status, and video_content", async () => {
  const { spawnSync } = await import("node:child_process");
  const pyState = await mkdtempSync(join(tmpdir(), "gflow-py-bridge-state-"));
  const repoDir = new URL(".", import.meta.url).pathname;
  const script = `
import json, os, sys, site
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repoDir)})
site.addsitedir(site.getusersitepackages())
import gflow.magpie_bridge as mb
from gflow.api.models import Asset, AssetType

seen_projects = []
status_step = {"mode": "MEDIA_GENERATION_STATUS_PENDING"}

class FakeFlowClient:
    _VIDEO_DONE_STATUSES = {"MEDIA_GENERATION_STATUS_SUCCESSFUL", "MEDIA_GENERATION_STATUS_COMPLETE"}
    _VIDEO_FAIL_STATUSES = {"MEDIA_GENERATION_STATUS_FAILED"}
    def __init__(self, cookies, *, debug=False, interactive_auth=True):
        assert cookies == ${JSON.stringify(COOKIES)}
        self._project_id = ""
        self._workflow_id = ""
        self._primary_media_id = ""
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def _ensure_project(self):
        if not self._project_id:
            self._project_id = "proj-persisted-1"
        return self._project_id
    def generate_video(self, req):
        self._ensure_project()
        self._workflow_id = "wf-persisted-1"
        self._primary_media_id = "prim-1"
        assert req.aspect_ratio == "portrait", req.aspect_ratio
        assert req.model == "veo-3.1-quality", req.model
        assert req.seconds == 6, req.seconds
        assert req.seed == 42
        return [Asset(id="uuid-media-99", name="video-uuid-med", asset_type=AssetType.VIDEO, prompt=req.prompt)]
    def check_video_status(self, names):
        seen_projects.append(self._project_id)
        assert names == ["uuid-media-99"]
        st = status_step["mode"]
        ms = {"mediaGenerationStatus": st}
        if st == "MEDIA_GENERATION_STATUS_FAILED":
            ms["failureReason"] = "policy block"
        return {"media": [{"name": "uuid-media-99", "mediaMetadata": {"mediaStatus": ms}}]}
    def get_flow_media(self, name):
        seen_projects.append(self._project_id)
        assert name == "uuid-media-99"
        return {"video": {"generatedVideo": {"fifeUrl": "https://cdn.example.test/v.mp4"}}}
    def save_video(self, asset, target):
        assert asset.url == "https://cdn.example.test/v.mp4"
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\\x00\\x00\\x00\\x18ftypmp42real-bridge-bytes")
        return target

mb.FlowClient = FakeFlowClient
base_req = {
    "account": "gflow#acct-py",
    "state_dir": ${JSON.stringify(pyState)},
    "headers": {"x-gflow-cookies": ${JSON.stringify(COOKIES)}},
}
started = mb.run({**base_req, "command": "video_start", "model": "gflow/veo-3.1-quality", "prompt": "secret-prompt-do-not-persist", "size": "720x1280", "seconds": "6", "seed": "42"})
assert started["id"] == "uuid-media-99" and started["model"] == "veo-3.1-quality" and started["status"] == "in_progress"

queued = mb.run({**base_req, "command": "video_status", "video_id": "uuid-media-99"})
assert queued["status"] == "queued" and queued["model"] == "veo-3.1-quality" and queued["size"] == "720x1280" and queued["seconds"] == "6"

status_step["mode"] = "MEDIA_GENERATION_STATUS_SUCCESSFUL"
done = mb.run({**base_req, "command": "video_status", "video_id": "uuid-media-99"})
assert done["status"] == "completed" and done["progress"] == 100

status_step["mode"] = "MEDIA_GENERATION_STATUS_FAILED"
failed = mb.run({**base_req, "command": "video_status", "video_id": "uuid-media-99"})
assert failed["status"] == "failed" and failed["error"]["message"] == "policy block"

content = mb.run({**base_req, "command": "video_content", "video_id": "uuid-media-99"})
assert Path(content["path"]).read_bytes().endswith(b"real-bridge-bytes")
assert seen_projects == ["proj-persisted-1", "proj-persisted-1", "proj-persisted-1", "proj-persisted-1"], seen_projects

state_files = list(Path(${JSON.stringify(pyState)}).rglob("video-state-*.json"))
assert len(state_files) == 1
raw_state = state_files[0].read_text("utf-8")
assert "SID=synthetic" not in raw_state
assert "secret-prompt-do-not-persist" not in raw_state
print("OK")
`;
  const r = spawnSync("python3", ["-I", "-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stdout.trim(), "OK");
});

test("newflow.py maps Veo 3.1 wire keys and drives YhhmEf / fZytfe / jwpduf / iFxMud offline", async () => {
  const { spawnSync } = await import("node:child_process");
  const pyHome = await mkdtempSync(join(tmpdir(), "gflow-newflow-vid-"));
  const repoDir = new URL(".", import.meta.url).pathname;
  const script = `
import json, os, sys, site
sys.path.insert(0, ${JSON.stringify(repoDir)})
site.addsitedir(site.getusersitepackages())
os.environ["GFLOW_HOME"] = ${JSON.stringify(pyHome)}
import gflow.api.newflow as nf

assert nf.resolve_video_wire_model("veo-3.1", aspect_ratio="landscape", seconds=8, tier=3) == "veo_3_1_t2v_fast_ultra"
assert nf.resolve_video_wire_model("veo-3.1", aspect_ratio="portrait", seconds=8, tier=3) == "veo_3_1_t2v_fast_portrait_ultra"
assert nf.resolve_video_wire_model("veo-3.1", aspect_ratio="landscape", seconds=6, tier=3) == "veo_3_1_t2v_fast_6s"
assert nf.resolve_video_wire_model("veo-3.1-quality", aspect_ratio="portrait", seconds=8, tier=3) == "veo_3_1_t2v_portrait"
assert nf.resolve_video_wire_model("veo-3.1-quality", aspect_ratio="landscape", seconds=6, tier=3) == "veo_3_1_t2v_quality_6s"
assert nf.resolve_video_wire_model("veo-3.1-lite", aspect_ratio="portrait", seconds=8, tier=3) == "veo_3_1_t2v_lite"
assert nf.resolve_video_wire_model("veo-3.1", aspect_ratio="portrait", extend=True, tier=3) == "veo_3_1_extend_fast_portrait_ultra"

calls = []
class FakeCDP:
    def close(self):
        pass
class FakeResp:
    def __init__(self, rpcid, payload):
        self.status_code = 200
        self.text = ")]}'\\n\\n" + json.dumps([["wrb.fr", rpcid, json.dumps(payload), None, None, None, "generic"]])

nf._cdp_connect = lambda: FakeCDP()
nf._CDPConnection = lambda ws_url: FakeCDP()
nf._page_ws_url = lambda: "ws://127.0.0.1:9222/devtools/page/fake-nf"
nf._cdp_cookies_and_globals = lambda cdp: ({"SID": "s"}, {"at": "xsrf-tok", "bl": "boq_labs", "f.sid": "123", "tier": 3})
nf._cdp_page_session = lambda: ({"SID": "s"}, {"at": "xsrf-tok", "bl": "boq_labs", "f.sid": "123", "tier": 3})
nf._project_id = lambda cookies, values: "proj-nf-1"
nf._recaptcha_token = lambda cdp, pid, action="IMAGE_GENERATION": f"rc-{action}-{pid}"

def fake_post_rpc(cookies, values, rpcid, arg, *, source_path="/"):
    calls.append((rpcid, arg, source_path))
    if rpcid == "nzlxg":
        return FakeResp("nzlxg", [None, None, 3])
    if rpcid == "YhhmEf":
        return FakeResp("YhhmEf", [None, 980, [["wf-nf-1"]], [["mid-nf-1", "wf-nf-1", None, None, None, [None]*8 + [[3]], None, [None, "https://storage.googleapis.com/ai-sandbox-videofx/video/abc?GoogleAccessId=x"]]]])
    if rpcid == "fZytfe":
        return FakeResp("fZytfe", [None, 960, [["wf-nf-1"]], [["mid-nf-2", "wf-nf-1", None, None, None, [None]*8 + [[3]], None, [None, "https://storage.googleapis.com/ai-sandbox-videofx/video/abc?GoogleAccessId=x"]]]])
    if rpcid == "jwpduf":
        return FakeResp("jwpduf", [None, 960, [["mid-nf-1", "wf-nf-1", None, None, None, [None]*8 + [[3]], None, [None, "https://storage.googleapis.com/ai-sandbox-videofx/video/abc?GoogleAccessId=x"]]]])
    if rpcid == "iFxMud":
        return FakeResp("iFxMud", [["mid-nf-1", "wf-nf-1", None, None, None, [None]*8 + [[3]], None, [None, "https://storage.googleapis.com/ai-sandbox-videofx/video/abc?GoogleAccessId=x"]]])
    raise AssertionError(f"unexpected rpcid {rpcid}")

nf._post_rpc = fake_post_rpc

gen = nf.generate_video(prompt="dawn over mountains", aspect_ratio="portrait", model="veo-3.1-quality", seconds=6, seed=99)
assert len(gen) == 1 and gen[0].id == "mid-nf-1"
assert gen[0].raw["workflowId"] == "wf-nf-1" and gen[0].raw["projectId"] == "proj-nf-1"
gen_call = next(c for c in calls if c[0] == "YhhmEf")
assert gen_call[1][0][0][1] == "veo_3_1_t2v_quality_6s", gen_call[1][0][0]
assert gen_call[1][0][0][2] == 1, gen_call[1][0][0]
assert gen_call[1][1][10] == ["rc-VIDEO_GENERATION-proj-nf-1", 1]
assert gen_call[2] == "/project/proj-nf-1"

ext = nf.extend_video(media_id="mid-nf-1", prompt="camera pans right", aspect_ratio="portrait", workflow_id="wf-nf-1")
assert len(ext) == 1 and ext[0].id == "mid-nf-2"
ext_call = next(c for c in calls if c[0] == "fZytfe")
assert ext_call[1][0][0][0][1] == "mid-nf-1"
assert ext_call[1][0][0][2] == "veo_3_1_extend_fast_portrait_ultra"

st = nf.check_video_status(["mid-nf-1"])
assert st["projectId"] == "proj-nf-1"
assert st["media"][0]["mediaMetadata"]["mediaStatus"]["mediaGenerationStatus"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
assert "storage.googleapis.com/ai-sandbox-videofx/video/abc" in st["media"][0]["video"]["generatedVideo"]["fifeUrl"]

detail = nf.get_flow_media("mid-nf-1")
assert "storage.googleapis.com/ai-sandbox-videofx/video/abc" in detail["video"]["generatedVideo"]["fifeUrl"]
print("OK")
`;
  const r = spawnSync("python3", ["-I", "-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.stdout.trim(), "OK");
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {prepareRequest, onRequest, onResponse, onEvent, PREPARED} from "../src/company-guard.js";
import {onRequest as hookRequest} from "../company-guard.hooks.mjs";
import {initializeOptions} from "../src/local-options.mjs";
import {signAuthorization} from "../src/session-authorization.js";

// Synthetic fixtures only: no user credentials, companies, grants or history.
const NAME = ["单元", "测试", "科技", "有限", "公司"].join("");
const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const keyFields = ["authKey", "receiptReadKey", "authorizationKey"];
const newKeys = () => Object.fromEntries(keyFields.map(field => [field, randomBytes(32).toString("hex")]));
function context(protocol, options = {}) {
  return {protocol, origin:"local", agent:"codex", session:SESSION, cwd:"/tmp/company-guard-fixture", state:{},
    options:{...newKeys(), companies:[NAME], ...options}, reject(status, message) { throw new Error(status + ": " + message); }};
}
const metadata = () => ({thread_source:"user", thread_id:SESSION, turn_id:TURN});
function request(protocol, text = NAME) {
  const body = {
    responses:() => ({input:[{role:"user", content:[{type:"input_text", text}]}]}),
    chat:() => ({messages:[{role:"user", content:text}]}),
    anthropic:() => ({messages:[{role:"user", content:[{type:"text", text}]}]}),
    gemini:() => ({contents:[{role:"user", parts:[{text}]}]})
  }[protocol]();
  body.client_metadata = metadata();
  return body;
}
function prepare(protocol, options) {
  const ctx = context(protocol, options), body = request(protocol);
  prepareRequest(body, ctx);
  assert.equal(ctx.state.guard.ready, true);
  assert(!JSON.stringify(body).includes(NAME));
  const token = Object.keys(ctx.state.guard.reverse)[0];
  assert(token?.startsWith("[[NERO_ORG_"));
  return {ctx, body, token};
}

for (const protocol of ["responses", "chat", "anthropic", "gemini"]) {
  test(protocol + ": request masking and reply restoration", () => {
    const {ctx, token} = prepare(protocol);
    const response = {
      responses:() => ({output:[{type:"message", content:[{type:"output_text", text:token}]}]}),
      chat:() => ({choices:[{message:{role:"assistant", content:token}}]}),
      anthropic:() => ({content:[{type:"text", text:token}]}),
      gemini:() => ({candidates:[{content:{parts:[{text:token}]}}]})
    }[protocol]();
    onResponse(response, ctx);
    assert(JSON.stringify(response).includes(NAME));
    assert(!JSON.stringify(response).includes(token));
  });

  test(protocol + ": restore a name split across streaming chunks", () => {
    const {ctx, token} = prepare(protocol);
    const events = [token.slice(0, 19), token.slice(19)].map((text, index) => ({
      responses:() => ({type:"response.output_text.delta", output_index:0, content_index:0, delta:text}),
      chat:() => ({choices:[{index:0, delta:{content:text}, finish_reason:index ? "stop" : null}]}),
      anthropic:() => ({type:"content_block_delta", index:0, delta:{type:"text_delta", text}}),
      gemini:() => ({candidates:[{index:0, content:{parts:[{text}]}, ...(index ? {finishReason:"STOP"} : {})}]})
    }[protocol]()));
    const output = events.map(event => {
      const restored = onEvent(event, ctx);
      assert(restored);
      return protocol === "responses" ? restored.delta : protocol === "chat" ? restored.choices[0].delta.content :
        protocol === "anthropic" ? restored.delta.text : restored.candidates[0].content.parts[0].text;
    }).join("");
    assert.equal(output, NAME);
    assert.equal(ctx.state.guard.failed, false);
  });

  test(protocol + ": mask company names in tool arguments", () => {
    const ctx = context(protocol), args = {company_name:NAME};
    const body = {
      responses:() => ({input:[{type:"function_call", name:"lookup", call_id:"fixture", arguments:JSON.stringify(args)}]}),
      chat:() => ({messages:[{role:"assistant", tool_calls:[{id:"fixture", type:"function", function:{name:"lookup", arguments:JSON.stringify(args)}}]}]}),
      anthropic:() => ({messages:[{role:"assistant", content:[{type:"tool_use", id:"fixture", name:"lookup", input:args}]}]}),
      gemini:() => ({contents:[{role:"model", parts:[{functionCall:{name:"lookup", args}}]}]})
    }[protocol]();
    prepareRequest(body, ctx);
    assert.equal(ctx.state.guard.ready, true);
    assert(!JSON.stringify(body).includes(NAME));
    assert.equal(Object.values(ctx.state.guard.reverse)[0], NAME);
  });
}

function authorization(ctx, state = "active", coverage = "names") {
  return signAuthorization({v:1, session:SESSION, workspace:ctx.cwd, state, coverage,
    names:coverage === "all" ? [] : [NAME], created:Date.now()}, ctx.options.authKey);
}
for (const coverage of ["names", "all"]) {
  test("session authorization: " + coverage + " approval and revocation", () => {
    const ctx = context("responses"), body = request("responses");
    ctx.options.sessionAuthorizations = [authorization(ctx, "active", coverage)];
    prepareRequest(body, ctx);
    assert(JSON.stringify(body).includes(NAME));
    assert.equal(ctx.state.guard.metrics.authorizationCoverage, coverage);
    ctx.options.sessionAuthorizations = [authorization(ctx, "revoked", coverage)];
    const next = request("responses");
    prepareRequest(next, ctx);
    assert(!JSON.stringify(next).includes(NAME));
    assert.equal(ctx.state.guard.metrics.authorizationReason, "session_revoked");
  });
}
test("authorization cannot cross sessions or workspaces; altered seals do not authorize", () => {
  const ctx = context("responses"), approved = authorization(ctx);
  ctx.options.sessionAuthorizations = [approved];
  const other = request("responses"); other.client_metadata.thread_id = TURN; ctx.session = TURN;
  prepareRequest(other, ctx); assert(!JSON.stringify(other).includes(NAME));
  ctx.session = SESSION; ctx.cwd += "/different";
  const moved = request("responses"); prepareRequest(moved, ctx); assert(!JSON.stringify(moved).includes(NAME));
  ctx.cwd = "/tmp/company-guard-fixture";
  ctx.options.sessionAuthorizations = [{...approved, mac:"0".repeat(64)}];
  const altered = request("responses"); prepareRequest(altered, ctx); assert(!JSON.stringify(altered).includes(NAME));
});

async function installation(t, supplied = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-guard-test-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await fs.rm(directory, {recursive:true, force:true}); });
  const configDirectory = path.join(directory, "magpie"); await fs.mkdir(configDirectory, {mode:0o700});
  const configFile = path.join(configDirectory, "plugins.json");
  const config = {plugins:[{spec:ROOT, options:{companies:[NAME], ...supplied}}, {spec:"fixture-other", options:{keep:true}}], prefer:{fixture:"fixture-other"}};
  await fs.writeFile(configFile, JSON.stringify(config), {mode:0o600});
  return {options:{...config.plugins[0].options}, configFile, keyFile:path.join(configDirectory, "company-guard", "keys.json"), config};
}
test("fresh install generates three private persistent keys and preserves unrelated settings", async t => {
  const setup = await installation(t);
  const options = await initializeOptions(setup.options);
  for (const field of keyFields) assert.match(options[field], /^[a-f0-9]{64}$/);
  assert.equal(new Set(keyFields.map(field => options[field])).size, 3);
  assert.equal((await fs.stat(setup.keyFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(setup.keyFile))).mode & 0o777, 0o700);
  const saved = JSON.parse(await fs.readFile(setup.configFile));
  assert.deepEqual(saved.plugins[1], setup.config.plugins[1]); assert.deepEqual(saved.prefer, setup.config.prefer);
  const again = await initializeOptions({...saved.plugins[0].options});
  for (const field of keyFields) assert.equal(again[field], options[field]);
  assert.equal((await fs.stat(setup.configFile)).mode & 0o777, 0o600);
});
test("a pinned GitHub installation initializes without a local-path registration", async t => {
  const setup = await installation(t);
  setup.config.plugins[0].spec = "github:cyanask/magpie-company-guard#main";
  await fs.writeFile(setup.configFile, JSON.stringify(setup.config));
  const options = await initializeOptions(setup.options);
  const saved = JSON.parse(await fs.readFile(setup.configFile));
  for (const field of keyFields) assert.equal(saved.plugins[0].options[field], options[field]);
});
for (const spec of ["@magpie-community/middleware-company-guard", "@magpie-community/middleware-company-guard@0.4.1"]) {
  test("community installation initializes: " + spec, async t => {
    const setup = await installation(t);
    setup.config.plugins[0].spec = spec;
    await fs.writeFile(setup.configFile, JSON.stringify(setup.config));
    const options = await initializeOptions(setup.options);
    const saved = JSON.parse(await fs.readFile(setup.configFile));
    for (const field of keyFields) assert.equal(saved.plugins[0].options[field], options[field]);
  });
}
test("duplicate installations are rejected instead of changing both entries", async t => {
  const setup = await installation(t);
  setup.config.plugins.push({spec:"github:cyanask/magpie-company-guard"});
  const before = JSON.stringify(setup.config); await fs.writeFile(setup.configFile, before);
  await assert.rejects(initializeOptions(setup.options), /installation_not_unique/);
  assert.equal(await fs.readFile(setup.configFile, "utf8"), before);
});
test("existing keys, explicit port and signed authorizations survive initialization", async t => {
  const keys = newKeys(), ctx = context("responses", keys), approved = authorization(ctx);
  const setup = await installation(t, {...keys, receiptPort:3478, sessionAuthorizations:[approved]});
  const before = await fs.readFile(setup.configFile, "utf8");
  const options = await initializeOptions(setup.options);
  assert.equal(await fs.readFile(setup.configFile, "utf8"), before);
  assert.equal(options.receiptPort, 3478);
  for (const field of keyFields) assert.equal(options[field], keys[field]);
  const body = request("responses"); prepareRequest(body, context("responses", options));
  assert(JSON.stringify(body).includes(NAME));
});
test("partial configuration retains its existing protection key", async t => {
  const authKey = randomBytes(32).toString("hex"), setup = await installation(t, {authKey});
  const options = await initializeOptions(setup.options);
  assert.equal(options.authKey, authKey);
  assert.match(options.receiptReadKey, /^[a-f0-9]{64}$/);
  assert.match(options.authorizationKey, /^[a-f0-9]{64}$/);
});
test("concurrent initializers share one complete key file", async t => {
  const setup = await installation(t);
  const results = await Promise.all(Array.from({length:6}, () => initializeOptions({...setup.options})));
  for (const options of results) for (const field of keyFields) assert.equal(options[field], results[0][field]);
  assert.deepEqual(JSON.parse(await fs.readFile(setup.keyFile)), Object.fromEntries(keyFields.map(field => [field, results[0][field]])));
});
test("invalid existing options are rejected without overwriting configuration", async t => {
  const setup = await installation(t, {authKey:"invalid"});
  const before = await fs.readFile(setup.configFile, "utf8");
  await assert.rejects(initializeOptions(setup.options), /invalid_existing_key/);
  assert.equal(await fs.readFile(setup.configFile, "utf8"), before);
  await assert.rejects(fs.stat(setup.keyFile), {code:"ENOENT"});
});
test("corrupt or conflicting stored keys are preserved and rejected", async t => {
  const setup = await installation(t); await initializeOptions(setup.options);
  const original = await fs.readFile(setup.keyFile, "utf8");
  await assert.rejects(initializeOptions({...setup.options, authKey:randomBytes(32).toString("hex")}), /key_conflict/);
  assert.equal(await fs.readFile(setup.keyFile, "utf8"), original);
  await fs.writeFile(setup.keyFile, "invalid-json");
  await assert.rejects(initializeOptions(setup.options), /invalid_key_file/);
  assert.equal(await fs.readFile(setup.keyFile, "utf8"), "invalid-json");
});
test("symlinked or permissive key files are rejected", async t => {
  const setup = await installation(t); await initializeOptions(setup.options);
  await fs.chmod(setup.keyFile, 0o644);
  await assert.rejects(initializeOptions(setup.options), /invalid_key_file/);
  await fs.chmod(setup.keyFile, 0o600);
  const target = setup.keyFile + ".saved"; await fs.rename(setup.keyFile, target); await fs.symlink(target, setup.keyFile);
  await assert.rejects(initializeOptions(setup.options), /invalid_key_file/);
});
test("fresh hook preparation and native middleware share keys and remove the private envelope", async t => {
  const setup = await installation(t), body = request("responses"), hook = context("responses", setup.options);
  hook.options = setup.options;
  await hookRequest(body, hook);
  assert(body[PREPARED]);
  const native = context("responses", JSON.parse(await fs.readFile(setup.configFile)).plugins[0].options);
  onRequest(body, native);
  assert.equal(body[PREPARED], undefined);
  assert(!JSON.stringify(body).includes(NAME));
  for (const field of keyFields) assert(!JSON.stringify(body).includes(native.options[field]));
  const token = Object.keys(native.state.guard.reverse)[0], reply = {output:[{content:[{type:"output_text", text:token}]}]};
  onResponse(reply, native); assert(JSON.stringify(reply).includes(NAME));
});

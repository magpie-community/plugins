// Real Magpie executable + real Bun host, in disposable homes and local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCAL_TOKEN } from '../bridge.mjs';

const exec = promisify(execFile);
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-trae-acceptance-'));
const magpie = process.env.MAGPIE_BIN || path.join(process.env.LOCALAPPDATA, 'Programs/Magpie/Magpie.exe');
const bun = process.env.MAGPIE_BUN || path.join(os.homedir(), '.cache/magpie/bun/1.4.4/magpie-bun.exe');
const freePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
const gatewayPort = await freePort(), bridgePort = await freePort();
const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(root, 'AppData/Local'), XDG_CONFIG_HOME: path.join(root, '.config'),
  XDG_CACHE_HOME: path.join(root, '.cache'), XDG_STATE_HOME: path.join(root, '.state'),
  MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_NO_ACCOUNTS: '1', MAGPIE_BUN: bun };
const run = async args => {
  try { return await exec(magpie, args, { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 2 << 20 }); }
  catch (e) { throw new Error(`magpie ${args.slice(0, 2).join(' ')}: ${e.stderr || e.message}`); }
};
const until = async (predicate, label) => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
};
const records = [], checks = [];
const pass = label => { checks.push(label); console.log(`PASS: ${label}`); };
const fixture = http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); records.push({ model: body.model, stream: body.stream });
  assert.equal(req.headers.authorization, 'Bearer fixture-only');
  res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
  const reply = { id: 'fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0,
    message: { role: 'assistant', content: `accepted-${body.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
  if (body.stream) res.end(`data: ${JSON.stringify({ ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `accepted-${body.model}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  else res.end(JSON.stringify(reply));
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
let child;
let output = '';
const base = `http://127.0.0.1:${bridgePort}`;
const health = async () => { try { return await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).json(); } catch { return {}; } };
const send = (stream, model = 'fixture/first') => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: {
  authorization: `Bearer ${LOCAL_TOKEN}`, 'content-type': 'application/json', 'x-forwarded-for': 'fc00::1' },
  body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'fixture' }] }) });
const control = path.join(root, '.config/magpie-trae/connection.json');
try {
  fs.mkdirSync(path.join(env.APPDATA, 'Trae CN'), { recursive: true });
  fs.mkdirSync(path.join(root, '.config/magpie'), { recursive: true });
  fs.mkdirSync(path.dirname(control), { recursive: true });
  const original = '{\n  "userNote": "retain fixture setting"\n}\n';
  fs.writeFileSync(control, original);
  fs.writeFileSync(path.join(root, '.config/magpie/providers.json'), JSON.stringify({ providers: [{
    id: 'fixture', name: 'Fixture', key: 'fixture-only', chat: `http://127.0.0.1:${fixture.address().port}/v1`, models: ['first', 'second'],
  }] }));
  await run(['plugin', 'add', repo]);
  await run(['plugin', 'options', repo, JSON.stringify({ port: bridgePort, skipNativeSync: true })]);
  const listed = await run(['ls']); assert.match(listed.stdout, /Trae/);
  pass('Magpie discovers the official Agent descriptor');
  const libraryRoot = path.join(root, '.config/magpie/library');
  const rule = path.join(root, '.trae-cn/user_rules/magpie.md');
  const mcp = path.join(env.APPDATA, 'Trae CN/User/mcp.json');
  const skill = path.join(root, '.trae-cn/skills/acceptance-skill/SKILL.md');
  for (const file of [rule, mcp, path.join(libraryRoot, 'skills/acceptance-skill/SKILL.md')]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(rule, '# Existing user rule\n');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { existing: { command: 'existing-user-server' } }, userNote: 'keep' }));
  fs.writeFileSync(path.join(libraryRoot, 'skills/acceptance-skill/SKILL.md'), '---\nname: acceptance-skill\ndescription: Isolated acceptance fixture.\n---\nMAGPIE_SKILL_E2E\n');
  fs.writeFileSync(path.join(root, '.config/magpie/library.json'), JSON.stringify({
    instructions: { agents: [] }, mcp: [], skills: [{ name: 'acceptance-skill', agents: ['trae-local'] }], copySkills: true,
  }));
  const sharedRule = path.join(root, 'shared-rule.md'); fs.writeFileSync(sharedRule, 'MAGPIE_RULE_E2E');
  await run(['library', 'instructions', 'set', sharedRule]);
  await run(['library', 'instructions', 'agents', 'trae-local']);
  await run(['library', 'mcp', 'add', 'acceptance-server', 'http://127.0.0.1:9/mcp', 'agents=trae-local']);
  await run(['library', 'sync']);
  assert.match(fs.readFileSync(rule, 'utf8'), /MAGPIE_RULE_E2E/);
  assert.match(fs.readFileSync(rule, 'utf8'), /Existing user rule/);
  assert.match(fs.readFileSync(skill, 'utf8'), /MAGPIE_SKILL_E2E/);
  const servers = JSON.parse(fs.readFileSync(mcp));
  assert.equal(servers.mcpServers['acceptance-server'].url, 'http://127.0.0.1:9/mcp');
  assert.equal(servers.mcpServers.existing.command, 'existing-user-server');
  pass('Real Magpie Library synchronizes rules, MCP and skills to Trae native paths, preserving user entries');
  await run(['library', 'instructions', 'agents', 'none']);
  await run(['library', 'mcp', 'agents', 'acceptance-server', 'none']);
  await run(['library', 'skill', 'agents', 'acceptance-skill', 'none']);
  assert.doesNotMatch(fs.readFileSync(rule, 'utf8'), /MAGPIE_RULE_E2E/);
  assert.match(fs.readFileSync(rule, 'utf8'), /Existing user rule/);
  assert.equal(fs.existsSync(skill), false);
  const withdrawn = JSON.parse(fs.readFileSync(mcp));
  assert.equal(withdrawn.mcpServers['acceptance-server'], undefined);
  assert.equal(withdrawn.mcpServers.existing.command, 'existing-user-server');
  assert.equal(withdrawn.userNote, 'keep');
  pass('Library withdrawal removes only its own rules, MCP and skills');
  await run(['trae-local', 'provider', 'magpie']);
  const connected = JSON.parse(fs.readFileSync(control));
  assert.equal(connected.model, undefined); assert.equal(connected.models.length, 2);
  pass('Magpie writes the complete model catalog without selecting a model');
  child = spawn(magpie, ['serve'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await until(async () => (await health()).models?.length === 2, 'resident Bun bridge');
  let response = await send(false); assert.equal(response.status, 200); assert.match(await response.text(), /accepted-first/);
  pass('Resident Bun host forwards a request through real Magpie to the local provider');
  const unchanged = fs.readFileSync(control, 'utf8');
  response = await send(true, 'fixture/second'); assert.equal(response.status, 200); assert.match(await response.text(), /accepted-second/);
  assert.equal(fs.readFileSync(control, 'utf8'), unchanged);
  pass('Client-side model selection and streaming work without changing Magpie configuration');
  await run(['provider', 'models', 'fixture', 'first', 'third']);
  await until(async () => {
    const ids = (await health()).models?.map(m => m.id) || [];
    return ids.includes('fixture/third') && !ids.includes('fixture/second');
  }, 'catalog replacement while connected');
  const changed = JSON.parse(fs.readFileSync(control));
  assert.deepEqual(changed.models.map(m => m.id).sort(), ['fixture/first', 'fixture/third']);
  response = await send(false, 'fixture/second'); assert.equal(response.status, 404); await response.text();
  response = await send(false, 'fixture/third'); assert.equal(response.status, 200); assert.match(await response.text(), /accepted-third/);
  pass('Real Magpie model addition and removal update the connected Agent and resident bridge without restart');
  await run(['trae-local', 'default']);
  response = await send(false); assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(fs.readFileSync(control)), JSON.parse(original));
  pass('Disconnect restores the original fields and refuses new inference');
  await run(['trae-local', 'provider', 'magpie']);
  await until(async () => (await health()).connected === true, 'reconnect');
  response = await send(false); assert.equal(response.status, 200); await response.text();
  await run(['plugin', 'off', repo]);
  await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`).catch(() => {});
  await until(async () => {
    const s = await health(); return !s.connected;
  }, 'disable');
  assert.deepEqual(JSON.parse(fs.readFileSync(control)), JSON.parse(original));
  pass('Disabling the plugin takes its connection out and preserves unrelated configuration');
  const report = { time: new Date().toISOString(), magpie: (await run(['version'])).stdout.trim(), checks,
    fixtureRequests: records, controlRestored: true, isolatedHome: true };
  fs.mkdirSync(path.join(repo, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'artifacts/magpie-acceptance.json'), JSON.stringify(report, null, 2));
} catch (e) {
  console.error(output.slice(-4500)); throw e;
} finally {
  if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  const target = path.resolve(root), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(parent) || !path.basename(target).startsWith('magpie-trae-acceptance-')) throw new Error('Unexpected cleanup target');
  // Magpie's Windows helper can release files shortly after its parent exits.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

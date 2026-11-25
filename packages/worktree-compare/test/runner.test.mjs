import { processAlive } from '../lib/proc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunner, listModels } from '../lib/runner.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('lists unique coding models from the local Magpie catalog without invoking a model', async t => {
  const seen = [];
  const port = await fixture(t, (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.end(JSON.stringify({data: [
      {id: 'one/model', tool_call: true, modalities: {output: ['text']}}, {id: 'two/model'},
      {id: 'one/model'}, {id: 'image', modalities: {output: ['image']}}, {id: 'no-tools', tool_call: false}, {id: ''}, null,
    ]}));
  });
  assert.deepEqual(await listModels({gatewayPort: port}), ['one/model', 'two/model']);
  assert.deepEqual(seen, [['GET', '/v1/models', undefined]]);
});

test('does not follow gateway redirects or silently accept an invalid catalog', async t => {
  const port = await fixture(t, (_, res) => { res.writeHead(302, {location: 'https://example.invalid/'}); res.end(); });
  await assert.rejects(listModels({gatewayPort: port}), /HTTP 302/);
  const bad = await fixture(t, (_, res) => res.end('{"error":"Invalid"}'));
  await assert.rejects(listModels({gatewayPort: bad}), /invalid model list/);
});

test('requires the explicit confirmation and scopes executable, model, worktree, and config to one run', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-runner-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const executable = path.join(dir, 'codex-test');
  await writeFile(executable, `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const data = {
      args, cwd: process.cwd(), home: process.env.HOME, config: process.env.CODEX_HOME,
      keys: Object.keys(process.env), prompt: fs.readFileSync(0, 'utf8'),
    };
    fs.writeFileSync('observed.json', JSON.stringify(data));
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ' candidate summary ');
  `, {mode: 0o700});
  const run = createRunner({gatewayPort: 19005, codexPath: executable});
  const input = {cwd: dir, model: 'local/demo', prompt: 'Make the requested change.'};
  await assert.rejects(run(input), /explicit usage confirmation/);
  await assert.rejects(access(path.join(dir, 'observed.json')));
  assert.deepEqual(await run({...input, confirmed: true}), {summary: 'candidate summary'});
  const obs = JSON.parse(await readFile(path.join(dir, 'observed.json'), 'utf8'));
  assert.ok(obs.args.includes('workspace-write'));
  assert.ok(obs.args.includes('approval_policy="never"'));
  assert.ok(obs.args.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(obs.args.includes('--model=local/demo'));
  assert.ok(obs.args.includes('model_providers.magpie_arena.base_url="http://127.0.0.1:19005/v1"'));
  assert.ok(obs.args.includes('--ignore-user-config'));
  assert.ok(obs.args.includes('--ephemeral'));
  assert.equal(obs.prompt, input.prompt);
  assert.ok(!obs.args.includes(input.prompt));
  assert.ok(!obs.keys.some(key => /TOKEN|API_KEY|PROXY|AUTH_SOCK/i.test(key)));
  assert.notEqual(obs.home, process.env.HOME);
  await assert.rejects(access(obs.config));
});

test('stops a candidate at its time limit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-runner-stop-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const executable = path.join(dir, 'codex-test');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);`, {mode: 0o700});
  const run = createRunner({gatewayPort: 19005, codexPath: executable, timeoutMs: 80});
  await assert.rejects(run({cwd: dir, model: 'demo', prompt: 'Wait', confirmed: true}), /time limit/);
});

test('cancelling a shim stops its native child and grandchild', {skip: process.platform === 'win32'}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-runner-tree-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const executable = path.join(dir, 'test-shim');
  const grandchild = "require('node:fs').writeFileSync('leaf-pid',String(process.pid));setInterval(()=>{},1000)";
  const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}]);setInterval(()=>{},1000)`;
  await writeFile(executable, `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}]);setInterval(()=>{},1000)`, {mode: 0o700});
  const run = createRunner({gatewayPort: 19005, codexPath: executable, timeoutMs: 5000});
  const ctrl = new AbortController();
  const ended = assert.rejects(run({cwd: dir, model: 'demo', prompt: 'Wait', confirmed: true, signal: ctrl.signal}), /cancelled/);
  let leaf;
  for (let i = 0; i < 200 && !leaf; i++) {
    try { leaf = Number(await readFile(path.join(dir, 'leaf-pid'), 'utf8')); } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  ctrl.abort();
  await ended;
  assert.ok(leaf);
  for (let i = 0; processAlive(leaf) && i < 100; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(processAlive(leaf), false);
});

// Explicit opt-in: this exercises installed CLI + OS sandbox, never a paid model.
test('installed Codex writes two distinct worktrees through a local Responses fixture', {
  skip: process.env.MAGPIE_TEST_INSTALLED_CODEX !== '1', timeout: 50_000,
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-arena-e2e-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', dir, ...args], {stdio: 'pipe'});
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Base');
  const labels = ['alpha', 'beta'];
  const requests = new Map();
  const port = await fixture(t, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const model = body.model;
    const label = model.replace('fixture/', '');
    if (!labels.includes(label)) { res.writeHead(400).end(); return; }
    const count = (requests.get(model) ?? 0) + 1;
    requests.set(model, count);
    if (count > 2) { res.writeHead(429).end(); return; }
    const item = count === 1 ? {
      id: 'fc_' + label, type: 'function_call', call_id: 'call_' + label, name: 'exec_command',
      arguments: JSON.stringify({cmd: `printf '%s\\n' ${label} > candidate.txt`}), status: 'completed',
    } : {
      id: 'msg_' + label, type: 'message', role: 'assistant', status: 'completed',
      content: [{type: 'output_text', text: `Completed ${label}`, annotations: []}],
    };
    const response = {id: `resp_${label}_${count}`, object: 'response', created_at: 1780000000, status: 'completed', model,
      output: [item], usage: {input_tokens: 4, output_tokens: 4, total_tokens: 8}};
    const frames = [
      {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
      {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress'}},
      {type: 'response.output_item.done', output_index: 0, item},
      {type: 'response.completed', response},
    ];
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  const runner = createRunner({gatewayPort: port, timeoutMs: 20000});
  for (const label of labels) git('worktree', 'add', '--quiet', '--detach', path.join(dir, label), 'HEAD');
  const results = await Promise.all(labels.map(label => runner({cwd: path.join(dir, label), model: 'fixture/' + label,
    prompt: 'Write a candidate fixture as requested.', confirmed: true})));
  for (const [i, label] of labels.entries()) {
    assert.equal(requests.get('fixture/' + label), 2);
    assert.deepEqual(results[i], {summary: 'Completed ' + label});
    assert.equal(await readFile(path.join(dir, label, 'candidate.txt'), 'utf8'), label + '\n');
  }
  await assert.rejects(access(path.join(dir, 'candidate.txt')));
});

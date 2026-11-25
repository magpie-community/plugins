import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createArenaService } from '../lib/service.mjs';

test('page API gates local runs and reviews two independent checkouts', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'compare-repo-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'compare-state-'));
  const arenaAccess = '1'.repeat(64);
  const opened = [];
  const server = await createArenaService({
    port: 0, options: { arenaAccess }, stateDir,
    listModels: async () => ['model-a', 'model-b'], openFolder: async cwd => opened.push(cwd),
    runCandidate: async ({ cwd, model, prompt, confirmed }) => {
      assert.equal(confirmed, true);
      assert.equal(prompt, 'Implement search');
      await writeFile(path.join(cwd, 'new.txt'), model);
      return { summary: model + ' finished' };
    },
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Arena-Key': arenaAccess, 'Content-Type': 'application/json', 'X-Arena-Request': '1' };
  const post = (route, input = {}) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(input) });
  const get = async route => (await fetch(base + route, { headers })).json();
  try {
    // WebKit's sandboxed desktop iframe needs the explicit loopback address.
    const policy = (await fetch(base)).headers.get('content-security-policy');
    assert.ok(policy.includes("connect-src 'self' " + base + ';'));
    assert.equal((await fetch(base + '/api/runs')).status, 403);
    assert.equal((await fetch(base + '/api/runs', { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
    const blocked = await fetch(base + '/api/runs', { method: 'POST', headers: {'Content-Type':'application/json', Origin:'null'}, body:'{}' });
    assert.equal(blocked.status, 403);
    assert.deepEqual((await get('/api/models')).models, ['model-a', 'model-b']);
    assert.equal((await post('/api/runs', { repo, prompt: 'x', models: ['model-a', 'unlisted'] })).status, 400);
    const git = args => execFileSync('git', ['-c','core.hooksPath=' + os.devNull,'-C', repo, ...args], { stdio: 'ignore' });
    git(['init', '-q']);
    await writeFile(path.join(repo, 'base.txt'), 'base');
    git(['add', 'base.txt']);
    git(['-c','user.name=Tester','-c','user.email=tester@example.org','-c','commit.gpgsign=false','commit','-qm','base']);
    const created = await post('/api/runs', {repo, prompt: 'Implement search', models: ['model-a', 'model-b']});
    assert.equal(created.status, 201);
    const { run } = await created.json();
    const route = '/api/runs/' + run.id;
    let finished;
    for (let i = 0; i < 100; i++) {
      finished = (await get(route)).run;
      if (finished.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(finished.status, 'completed');
    for (const entry of finished.candidates) {
      assert.match((await get(route + '/' + entry.side + '/diff')).diff, new RegExp(entry.model));
      assert.equal(await readFile(path.join(entry.cwd, 'new.txt'), 'utf8'), entry.model);
    }
    assert.equal((await post(route + '/a/open')).status, 200);
    assert.deepEqual(opened, [finished.candidates[0].cwd]);
    assert.equal((await (await post(route + '/b/choose')).json()).run.chosen, 'b');
    assert.equal((await (await post(route + '/discard')).json()).run.status, 'discarded');
    assert.equal(await readFile(path.join(repo, 'base.txt'), 'utf8'), 'base');
    await assert.rejects(readFile(path.join(repo, 'new.txt')), {code:'ENOENT'});
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive:true, force:true });
    await rm(repo, { recursive:true, force:true });
  }
});

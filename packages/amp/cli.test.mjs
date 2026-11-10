import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-amp-regression-'));
  const stateDir = path.join(root, 'local');
  const remoteFile = path.join(root, 'remote.json');
  const keyFile = path.join(root, 'key');
  const remote = () => JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
  const save = state => fs.writeFileSync(remoteFile, JSON.stringify(state));
  save({ user: 'user_fixture', routes: [{ id: 'unrelated', name: 'ChatGPT', type: 'model_provider_chatgpt', active: true, priority: 0, config: {} }], mutations: [] });
  fs.writeFileSync(keyFile, 'private-fixture-gateway-key\n', { mode: 0o600 });
  const env = { ...process.env, AMP_FIXTURE_STATE: remoteFile };
  delete env.AMP_API_KEY;
  delete env.AMP_URL;
  function run(args, exitCode = 0) {
    const result = spawnSync('node', [path.join(import.meta.dir, 'cli.mjs'), '--state-dir', stateDir, '--amp-bin', path.join(import.meta.dir, 'fixtures/amp-cli.mjs'), ...args], { encoding: 'utf8', env, timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(exitCode);
    return JSON.parse((result.stdout || result.stderr).trim());
  }
  run(['setup', '--base-url', 'https://gateway.example.com/v1', '--amp-model', 'anthropic/claude-opus-4-6', '--gateway-key-file', keyFile]);
  const select = model => fs.writeFileSync(path.join(stateDir, 'control.json'), JSON.stringify({ version: 1, model }), { mode: 0o600 });
  return { run, select, remote, save, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('reverts its new activation when Amp readback discovers a preceding route', () => {
  const s = scenario();
  try {
    s.select('group/first');
    s.save({ ...s.remote(), postActivateShadow: true });
    s.run(['sync'], 2);
    const state = s.remote();
    expect(state.routes[1].active).toBe(false);
    expect(state.routes[0].active).toBe(true);
    expect(state.mutations.at(-1)).toEqual({ action: 'deactivate', args: ['config', 'model-providers', 'deactivate', state.routes[1].id] });
  } finally { s.close(); }
}, 30_000);

test('recovers an uncertain applied edit and permits disconnect before resynchronizing', () => {
  const s = scenario();
  try {
    s.select('group/before');
    s.run(['sync']);
    const ownedID = s.remote().routes[1].id;
    s.select('group/uncertain');
    s.save({ ...s.remote(), failEditOnce: true });
    s.run(['sync'], 1);
    expect(s.run(['status']).status).toBe('prepared/pending');
    s.run(['disconnect']);
    expect(s.remote().routes[1].active).toBe(false);
    s.select('group/newer');
    s.save({ ...s.remote(), failEditOnce: true });
    s.run(['sync'], 1);
    s.run(['sync']);
    const state = s.remote();
    expect(state.routes[1].id).toBe(ownedID);
    expect(state.routes[1].config.modelMapping).toBe('anthropic/claude-opus-4-6 -> group/newer');
    expect(state.mutations.filter(call => call.action === 'add-router')).toHaveLength(1);
    expect(state.routes[0]).toEqual({ id: 'unrelated', name: 'ChatGPT', type: 'model_provider_chatgpt', active: true, priority: 0, config: {} });
  } finally { s.close(); }
}, 30_000);

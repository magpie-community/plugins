import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncModels, syncPaths, modelRequest } from '../sync.mjs';
import { TraeAPI, readSession } from '../trae-api.mjs';
import { encodeCredential, decodeCredential } from '../trae-local-token.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const fixtureAK = 'fixture-native-encoded-key';
const models = [{ id: 'fixture/one', name: 'One', context: 128000, output: 16000, images: true, efforts: ['low', 'high'] },
  { id: 'fixture/two', name: 'Two', context: 64000, output: 8000, images: false, efforts: [] }];

class MemoryAPI {
  session = { account: 'fixture-account' };
  entries = [];
  writes = [];
  nextID = 100;
  async list() { return copy(this.entries); }
  async call(method, body) {
    this.writes.push({ method, body: copy(body) });
    if (method === 'add_custom_model') {
      this.entries.push({ id: String(this.nextID++), model: body.model_name, provider: body.provider,
        ak: body.ak, name: body.display_name, baseURL: body.base_url, status: true,
        config: { auth_type: 0 }, detail: copy(body.config_detail) });
    } else if (method === 'update_custom_model') {
      const e = this.entries.find(e => e.id === String(body.id));
      if (!e) throw new Error('missing_fixture_model');
      if (body.action === 'delete') this.entries = this.entries.filter(entry => entry !== e);
      else Object.assign(e, { model: body.model_name, provider: body.provider, ...(Object.hasOwn(body, 'ak') ? { ak: body.ak } : {}),
        name: body.display_name, baseURL: body.base_url, status: body.status, detail: copy(body.config_detail) });
    } else throw new Error('unexpected_fixture_operation');
    if (this.failAfter === method) { this.failAfter = null; throw new Error('lost_response'); }
    return { code: 0 };
  }
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-sync-test-'));
  const paths = syncPaths(root);
  fs.mkdirSync(path.dirname(paths.control), { recursive: true });
  const write = (list = models) => fs.writeFileSync(paths.control, JSON.stringify({ version: 2, gatewayKey: 'fixture', models: list }));
  write();
  const api = new MemoryAPI();
  const sync = () => syncModels({ paths, apiFactory: () => api, credentialFactory: () => fixtureAK });
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, write, api, sync, state: () => JSON.parse(fs.readFileSync(paths.state, 'utf8')) };
}

test('one connection provisions all models in Trae, with capability metadata', async t => {
  const f = setup(t);
  const result = await f.sync();
  assert.equal(result.state, 'synced'); assert.equal(result.models, 2);
  assert.deepEqual(f.api.entries.map(e => e.model), ['fixture/one', 'fixture/two']);
  assert.equal(f.api.entries[0].detail.multimodal, true);
  assert.deepEqual(f.api.entries[0].detail.model_hyper_params.reasoning_param.values, ['default', 'low', 'high']);
  assert.equal(f.api.entries[1].detail.model_hyper_params.thinking_enable, 0);
  assert.equal(f.api.entries[0].detail.model_hyper_params.prompt_max_tokens, 128000);
});

test('repeating sync does not create duplicates or rewrite unchanged models', async t => {
  const f = setup(t); await f.sync(); const writes = f.api.writes.length;
  await f.sync(); assert.equal(f.api.writes.length, writes); assert.equal(f.api.entries.length, 2);
});

test('catalog metadata changes update the existing Trae model ID', async t => {
  const f = setup(t); await f.sync(); const id = f.api.entries[0].id;
  f.write([{ ...models[0], context: 256000, images: false, efforts: ['high', 'max'] }, models[1]]);
  await f.sync(); assert.equal(f.api.entries[0].id, id);
  assert.equal(f.api.entries[0].detail.multimodal, false);
  assert.equal(f.api.entries[0].detail.model_hyper_params.prompt_max_tokens, 256000);
  assert.deepEqual(f.api.entries[0].detail.model_hyper_params.reasoning_param.values, ['default', 'high', 'max']);
});

test('removing a model deletes its native entry; re-adding creates one fresh entry', async t => {
  const f = setup(t); await f.sync(); const id = f.api.entries[1].id;
  f.write([models[0]]); await f.sync(); assert.equal(f.api.entries.length, 1);
  assert.equal(f.state().entries[models[1].id], undefined);
  f.write(); await f.sync(); assert.equal(f.api.entries.length, 2);
  assert.notEqual(f.api.entries[1].id, id); assert.equal(f.api.entries[1].status, true);
});

test('metadata and status updates preserve the key by omitting ak, as the native editor does', async t => {
  const f = setup(t); await f.sync(); const ak = f.api.entries[0].ak;
  f.write([{ ...models[0], context: 256000 }]); await f.sync();
  const updates = f.api.writes.filter(w => w.method === 'update_custom_model');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(w => !Object.hasOwn(w.body, 'ak')));
  assert.equal(f.api.entries[0].ak, ak);
  assert.equal(updates[1].body.action, 'delete');
  assert.equal(f.api.entries.length, 1);
});

test('an unavailable verified credential profile prevents cloud writes', async t => {
  const f = setup(t);
  await assert.rejects(syncModels({ paths: f.paths, apiFactory: () => f.api,
    credentialFactory: () => { throw new Error('trae_credential_build_unsupported'); } }), /trae_credential_build_unsupported/);
  assert.equal(f.api.writes.length, 0);
});

test('disconnect deletes created entries and leaves unrelated providers intact', async t => {
  const f = setup(t);
  f.api.entries.push({ id: '9', model: 'mine', provider: 'mine', name: 'Mine', baseURL: 'https://example.com', status: true });
  await f.sync(); fs.writeFileSync(f.paths.control, '{}'); await f.sync();
  assert.deepEqual(f.api.entries.map(e => e.id), ['9']); assert.equal(f.api.entries[0].status, true);
  assert.deepEqual(f.state().entries, {});
});

test('adopted local entries have their original capability settings restored', async t => {
  const f = setup(t);
  const original = { id: '9', model: models[0].id, provider: 'custom_openai_compatible', name: 'Personal name',
    ak: 'original-local-marker', baseURL: 'http://127.0.0.1:3498/v1/chat/completions', status: false,
    config: { auth_type: 0 }, detail: { multimodal: false, model_hyper_params: { thinking_enable: 0 }, max_turn: 12 } };
  f.api.entries.push(copy(original)); await f.sync();
  assert.equal(f.api.entries[0].name, 'One · Magpie');
  fs.writeFileSync(f.paths.control, '{}'); await f.sync();
  assert.equal(f.api.entries[0].name, original.name);
  assert.equal(f.api.entries[0].ak, original.ak);
  assert.deepEqual(f.api.entries[0].detail, original.detail);
  assert.equal(f.api.entries[0].status, false);
});

test('manual edits in Trae are reported and preserved', async t => {
  const f = setup(t); await f.sync(); f.api.entries[0].name = 'User edit';
  const result = await f.sync(); assert.equal(f.api.entries[0].name, 'User edit');
  assert.equal(result.warnings[0].code, 'model_edited_in_trae');
});

test('disconnect preserves manually edited entries while removing untouched additions', async t => {
  const f = setup(t); await f.sync(); f.api.entries[0].name = 'User edit';
  fs.writeFileSync(f.paths.control, '{}'); const result = await f.sync();
  assert.deepEqual(f.api.entries.map(e => e.name), ['User edit']);
  assert.equal(result.warnings[0].code, 'model_edited_in_trae');
});

test('catalog removal restores an adopted original even when only name and key differ', async t => {
  const f = setup(t); await f.sync();
  const original = copy(f.api.entries[0]); original.name = 'Personal'; original.ak = 'personal-key';
  f.api.entries = [copy(original)]; fs.unlinkSync(f.paths.state); f.write([models[0]]);
  await f.sync(); f.write([]); await f.sync();
  assert.deepEqual(f.api.entries, [original]); assert.deepEqual(f.state().entries, {});
});

test('lost restoration response releases the adoption only after exact readback', async t => {
  const f = setup(t); await f.sync();
  const original = copy(f.api.entries[0]); original.name = 'Personal'; original.ak = 'personal-key';
  f.api.entries = [copy(original)]; fs.unlinkSync(f.paths.state); f.write([models[0]]);
  await f.sync(); fs.writeFileSync(f.paths.control, '{}');
  f.api.failAfter = 'update_custom_model'; await assert.rejects(f.sync(), /lost_response/);
  assert.equal(f.state().pending.release, true);
  await f.sync(); assert.deepEqual(f.api.entries, [original]); assert.deepEqual(f.state().entries, {});
});

test('lost delete response is verified and recovered without deleting unrelated models', async t => {
  const f = setup(t); await f.sync(); f.write([models[0]]);
  f.api.failAfter = 'update_custom_model'; await assert.rejects(f.sync(), /lost_response/);
  assert.equal(f.state().pending.kind, 'delete'); const writes = f.api.writes.length;
  await f.sync(); assert.equal(f.api.writes.length, writes);
  assert.deepEqual(f.api.entries.map(e => e.model), [models[0].id]); assert.equal(f.state().pending, null);
});

test('failed delete remains recoverable and refuses to delete a subsequently edited entry', async t => {
  const f = setup(t); await f.sync(); f.write([models[0]]);
  const call = f.api.call.bind(f.api); f.api.call = async () => { throw new Error('offline'); };
  await assert.rejects(f.sync(), /offline/); f.api.call = call;
  f.api.entries[1].name = 'User edit';
  await assert.rejects(f.sync(), /trae_pending_model_edited/);
  assert.equal(f.api.entries[1].name, 'User edit');
});

test('a no-op delete response never clears the journal or reports successful removal', async t => {
  const f = setup(t); await f.sync(); f.write([models[0]]);
  f.api.call = async () => ({ code: 0 });
  await assert.rejects(f.sync(), /trae_model_delete_unverified/);
  assert.equal(f.state().pending.kind, 'delete'); assert.equal(f.api.entries.length, 2);
});

test('refresh revision is stable without changes and changes after catalog removal', async t => {
  const f = setup(t); const first = await f.sync(), repeated = await f.sync();
  assert.match(first.revision, /^[a-f0-9]{64}$/); assert.equal(first.revision, repeated.revision);
  f.write([models[0]]); const removed = await f.sync(); assert.notEqual(removed.revision, first.revision);
});

test('a credential edit in Trae is preserved and reported before any update', async t => {
  const f = setup(t); await f.sync(); const writes = f.api.writes.length;
  f.api.entries[0].ak = 'user-changed-local-key';
  const result = await f.sync();
  assert.equal(f.api.writes.length, writes);
  assert.equal(f.api.entries[0].ak, 'user-changed-local-key');
  assert.equal(result.warnings[0].code, 'model_edited_in_trae');
});

test('version 1 journal upgrades the local marker without duplicating native IDs', async t => {
  const f = setup(t); await f.sync();
  const state = f.state(); state.version = 1;
  for (const entry of f.api.entries) {
    entry.ak = 'old-development-marker';
    state.entries[entry.model].last = JSON.stringify({ model: entry.model, name: entry.name,
      baseURL: entry.baseURL, status: entry.status, detail: entry.detail });
  }
  fs.writeFileSync(f.paths.state, JSON.stringify(state));
  const ids = f.api.entries.map(e => e.id);
  const result = await f.sync();
  assert.deepEqual(result.warnings, []); assert.equal(f.state().version, 2);
  assert.deepEqual(f.api.entries.map(e => e.id), ids);
  assert.equal(f.api.entries[0].ak, modelRequest(models[0], '', fixtureAK).ak);
});

test('eventually consistent native catalog is read back before confirming an update', async t => {
  const f = setup(t); await f.sync();
  const stale = copy(f.api.entries), originalList = f.api.list.bind(f.api);
  let staleReads = 0;
  const call = f.api.call.bind(f.api);
  f.api.call = async (...args) => { const result = await call(...args); staleReads = 1; return result; };
  f.api.list = async () => staleReads-- > 0 ? copy(stale) : originalList();
  f.write([{ ...models[0], context: 256000 }, models[1]]);
  const result = await f.sync();
  assert.deepEqual(result.warnings, []); assert.equal(f.state().pending, null);
  assert.equal(f.api.entries[0].detail.model_hyper_params.prompt_max_tokens, 256000);
});

test('account changes never apply another account journal', async t => {
  const f = setup(t); await f.sync(); const count = f.api.writes.length;
  f.api.session.account = 'different-account';
  await assert.rejects(f.sync(), /trae_account_changed/); assert.equal(f.api.writes.length, count);
});

test('lost create response is recovered without duplicate creation', async t => {
  const f = setup(t); f.api.failAfter = 'add_custom_model';
  await assert.rejects(f.sync(), /lost_response/); assert.equal(f.state().pending.kind, 'add');
  await f.sync(); assert.equal(f.api.entries.length, 2); assert.equal(f.state().pending, null);
});

test('lost update response is recovered rather than mistaken for a manual edit', async t => {
  const f = setup(t); await f.sync(); f.write([{ ...models[0], context: 256000 }, models[1]]);
  f.api.failAfter = 'update_custom_model'; await assert.rejects(f.sync(), /lost_response/);
  const result = await f.sync(); assert.deepEqual(result.warnings, []);
  assert.equal(f.api.entries[0].detail.model_hyper_params.prompt_max_tokens, 256000);
});

test('corrupt control or state is unknown and causes no cloud mutation', async t => {
  const f = setup(t); fs.writeFileSync(f.paths.control, '{bad');
  await assert.rejects(f.sync(), /sync_file_unreadable/); assert.equal(f.api.writes.length, 0);
  f.write(); fs.writeFileSync(f.paths.state, '{bad');
  await assert.rejects(f.sync(), /sync_file_unreadable/); assert.equal(f.api.writes.length, 0);
});

test('failed authoritative catalog read leaves cloud configuration unchanged', async t => {
  const f = setup(t); f.api.list = async () => { throw new Error('unreadable_catalog'); };
  await assert.rejects(f.sync(), /unreadable_catalog/); assert.equal(f.api.writes.length, 0);
});

test('native API sends the verified endpoint, headers and structured request body', async () => {
  let sent;
  const profile = { key: Buffer.alloc(32, 0x61), aad: Buffer.from('fixture') };
  const api = new TraeAPI({ account: 'fixture', headers: { Authorization: 'fixture-only' } }, { request: async (url, options) => {
    sent = { url, options }; return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }, encodeEmptySecret: () => encodeCredential('', profile) });
  const body = modelRequest(models[0], 'http://127.0.0.1:3498/v1/chat/completions', fixtureAK);
  await api.call('add_custom_model', body);
  assert.equal(sent.url, 'https://trae-api-cn.mchost.guru/api/ide/v1/add_custom_model');
  const encoded = JSON.parse(sent.options.body);
  assert.equal(decodeCredential(encoded.sk, profile), '');
  assert.deepEqual({ ...encoded, sk: '' }, body); assert.equal(body.sk, '');
  assert.equal(sent.options.redirect, 'error');
  const update = { action: 'update', id: 100, sk: '' };
  await api.call('update_custom_model', update);
  assert.equal(decodeCredential(JSON.parse(sent.options.body).sk, profile), '');
  assert.equal(Object.hasOwn(JSON.parse(sent.options.body), 'ak'), false);
  await api.call('update_custom_model', { action: 'delete', id: 100 });
  assert.equal(Object.hasOwn(JSON.parse(sent.options.body), 'sk'), false);
  await assert.rejects(api.call('delete_everything', {}), /unsupported_trae_operation/);
});

test('old entries receive one SK-format repair, with unchanged IDs and manual edits preserved', async t => {
  const f = setup(t); await f.sync(); const state = f.state();
  for (const entry of Object.values(state.entries)) delete entry.credentialFormat;
  fs.writeFileSync(f.paths.state, JSON.stringify(state));
  f.api.entries[1].name = 'User edit';
  const before = copy(f.api.entries), writes = f.api.writes.length;
  const result = await f.sync();
  assert.deepEqual(f.api.entries, before);
  assert.equal(f.api.writes.length, writes + 1);
  assert.equal(f.state().entries[models[0].id].credentialFormat, 2);
  assert.equal(f.state().entries[models[1].id].credentialFormat, undefined);
  assert.equal(result.warnings[0].code, 'model_edited_in_trae');
  await f.sync(); assert.equal(f.api.writes.length, writes + 1);
});

test('a lost SK-format repair response is replayed because the catalog omits SK', async t => {
  const f = setup(t); await f.sync(); const state = f.state();
  delete state.entries[models[0].id].credentialFormat;
  fs.writeFileSync(f.paths.state, JSON.stringify(state));
  f.api.failAfter = 'update_custom_model'; await assert.rejects(f.sync(), /lost_response/);
  const writes = f.api.writes.length;
  await f.sync(); assert.equal(f.api.writes.length, writes + 1);
  assert.equal(f.state().pending, null);
  assert.equal(f.state().entries[models[0].id].credentialFormat, 2);
  await f.sync(); assert.equal(f.api.writes.length, writes + 1);
});

test('native API rejects unknown catalog shape and per-function errors', async () => {
  for (const payload of [{}, { function_configs: [{ error_code: 2001 }] }]) {
    const api = new TraeAPI({ account: 'fixture', headers: {} }, { request: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(api.list(), /trae_catalog/);
  }
});

test('session reads use the real client shape and reject expired or ambiguous identities', t => {
  const f = setup(t); const roaming = path.join(f.root, 'roaming'), local = path.join(f.root, 'local');
  const storage = path.join(roaming, 'Trae CN/User/globalStorage/storage.json');
  const product = path.join(local, 'Programs/Trae CN/resources/app/product.json');
  fs.mkdirSync(path.dirname(storage), { recursive: true }); fs.mkdirSync(path.dirname(product), { recursive: true });
  fs.writeFileSync(product, '{"appVersion":"fixture-version"}');
  const jwt = exp => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.fixture`;
  const save = (exp, extra = {}) => fs.writeFileSync(storage, JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: jwt(exp), userId: 'fixture-user' }),
    'iCubeAuthInfo://icube-dc:12345678': 'fixture', ...extra }));
  save(Math.floor(Date.now() / 1000) + 600);
  const session = readSession({ roaming, local });
  assert.equal(session.headers['x-app-version'], 'fixture-version'); assert.equal(session.headers['x-device-id'], '12345678');
  save(1); assert.throws(() => readSession({ roaming, local }), /trae_sign_in_expired/);
  save(Math.floor(Date.now() / 1000) + 600, { 'iCubeAuthInfo://icube-dc:87654321': 'fixture' });
  assert.throws(() => readSession({ roaming, local }), /trae_device_unavailable/);
});

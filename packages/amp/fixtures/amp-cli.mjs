#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.env.AMP_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === 'account') {
  console.log(JSON.stringify({ accounts: [{ userID: state.user, active: true, email: 'fixture@example.invalid' }] }));
  process.exit(0);
}
const action = args[2];
if (action === 'list') { console.log(JSON.stringify(state.routes)); process.exit(0); }
state.mutations.push({ action, args });
const id = args[3];
let route = state.routes.find(row => row.id === id);
if (action === 'add-router') {
  if (!args.includes('--personal') || !args.includes('--no-active')) process.exit(9);
  route = { id: `fixture-${state.routes.length}`, name: value('--name'), type: 'model_provider_custom_url', active: false, priority: state.routes.length, hasWarnings: false,
    config: { apiFormat: value('--api-format'), baseURL: value('--base-url'), modelMapping: value('--model-mapping'), headers: [], queryParams: {} } };
  state.routes.push(route);
} else if (action === 'edit-router') {
  if (!route) process.exit(10);
  for (const [flag, field] of [['--base-url', 'baseURL'], ['--model-mapping', 'modelMapping']]) if (args.includes(flag)) route.config[field] = value(flag);
} else if (action === 'activate' || action === 'deactivate') {
  if (!route) process.exit(11);
  route.active = action === 'activate';
  if (action === 'activate' && state.postActivateShadow) {
    state.routes[0].config.modelMapping = route.config.modelMapping.split(' -> ')[0];
    state.postActivateShadow = false;
  }
} else process.exit(12);
if (args.includes('--api-key-file')) {
  const key = fs.readFileSync(0, 'utf8').trim();
  state.keyHashes ??= {};
  state.keyHashes[route.id] = createHash('sha256').update(key).digest('hex');
}
if (action === 'edit-router' && state.failEditOnce) {
  state.failEditOnce = false;
  save();
  process.exit(14);
}
if (action === 'add-router' && state.failCreateOnce) {
  state.failCreateOnce = false;
  save();
  process.exit(13);
}
save();
console.log(JSON.stringify({ id: route.id }));

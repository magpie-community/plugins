// Octop as a Magpie agent.
//
// Octop is a local, self-hosted coding agent. Its LLM providers live in
// ~/.octop/octop.db (SQLite) and its HTTP API listens on ~/.octop/config.json
// (default 127.0.0.1:8088). This plugin registers Magpie's gateway as an Octop
// provider named "magpie" and points Octop's active model at the model chosen
// here.
//
// This file is evaluated inside Magpie's sandbox: it must stay import-free and
// export only `agent` and `connect`. The work that touches Octop's database and
// HTTP API lives in the shared-host adapter (index.mjs + adapter.mjs).
export const agent = {
  id: 'octop',
  name: 'Octop',
  // The one file Magpie edits. Magpie writes the selected model here (below),
  // the gateway address/key and the exposed model list come from `connect`.
  config: '~/.config/magpie-octop/connection.json',
  format: 'json',
  model: 'model',
  // Octop's home directory tells Magpie whether Octop is installed.
  dir: '~/.octop',
  ua: ['Octop'],
  notice: 'Connects to a local Octop. Keep Octop running: the plugin writes a "magpie" provider and switches Octop\'s active model; disconnecting restores it.',
};

export function connect({ gateway, models }) {
  return {
    enabled: true,
    'gateway.url': gateway.v1,
    'gateway.key': gateway.key,
    models: models || [],
  };
}

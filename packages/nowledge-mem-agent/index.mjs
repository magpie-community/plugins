import { startAdapter } from './lib/runtime.mjs';

const STARTED=Symbol.for('magpie.nowledge-mem.adapter.v1');

// Only export the plugin: Magpie treats every exported function as a plugin.
export default async function NowledgeMemAgent(input,options) {
  if(!globalThis[STARTED]){await startAdapter(input,options);globalThis[STARTED]=true;}
  return {};
}

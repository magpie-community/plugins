// Opt-in local contract check. Refuses to run against an enabled/configured
// instance; creates and removes one temporary provider, without model calls.
import assert from 'node:assert/strict';
import { createAPI } from '../lib/api.mjs';
import { providerConfig } from '../lib/selection.mjs';

const api=createAPI({apiUrl:process.env.NMEM_API_URL || 'http://127.0.0.1:14242',apiKey:process.env.NMEM_API_KEY});
const before=await api('/remote-llm/config');
const spec=await api('/openapi.json');
console.log('Nowledge service version:',spec.info?.version||'unknown');
if(process.argv.includes('--read-only')){
  assert.equal(typeof before.enabled,'boolean');
  for(const purpose of ['default','ai_now','background'])assert.ok(before.purposes?.[purpose]&&Object.hasOwn(before.purposes[purpose],'provider')&&Object.hasOwn(before.purposes[purpose],'model'));
  assert.ok(Object.values(before.providers||{}).some(p=>p.provider_type==='magpie'),'Read-only check requires an existing native Magpie provider');
  console.log('PASS: read-only config shape and native Magpie provider confirmed; no writes.');
  process.exit(0);
}
assert.equal(before.enabled,false,'Contract check requires disabled Remote mode');
assert.ok(!Object.values(before.providers || {}).some(p=>p.model||p.has_api_key||p.api_base),'Contract check requires no configured providers (empty legacy placeholders are allowed)');
assert.ok(!before.active_provider&&!before.provider,'Contract check requires no active provider');
const provider=`magpie:agent-contract-${Date.now()}`;
try {
  const body=providerConfig({model:'contract/model',gateway:{baseURL:'http://127.0.0.1:3425/v1',key:'magpie-nowledge-mem-contract-only'},metadata:{context:65536,output:4096,images:true}},provider);
  await api('/remote-llm/config',body);
  const after=await api('/remote-llm/config');
  assert.equal(after.enabled,false);
  assert.equal(after.active_provider,provider,'First provider auto-activation contract');
  assert.equal(after.providers[provider].provider_type,'magpie');
  assert.equal(after.providers[provider].model,'contract/model');
  assert.equal(after.providers[provider].context_window,65536);
  assert.equal(after.providers[provider].max_tokens,4096);
  assert.equal(after.providers[provider].has_api_key,true);
  assert.equal(after.providers[provider].api_key,undefined,'List API must mask keys');
  console.log('PASS: native Magpie provider instance, scoped metadata, masked key, first-provider auto-activation, Remote mode preserved.');
} finally {
  const current=await api('/remote-llm/config');
  if(current.providers?.[provider])await api('/remote-llm/provider/remove',{provider});
  const after=await api('/remote-llm/config');
  assert.equal(after.enabled,before.enabled);assert.equal(after.active_provider,before.active_provider);
  assert.deepEqual(after.purposes,before.purposes);assert.deepEqual(after.providers,before.providers);
  console.log('PASS: temporary provider removed; original active provider, mode and purpose assignments restored.');
}

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAPI, normalizeURL } from './api.mjs';
import { readJSON, writeJSON, withLock } from './files.mjs';
import { selectionFrom, providerConfig } from './selection.mjs';

const PURPOSES = ['default','ai_now','background'];
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const pair = (p) => ({provider:p?.provider || null,model:p?.model || null});
function currentPair(config,purpose) {
  return pair(config.purposes?.[purpose] ?? (purpose === 'default' ? {provider:config.active_provider || config.provider,model:config.model} : {}));
}
function fingerprint(p) {
  if (!p) return null;
  return {provider_type:p.provider_type || 'magpie',model:p.model,api_base:p.api_base?.replace(/\/+$/,''),api_format:p.api_format || 'chat_completions',context_window:p.context_window ?? null};
}
function owns(entry,current) {
  return !entry.released && [entry.applied,entry.pending, ...(!entry.applied ? [entry.before] : [])].filter(Boolean).some(x=>equal(x,current));
}
function validConfig(config) {
  const assignment=p=>p&&typeof p==='object'&&!Array.isArray(p)&&Object.hasOwn(p,'provider')&&Object.hasOwn(p,'model');
  if (!config || typeof config.enabled !== 'boolean' || !Object.hasOwn(config,'providers') || Array.isArray(config.providers) || !PURPOSES.every(p=>assignment(config.purposes?.[p]))) throw new Error('Unsupported Nowledge config response; no changes made.');
}

export async function synchronize(rawSelection,options) {
  const selection = selectionFrom(rawSelection);
  const apiUrl = normalizeURL(options.apiUrl);
  if (!options.stateFile) throw new Error('stateFile is required');
  return withLock(options.stateFile,async()=>{
    let state = await readJSON(options.stateFile);
    if (state && (state.version !== 1 || state.apiUrl !== apiUrl)) throw new Error('Recovery journal belongs to a different backend or version; use its original backend.');
    if(state && (state.providerId!=='magpie:nowledge-agent' || typeof state.original?.enabled!=='boolean' || !state.provider || !state.enabled || !PURPOSES.every(p=>state.purposes?.[p]?.before))) throw new Error('Invalid recovery journal; preserve it and recover with the original adapter.');
    if(state?.phase==='restoring'&&selection) throw new Error('An interrupted restore is pending. Run cli.mjs restore before reconnecting.');
    if (!selection && !state) return {status:'disconnected',conflicts:[]};
    const api = createAPI({...options,apiUrl});
    let config = await api('/remote-llm/config');
    validConfig(config);
    const save = () => writeJSON(options.stateFile,state);
    if (!state) {
      const providerId = 'magpie:nowledge-agent';
      if (config.providers?.[providerId]) throw new Error(`Provider ${providerId} already exists; refusing to overwrite it.`);
      const hasConfiguredProvider=Object.values(config.providers || {}).some(p=>p?.model||p?.has_api_key||p?.api_base);
      if (!currentPair(config,'default').provider && hasConfiguredProvider) throw new Error('No default provider is selected, but other configured providers exist. Select an original default in Nowledge first so it can be restored reliably.');
      state = {version:1,apiUrl,providerId,original:{enabled:config.enabled,activeProvider:config.active_provider || config.provider || null},purposes:{},provider:{applied:null,pending:null,digest:null},enabled:{before:config.enabled,applied:null,pending:null}};
      for (const p of PURPOSES) state.purposes[p] = {before:currentPair(config,p),applied:null,pending:null,released:false};
      await save();
    }
    const conflicts=[];
    const markConflict = async(p) => {state.purposes[p].released=true;conflicts.push(p);await save();};
    if (selection) {
      // Discover manual changes before a provider POST: updating its default
      // model may itself affect Nowledge's active default assignment.
      for(const p of PURPOSES) {
        const e=state.purposes[p];
        if(!e.released&&!owns(e,currentPair(config,p)))await markConflict(p);
      }
      const body=providerConfig(selection,state.providerId);
      const wanted=fingerprint(body);
      const stored=config.providers?.[state.providerId];
      const record=state.provider;
      if (stored && ![record.applied,record.pending].filter(Boolean).some(x=>equal(x,fingerprint(stored)))) throw new Error('Managed provider was changed manually; disconnect the Agent and recover before reconnecting.');
      const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if(state.purposes.default.released && currentPair(config,'default').provider===state.providerId && digest!==record.digest) throw new Error('Default was changed manually on the managed provider. Disconnect the Agent before changing its model.');
      if (!stored || digest !== record.digest || !equal(fingerprint(stored),wanted)) {
        // Nowledge may auto-select its first provider, and may update a default
        // model along with the provider. Journal that side effect before POST.
        for(const p of PURPOSES) {
          const e=state.purposes[p];
          if(owns(e,currentPair(config,p))) e.pending={provider:state.providerId,model:selection.model};
        }
        record.pending=wanted;await save();
        config=await api('/remote-llm/config',body);
        // Read back to use the server's canonical field values.
        config=await api('/remote-llm/config');validConfig(config);
        const confirmed=config.providers?.[state.providerId];
        if (!confirmed || confirmed.provider_type!=='magpie' || confirmed.model !== body.model || confirmed.api_base?.replace(/\/+$/,'') !== body.api_base) throw new Error('Nowledge did not retain the requested native Magpie provider configuration.');
        record.applied=fingerprint(confirmed);record.pending=null;record.digest=digest;await save();
      }
      for (const p of PURPOSES) {
        const e=state.purposes[p];
        if (e.released) {conflicts.push(p);continue;}
        const current=currentPair(config,p);
        if (!owns(e,current)) {await markConflict(p);continue;}
        const desired={provider:state.providerId,model:selection.model};
        if (!equal(current,desired)) {
          e.pending=desired;await save();
          await api('/remote-llm/purpose',{purpose:p,...desired});
          config=await api('/remote-llm/config');
          if (!equal(currentPair(config,p),desired)) throw new Error(`Nowledge did not retain the ${p} assignment.`);
        }
        if(!equal(e.applied,desired)||e.pending) {e.applied=desired;e.pending=null;await save();}
      }
      const e=state.enabled;
      if (!config.enabled && e.applied !== true) {
        e.pending=true;await save();await api('/remote-llm/enabled',{enabled:true});e.applied=true;e.pending=null;await save();
      } else if (!config.enabled && e.applied === true) conflicts.push('enabled');
      return {status:conflicts.length?'conflict':'connected',model:selection.model,conflicts};
    }

    // Recover per purpose. A journal survives every intermediate step.
    state.phase='restoring';await save();
    for (const p of PURPOSES) {
      const e=state.purposes[p];
      const current=currentPair(config,p);
      if (e.restored) continue;
      if (equal(current,e.before)) {e.restored=true;await save();continue;}
      if (!owns(e,current)) {if(!e.released)await markConflict(p);else conflicts.push(p);e.restored=true;await save();continue;}
      // The API rejects default=null. Removing our originally-first provider
      // clears that default; defer it until the other purposes are restored.
      if (p==='default' && !e.before.provider) {e.clearByRemoval=true;await save();continue;}
      e.pending=e.before;await save();
      await api('/remote-llm/purpose',{purpose:p,...e.before});
      config=await api('/remote-llm/config');
      if (!equal(currentPair(config,p),e.before)) throw new Error(`Nowledge did not restore ${p}.`);
      e.restored=true;e.pending=null;await save();
    }
    config=await api('/remote-llm/config');
    const enabled=state.enabled;
    const active=config.active_provider || config.provider || null;
    const clearDefault=state.purposes.default.clearByRemoval && owns(state.purposes.default,currentPair(config,'default'));
    const defaultRestored=equal(currentPair(config,'default'),state.purposes.default.before) || clearDefault;
    // Never switch off remote mode underneath a user's new default provider.
    if (defaultRestored && (enabled.applied !== null || enabled.pending !== null) && [enabled.applied,enabled.pending].includes(config.enabled) && config.enabled !== enabled.before) {
      await api('/remote-llm/enabled',{enabled:enabled.before});
    }
    const stored=config.providers?.[state.providerId];
    const referenced=Object.entries(config.purposes || {}).some(([name,p])=>p?.provider === state.providerId && !(name==='default'&&clearDefault)) || (active === state.providerId && !clearDefault);
    if (stored && !referenced && [state.provider.applied,state.provider.pending].filter(Boolean).some(x=>equal(x,fingerprint(stored)))) await api('/remote-llm/provider/remove',{provider:state.providerId});
    else if (stored) conflicts.push('provider-retained');
    if(clearDefault) {
      const checked=await api('/remote-llm/config');
      if(!equal(currentPair(checked,'default'),state.purposes.default.before)) throw new Error('Cannot clear the original empty default while the provider is retained. Remove its new references or restore its original connection fields, then retry restore.');
    }
    await fs.rm(options.stateFile,{force:true});
    return {status:'disconnected',conflicts};
  });
}

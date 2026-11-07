import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readJSON, writeJSON } from './files.mjs';
import { synchronize } from './sync.mjs';
import { createAPI, normalizeURL } from './api.mjs';

export const defaultDirectory = path.join(homedir(),'.config','magpie-nowledge-mem');
const expand = p => path.resolve(p.startsWith('~/') ? path.join(homedir(),p.slice(2)) : p);
const hash = text => createHash('sha256').update(text).digest('hex');

export async function settings(options = {}) {
  const file = process.env.MAGPIE_NOWLEDGE_CONFIG || path.join(defaultDirectory,'adapter.json');
  const local = await readJSON(expand(file)) || {};
  const config = {...local,...options};
  const selectionFile = expand(config.selectionFile || path.join(defaultDirectory,'selection.json'));
  const directory = path.dirname(selectionFile);
  const apiUrl = normalizeURL(config.apiUrl || process.env.NMEM_API_URL || 'http://127.0.0.1:14242');
  let apiKey = process.env.NMEM_API_KEY || '';
  if (config.apiKeyFile) apiKey = (await fs.readFile(expand(config.apiKeyFile),'utf8')).trim();
  if (typeof config.pollMs !== 'undefined' && (!Number.isSafeInteger(config.pollMs) || config.pollMs<500 || config.pollMs>60000)) throw new Error('pollMs must be an integer from 500 to 60000.');
  return {apiUrl,apiKey,selectionFile,stateFile:path.join(directory,'state.json'),statusFile:path.join(directory,'status.json'),pauseFile:path.join(directory,'paused.json'),pollMs:config.pollMs || 2000,timeoutMs:10000};
}

export async function selectionText(file) {
  try { await fs.chmod(file,0o600);return await fs.readFile(file,'utf8'); }
  catch(error) { if(error.code==='ENOENT')return '';throw error; }
}

export async function runOnce(config, {restore=false,resume=false}={}) {
  const text = await selectionText(config.selectionFile);
  if(restore) await writeJSON(config.pauseFile,{selectionHash:hash(text)});
  if(resume) await fs.rm(config.pauseFile,{force:true});
  const pause=await readJSON(config.pauseFile);
  if(!restore && pause?.selectionHash===hash(text)) return {status:'paused',conflicts:[]};
  if(pause&&!restore) await fs.rm(config.pauseFile,{force:true});
  const selection=restore||!text.trim()?null:JSON.parse(text);
  const result=await synchronize(selection,config);
  const last=await readJSON(config.statusFile);
  const {updatedAt,...previous}=last || {};
  if(JSON.stringify(previous)!==JSON.stringify(result)) await writeJSON(config.statusFile,{...result,updatedAt:new Date().toISOString()});
  return result;
}

export async function status(config) {
  const journal=await readJSON(config.stateFile);
  const last=await readJSON(config.statusFile);
  const paused=!!await readJSON(config.pauseFile);
  const api=createAPI(config);
  const c=await api('/remote-llm/config');
  return {apiUrl:config.apiUrl,selectionFile:config.selectionFile,recoveryPending:!!journal,paused,last,enabled:c.enabled,purposes:Object.fromEntries(['default','ai_now','background'].map(p=>[p,{provider:c.purposes?.[p]?.provider??null,model:c.purposes?.[p]?.model??null}]))};
}

export async function startAdapter(input, options) {
  const initial=await settings(options);
  const directory=path.dirname(initial.selectionFile);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  // Only tighten our own standard directory; do not chmod arbitrary parents
  // supplied by an integrator through selectionFile.
  if(directory===defaultDirectory)await fs.chmod(directory,0o700);
  let stopped=false, timer, previousText, previousMessage='';
  const log=(level,message)=>{
    if(message===previousMessage)return;
    previousMessage=message;
    try { input?.client?.app?.log?.({body:{service:'nowledge-agent',level,message}})?.catch?.(()=>{}); } catch {}
  };
  const tick=async()=>{
    let delay=2000;
    try {
      const config=await settings(options);delay=config.pollMs;
      const text=await selectionText(config.selectionFile);
      // Magpie patches individual keys. Wait for a full quiet polling period
      // before interpreting a newly changed selection.
      if(text!==previousText){previousText=text;return;}
      const result=await runOnce(config);
      log(result.conflicts.length?'warn':'info',`nowledge-agent: ${result.status}${result.model?` · ${result.model}`:''}${result.conflicts.length?` · conflicts: ${result.conflicts.join(', ')}`:''}`);
    } catch(error) {
      // Errors from our API wrapper contain no server body or credentials.
      const message=error instanceof SyntaxError?'Selection/config JSON is incomplete; waiting for a valid file.':error.code==='ENOENT'?'A configured credential file is missing.':error.message;
      log('warn',`nowledge-agent: ${message}`);
    } finally {
      if(!stopped){timer=setTimeout(tick,delay);timer.unref?.();}
    }
  };
  // Init must finish before a backend is available; no network in this call.
  timer=setTimeout(tick,0);timer.unref?.();
  return ()=>{stopped=true;clearTimeout(timer);};
}

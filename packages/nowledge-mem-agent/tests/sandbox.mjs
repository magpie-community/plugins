import path from 'node:path';
import {homedir,userInfo} from 'node:os';

const callerHome=homedir();
let accountHome=callerHome;
try{accountHome=userInfo().homedir;}catch{}

export function assertSandboxEnvironment(env,root){
  const contains=p=>{
    if(typeof p!=='string')return false;
    const relative=path.relative(path.resolve(root),path.resolve(p));
    return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
  };
  if(!contains(env.HOME)||[callerHome,accountHome].some(p=>path.resolve(p)===path.resolve(env.HOME)))throw Error('Refusing real HOME: the smoke test requires its own sandbox home.');
  for(const key of ['XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME'])if(!contains(env[key]))throw Error(`${key} must stay inside the smoke sandbox.`);
}

export function sandboxEnvironment(root,base=process.env){
  const smokeHome=path.join(root,'home');
  // Configure only a child process's actual home; never mutate the caller's
  // process.env or use its HOME as a scratch directory.
  const env={...base,HOME:smokeHome,USERPROFILE:smokeHome,APPDATA:path.join(smokeHome,'AppData','Roaming'),LOCALAPPDATA:path.join(smokeHome,'AppData','Local'),XDG_CONFIG_HOME:path.join(smokeHome,'.config'),XDG_CACHE_HOME:path.join(smokeHome,'.cache'),XDG_DATA_HOME:path.join(smokeHome,'.local','share'),MAGPIE_NO_ACCOUNTS:'1',DO_NOT_TRACK:'1',NMEM_API_KEY:''};
  for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','PI_CODING_AGENT_DIR'])delete env[key];
  assertSandboxEnvironment(env,root);
  return env;
}

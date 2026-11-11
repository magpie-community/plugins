import {test} from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {sandboxEnvironment,assertSandboxEnvironment} from './tests/sandbox.mjs';

test('smoke environment isolates all homes and leaves the caller unchanged',()=>{
  const original=process.env.HOME;const root=path.join(tmpdir(),'nowledge-sandbox-check');
  const env=sandboxEnvironment(root,{...process.env,CODEX_HOME:'/real/codex',CLAUDE_CONFIG_DIR:'/real/claude'});
  assert.equal(env.HOME,path.join(root,'home'));assert.equal(process.env.HOME,original);
  assert.equal(env.CODEX_HOME,undefined);assert.equal(env.CLAUDE_CONFIG_DIR,undefined);
  assert.equal(env.MAGPIE_NO_ACCOUNTS,'1');
  assertSandboxEnvironment(env,root);
});

test('smoke refuses a real home or escaped config/cache directory',()=>{
  const root=path.join(tmpdir(),'nowledge-sandbox-check');const env=sandboxEnvironment(root);
  assert.throws(()=>assertSandboxEnvironment({...env,HOME:homedir()},root),/Refusing real HOME/);
  assert.throws(()=>assertSandboxEnvironment({...env,XDG_CONFIG_HOME:path.join(homedir(),'.config')},root),/XDG_CONFIG_HOME/);
  assert.throws(()=>assertSandboxEnvironment({...env,XDG_CACHE_HOME:root},root),/XDG_CACHE_HOME/);
  assert.throws(()=>assertSandboxEnvironment({...env,XDG_CACHE_HOME:path.dirname(root)},root),/XDG_CACHE_HOME/);
});

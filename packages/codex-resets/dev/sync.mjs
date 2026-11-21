#!/usr/bin/env node
// Development-only fixture/smoke helper; excluded from the published package.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { syncOnce } from '../sync-core.mjs';
const run = promisify(execFile);
const HELP = `Codex reset news — development smoke check (Node 22+ or Bun)
Usage: node dev/sync.mjs [--magpie PATH] [--plugin NAME]

Fetches https://codex-resets.com/api/v1/status, then uses only
magpie plugin options NAME to publish public data to the page.
One check in a dedicated test HOME. This is not an end-user sync workflow.
Production automatic sync is blocked on yetone/magpie#3609.
Data from https://codex-resets.com (community tracking, not guaranteed).
`;
export function args(argv) {
  const out = { magpie: 'magpie', plugin: 'codex-resets' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--magpie' || a === '--plugin') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error(`Missing value for ${a}`);
      out[a.slice(2)] = v;
    } else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}
export function parseOptions(text) {
  const clean = text.trim();
  if (clean === 'No options set.') return {};
  const prefix = 'No options set. Its package suggests:';
  const value = JSON.parse(clean.startsWith(prefix) ? clean.slice(prefix.length) : clean);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin options are not an object');
  return value;
}
export async function cli(argv) {
  const config = args(argv);
  if (config.help) { console.log(HELP); return; }
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const command = async (extra = []) => {
    const { stdout } = await run(config.magpie, ['plugin', 'options', config.plugin, ...extra], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, signal: ctl.signal,
    });
    return stdout;
  };
  try {
    const options = parseOptions(await command());
    const result = await syncOnce({ options, request: fetch, signal: ctl.signal, save: o => command([JSON.stringify(o)]) });
    if (result.error) { console.error(result.error); process.exitCode = 1; }
    else if (result.changed) console.log(`Updated development snapshot at ${new Date().toLocaleString()}.`);
    else console.log(`Next source check after ${new Date(result.nextCheckAt).toLocaleString()}.`);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}

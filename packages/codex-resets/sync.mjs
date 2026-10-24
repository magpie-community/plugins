#!/usr/bin/env node
// Explicit foreground helper. Importing/installing the page starts nothing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { syncOnce, INTERVAL } from './sync-core.mjs';
const run = promisify(execFile);
const HELP = `Codex reset news — explicit local sync (Node 22+ or Bun)
Usage: node sync.mjs [--watch] [--bell] [--magpie PATH] [--plugin NAME]

Fetches https://codex-resets.com/api/v1/status, then uses only
magpie plugin options NAME to publish public data to the page.
Default: one check. --watch: keep checking at most once every five minutes.
--bell: ring the terminal bell for a new, unexpired reset announcement.
Stop with Ctrl-C. This installs no background service. Turning off the page
in Magpie does not stop a helper you started separately.
No desktop notifications or interception of Magpie's reset-card dialog.
Data from https://codex-resets.com (community tracking, not guaranteed).
`;
export function args(argv) {
  const out = { watch: false, bell: false, magpie: 'magpie', plugin: 'codex-resets' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--watch') out.watch = true;
    else if (a === '--bell') out.bell = true;
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
    do {
      let next = Date.now() + INTERVAL;
      try {
        const options = parseOptions(await command());
        const result = await syncOnce({ options, signal: ctl.signal, save: o => command([JSON.stringify(o)]) });
        next = result.nextCheckAt;
        if (result.error) console.error(result.error);
        else if (result.changed) console.log(`Updated Codex reset news at ${new Date().toLocaleString()}.`);
        else if (!config.watch) console.log(`Next source check after ${new Date(next).toLocaleString()}.`);
        if (result.notice) {
          const when = result.notice.scheduledFor ? new Date(result.notice.scheduledFor).toLocaleString() : 'time not specified';
          console.log(`${config.bell ? '\x07' : ''}Codex reset announced (${when}). Community tracking; verify the source before using a reset credit.\n${result.notice.url}`);
        }
        if (result.error && !config.watch) process.exitCode = 1;
      } catch (e) {
        if (ctl.signal.aborted) break;
        console.error(`Sync failed: ${e.message}`);
        if (!config.watch) process.exitCode = 1;
      }
      if (!config.watch) break;
      await wait(Math.max(1000, next - Date.now()), undefined, { signal: ctl.signal }).catch(e => { if (!ctl.signal.aborted) throw e; });
    } while (!ctl.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}

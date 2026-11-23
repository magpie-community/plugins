import { startDashboard } from './server.mjs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

let startup;

async function firstmateDashboard(_input, options = {}) {
  // A host can ask for the same plugin more than once while it initializes.
  startup ??= startDashboard(options).catch(error => {
    startup = undefined;
    throw error;
  });
  await startup;
  return {};
}

export default { id: 'firstmate-dashboard', server: firstmateDashboard };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
  await firstmateDashboard({}, options);
  (await startup).ref();
  const children = new Set();
  let stopping = false;
  for (const route of options.syncTunnels || []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(route.host || '') || !Number.isInteger(route.port) || route.port < 1024 || route.port > 65535) throw new Error('Invalid secondmate sync tunnel');
    const connect = () => {
      if (stopping) return;
      const child = spawn('ssh', ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${route.port}:127.0.0.1:${options.port ?? 35871}`, route.host], { stdio: ['ignore', 'ignore', 'inherit'] });
      children.add(child);
      child.on('error', () => {});
      child.once('close', () => { children.delete(child); if (!stopping) setTimeout(connect, 10000).unref(); });
    };
    connect();
  }
  const stop = () => { stopping = true; for (const child of children) child.kill('SIGTERM'); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

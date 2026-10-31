import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, stateDirectory } from './state.mjs';

export async function enqueue(job) {
  const store = new Store(stateDirectory(job.o));
  const name = 'job-' + job.source;
  await store.change(name, async (current, save) => {
    if (current) return;
    if ((await store.jobs()).length >= 512) throw new Error('queue-capacity');
    await save({ ...job, status: 'queued', createdAt: new Date().toISOString(), writeAttempted: false });
  });
  wakeQueue(job.o);
}

export function wakeQueue(o) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), 'run', stateDirectory(o)],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // The encrypted queued job remains recoverable through worker.mjs run.
  child.unref();
}

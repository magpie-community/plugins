import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, stateDirectory, digest } from './state.mjs';
import { join } from 'node:path';
import { acquireLock } from './lock.mjs';

export const CONTROL_LEASE_MS = 300000;
export const controlSignature = o => digest(o.readOnly, o.archive, o.capture, o.generationBaseUrl, o.generationModel, o.authorizationEnv);
export function checkControl(job, control) {
  const created = Date.parse(job.createdAt);
  if (!Number.isFinite(created) || Date.now() - created > CONTROL_LEASE_MS || !control?.updatedAt ||
      control.updatedAt < created || Date.now() - control.updatedAt > CONTROL_LEASE_MS) throw new Error('control-expired');
  if (control.readOnly || job.o.archive && !control.archive || job.o.capture && !control.capture || control.signature !== controlSignature(job.o)) throw new Error('job-disabled');
  return control.updatedAt + CONTROL_LEASE_MS;
}

export async function enqueue(job) {
  const store = new Store(stateDirectory(job.o));
  const name = 'job-' + job.source;
  await store.key();
  const release = await acquireLock(join(store.dir, 'queue.lock'));
  let created = false;
  try {
  await store.change(name, async (current, save) => {
    if (current) return;
    let active = 0;
    for (const key of await store.jobs()) if (['queued', 'running'].includes((await store.get(key))?.status)) active++;
    if (active >= 512) throw new Error('queue-capacity');
    const acceptedAt = Date.now();
    await store.change('control-' + digest(job.account, job.o.url, job.o.project), async (control, persist) => {
      if (!control || control.readOnly || job.o.archive && !control.archive || job.o.capture && !control.capture || control.signature !== controlSignature(job.o)) throw new Error('job-disabled');
      await persist({ ...control, updatedAt: acceptedAt });
    });
    await save({ ...job, status: 'queued', createdAt: new Date(acceptedAt).toISOString(), writeAttempted: false });
    created = true;
  });
  } finally { await release(); }
  if (created) return wakeQueue(job.o);
}

export function wakeQueue(o) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), 'run', stateDirectory(o)],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // The encrypted queued job remains recoverable through worker.mjs run.
  child.unref();
  return child;
}

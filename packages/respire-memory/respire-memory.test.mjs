// CI adapter for the existing isolated checks; no production HOME or account is used.
import { test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('respire-memory existing isolated checks and detached worker', () => {
  execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' });
}, 90000);

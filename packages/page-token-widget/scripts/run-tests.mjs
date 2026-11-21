// The tests are run by a small script of our own, so that the same command
// works the same way on every platform and on every version of Node.
//
// The shell of Windows does not expand the names of the files, and Node 20
// does not expand them either, so "node --test test/*.test.mjs" works on a
// Linux machine and fails on a Windows one. Here the names are read and
// handed over one by one, which every version understands.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'test');

const names = (await readdir(folder)).filter((name) => name.endsWith('.test.mjs')).sort();
if (!names.length) {
  console.error('There is no test file in ' + folder);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...names.map((name) => path.join('test', name))], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});

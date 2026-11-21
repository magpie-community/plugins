// Checks that every source file of the plugin parses.
// The browser and Scriptable files are ES modules (they use import or a top level await),
// so each one is checked through a copy with the .mjs extension: node --check then reads
// them as modules, on every platform the same way.
import { copyFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['index.mjs', 'lib', 'test', 'ui', 'mobile', 'page', 'scriptable', 'scripts'];
const files = [];

const walk = (target) => {
  const state = statSync(target);
  if (state.isDirectory()) {
    for (const entry of readdirSync(target)) walk(path.join(target, entry));
    return;
  }
  if (target.endsWith('.mjs') || target.endsWith('.js')) files.push(target);
};

for (const root of roots) walk(root);

const scratch = mkdtempSync(path.join(tmpdir(), 'magpie-syntax-'));
let broken = 0;

files.forEach((file, index) => {
  const copy = path.join(scratch, `file-${index}.mjs`);
  copyFileSync(file, copy);
  const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  if (result.status !== 0) {
    broken += 1;
    console.error(`syntax error in ${file}`);
    console.error(result.stderr || result.stdout);
  }
});

if (broken > 0) {
  console.error(`${broken} file(s) did not parse`);
  process.exit(1);
}

console.log(`${files.length} files parsed`);

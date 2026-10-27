// magpie-community/plugins#356: the user's shared instructions went to the
// model wrapped in <magpie-kimi-shared-instructions>, so every prompt named
// the app. The tag is neutral now, and a history that still carries the old
// tag from earlier turns has it taken out, never sent twice.
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyInstructions} from './library.mjs';

function withRules(text, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-rules-'));
  try { const file = path.join(dir, 'instructions.md'); fs.writeFileSync(file, text); return run(file); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

const history = [
  {role: 'system', content: 'Kimi native system prompt'},
  {role: 'system', content: '<magpie-kimi-shared-instructions>\nold rule\n</magpie-kimi-shared-instructions>'},
  {role: 'user', content: 'fix the build'},
  {role: 'assistant', content: 'on it'},
];

test('the prompt with shared instructions names no magpie, old tag included', () => withRules('use tabs', file => {
  const out = applyInstructions({model: 'k3-agent', messages: history}, file);
  expect(JSON.stringify(out)).not.toMatch(/magpie/i);
  const shared = out.messages.filter(m => m.role === 'system' && m.content.includes('use tabs'));
  expect(shared).toEqual([{role: 'system', content: '<shared-instructions>\nuse tabs\n</shared-instructions>'}]);
  expect(out.messages.map(m => m.content)).toEqual(['Kimi native system prompt',
    '<shared-instructions>\nuse tabs\n</shared-instructions>', 'fix the build', 'on it']);
  expect(applyInstructions(out, file)).toEqual(out);
}));

test('with no shared instructions an old tagged turn is still taken out', () => withRules('', file => {
  const out = applyInstructions({model: 'k3-agent', messages: history}, file);
  expect(JSON.stringify(out)).not.toMatch(/magpie/i);
  expect(out.messages).toEqual([history[0], history[2], history[3]]);
}));

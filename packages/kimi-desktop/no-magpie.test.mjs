// magpie-community/plugins#356: the user's shared instructions went to the
// model wrapped in <magpie-kimi-shared-instructions>, so every prompt named
// the app. The tag is neutral now, and a history that still carries the old
// tag from earlier turns has it taken out, never sent twice.
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyInstructions} from './library.mjs';
import {recoveryPeer} from './test-fixtures/control-peer.mjs';

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

for (const legacy of [false, true]) {
  test(`a real bridge keeps branding out of native V2 tools and Agent history (${legacy ? 'legacy aliases' : 'neutral aliases'})`, async () => {
    const f = recoveryPeer({ secondaryModel: 'provider/secondary' });
    try {
      await f.controller.tick();
      const fixture = JSON.parse(fs.readFileSync(new URL('./test-fixtures/v2-agent-schema.json', import.meta.url), 'utf8'));
      const main = f.controller.catalog.find(row => row.id === 'provider/main').alias;
      const secondary = f.controller.catalog.find(row => row.id === 'provider/secondary').alias;
      let text = JSON.stringify(fixture.request)
        .replaceAll(fixture.expectedAliases.primary, main).replaceAll(fixture.expectedAliases.secondary, secondary);
      if (legacy) text = text.replaceAll('local-model-', 'magpie-local-');
      const request = JSON.parse(text);
      request.model = legacy ? secondary.replace('local-model-', 'magpie-local-') : secondary;
      const key = JSON.parse(fs.readFileSync(f.controller.configFile, 'utf8')).credentials.kimiCode.apiKey;
      const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      expect(response.status).toBe(200);
      await response.text();
      expect(f.requests).toHaveLength(1);
      const upstream = f.requests[0].body;
      expect(upstream.model).toBe('provider/main');
      expect(JSON.stringify(upstream)).not.toMatch(/magpie/i);
      expect(upstream.tools[0].function.parameters.properties.model.enum).toEqual(['primary', 'secondary', 'native']);
      expect(upstream.tools[0].function.description).toContain('- secondary [default]:');
      expect(upstream.tools[0].function.description).not.toContain(main);
      expect(upstream.tools[0].function.description).not.toContain(secondary);
      expect(JSON.stringify(upstream.messages)).toContain(secondary);
      const original = JSON.parse(text).tools[0].function.parameters;
      const actual = upstream.tools[0].function.parameters;
      expect(actual.required).toEqual(original.required);
      for (const [name, schema] of Object.entries(original.properties)) {
        if (name !== 'model') expect(actual.properties[name]).toEqual(schema);
      }
    } finally { await f.cleanup(); }
  });
}

test('the real bridge preserves user filenames and non-Agent data while normalizing only old Agent model identities', async () => {
  const f = recoveryPeer({ secondaryModel: 'provider/secondary' });
  try {
    await f.controller.tick();
    const row = f.controller.catalog.find(row => row.id === 'provider/secondary');
    const old = row.alias.replace('local-model-', 'magpie-local-');
    const filename = `/tmp/${old}.json`;
    const fixture = JSON.parse(fs.readFileSync(new URL('./test-fixtures/v2-agent-schema.json', import.meta.url), 'utf8'));
    const agent = structuredClone(fixture.request.tools[0]);
    agent.function.parameters.properties.prompt.description = filename;
    const readTool = { type: 'function', function: { name: 'read_file', parameters: {
      type: 'object', properties: { [old]: { type: 'string' }, path: { type: 'string' } },
    } } };
    const request = { model: 'native', tools: [agent, readTool], messages: [
      { role: 'user', content: `Read exactly ${filename}` },
      { role: 'assistant', tool_calls: [{ id: 'old-agent', type: 'function', function: { name: 'Agent',
        arguments: JSON.stringify({ model: old, prompt: `Read exactly ${filename}`, description: 'Read path' }) } }] },
      { role: 'tool', tool_call_id: 'old-agent', content: JSON.stringify({ [old]: filename }) },
    ] };
    const key = JSON.parse(fs.readFileSync(f.controller.configFile, 'utf8')).credentials.kimiCode.apiKey;
    const response = await fetch(f.controller.bridgeURL + '/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + key }, body: JSON.stringify(request) });
    expect(response.status).toBe(200); await response.text();
    const sent = f.requests.at(-1).body;
    expect(sent.messages[0]).toEqual(request.messages[0]);
    expect(sent.messages[2]).toEqual(request.messages[2]);
    expect(sent.tools[1]).toEqual(readTool);
    expect(sent.tools[0].function.parameters.properties.prompt.description).toBe(filename);
    expect(sent.tools[0].function.parameters.properties.model.enum).toEqual(['primary', 'secondary', 'native']);
    expect(JSON.parse(sent.messages[1].tool_calls[0].function.arguments))
      .toEqual({ model: row.alias, prompt: `Read exactly ${filename}`, description: 'Read path' });
  } finally { await f.cleanup(); }
});

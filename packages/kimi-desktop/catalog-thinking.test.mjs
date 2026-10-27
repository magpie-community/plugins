import {test, expect} from 'bun:test';
import {normalizeModels, mergeRuntimeModels} from './catalog.mjs';

const row = (id, reasoning, efforts) => ({id: 'fixture/' + id, reasoning,
  supported_reasoning_levels: efforts.map(effort => ({effort}))});

test.each([
  ['required', true, ['low', 'high', 'max'], true],
  ['single-required-level', true, ['high'], true],
  ['duplicate-required-level', true, ['high', 'high'], true],
  ['toggle', true, ['none', 'low', 'high'], false],
  ['unknown-levels', true, [], false],
  ['unrecognized-off', true, ['off', 'high'], false],
  ['future-level', true, ['future', 'high'], false],
  ['no-thinking', false, ['high'], false],
])('thinking capability: %s', (id, reasoning, efforts, always) => {
  const model = normalizeModels({data: [row(id, reasoning, efforts)]})[0];
  expect(model.runtime.capabilities.includes('thinking')).toBe(reasoning);
  expect(model.runtime.capabilities.includes('always_thinking')).toBe(always);
  expect(model.menu.daimonModelConfig.capabilities).toEqual(model.runtime.capabilities);
  expect(model.menu.daimonModelConfig.supportEfforts).toEqual(model.runtime.supportEfforts ?? []);
  if (efforts.includes('none')) {
    expect(model.runtime.supportEfforts).toContain('none');
    expect(model.menu.reasoningEffortOptions.some(e => e.reasoningEffort === 'none')).toBe(true);
  }
});

test('capability refresh replaces only adapter models and retains native thinking settings', () => {
  const required = normalizeModels({data: [row('required', true, ['low', 'high', 'max'])]});
  const native = {model: 'native-model', capabilities: ['thinking'], defaultEffort: 'max', user: true};
  const obsolete = {...required[0].runtime, capabilities: ['thinking']};
  const merged = mergeRuntimeModels([native, obsolete], required);
  expect(merged[0]).toBe(native);
  expect(merged[1].capabilities).toContain('always_thinking');
  expect(merged).toHaveLength(2);
  const toggle = normalizeModels({data: [row('required', true, ['none', 'high'])]});
  expect(mergeRuntimeModels(merged, toggle)[1].capabilities).not.toContain('always_thinking');
});

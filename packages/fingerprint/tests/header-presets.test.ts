import { expect, test } from 'bun:test';
import { headerPresets, presetHeaderText } from '../src/header-presets';
import { parseRequestHeaders } from '../src/request-headers';

test('every client preset produces valid, bounded inference headers with source provenance', () => {
  for (const id of ['codex-cli', 'claude-code', 'opencode', 'cline', 'roo-code'])
    expect(headerPresets.some((preset) => preset.id === id)).toBe(true);
  expect(new Set(headerPresets.map((preset) => preset.id)).size).toBe(headerPresets.length);
  for (const preset of headerPresets) {
    const headers = parseRequestHeaders(presetHeaderText(preset));
    expect(Object.keys(headers).length).toBeGreaterThan(0);
    expect(headers).toEqual(
      Object.fromEntries(
        Object.entries(preset.headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    );
    expect(preset.name).toBeTruthy();
    expect(preset.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(preset.sources.length).toBeGreaterThan(0);
    for (const source of preset.sources) expect(new URL(source).protocol).toBe('https:');
  }
});

test('identity presets exclude ephemeral sessions, SDK runtime claims and protocol feature opt-ins', () => {
  for (const preset of headerPresets) {
    const names = Object.keys(parseRequestHeaders(presetHeaderText(preset)));
    for (const name of names) {
      expect(name).not.toMatch(/session|request-id|trace|^x-stainless-/);
      expect(name).not.toBe('anthropic-beta');
      expect(name).not.toBe('openai-beta');
    }
  }
});

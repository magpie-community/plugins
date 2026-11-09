import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../current-turn-images.middleware.js';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
for (const fixture of cases) {
  test(fixture.name, t => {
    t.mock.method(console, 'log', () => {});
    const body = structuredClone(fixture.request);
    const ctx = {protocol: fixture.protocol, state: {}, options: {}};
    const result = onRequest(body, ctx);
    const actual = result === undefined ? body : result;
    assert.deepEqual(actual, fixture.expected);
    assert.deepEqual(body, fixture.request, 'caller input is unchanged');
    const again = onRequest(structuredClone(actual), ctx);
    assert.deepEqual(again === undefined ? actual : again, fixture.expected, 'filter is idempotent');
  });
}

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
  for (const [scenario, expected] of [
    ['historical image removed and current images retained', {removedImages: 1, affectedMessages: 1, placeholderMessages: 0, keptCurrentImages: 2}],
    ['image-only historical message gets marker', {removedImages: 1, affectedMessages: 1, placeholderMessages: 1, keptCurrentImages: 2}],
    ['first turn retained', {removedImages: 0, affectedMessages: 0, placeholderMessages: 0, keptCurrentImages: 2}],
    ['three turns', {removedImages: 2, affectedMessages: 2, placeholderMessages: 0, keptCurrentImages: 2}],
  ]) {
    test(protocol + ' - logs ' + scenario, t => {
      const logger = t.mock.method(console, 'log', () => {});
      const fixture = cases.find(c => c.name === protocol + ' - ' + scenario);
      const result = onRequest(structuredClone(fixture.request), {protocol});
      assert.deepEqual(result === undefined ? fixture.request : result, fixture.expected);
      assert.equal(logger.mock.callCount(), 1);
      const [line] = logger.mock.calls[0].arguments;
      assert.ok(line.startsWith('[current-turn-images] '));
      assert.deepEqual(JSON.parse(line.slice('[current-turn-images] '.length)), {protocol, ...expected});
    });
  }
}

test('unknown protocol and unrecognized history produce no image record', t => {
  const logger = t.mock.method(console, 'log', () => {});
  for (const fixture of cases.filter(c => ['unknown protocol', 'null body', 'array body', 'responses - string input'].includes(c.name))) {
    assert.equal(onRequest(structuredClone(fixture.request), {protocol: fixture.protocol}), undefined);
  }
  assert.equal(logger.mock.callCount(), 0);
});

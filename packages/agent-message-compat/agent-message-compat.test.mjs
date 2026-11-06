import {test} from 'bun:test';

test('agent message compatibility: 12 offline protocol checks', async () => {
  await import('./test.mjs');
});

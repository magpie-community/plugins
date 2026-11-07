import test from 'node:test';
import assert from 'node:assert/strict';

test('Agent writes the gateway supplied by Magpie and keeps model ids intact', async () => {
  const { agent, connect } = await import('../agent.js');
  assert.equal(agent.model, 'model');
  const values = connect({gateway: {v1:'http://127.0.0.1:3999/v1', key:'agent-secret'}, model: {id:'group/daily', context:100000, output:16000, images:true}});
  assert.equal(values['gateway.baseURL'], 'http://127.0.0.1:3999/v1');
  assert.equal(values['gateway.key'], 'agent-secret');
  assert.equal(values['metadata.context'], 100000);
  assert.equal(values['metadata.output'], 16000);
  assert.equal(values['metadata.images'], true);
  assert.equal(agent.prefix, undefined);
});

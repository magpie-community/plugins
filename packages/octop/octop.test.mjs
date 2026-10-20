import { expect, test } from 'bun:test'
import { agent, connect } from './octop.agent.js'

test('says where Octop keeps its model', () => {
  expect(agent).toMatchObject({
    id: 'octop',
    name: 'Octop',
    config: '~/.config/magpie-octop/connection.json',
    format: 'json',
    model: 'model',
    dir: '~/.octop',
    ua: ['Octop'],
  })
})

test('points Octop at magpie with gateway url and key', () => {
  const out = connect({
    gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-octop' },
    models: [
      { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek Flash', context: 128000, output: 8192, images: true },
    ],
    agent: { id: 'octop', config: '/home/u/.config/magpie-octop/connection.json' },
  })
  expect(out).toEqual({
    enabled: true,
    'gateway.url': 'http://127.0.0.1:3425/v1',
    'gateway.key': 'magpie-octop',
    models: [
      { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek Flash', context: 128000, output: 8192, images: true },
    ],
  })
})

test('handles empty models array', () => {
  const out = connect({
    gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-octop' },
    models: [],
    agent: { id: 'octop' },
  })
  expect(out.models).toEqual([])
})

// Request-time labels preserve stable routing IDs on the shared Qoder protocol.
import { afterEach, expect, test } from 'bun:test'
import { QoderAuthPlugin, QoderCNAuthPlugin, QwenWorkAuthPlugin, QwenWorkEnterpriseAuthPlugin, _internal } from './index.mjs'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const catalog = { kmodel_latest: 'Kimi-K3', gmodel: 'GLM-5.3', qmodel_latest: 'Qwen3.8-Max', qmodel_38max: 'Qwen3.8-Max', dfmodel: 'DeepSeek-Flash', mmodel: 'MiniMax-M3.1-Flash', ultimate: 'Ultimate', future_slot: 'Future Model' }
async function fixture(create) {
  const names = { ...catalog }
  let available = true
  let listingCalls = 0
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/model/list')) {
      listingCalls++
      if (!available) return new Response('', { status: 502 })
      const models = Object.entries(names).map(([key, display_name]) => ({ key, display_name, enable: true, max_input_tokens: 131072 }))
      return Response.json({ chat: models, qwork: models })
    }
    if (String(url).includes('agent_chat_generation')) {
      sent.push({ key: new Headers(init.headers).get('X-Model-Key'), body: JSON.parse(_internal.decodeBody(init.body)) })
      const chunk = { model: 'auto', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
      return new Response('data: ' + JSON.stringify({ body: JSON.stringify(chunk) }) + '\n\ndata: ' + JSON.stringify({ body: '[DONE]' }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error('Unexpected upstream URL')
  }
  const auth = { type: 'oauth', access: 'test-token', refresh: 'test-refresh', expires: Date.now() + 3600000, uid: 'test-user', machineId: 'test-machine' }
  if (create === QwenWorkEnterpriseAuthPlugin) auth.enterpriseHost = 'acme.example.com'
  const hooks = await create({ client: { auth: { set: async () => {} } } })
  const loader = await hooks.auth.loader(async () => auth)
  const ask = (model, stream = false) => loader.fetch('https://test.invalid/chat/completions', { method: 'POST', body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'OK' }] }) })
  return { ask, sent, names, hooks, auth, listingCalls: () => listingCalls, refresh: () => hooks.provider.models({ models: {} }, { auth }), fail: () => { available = false } }
}
for (const [site, create] of [['qoder', QoderAuthPlugin], ['qoder-cn', QoderCNAuthPlugin], ['qwenwork', QwenWorkAuthPlugin], ['qwenwork-enterprise', QwenWorkEnterpriseAuthPlugin]]) {
  for (const stream of [false, true]) {
    test(`${site}: all model labels, duplicate labels and tiers; stream=${stream}`, async () => {
      const f = await fixture(create)
      for (const [key, name] of Object.entries(catalog)) {
        const response = await f.ask(key, stream)
        expect(response.status).toBe(200)
        const events = stream ? (await response.text()).split('\n').filter(x => x.startsWith('data: ') && x !== 'data: [DONE]').map(x => JSON.parse(x.slice(6))) : [await response.json()]
        expect(events.every(x => x.model === name)).toBe(true)
        expect(events.at(-1).usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 10 })
        expect(f.sent.at(-1).key).toBe(key)
        expect(JSON.stringify(f.sent.at(-1).body)).toContain(key)
      }
      expect(Object.keys(await f.hooks.provider.models({ models: {} }, { auth: f.auth }))).toEqual(Object.keys(catalog))
    })
  }
  test(`${site}: a cached chat does not fetch the model list again`, async () => {
    const f = await fixture(create)
    await f.refresh()
    expect(f.listingCalls()).toBe(1)
    for (let i = 0; i < 2; i++) {
      expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-5.3')
      expect(f.listingCalls()).toBe(1)
    }
  })
  test(`${site}: the reported name and model_config follow the same cached entry`, async () => {
    const f = await fixture(create)
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-5.3')
    expect(f.listingCalls()).toBe(1)
    f.names.gmodel = 'GLM-Next'
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-5.3')
    expect(f.sent.at(-1).body.model_config.display_name).toBe('GLM-5.3')
    expect(f.listingCalls()).toBe(1)
    await f.refresh()
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-Next')
    expect(f.sent.at(-1).body.model_config.display_name).toBe('GLM-Next')
    expect(f.listingCalls()).toBe(2)
  })
  test(`${site}: a missing cached model still forces exactly one refresh`, async () => {
    const f = await fixture(create)
    await f.refresh()
    f.names.new_slot = 'New Model'
    expect((await (await f.ask('new_slot')).json()).model).toBe('New Model')
    expect(f.listingCalls()).toBe(2)
    expect(f.sent.at(-1).key).toBe('new_slot')
    expect(f.sent.at(-1).body.model_config.display_name).toBe('New Model')
  })
  test(`${site}: empty, missing or unchanged names fall back to the slot ID`, async () => {
    const f = await fixture(create)
    for (const name of ['', '   ', undefined, 'gmodel']) {
      f.names.gmodel = name
      await f.refresh()
      expect((await (await f.ask('gmodel')).json()).model).toBe('gmodel')
    }
    f.names.gmodel = '  GLM-Next  '
    await f.refresh()
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-Next')
  })
  test(`${site}: a failed normal refresh keeps the request's cached entry`, async () => {
    const f = await fixture(create)
    await f.refresh()
    f.fail()
    await f.refresh()
    const response = await f.ask('gmodel')
    expect(response.status).toBe(200)
    expect((await response.json()).model).toBe('GLM-5.3')
    expect(f.sent.at(-1).body.model_config.display_name).toBe('GLM-5.3')
    expect(f.listingCalls()).toBe(2)
  })
}

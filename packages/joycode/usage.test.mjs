import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const auth = { type: 'api', key: 'fake-ticket', metadata: { tenant: '测试租户', loginType: 'PIN_JD_CLOUD' } }
const item = { type: 'seatPackage', title: '套餐积分', badge: '团队版（限免）', used: 0, total: 10000, remain: 10000, usedPercent: 0, expireText: '有效期至 2026年11月11日' }

async function query(t, response, account = auth) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api-ai.jd.com')
    assert.equal(new URL(url).searchParams.get('functionId'), 'get_newpoint_ide')
    assert.equal(init.method, 'POST')
    assert.equal(init.body, '{}')
    assert.equal(init.headers.ptkey, account.key)
    assert.equal(init.headers.tenant, encodeURIComponent(account.metadata.tenant))
    assert.equal(init.headers.logintype, account.metadata.loginType)
    assert.ok(init.signal)
    return response()
  })
  const hooks = await plugin.server({})
  assert.equal(typeof hooks.auth.usage, 'function')
  return hooks.auth.usage(async () => account)
}

test('maps actual IDE quota schema including zero usage and expiry text', async (t) => {
  const result = await query(t, () => Response.json({ code: 0, data: { usageItems: [item] } }))
  assert.equal(result.plan, '团队版（限免）')
  assert.equal(result.balance, '10,000 积分')
  assert.equal(result.windows[0].used, 0)
  assert.equal(result.windows[0].amount, 0)
  assert.equal(result.windows[0].limit, 10000)
  assert.match(result.windows[0].display, /剩余 10,000/)
  assert.match(result.windows[0].display, /2026年11月11日/)
  assert.equal(result.windows[0].resetsAt, undefined)
})

test('multiple pools preserve balances without one exhausted pool blocking the account', async (t) => {
  const result = await query(t, () => Response.json({ code: 0, data: { usageItems: [
    { ...item, used: 10000, remain: 0, usedPercent: 100 },
    { title: '加油包', used: 250, total: 1000, remain: 750, usedPercent: 25 },
  ] } }))
  assert.equal(result.balance, undefined)
  assert.deepEqual(result.windows.map(w => w.used), [100, 25])
  assert.ok(result.windows.every(w => w.aside === true))
})

test('missing numeric values never become fake zero quota', async (t) => {
  const result = await query(t, () => Response.json({ code: 0, data: { usageItems: [{ title: '套餐积分' }] } }))
  assert.ok(result.error)
  assert.deepEqual(result.windows, [])
  assert.equal(result.balance, undefined)
})

for (const field of ['msg', 'message']) {
  test(`business error preserves ${field} without exposing account data`, async t => {
    const result = await query(t, () => Response.json({ code: 9, [field]: '套餐不可用', data: { private: 'private-marker' } }))
    assert.equal(result.error, 'JoyCode 数据查询失败（HTTP 200）：套餐不可用')
    assert.equal(result.signIn, 'kept')
    assert.deepEqual(result.windows, [])
    assert.doesNotMatch(JSON.stringify(result), /private-marker|fake-ticket/)
  })
}

for (const [name, response, signIn] of [
  ['401', () => new Response('private-marker', { status: 401 }), 'expired'],
  ['403 permission error', () => new Response('private-marker', { status: 403 }), 'kept'],
  ['business error with malformed message', () => Response.json({ code: 9, msg: { private: 'private-marker' } }), 'kept'],
  ['invalid JSON', () => new Response('private-marker'), 'kept'],
  ['network failure', () => { throw new Error('private-marker') }, 'kept'],
  ['empty quota', () => Response.json({ code: 0, data: { usageItems: [] } }), 'kept'],
]) {
  test(`${name} reports a safe error without fake balances`, async (t) => {
    const result = await query(t, response)
    assert.ok(result.error)
    assert.equal(result.signIn, signIn)
    assert.deepEqual(result.windows, [])
    assert.equal(result.balance, undefined)
    assert.doesNotMatch(JSON.stringify(result), /private-marker|fake-ticket/)
  })
}

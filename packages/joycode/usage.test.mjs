import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const auth = { type: 'api', key: 'fake-ticket', metadata: { tenant: '测试租户', loginType: 'PIN_JD_CLOUD' } }
const item = { type: 'seatPackage', title: '套餐积分', badge: '团队版（限免）', used: 0, total: 10000, remain: 10000, usedPercent: 0, expireText: '有效期至 2026年11月11日' }

// Install fetch once per test. Calling mock.method again in the same test
// makes Bun 1.4 restore the wrong function, and packages that captured
// global fetch at import (the nonet guards) keep calling this mock.
function mockQuota(t, account = auth) {
  let response = () => { throw new Error('no quota response') }
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
  return async next => {
    response = next
    const hooks = await plugin.server({})
    assert.equal(typeof hooks.auth.usage, 'function')
    return hooks.auth.usage(async () => account)
  }
}

async function query(t, response, account = auth) {
  return mockQuota(t, account)(response)
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
  // 23:59:59 on 2026-11-11 in China, shown as "将于 … 过期", not a reset.
  assert.equal(result.until, '2026-11-11T15:59:59.000Z')
  assert.equal(result.windows[0].runsOutAt, '2026-11-11T15:59:59.000Z')
  assert.equal(result.windows[0].runsOut, 10000)
})

test('plan expiry accepts the IDE date phrases and ignores text that is not a date', async (t) => {
  const run = mockQuota(t)
  for (const [expireText, until] of [
    ['有效期至2026年11月11日', '2026-11-11T15:59:59.000Z'],
    ['2026-11-11', '2026-11-11T15:59:59.000Z'],
    ['2026/11/11', '2026-11-11T15:59:59.000Z'],
    ['2024年2月29日', '2024-02-29T15:59:59.000Z'],
    ['长期有效', undefined],
    ['有效期至 2026年2月31日', undefined],
    ['有效期至 1999年11月11日', undefined],
  ]) {
    const result = await run(() => Response.json({ code: 0, data: { usageItems: [{ ...item, expireText }] } }))
    assert.equal(result.until, until, expireText)
    assert.equal(result.windows[0].runsOutAt, until, expireText)
    assert.equal(result.windows[0].runsOut, until ? 10000 : undefined, expireText)
    assert.equal(result.windows[0].resetsAt, undefined)
    assert.match(result.windows[0].display, new RegExp(expireText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('plan expiry follows the package row, and otherwise the earliest pool', async (t) => {
  const run = mockQuota(t)
  const packaged = await run(() => Response.json({ code: 0, data: { usageItems: [
    { ...item, expireText: '有效期至 2026年12月1日' },
    { title: '加油包', used: 0, total: 100, remain: 100, usedPercent: 0, expireText: '2026-11-01' },
  ] } }))
  assert.equal(packaged.until, '2026-12-01T15:59:59.000Z')
  assert.equal(packaged.windows[0].runsOutAt, '2026-12-01T15:59:59.000Z')
  assert.equal(packaged.windows[0].runsOut, 10000)
  assert.equal(packaged.windows[1].runsOutAt, '2026-11-01T15:59:59.000Z')
  assert.equal(packaged.windows[1].runsOut, 100)
  assert.ok(packaged.windows.every(window => window.resetsAt === undefined))

  const pools = await run(() => Response.json({ code: 0, data: { usageItems: [
    { title: '套餐积分', used: 0, total: 100, remain: 100, usedPercent: 0, expireText: '2026-12-01' },
    { title: '加油包', used: 0, total: 100, remain: 100, usedPercent: 0, expireText: '2026-11-01' },
  ] } }))
  assert.equal(pools.until, '2026-11-01T15:59:59.000Z')
})

test('multiple pools preserve balances without one exhausted pool blocking the account', async (t) => {
  const result = await query(t, () => Response.json({ code: 0, data: { usageItems: [
    { ...item, used: 10000, remain: 0, usedPercent: 100 },
    { title: '加油包', used: 250, total: 1000, remain: 750, usedPercent: 25 },
  ] } }))
  assert.equal(result.balance, undefined)
  assert.equal(result.until, '2026-11-11T15:59:59.000Z')
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

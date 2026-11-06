// 登录 / 续期：浏览器替身（fake-browser.mjs）+ 本地 fake 上游。覆盖：登录成功
// 存 profile 与手机号；取消（callback 没被调）后定时器收尾关浏览器、放锁；
// 续期只开账号自己的 profile 且校验票的归属，别人的票拒写。
import './nonet.mjs'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import { MclawAuthPlugin, _internal } from './index.mjs'
import { fakeUpstream, TICKET_A, TICKET_B, PHONE_A, PHONE_B } from './fake.mjs'
import { fakeBrowserModule } from './fake-browser.mjs'

let f
let fb
afterEach(() => {
  f?.close()
  f = undefined
})
beforeEach(() => _internal.resetModelCache())

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const oauthMethod = (plugin) => plugin.auth.methods[0]

test('登录成功：收割票 + 自动取 key，profile 与掩码手机号进 metadata', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 60_000 })
  const flow = await oauthMethod(plugin).authorize({})
  expect(flow.opened).toBe(true)
  expect(flow.method).toBe('auto')
  fb.module.deliverHarvest()
  const result = await flow.callback()
  expect(result.type).toBe('success')
  expect(result.access).toBe(TICKET_A)
  expect(result.refresh).toBe('browser')
  expect(result.metadata.apiKey).toBe('na-test-key')
  expect(result.metadata.email).toBe(PHONE_A)
  expect(result.metadata.profile).toBe(fb.state.openedProfiles[0])
  // 正常收尾：callback 自己关浏览器、放锁，abort 定时器不再动它
  expect(fb.state.closed).toBe(1)
  expect(fb.state.released).toBe(1)
})

test('宿主取消（callback 没被调）→ 定时器到点关浏览器、放 profile 锁', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 30 })
  await oauthMethod(plugin).authorize({})
  // 收割一直挂着（用户没登录完），宿主已经取消：定时器到点应 abort
  await sleep(120)
  expect(fb.state.aborted).toBe(true)
  expect(fb.state.closed).toBeGreaterThanOrEqual(1)
  expect(fb.state.released).toBeGreaterThanOrEqual(1)
})

test('续期：只开账号自己的 profile；票换了 key 跟着刷', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module })
  const auth = { type: 'oauth', refresh: 'browser', access: 'Basic old', expires: Date.now() - 1000, metadata: { apiKey: 'na-old', email: PHONE_A, profile: 'profile-of-A' } }
  const out = await plugin.auth.refresh(auth)
  expect(fb.state.refreshProfiles).toEqual(['profile-of-A'])
  expect(out.access).toBe(TICKET_A)
  expect(out.metadata.apiKey).toBe('na-test-key')
  expect(out.metadata.profile).toBe('profile-of-A')
})

test('续期收割到别人的票 → 拒写（expired），绝不张冠李戴', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_B })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module })
  const auth = { type: 'oauth', refresh: 'browser', access: TICKET_A, expires: Date.now() - 1000, metadata: { apiKey: 'na-a', email: PHONE_A, profile: 'profile-of-A' } }
  let caught
  try {
    await plugin.auth.refresh(auth)
  } catch (error) {
    caught = error
  }
  expect(caught?.signIn).toBe('expired')
  expect(caught?.message).toContain(PHONE_B)
})

test('0.5.0 前的老账号（metadata 无 profile）：退回老共享目录续期，成功后钉进 metadata', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_B })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module })
  const auth = { type: 'oauth', refresh: 'browser', access: TICKET_B, expires: Date.now() - 1000, metadata: { apiKey: 'na-b', email: PHONE_B } }
  const out = await plugin.auth.refresh(auth)
  expect(fb.state.refreshProfiles).toEqual([undefined]) // fake 的缺省路径
  expect(out.metadata.profile).toBe('fake-profile-legacy')
  expect(out.metadata.email).toBe(PHONE_B)
})

test('llm key 自动获取失败（网络抖动）→ 登录失败并提示重试，收尾照常', async () => {
  f = fakeUpstream()
  f.route('POST /api/llm/apikey/get', () => new Response('boom', { status: 500 }))
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 60_000 })
  const flow = await oauthMethod(plugin).authorize({})
  fb.module.deliverHarvest()
  const result = await flow.callback()
  expect(result.type).toBe('failed')
  expect(result.error).toContain('重新登录')
  expect(fb.state.closed).toBe(1)
  expect(fb.state.released).toBe(1)
})

test('authorize 不需要任何输入：无 prompts，直接开登', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 60_000 })
  const method = oauthMethod(plugin)
  expect(method.prompts).toBeUndefined()
  const flow = await method.authorize()
  expect(flow.opened).toBe(true)
  fb.module.deliverHarvest()
  const result = await flow.callback()
  expect(result.type).toBe('success')
  expect(result.metadata.email).toBe(PHONE_A)
})

test('magpie 式取消：callback 立即被调 + signal abort → 立即收尾', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 60_000 })
  const controller = new AbortController()
  // magpie 的时序：authorize 一返回就调 callback(undefined, { signal })，
  // 用户取消/登录超时时 abort signal——收尾必须立刻发生，不等 5 分钟定时器
  const flow = await oauthMethod(plugin).authorize({}, { signal: controller.signal })
  const done = flow.callback(undefined, { signal: controller.signal })
  await sleep(10)
  expect(fb.state.aborted).toBe(false)
  controller.abort()
  const result = await done
  expect(result.type).toBe('failed')
  expect(fb.state.aborted).toBe(true)
  expect(fb.state.closed).toBeGreaterThanOrEqual(1)
  expect(fb.state.released).toBeGreaterThanOrEqual(1)
})

test('authorize 时 signal 已是 aborted → 直接收尾不开流程', async () => {
  f = fakeUpstream()
  fb = fakeBrowserModule({ ticket: TICKET_A })
  const plugin = await MclawAuthPlugin({}, { browserModule: fb.module, signinAbortMs: 60_000 })
  const controller = new AbortController()
  controller.abort()
  await oauthMethod(plugin).authorize({}, { signal: controller.signal })
  await sleep(10)
  expect(fb.state.aborted).toBe(true)
  expect(fb.state.closed).toBeGreaterThanOrEqual(1)
  expect(fb.state.released).toBeGreaterThanOrEqual(1)
})

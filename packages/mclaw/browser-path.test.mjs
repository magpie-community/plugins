// 浏览器定位与登录前提：候选表、MCLAW_CHROME_PATH 校验、无图形界面拒绝。
// 全部注入 platform/env/candidates，不依赖测试机是否装了 Chrome。
import './nonet.mjs'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { browserCandidates, requireBrowser, assertBrowserSigninPrerequisites } from './browser.mjs'

const clean = (env = {}) => ({
  MCLAW_CHROME_PATH: undefined,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  ...env,
})

let tmp
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

function fakeExecutable(name = 'chrome') {
  tmp = mkdtempSync(join(tmpdir(), 'mclaw-browser-test-'))
  const path = join(tmp, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

test('候选表覆盖三平台，且认 Edge / Chromium / Brave', () => {
  const win = browserCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:/PF', LOCALAPPDATA: 'C:/LA' } })
  expect(win.some((p) => p.endsWith('msedge.exe'))).toBe(true)
  expect(win.some((p) => p.endsWith('chrome.exe'))).toBe(true)

  const mac = browserCandidates({ platform: 'darwin', env: {} })
  expect(mac.some((p) => p.includes('Google Chrome.app'))).toBe(true)
  expect(mac.some((p) => p.includes('Microsoft Edge.app'))).toBe(true)
  expect(mac.some((p) => p.includes('Chromium.app'))).toBe(true)
  expect(mac.some((p) => p.includes('Brave Browser.app'))).toBe(true)

  const linux = browserCandidates({ platform: 'linux', env: {} })
  expect(linux).toContain('/usr/bin/microsoft-edge')
  expect(linux).toContain('/usr/bin/chromium')
})

test('候选为空 → 报错且只此一份文案，不宣称窗口已弹出', async () => {
  let caught
  try {
    await requireBrowser({ platform: 'linux', env: clean(), candidates: [] })
  } catch (error) {
    caught = error
  }
  expect(caught?.message).toContain('找不到可用的 Chrome / Edge / Chromium')
  expect(caught?.message).toContain('图形界面')
  expect(caught?.message).toContain('MCLAW_CHROME_PATH')
})

test('候选里有一个真实可执行文件 → 返回它', async () => {
  const exe = fakeExecutable()
  const found = await requireBrowser({ platform: 'linux', env: clean(), candidates: ['/definitely/not/here', exe] })
  expect(found).toBe(exe)
})

test('MCLAW_CHROME_PATH 写错 → 专属报错，不混成「找不到 Chrome」', async () => {
  let caught
  try {
    await requireBrowser({ platform: 'linux', env: clean({ MCLAW_CHROME_PATH: '/no/such/chrome' }), candidates: [] })
  } catch (error) {
    caught = error
  }
  expect(caught?.message).toContain('MCLAW_CHROME_PATH 指向的浏览器不存在或不可执行')
  expect(caught?.message).toContain('/no/such/chrome')
  expect(caught?.message).not.toContain('找不到可用的 Chrome')
})

test('MCLAW_CHROME_PATH 指向可执行文件 → 优先于候选表', async () => {
  const exe = fakeExecutable()
  const found = await requireBrowser({ platform: 'linux', env: clean({ MCLAW_CHROME_PATH: exe }), candidates: [] })
  expect(found).toBe(exe)
})

test('Linux 无 DISPLAY / WAYLAND_DISPLAY → 明确拒绝，即使浏览器存在', async () => {
  const exe = fakeExecutable()
  let caught
  try {
    await assertBrowserSigninPrerequisites({ platform: 'linux', env: clean(), candidates: [exe] })
  } catch (error) {
    caught = error
  }
  expect(caught?.message).toContain('没有图形界面')
  expect(caught?.message).toContain('DISPLAY')
})

test('Linux 有 DISPLAY 且浏览器存在 → 预检通过', async () => {
  const exe = fakeExecutable()
  await expect(assertBrowserSigninPrerequisites({
    platform: 'linux', env: clean({ DISPLAY: ':0' }), candidates: [exe],
  })).resolves.toBe(exe)
})

test('macOS 无 DISPLAY 也放行（不走 Linux 的 GUI 判定）', async () => {
  const exe = fakeExecutable()
  await expect(assertBrowserSigninPrerequisites({
    platform: 'darwin', env: clean(), candidates: [exe],
  })).resolves.toBe(exe)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PROVIDER_ICONS } from '../app/provider-icons.js'

test('ZCode and Volcengine provider keys embed the original correct brand assets', async () => {
  for (const [key, filename, mime] of [['zcode', 'zcode.png', 'image/png'], ['volcengine', 'volcengine-color.svg', 'image/svg+xml']]) {
    const original = await readFile(new URL(`../app/icons/${filename}`, import.meta.url))
    assert.equal(PROVIDER_ICONS[key], `data:${mime};base64,${original.toString('base64')}`)
  }
  const unrelatedZooCode = await readFile(new URL('../app/icons/zoo-code.png', import.meta.url))
  assert.notEqual(PROVIDER_ICONS.zcode, `data:image/png;base64,${unrelatedZooCode.toString('base64')}`)
})

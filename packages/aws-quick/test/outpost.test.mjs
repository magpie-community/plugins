import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Outpost, findAgent } from '../lib/outpost.mjs'

test('findAgent uses explicit agentPath and logs when missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outpost-find-'))
  try {
    const fakeBin = path.join(dir, 'quickwork-agent')
    writeFileSync(fakeBin, '')
    const found = findAgent({ agentPath: fakeBin })
    assert.deepEqual(found, { path: fakeBin, source: 'option' })

    const logs = []
    try {
      findAgent({ agentPath: path.join(dir, 'does-not-exist'), userDataDir: dir, cacheDir: dir, log: (l) => logs.push(l) })
    } catch { /* fallback may or may not find an installed desktop app */ }
    assert.ok(logs.some((l) => l.includes('does not exist')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Outpost line-buffers stdout chunks and deduplicates concurrent session() calls', async () => {
  const op = new Outpost({ log: () => {} })
  // Simulate OUTPOST_PORT arriving split across two stdout chunks.
  op._onStdout('booting...\nOUTPOST_PO')
  assert.equal(op.port, null)
  op._onStdout('RT: 43210\n')
  assert.equal(op.port, 43210)
  assert.equal(op.base, 'http://127.0.0.1:43210')

  // Stub ensure() and _fetch() to test concurrent session() deduplication + validation.
  let calls = 0
  op.ensure = async () => op
  op._fetch = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 30))
    return {
      ok: true,
      status: 200,
      data: { id_token: 'tok-a', ws_host: 'ws.example.com', usable_until: Math.floor(Date.now() / 1000) + 600 },
    }
  }
  const [s1, s2] = await Promise.all([op.session(), op.session()])
  assert.equal(calls, 1)
  assert.equal(s1.id_token, 'tok-a')
  assert.equal(s2.id_token, 'tok-a')

  // Invalid payload should throw instead of poisoning sessionCache.
  op.sessionCache = null
  op._fetch = async () => ({ ok: true, status: 200, data: { incomplete: true } })
  await assert.rejects(() => op.session(), /无效的 sncs-session/)
  assert.equal(op.sessionCache, null)
})

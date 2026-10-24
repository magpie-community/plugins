// Optional integration test against a separately running, isolated Magpie web.
// See README. Never uses the operator's own Magpie configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions } from './sync.mjs';
const enabled = process.env.MAGPIE_UI_TEST === '1';
test('real Magpie page: light/dark, responsive, sources, failure and empty states', { skip: !enabled }, async () => {
  assert.equal(process.env.HOME, process.env.MAGPIE_TEST_HOME, 'explicit sandbox HOME required');
  assert.ok(process.env.MAGPIE_TEST_HOME?.includes('sandbox'), 'use a named test sandbox');
  const base = new URL(process.env.MAGPIE_TEST_URL);
  assert.equal(base.hostname, '127.0.0.1');
  const pw = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  const run = promisify(execFile), bin = process.env.MAGPIE_TEST_BIN;
  const settingsFile = join(process.env.HOME, '.config/magpie/settings.json');
  const originalSettings = await readFile(settingsFile, 'utf8');
  const settings = JSON.parse(originalSettings);
  const options = async value => run(bin, ['plugin', 'options', 'codex-resets', JSON.stringify(value)], { timeout: 15000 });
  const originalOptions = parseOptions((await run(bin, ['plugin', 'options', 'codex-resets'], { timeout: 15000 })).stdout);
  const now = Date.parse('2026-10-23T08:00:00Z');
  const record = { version: 1, checkedAt: new Date(now).toISOString(), error: '', payload: {
    meta: { api_version: 'v1', generated_at: new Date(now).toISOString() },
    data: {
      scheduled_reset: { id: '123456789', reset_type: 'regular', status: 'scheduled', announced_at: '2026-10-23T07:00:00Z', scheduled_for: '2026-10-23T10:00:00Z', source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/123456789' } },
      latest_reset: { id: 'observed-example', reset_type: 'banked', announced_at: '2026-10-22T07:00:00Z', source: { type: 'observed' } },
      active_watch: { level: 'strong', reset_chance_percent: 75, forecast_window: 'Next 24 hours', observed_at: '2026-10-23T07:00:00Z', expires_at: '2026-10-23T22:00:00Z', source: { type: 'observed' } },
    },
  } };
  const engines = (process.env.MAGPIE_TEST_ENGINES || 'chromium').split(',');
  assert.ok(engines.every(e => ['chromium', 'webkit'].includes(e)), 'supported engines: chromium,webkit');
  try {
    for (const engine of engines) {
      const browser = await pw[engine].launch(engine === 'chromium' ? { channel: 'chromium' } : {});
      try {
        for (const theme of ['light', 'dark']) for (const width of [1100, 760, 420]) {
          await writeFile(settingsFile, JSON.stringify({ ...settings, theme, lang: 'zh' }));
          await options({ codexResets: record });
          const ctx = await browser.newContext({ viewport: { width, height: 820 }, timezoneId: 'Asia/Taipei', colorScheme: theme });
          const page = await ctx.newPage(), errors = [], requests = [];
          page.on('pageerror', e => errors.push(e.message));
          const consoleErrors = []; page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
          page.on('request', req => {
            if (req.frame().url().includes('/_magpie/plugin/') && !req.url().startsWith(base.origin)) requests.push(req.url());
          });
          await page.clock.setFixedTime(now);
          const url = new URL(base); url.searchParams.set('view', 'plugin-codex-resets');
          await page.goto(url.href);
          const frame = page.frameLocator('iframe');
          try { await frame.locator('#overview').waitFor({ state: 'visible', timeout: 10000 }); }
          catch (e) {
            console.error(JSON.stringify({ engine, theme, width, errors, consoleErrors, url: page.url(),
              body: await page.locator('body').innerText({ timeout: 1000 }),
              frames: await Promise.all(page.frames().map(async f => ({ url: f.url(), body: await f.locator('body').innerText({ timeout: 1000 }).catch(() => 'unavailable') }))) }));
            throw e;
          }
          assert.equal(await frame.locator('#forecastValue').textContent(), '75%');
          assert.match(await frame.locator('#resetValue').textContent(), /18:00/);
          assert.equal(await frame.locator('#grantValue').textContent(), '已报告发卡');
          assert.equal(await frame.locator('html').getAttribute('data-theme'), theme);
          assert.ok(await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${engine} ${width}: horizontal overflow`);
          if (process.env.MAGPIE_SCREENSHOTS && engine === 'chromium') {
            await mkdir(process.env.MAGPIE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: join(process.env.MAGPIE_SCREENSHOTS, `community-preview-${theme}-${width}.png`), fullPage: true });
          }
          await frame.locator('#details > summary').click();
          await frame.getByRole('button', { name: '选中地址 · 重置公告原帖', exact: true }).click();
          assert.equal(await frame.locator('#sourceReset').evaluate(el => el.selectionEnd - el.selectionStart), 'https://x.com/thsottiaux/status/123456789'.length);
          await frame.locator('#reload').click();
          assert.ok(await frame.locator('#details').evaluate(el => el.open), 'refresh keeps disclosure open');
          const zero = structuredClone(record); zero.payload.data.active_watch.reset_chance_percent = 0;
          await options({ codexResets: zero }); await frame.locator('#reload').click();
          await page.frames().find(f => f.url().includes('/_magpie/plugin/')).waitForFunction(() => document.getElementById('forecastValue').textContent === '0%');
          await options({ codexResets: { ...record, error: 'offline' } }); await frame.locator('#reload').click();
          await page.frames().find(f => f.url().includes('/_magpie/plugin/')).waitForFunction(() => document.getElementById('emptyTitle').textContent === '当前信息暂不可用');
          assert.equal(await frame.locator('#overview').isVisible(), false);
          await options({ codexResets: null }); await frame.locator('#reload').click();
          await page.frames().find(f => f.url().includes('/_magpie/plugin/')).waitForFunction(() => document.getElementById('emptyTitle').textContent === '还没有同步公告');
          assert.deepEqual(requests, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
          await ctx.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await options(originalOptions); await writeFile(settingsFile, originalSettings); }
});

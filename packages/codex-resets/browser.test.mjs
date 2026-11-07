// Optional integration test against a separately running, isolated Magpie web.
// See README. Never uses the operator's own Magpie configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions } from './dev/sync.mjs';
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
  const channel = process.env.MAGPIE_TEST_CHROMIUM_CHANNEL || 'chromium';
  assert.ok(['chromium', 'chrome'].includes(channel), 'use bundled Chromium or installed Chrome');
  const languages = {
    en: ['Codex reset news', 'Grant reported', 'Current status is unavailable', 'Automatic updates are not available yet'],
    zh: ['Codex 重置动态', '已报告发卡', '当前信息暂不可用', '自动更新尚不可用'],
    'zh-TW': ['Codex 重設動態', '已報告發卡', '目前資訊暫不可用', '自動更新尚不可用'],
    ja: ['Codex リセット情報', '付与の報告あり', '現在の情報を取得できません', '自動更新はまだ利用できません'],
    de: ['Codex-Resetmeldungen', 'Gutschrift gemeldet', 'Aktueller Status nicht verfügbar', 'Automatische Updates noch nicht verfügbar'],
  };
  assert.ok(engines.every(e => ['chromium', 'webkit'].includes(e)), 'supported engines: chromium,webkit');
  try {
    for (const engine of engines) {
      const browser = await pw[engine].launch(engine === 'chromium' ? { channel } : {});
      try {
        for (const [lang, words] of Object.entries(languages)) for (const theme of ['light', 'dark']) for (const width of [1100, 760, 420]) {
          await writeFile(settingsFile, JSON.stringify({ ...settings, theme, lang }));
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
          // Center controls in the scrolling frame before real pointer input:
          // partially clipped controls can send the click to the iframe edge.
          const click = async selector => {
            const control = frame.locator(selector);
            await control.evaluate(el => el.scrollIntoView({ block: 'center' }));
            await control.click();
          };
          try { await frame.locator('#overview').waitFor({ state: 'visible', timeout: 10000 }); }
          catch (e) {
            console.error(JSON.stringify({ engine, lang, theme, width, errors, consoleErrors, url: page.url(),
              body: await page.locator('body').innerText({ timeout: 1000 }),
              frames: await Promise.all(page.frames().map(async f => ({ url: f.url(), body: await f.locator('body').innerText({ timeout: 1000 }).catch(() => 'unavailable') }))) }));
            throw e;
          }
          await page.locator('button[data-view="plugin-codex-resets"].on').waitFor();
          await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
          // A host update can show release notes in this isolated profile.
          const releaseNotes = page.locator('#modal .whatsnew');
          if (await releaseNotes.isVisible()) await releaseNotes.locator('.bar button.primary').click();
          assert.equal(await frame.locator('.metric').count(), 2);
          assert.doesNotMatch(await frame.locator('body').innerText(), /75%|Next 24 hours/);
          assert.equal(await frame.locator('h1').textContent(), words[0]);
          assert.equal(await frame.locator('#resetValue').textContent(), new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : lang,
            { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }).format(new Date('2026-10-23T10:00:00Z')));
          assert.equal(await frame.locator('#grantValue').textContent(), words[1]);
          assert.equal(await frame.locator('html').getAttribute('data-theme'), theme);
          assert.ok(await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${engine} ${width}: horizontal overflow`);
          if (process.env.MAGPIE_SCREENSHOTS && engine === 'chromium') {
            await mkdir(process.env.MAGPIE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: join(process.env.MAGPIE_SCREENSHOTS, `community-preview-${lang}-${theme}-${width}.png`), fullPage: true });
          }
          await click('#details > summary');
          await click('#sourceReset + button');
          assert.equal(await frame.locator('#sourceReset').evaluate(el => el.selectionEnd - el.selectionStart), 'https://x.com/thsottiaux/status/123456789'.length);
          await click('#reload');
          assert.ok(await frame.locator('#details').evaluate(el => el.open), 'refresh keeps disclosure open');
          await options({ codexResets: { ...record, error: 'offline' } }); await click('#reload');
          await page.frames().find(f => f.url().includes('/_magpie/plugin/')).waitForFunction(text => document.getElementById('emptyTitle').textContent === text, words[2]);
          assert.equal(await frame.locator('#overview').isVisible(), false);
          await options({ codexResets: null }); await click('#reload');
          await page.frames().find(f => f.url().includes('/_magpie/plugin/')).waitForFunction(text => document.getElementById('emptyTitle').textContent === text, words[3]);
          assert.doesNotMatch(await frame.locator('body').innerText(), /node packages|--watch|--bell|Ctrl-C/);
          if (process.env.MAGPIE_SCREENSHOTS && engine === 'chromium' && ['ja', 'de'].includes(lang) && width === 420) {
            await click('#setup > summary');
            assert.ok(await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
            await page.screenshot({ path: join(process.env.MAGPIE_SCREENSHOTS, `community-empty-${lang}-${theme}-${width}.png`), fullPage: true });
          }
          assert.deepEqual(requests, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
          console.log(`Verified ${engine} ${lang} ${theme} ${width}`);
          await ctx.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await options(originalOptions); await writeFile(settingsFile, originalSettings); }
});

// Loopback page service adapted from magpie-community/page-model-quota (MIT).
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildReport, SPEND_WINDOWS } from './report.mjs';
import { updateCreditReadings } from './credit-history.mjs';
import { PERIODS } from './pricing.mjs';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
]);
const safeId = value => typeof value === 'string' && /^[a-z0-9][\w./:-]{0,159}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const parse = async file => JSON.parse(await readFile(file, 'utf8'));

async function optional(file, fallback) {
  try { return await parse(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function configuration(given) {
  if (given && isAbsolute(given) && existsSync(given)) return given;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && isAbsolute(xdg) ? join(xdg, 'magpie') : join(homedir(), '.config', 'magpie');
}

async function readUsage(file, now) {
  if (!existsSync(file)) return [];
  const rows = [];
  const since = now - 30 * 86_400_000;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    try {
      const row = JSON.parse(line);
      if (Date.parse(row?.t) >= since) rows.push(row);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // An incomplete tail record is read again at the next refresh.
    }
  }
  return rows;
}

async function readCards(dir) {
  const gateway = await optional(join(dir, 'gateway.json'), {});
  const port = Number(gateway.addr?.match(/:(\d+)$/)?.[1] ?? 3425);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Magpie 网关地址无效');
  const response = await fetch(`http://127.0.0.1:${port}/v1/magpie/quotas?kept=1`, {
    signal: AbortSignal.timeout(6000), redirect: 'error',
  });
  if (!response.ok) throw new Error('无法读取 Magpie 额度');
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('Magpie 额度格式不兼容');
  return json.data;
}

async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error('设置内容过长');
  }
  return JSON.parse(text);
}

function update(preferences, change, report) {
  const { kind, value, provider, model, period } = change;
  const row = report.providers.find(p => p.id === provider);
  const mappingValues = (kind === 'mapping' || kind === 'tokenMapping') && Array.isArray(value) ? value : null;
  const selectedModel = kind === 'mapping' ? mappingValues ? mappingValues[0] : value : model;
  const modelExists = safeId(selectedModel) && row && Object.hasOwn(row.models, selectedModel);
  if (kind === 'base' && report.providers.some(p => p.id === value)) preferences.base = value;
  else if (kind === 'baseModel' && (value === null || (safeId(value) && report.base &&
      Object.hasOwn(report.providers.find(p => p.id === report.base).models, value)))) {
    if (value === null) delete preferences.baseModel;
    else preferences.baseModel = value;
  }
  else if (kind === 'model' && report.models.some(m => m.id === value)) preferences.model = value;
  else if (kind === 'period' && PERIODS.includes(value)) preferences.period = value;
  else if (kind === 'spendWindow' && Object.hasOwn(SPEND_WINDOWS, value)) preferences.spendWindow = value;
  else if (kind === 'enabled' && safeId(provider) && row && typeof value === 'boolean') {
    const enabled = preferences.enabled ??= {};
    enabled[provider] = value;
  }
  else if (kind === 'mapping' && safeId(provider) && row && provider !== report.base && report.baseModel &&
      (value === null || mappingValues && mappingValues.length <= 64 &&
        mappingValues.every(id => safeId(id) && Object.hasOwn(row.models, id)) || modelExists)) {
    const byBase = preferences.mappings ??= {};
    const byModel = byBase[report.base] ??= {};
    const mappings = byModel[report.baseModel] ??= {};
    if (value === null || mappingValues?.length === 0) delete mappings[provider];
    else mappings[provider] = mappingValues ? [...new Set(mappingValues)] : value;
  } else if (kind === 'matchModels' && report.baseModel && value === report.baseModel && provider === report.base) {
    const mappings = ((preferences.mappings ??= {})[report.base] ??= {})[report.baseModel] ??= {};
    for (const candidate of report.providers) {
      if (candidate.enabled && candidate.shared.length && !candidate.selectedBridges.length) {
        mappings[candidate.id] = candidate.shared;
      }
    }
  } else if (kind === 'tokenMapping' && safeId(provider) && row && report.selectedModel &&
      (value === null || mappingValues && mappingValues.length <= 64 &&
        mappingValues.every(id => safeId(id) && Object.hasOwn(row.models, id)))) {
    const byModel = preferences.tokenMappings ??= {};
    const mappings = byModel[report.selectedModel] ??= {};
    // An empty list is an explicit "none" so a same-name default stays deselected.
    if (value === null) delete mappings[provider];
    else mappings[provider] = [...new Set(mappingValues)];
  } else if (kind === 'rate' && safeId(provider) && modelExists && PERIODS.includes(period) &&
      (value === null || (Number.isFinite(value) && value > 0 && value <= 1e9 && value >= 1e-8))) {
    const providers = preferences.rates ??= {};
    const models = providers[provider] ??= {};
    const rates = models[model] ??= {};
    if (value === null) delete rates[period];
    else rates[period] = value;
  } else throw new Error('设置值无效');
}

export async function startServer({ configDir, port = 3498 } = {}) {
  const dir = configuration(configDir);
  const key = randomBytes(24).toString('base64url');
  const want = Buffer.from(key);
  const workDir = join(dir, 'plugin-work');
  const settings = join(workDir, 'magpie-credit-balance.json');
  const readingsFile = join(workDir, 'magpie-credit-readings.json');
  let reading;
  let snapshot;
  let writing = Promise.resolve();
  let savingReadings = Promise.resolve();
  let address;

  async function data(refresh) {
    if (!refresh && snapshot && Date.now() - snapshot.now < 20_000) return snapshot;
    reading ??= (async () => {
      const now = Date.now();
      const [cards, usage, catalog, providerFile, dailyCredits, previousReadings] = await Promise.all([
        readCards(dir), readUsage(join(dir, 'usage.jsonl'), now), optional(join(dir, 'plugin-providers.json'), []),
        optional(join(dir, 'providers.json'), {}), optional(join(dir, 'credits-daily.json'), {}),
        optional(readingsFile, {}),
      ]);
      const configured = Array.isArray(providerFile?.providers) ? providerFile.providers : [];
      // providers.json holds both the user's provider settings and the
      // per-provider checked model list shown on Magpie's provider page.
      const checkedModels = Object.fromEntries((Array.isArray(providerFile?.providers) ? providerFile.providers : [])
        .filter(provider => safeId(provider?.id) && Array.isArray(provider.models))
        .map(provider => [provider.id, provider.models]));
      const creditReadings = updateCreditReadings(previousReadings, cards, now);
      // Persist the absolute-counter snapshots so the rolling 24-hour view
      // keeps accumulating while the page stays open across restarts.
      if (JSON.stringify(creditReadings) !== JSON.stringify(previousReadings)) {
        savingReadings = savingReadings.then(async () => {
          await mkdir(workDir, { recursive: true });
          const tmp = `${readingsFile}.${randomBytes(6).toString('hex')}.tmp`;
          try {
            await writeFile(tmp, JSON.stringify(creditReadings), { flag: 'wx' });
            await rename(tmp, readingsFile);
          } finally {
            await rm(tmp, { force: true });
          }
        }).catch(() => undefined);
      }
      snapshot = { cards, catalog: Array.isArray(catalog) ? catalog : [], usage,
        providerConfigs: [...(Array.isArray(catalog) ? catalog : []), ...configured],
        dailyCredits: dailyCredits && typeof dailyCredits === 'object' && !Array.isArray(dailyCredits) ? dailyCredits : {},
        creditReadings, checkedModels, now };
      return snapshot;
    })().finally(() => { reading = undefined; });
    return reading;
  }

  const app = createServer(async (req, res) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const own = origin === `http://${address}`;
    const allowedOrigin = !origin || origin === 'null' || own;
    const cors = origin && allowedOrigin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const send = (status, payload, type = 'application/json') => {
      res.writeHead(status, { ...cors, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self' http://${address}; style-src 'self' http://${address}; connect-src 'self' http://${address}; base-uri 'none'; form-action 'none'` });
      res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
    };
    if (host !== address || !allowedOrigin) return send(403, { error: '访问来源无效' });
    const target = new URL(req.url, `http://${address}`);
    try {
      if (target.pathname === '/api/health' && req.method === 'GET') return send(200, { plugin: 'magpie-credit-balance' });
      if (target.pathname === '/api/report' || target.pathname === '/api/preference') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...cors, 'Access-Control-Allow-Headers': 'content-type,x-magpie-credit-key',
            'Access-Control-Allow-Methods': 'GET,POST' });
          return res.end();
        }
        const got = Buffer.from(req.headers['x-magpie-credit-key'] ?? '');
        if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: '请重新打开插件页面' });
        if (target.pathname === '/api/report' && req.method === 'GET') {
          const report = buildReport({ ...await data(target.searchParams.get('refresh') === '1'),
            preferences: await optional(settings, {}) });
          return send(200, report);
        }
        if (target.pathname === '/api/preference' && req.method === 'POST') {
          let change;
          try { change = await bodyOf(req); }
          catch { return send(400, { error: '设置内容有误' }); }
          const operation = writing.then(async () => {
            const source = await data(false);
            const preferences = await optional(settings, {});
            try { update(preferences, change, buildReport({ ...source, preferences })); }
            catch { return null; }
            await mkdir(workDir, { recursive: true });
            const tmp = `${settings}.${randomBytes(6).toString('hex')}.tmp`;
            try {
              await writeFile(tmp, JSON.stringify(preferences, null, 2), { flag: 'wx' });
              await rename(tmp, settings);
            } finally {
              await rm(tmp, { force: true });
            }
            return buildReport({ ...source, preferences });
          });
          writing = operation.then(() => undefined, () => undefined);
          const report = await operation;
          return report ? send(200, report) : send(400, { error: '设置值无效' });
        }
        return send(405, { error: '请求方法无效' });
      }
      const asset = ASSETS.get(target.pathname);
      if (!asset || req.method !== 'GET') return send(404, { error: '页面不存在' });
      const [file, type] = asset;
      const content = await readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8');
      if (file !== 'index.html') return send(200, content, type);
      const mode = req.headers['sec-fetch-mode'];
      if (mode && mode !== 'navigate') return send(403, { error: '请从 Magpie 打开插件' });
      return send(200, content.replace('<head>', `<head><meta name="credit-key" content="${key}">`), type);
    } catch {
      return send(503, { error: '无法加载积分数据，请确认 Magpie 网关正在运行，然后重试。' });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      app.once('error', reject);
      app.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!health.ok || (await health.json()).plugin !== 'magpie-credit-balance') throw error;
    // Magpie can start the incoming plugin host before the previous one exits.
    const timer = setInterval(() => {
      const probe = app.listenerCount('listening');
      if (!app.listening && probe === 0) {
        app.once('listening', () => { address = `127.0.0.1:${port}`; clearInterval(timer); });
        app.once('error', () => app.removeAllListeners('listening'));
        app.listen(port, '127.0.0.1');
      }
    }, 1000);
    timer.unref();
    return { server: app, url: `http://127.0.0.1:${port}` };
  }
  address = `127.0.0.1:${app.address().port}`;
  return { server: app, url: `http://${address}` };
}

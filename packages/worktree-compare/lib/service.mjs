import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Arena } from './arena.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const inputLimit = 48 * 1024;
const httpError = (status, message) => Object.assign(new Error(message), { status });

function authorize(req, key) {
  const received = req.headers['x-arena-key'];
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || typeof received !== 'string' ||
      !/^[a-f0-9]{64}$/.test(received) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(key))) {
    throw httpError(403, 'Open Worktree Compare from the Magpie sidebar.');
  }
}

async function readInput(req) {
  if (req.headers['x-arena-request'] !== '1' ||
      req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw httpError(415, 'Send a JSON page request.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > inputLimit) throw httpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {}
  throw httpError(400, 'Invalid JSON object.');
}

function send(res, status, result) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result));
}

export async function createArenaService({ port = 3497, options = {}, listModels, runCandidate,
  stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'magpie', 'worktree-compare'),
  openFolder, timeoutMs }) {
  const arena = new Arena({ stateDir, openFolder, timeoutMs,
    runner: (input) => runCandidate({ ...input, confirmed: true }) });
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const host = '127.0.0.1:' + server.address()?.port;
      if (req.headers.host !== host) throw httpError(403, 'Invalid local host.');
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && origin !== 'http://' + host) throw httpError(403, 'Invalid origin.');
      if (origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Arena-Key, X-Arena-Request' });
        return res.end();
      }
      const path = req.url.split('?')[0];
      const asset = assets.get(path);
      if (req.method === 'GET' && asset) {
        const data = await readFile(new URL('../page/' + asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1],
          'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://${host}; img-src 'self' data:; base-uri 'none'; form-action 'none'` });
        return res.end(data);
      }
      authorize(req, options.arenaAccess);
      if (req.method === 'GET' && path === '/api/models') return send(res, 200, { models: await listModels() });
      if (req.method === 'GET' && path === '/api/runs') return send(res, 200, { runs: await arena.list() });
      if (req.method === 'POST' && path === '/api/runs') {
        const { repo, prompt, models } = await readInput(req);
        if (typeof repo !== 'string' || typeof prompt !== 'string' || !prompt.trim() ||
            !Array.isArray(models) || models.length !== 2 || models[0] === models[1]) {
          throw httpError(400, 'Choose a Git repository, a task and two different models.');
        }
        const available = await listModels();
        if (!models.every(model => available.includes(model))) throw httpError(400, 'Select two available Magpie models.');
        return send(res, 201, { run: await arena.start({ repo, prompt, models }) });
      }
      const match = /^\/api\/runs\/([a-zA-Z0-9-]+)(?:\/(cancel|discard)|\/([ab])\/(diff|choose|open))?$/.exec(path);
      if (!match) throw httpError(404, 'Unknown route.');
      const [, id, runAction, side, sideAction] = match;
      if (req.method === 'GET' && !runAction && !side) return send(res, 200, { run: await arena.get(id) });
      if (req.method === 'GET' && sideAction === 'diff') return send(res, 200, { diff: await arena.diff(id, side) });
      if (req.method === 'POST' && (runAction || sideAction === 'choose' || sideAction === 'open')) {
        await readInput(req);
        const run = runAction ? await arena[runAction](id) : await arena[sideAction](id, side);
        return send(res, 200, { run });
      }
      throw httpError(405, 'Unsupported method.');
    } catch (error) {
      send(res, Number.isInteger(error.status) ? error.status : 400, { error: error.message });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}

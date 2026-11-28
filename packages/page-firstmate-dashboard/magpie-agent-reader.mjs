import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { Readable } from 'node:stream';

const modelKeys = [
  'value', 'label', 'note', 'icon', 'icons', 'group', 'groupIcon', 'ref',
  'free', 'zero', 'rate', 'rateWas', 'context', 'takes', 'direct', 'via',
  'same', 'served', 'alias', 'fast', 'ownFast', 'ultraOk', 'ultra', 'reset',
];

function fieldsOf(agent, state, speeds) {
  return (agent.fields || []).filter(field => ['model', 'effort'].includes(field.key)).map(field => {
    const options = field.list
      ? state.optionLists[field.list - 1].map(index => state.options[index])
      : field.options || [];
    return { key: field.key, value: String(field.value || ''), options: options.map(option => {
      const result = {};
      for (const key of modelKeys) {
        if (option[key] !== undefined) result[key] = option[key];
      }
      if (option.fastFor) result.fastFor = true;
      const speed = option.ref && speeds[option.ref];
      if (speed) result.speed = { tps: Number(speed.tps) || 0, ttft: Number(speed.ttft) || 0 };
      return result;
    }) };
  });
}

async function customIcons(fields, get) {
  const names = new Set(fields.flatMap(field => field.options.flatMap(option =>
    [option.icon, option.groupIcon, ...(option.icons || [])].filter(icon =>
      /^file:[a-f0-9]{8,64}\.(?:png|webp|jpe?g|svg)$/i.test(icon)))));
  const icons = await Promise.all([...names].slice(0, 24).map(async name => {
    try {
      const response = await get(`/api/icons/${encodeURIComponent(name.slice(5))}`);
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!response.ok || !/^image\/(png|webp|jpeg|svg\+xml)$/.test(type)) return null;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 65536) return null;
      return [name, `data:${type};base64,${Buffer.from(bytes).toString('base64')}`];
    } catch { return null; }
  }));
  return Object.fromEntries(icons.filter(Boolean));
}

// Agent reads use the same endpoints as MagPie's Web UI. A running daemon
// can return its existing loopback URL instead of opening a temporary listener.
// The URL and its key stay in the execution machine's reader process.
export async function readAgentState(agentId = '') {
  const env = { ...process.env, MAGPIE_WEB_KEY: randomBytes(24).toString('hex') };
  for (const name of ['MAGPIE_WEB_URL', 'MAGPIE_PUBLIC_URL', 'MAGPIE_WEB_SIGN_IN']) delete env[name];
  const child = spawn('magpie', ['web', '--addr', '127.0.0.1:0', '--no-open'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const abort = new AbortController();
  const unavailable = () => new Error('MagPie 原生模型字段读取失败');
  let timer;
  try {
    const { port, key } = await new Promise((resolve, reject) => {
      const fail = () => reject(unavailable());
      timer = setTimeout(() => { abort.abort(); fail(); }, 12000);
      child.once('error', fail);
      child.once('close', fail);
      for (const stream of [child.stdout, child.stderr]) {
        let output = '';
        stream.setEncoding('utf8');
        stream.on('data', data => {
          output = (output + data).slice(-16384);
          const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?k=([a-zA-Z0-9._~-]+)(?=\s)/);
          if (match) resolve({ port: match[1], key: match[2] });
        });
      }
    });
    const get = path => new Promise((resolve, reject) => {
      // The web key is loopback-only, including when Node uses environment proxies.
      const request = httpGet({
        hostname: '127.0.0.1', port, path, agent: false, signal: abort.signal,
        headers: { Cookie: `magpie_web_${port}=${key}` },
      }, response => resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode, headers: response.headers,
      })));
      request.once('error', reject);
    });
    const res = await get('/api/state');
    if (!res.ok) throw unavailable();
    const state = await res.json();
    if (!Array.isArray(state.agents)) throw unavailable();
    const speeds = await get('/api/model-speeds').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    return await Promise.all(state.agents.filter(agent => !agentId || agent.id === agentId).map(async agent => {
      const fields = fieldsOf(agent, state, speeds);
      return { id: agent.id, wired: Boolean(agent.wired), fields,
        ...(agentId ? { customIcons: await customIcons(fields, get) } : {}) };
    }));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT');
      let deadline;
      await Promise.race([closed, new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]);
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

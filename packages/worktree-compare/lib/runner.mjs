import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const defaultGatewayPort = 3425;
const maxMillis = 8 * 60_000;
const maxSummaryBytes = 16_384;

function gatewayPort(options) {
  const address = process.env.MAGPIE_ADDR;
  const hostPort = address && /^(?:[^:/?#]*|\[[^\]]+\]):(\d+)$/.exec(address)?.[1];
  const port = Number(options.gatewayPort ?? hostPort ?? defaultGatewayPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Magpie gateway port is invalid.');
  return port;
}

function validModel(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 300 && !/[\s\p{Cc}]/u.test(id);
}

// Local HTTP only. No proxy, redirects, model requests, or credential lookup.
export async function listModels(options = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(options.signal ? [options.signal] : [])]);
  const body = await new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port: gatewayPort(options), path: '/v1/models', signal}, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Magpie could not list models (HTTP ${res.statusCode}).`));
        return;
      }
      const parts = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', part => {
        size += part.length;
        if (size > 4 * 1024 * 1024) req.destroy(new Error('Magpie model list exceeds 4 MiB.'));
        else parts.push(part);
      });
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });
  let data;
  try { data = JSON.parse(body)?.data; } catch { /* Report a response-format error below. */ }
  if (!Array.isArray(data)) throw new Error('Magpie returned an invalid model list.');
  const ids = data.filter(m => validModel(m?.id) && m.tool_call !== false &&
    (!Array.isArray(m.modalities?.output) || m.modalities.output.includes('text'))).map(m => m.id);
  return [...new Set(ids)];
}

function cliPath() {
  // Magpie launched from Finder may have only the system PATH.
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(p => path.isAbsolute(p)),
    path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    '/opt/homebrew/opt/node@22/bin', '/usr/local/opt/node@22/bin',
  ];
  return [...new Set(dirs)].join(path.delimiter);
}

async function findCodex(executable, searchPath) {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = executable ? [executable] : searchPath.split(path.delimiter).map(dir => path.join(dir, name));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Codex CLI was not found. Install the Codex CLI or configure its absolute executable path in the plugin.');
}

// Keep the host's original process group for Magpie shutdown. During a
// per-candidate cancellation, stop the launcher before finding its children:
// an npm shim that exits first could otherwise leave the native CLI running.
function stopCandidate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true, timeout: 5000});
    } catch { child.kill('SIGKILL'); }
    return;
  }
  const frozen = new Set();
  const freeze = pid => {
    try { process.kill(pid, 'SIGSTOP'); frozen.add(pid); } catch { /* Already exited. */ }
  };
  freeze(child.pid);
  try {
    for (let depth = 0; depth < 64 && frozen.size; depth++) {
      const snapshot = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], {encoding: 'utf8', timeout: 1500, maxBuffer: 4 * 1024 * 1024});
      const before = frozen.size;
      for (const line of snapshot.trim().split('\n')) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (frozen.has(parent) && !frozen.has(pid)) freeze(pid);
      }
      if (frozen.size === before) break;
    }
  } finally {
    for (const pid of [...frozen].reverse()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
}

function runProcess(executable, args, {cwd, env, prompt, signal}) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Stay in the Magpie host process tree so its shutdown cleans up children.
    const child = spawn(executable, args, {cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']});
    let errorTail = '';
    const stop = () => {
      try { stopCandidate(child); } catch { child.kill('SIGKILL'); }
    };
    signal.addEventListener('abort', stop, {once: true});
    child.stdin.on('error', () => {}); // A CLI startup failure may close the pipe before reading.
    child.stderr.on('data', chunk => { errorTail = (errorTail + chunk.toString()).slice(-4096); });
    child.once('error', err => {
      reject(new Error(`Could not launch Codex CLI (${err.code ?? 'spawn failed'}).`));
    });
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new Error(signal.reason?.name === 'TimeoutError' ? 'Candidate reached its time limit.' : 'Candidate cancelled.'));
      else if (code === 0) resolve();
      else if (/unexpected argument|unrecognized option/i.test(errorTail)) reject(new Error('Codex CLI does not support the required isolation flags. Update Codex CLI.'));
      else if (/unauthori[sz]ed|401 Unauthorized/i.test(errorTail)) reject(new Error('The local gateway did not authorize this model run.'));
      else reject(new Error(`Codex CLI exited with code ${code ?? 'signal'}. Check the selected model and Magpie gateway.`));
    });
    child.stdin.end(prompt);
  });
}

export function createRunner(options = {}) {
  const port = gatewayPort(options);
  return async ({cwd, model, prompt, confirmed, signal: callerSignal}) => {
    if (confirmed !== true) throw new Error('Running a model requires explicit usage confirmation.');
    if (!path.isAbsolute(cwd) || !validModel(model) || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Invalid model run.');
    const duration = options.timeoutMs ?? maxMillis;
    if (!Number.isInteger(duration) || duration < 1 || duration > maxMillis) throw new Error('Invalid candidate time limit.');
    const signal = AbortSignal.any([AbortSignal.timeout(duration), ...(callerSignal ? [callerSignal] : [])]);
    const searchPath = cliPath();
    const executable = await findCodex(options.codexPath, searchPath);
    const temp = await mkdtemp(path.join(tmpdir(), 'magpie-worktree-run-'));
    try {
      const codexHome = path.join(temp, 'codex');
      await mkdir(codexHome, {mode: 0o700});
      const messageFile = path.join(temp, 'result.txt');
      // Use a clean HOME and CODEX_HOME for this invocation. In particular no
      // auth.json, hosted tools, or user-defined MCP processes are needed.
      const env = {PATH: searchPath, HOME: temp, USERPROFILE: temp, CODEX_HOME: codexHome, LANG: 'en_US.UTF-8'};
      if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'workspace-write',
        '--color', 'never', '--cd', cwd, `--model=${model}`, '--output-last-message', messageFile,
        '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
        '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false',
        '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
        '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
        '-c', 'model_provider="magpie_arena"', '-c', 'model_providers.magpie_arena.name="Magpie"',
        '-c', `model_providers.magpie_arena.base_url="http://127.0.0.1:${port}/v1"`,
        '-c', 'model_providers.magpie_arena.wire_api="responses"',
        '-c', 'model_providers.magpie_arena.request_max_retries=0', '-c', 'model_providers.magpie_arena.stream_max_retries=0', '-'];
      await runProcess(executable, args, {cwd, env, prompt, signal});
      const file = await open(messageFile, 'r');
      try {
        const {buffer, bytesRead} = await file.read(Buffer.alloc(maxSummaryBytes));
        return {summary: buffer.toString('utf8', 0, bytesRead).trim()};
      } finally { await file.close(); }
    } finally { await rm(temp, {force: true, recursive: true}); }
  };
}

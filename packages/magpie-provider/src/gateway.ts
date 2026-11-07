import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MagpieModel } from './catalog.js';

export const INSTALL_MESSAGE =
  '未安装 Magpie，请先从 https://usemagpie.ai/zh/ 安装并登录所需服务，再使用此插件。';

export type GatewayConnection = {
  agentID?: string;
  baseURL: string;
  token: string;
  remote: boolean;
  ensure: () => Promise<void>;
};

/** Explicit remote URLs are API bases, including any reverse-proxy prefix and version path. */
export const resolveConnection = async (options?: unknown): Promise<GatewayConnection> => {
  const agentID = (options as { agentID?: unknown } | undefined)?.agentID ?? 'opencode';
  if (typeof agentID !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentID))
    throw new Error('Magpie options.agentID must be a lowercase identifier (1-64 characters).');
  const remote = (options as { remote?: unknown } | undefined)?.remote;
  if (remote === undefined) {
    const localURL = await resolveBaseURL();
    return {
      agentID,
      baseURL: `${localURL}/v1`,
      token: 'magpie',
      remote: false,
      ensure: () => ensureGateway(localURL),
    };
  }
  const invalid = (field: string, reason: string): Error =>
    new Error(`Magpie 插件的 options.remote${field} 无效：${reason}。`);
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote))
    throw invalid('', '必须是包含 baseURL 和 token 的对象');
  const value = remote as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'baseURL' && key !== 'token'))
    throw invalid('', '仅支持 baseURL 和 token 字段');
  let url: URL;
  try {
    if (typeof value.baseURL !== 'string' || value.baseURL.trim() !== value.baseURL)
      throw new Error();
    url = new URL(value.baseURL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw invalid(
      '.baseURL',
      '必须是完整 HTTP(S) API 基地址，不能包含用户名、密码、查询参数或片段',
    );
  }
  if (typeof value.token !== 'string' || !/^[\x21-\x7e]+$/.test(value.token))
    throw invalid('.token', '必须是非空 token，不能包含空格或控制字符');
  return {
    agentID,
    baseURL: url.href.replace(/\/+$/, ''),
    token: value.token,
    remote: true,
    ensure: async () => {},
  };
};

export const resolveBaseURL = async (): Promise<string> => {
  if (process.env.MAGPIE_ADDR) {
    const addr = process.env.MAGPIE_ADDR.replace(/^:/, '127.0.0.1:');
    const url = new URL(addr.includes('://') ? addr : `http://${addr}`);
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Magpie 自动启动仅支持本机 MAGPIE_ADDR。');
    }
    return url.origin;
  }
  const path = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'magpie',
    'settings.json',
  );
  const settings: { port?: number } = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as { port?: number })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
  const port = settings.port || 3425;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Magpie settings.json 中的 port 无效。');
  return `http://127.0.0.1:${port}`;
};

export const findExecutable = async (): Promise<string | undefined> => {
  const binary = process.platform === 'win32' ? 'magpie.exe' : 'magpie';
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, binary)),
    join(homedir(), '.local', 'bin', binary),
    '/opt/homebrew/bin/magpie',
    '/usr/local/bin/magpie',
    '/Applications/Magpie.app/Contents/MacOS/magpie',
    join(homedir(), 'Applications/Magpie.app/Contents/MacOS/magpie'),
  ];
  const found = await Promise.all(
    candidates.map(
      async (path) =>
        await access(path, constants.X_OK).then(
          () => path,
          () => undefined,
        ),
    ),
  );
  const executable = found.find(Boolean);
  if (!executable) return undefined;
  // The installer links Magpie.app into ~/.local/bin, and a PATH entry wins over the bundle.
  // Resolve the link so the caller can tell the app from a standalone CLI before starting it.
  return await realpath(executable).catch(() => executable);
};

export const probeGateway = async (baseURL: string): Promise<boolean> => {
  let response: Response;
  try {
    response = await fetch(baseURL, { signal: AbortSignal.timeout(1500) });
  } catch {
    return false;
  }
  const info = (await response.json().catch(() => undefined)) as { name?: string } | undefined;
  if (!response.ok || info?.name !== 'magpie')
    throw new Error(`${baseURL} 已被非 Magpie 服务占用。`);
  return true;
};

/**
 * How to bring the gateway up when nothing is listening.
 *
 * `magpie serve` runs the gateway with no window, and only a window can show Magpie's Routing
 * view. A windowless gateway that wins the port keeps Magpie's own app from starting one — the
 * app does not take the port back, it just reports that routing cannot be watched there. On
 * macOS the bundled executable is the app, which serves the gateway as well and keeps the
 * Routing view available.
 *
 * `--web` is not an option here: it opens a second listener on a fixed port, and when that port
 * is taken the whole gateway exits instead of just the page.
 */
export const gatewayArgs = (executable: string): string[] => {
  const app = /[\\/]magpie\.app[\\/]/i.test(executable);
  return process.platform === 'darwin' && app ? ['tray'] : ['serve'];
};

/**
 * The commands to try, in order, when nothing is listening.
 *
 * The app is preferred on macOS because only it has a window, and a window is what shows the
 * Routing view. It needs a GUI session, though: a Mac reached over SSH, or one where OpenCode
 * runs as a daemon, has none, and `magpie tray` then exits without serving. The windowless
 * gateway has no such requirement, which is why it stays as the fallback rather than being
 * replaced.
 */
export const startAttempts = (executable: string): string[][] => {
  const preferred = gatewayArgs(executable);
  return preferred[0] === 'tray' ? [preferred, ['serve']] : [preferred];
};

const startGateway = async (executable: string, args: string[]): Promise<{ failed: boolean }> => {
  const state = { failed: false };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    // A successful exit can mean handoff to an existing app, not startup failure.
    child.once('exit', (code: number | null, signal: string | null) => {
      state.failed = (code !== null && code !== 0) || signal != null;
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return state;
};

/** Polls until the gateway answers, or gives up after `tries` half-second waits. */
const waitForGateway = async (
  baseURL: string,
  tries: number,
  state: { failed: boolean },
): Promise<boolean> => {
  for (let remaining = tries; remaining >= 0; remaining -= 1) {
    if (await probeGateway(baseURL)) return true;
    if (state.failed) return false;
    if (remaining === 0) return false;
    await delay(500);
  }
  return false;
};

const starting = new Map<string, Promise<void>>();

export const ensureGateway = async (baseURL: string): Promise<void> => {
  if (await probeGateway(baseURL)) return;
  const pending = starting.get(baseURL);
  if (pending) return pending;
  const task = (async () => {
    const executable = await findExecutable();
    if (!executable) throw new Error(INSTALL_MESSAGE);
    for (const args of startAttempts(executable)) {
      const state = await startGateway(executable, args);
      if (await waitForGateway(baseURL, args[0] === 'tray' ? 60 : 30, state)) return;
      if (args[0] === 'tray' && !state.failed) {
        throw new Error(
          'Magpie app 网关尚未就绪，请在 app 中检查网关状态；未启动无窗口服务，以免抢占端口。',
        );
      }
    }
    throw new Error('Magpie 网关启动超时，请运行 magpie serve 查看错误。');
  })();
  starting.set(baseURL, task);
  try {
    await task;
  } finally {
    starting.delete(baseURL);
  }
};

export const fetchModels = async (baseURL: string, token = 'magpie', agentID = 'opencode'): Promise<MagpieModel[]> => {
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Magpie-Prices': '1',
      'X-Magpie-Agent': agentID,
      'User-Agent': `${agentID}/opencode-magpie-provider`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Magpie 模型发现失败：HTTP ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as
    | { data?: MagpieModel[] }
    | undefined;
  if (
    !Array.isArray(body?.data) ||
    body.data.some(
      (model) => !model || typeof model.id !== 'string' || typeof model.owned_by !== 'string',
    )
  ) {
    throw new Error('Magpie models 接口返回了无效的模型目录。');
  }
  return body.data;
};

import { processAlive } from './proc.mjs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sides = ['a', 'b'];
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const maxDiff = 2 * 1024 * 1024;
const gitOptions = [
  '-c',
  'core.hooksPath=' + devNull,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'submodule.recurse=false',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=false',
];
const queues = new Map();

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

async function git(dir, args, { options = [], codes = [], clip = false } = {}) {
  try {
    const result = await exec('git', ['--no-pager', ...gitOptions, ...options, '-C', dir, ...args], {
      env: gitEnv(),
      maxBuffer: maxDiff,
      timeout: 60_000,
    });
    return result.stdout;
  } catch (err) {
    if (clip && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return err.stdout + '\n[Diff truncated]\n';
    if (codes.includes(err.code)) return err.stdout;
    throw new Error((err.stderr || err.message).trim().slice(0, 1400));
  }
}

async function disableFilters(repo) {
  // A repository's configured clean, smudge or process filter can run an external
  // command during checkout or diff. Disable every configured driver by name.
  const keys = await git(repo, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
    codes: [1],
  });
  const options = [];
  for (const name of new Set(
    keys
      .split('\0')
      .filter(Boolean)
      .map((x) => x.slice(0, x.lastIndexOf('.'))),
  )) {
    for (const key of ['clean', 'smudge', 'process']) options.push('-c', name + '.' + key + '=');
    options.push('-c', name + '.required=false');
  }
  return options;
}

async function atomicJSON(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function json(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function input(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error('Invalid ' + name);
  }
  return value.trim();
}

async function defaultOpen(cwd) {
  if (process.platform === 'win32') await exec('explorer.exe', [cwd]);
  else await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [cwd]);
}

export class Arena {
  constructor({ stateDir, runner, openFolder = defaultOpen, timeoutMs = 15 * 60_000 }) {
    if (
      !path.isAbsolute(stateDir) ||
      typeof runner !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new Error('Arena requires an absolute stateDir, runner and positive timeout');
    }
    this.stateDir = path.resolve(stateDir);
    this.runner = runner;
    this.openFolder = openFolder;
    this.timeoutMs = timeoutMs;
    this.claims = path.join(this.stateDir, 'claims');
    this.runs = path.join(this.stateDir, 'runs');
    this.live = null;
  }

  // Keep read-modify-write operations ordered, including callers using another
  // Arena instance for the same state in this process.
  _queue(fn) {
    const previous = queues.get(this.stateDir) || Promise.resolve();
    const current = previous.then(fn);
    const tail = current.catch(() => {});
    queues.set(this.stateDir, tail);
    tail.then(() => {
      if (queues.get(this.stateDir) === tail) queues.delete(this.stateDir);
    });
    return current;
  }

  _dir(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid comparison id');
    return path.join(this.runs, id);
  }

  _save(run) {
    return atomicJSON(path.join(this._dir(run.id), 'run.json'), run);
  }

  async _read(id) {
    const run = await json(path.join(this._dir(id), 'run.json'));
    if (run.id !== id) throw new Error('Invalid comparison metadata');
    if (run.status !== 'running') return run;
    const { owner } = await this._latestClaim();
    if (owner?.id === id && !owner.released && processAlive(owner.pid)) return run;
    for (const entry of run.candidates) {
      if (['pending', 'running'].includes(entry.status)) entry.status = 'interrupted';
    }
    run.status = 'interrupted';
    await this._save(run);
    return run;
  }

  get(id) {
    return this._queue(() => this._read(id));
  }

  list() {
    return this._queue(async () => {
      await fs.mkdir(this.runs, { recursive: true, mode: 0o700 });
      const names = await fs.readdir(this.runs, { withFileTypes: true });
      const runs = [];
      for (const e of names) {
        if (!e.isDirectory() || !idPattern.test(e.name)) continue;
        try {
          runs.push(await this._read(e.name));
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  // An append-only sequence of tiny lease records acts as a compare-and-swap.
  // Two processes recovering the same dead owner compete for the same next
  // number. Neither can unlink a lease that the other process just acquired.
  async _latestClaim() {
    await fs.mkdir(this.claims, { recursive: true, mode: 0o700 });
    const names = (await fs.readdir(this.claims)).filter((name) => /^\d{12}$/.test(name)).sort();
    if (!names.length) return { number: 0, owner: null };
    const name = names.at(-1);
    const owner = await json(path.join(this.claims, name));
    return { number: Number(name), owner };
  }

  async _claim(id) {
    const { number, owner } = await this._latestClaim();
    if (owner && !owner.released && processAlive(owner.pid)) throw new Error('A comparison is already active');
    const file = path.join(this.claims, String(number + 1).padStart(12, '0'));
    const proposal = path.join(this.claims, id + '.tmp');
    await fs.writeFile(proposal, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(proposal, file);
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error('A comparison is already active');
      throw err;
    } finally {
      await fs.rm(proposal, { force: true });
    }
    return file;
  }

  async _release(file, id) {
    const owner = await json(file);
    if (owner.id === id) await atomicJSON(file, { ...owner, released: true });
  }

  start({ repo, prompt, models } = {}) {
    return this._queue(async () => {
      const folder = input(repo, 'repository path', 16000);
      if (!path.isAbsolute(folder)) throw new Error('Choose an absolute local repository path');
      prompt = input(prompt, 'task', 32_000);
      if (!Array.isArray(models) || models.length !== 2) throw new Error('Choose two models');
      models = models.map((model) => input(model, 'model', 256));
      if (models[0] === models[1]) throw new Error('Choose two different models');
      const root = await fs.realpath((await git(folder, ['rev-parse', '--show-toplevel'])).trimEnd());
      const base = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base)) throw new Error('Repository has no valid HEAD');
      // Resolve an existing ancestor before creating anything inside the project.
      let ancestor = this.stateDir;
      for (;;) {
        try {
          ancestor = await fs.realpath(ancestor);
          break;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          ancestor = path.dirname(ancestor);
        }
      }
      const relative = path.relative(root, ancestor);
      if (
        relative === '' ||
        (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      ) {
        throw new Error('Arena storage must be outside the selected repository');
      }
      await fs.mkdir(this.runs, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const claim = await this._claim(id);
      const dir = this._dir(id);
      const run = {
        id,
        repo: root,
        base,
        prompt,
        createdAt: new Date().toISOString(),
        status: 'running',
        candidates: sides.map((side, i) => ({
          side,
          model: models[i],
          cwd: path.join(dir, side),
          status: 'pending',
        })),
      };
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        await this._save(run);
        for (const candidate of run.candidates) {
          await git(root, ['worktree', 'add', '--no-checkout', '--detach', '--', candidate.cwd, base]);
          // Conditional git config can choose drivers based on the new worktree's path.
          await this._workspace(run, candidate.side);
          const options = await disableFilters(candidate.cwd);
          await git(candidate.cwd, ['read-tree', '-m', '-u', base], { options });
        }
        for (const candidate of run.candidates) candidate.status = 'running';
        await this._save(run);
        this.live = { id, claim, remaining: 2, controllers: sides.map(() => new AbortController()) };
        const controllers = this.live.controllers;
        setImmediate(() => {
          for (const [i, entry] of run.candidates.entries()) {
            this._execute(run, entry, controllers[i]).catch((err) =>
              console.error('Arena state update failed:', err.message),
            );
          }
        });
        return structuredClone(run);
      } catch (err) {
        run.status = 'failed';
        for (const entry of run.candidates) {
          entry.status = 'failed';
          entry.error = String(err.message).slice(0, 1400);
        }
        try {
          await this._save(run);
        } finally {
          await this._release(claim, id);
        }
        throw err;
      }
    });
  }

  async _execute(run, entry, controller) {
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new Error('Time limit exceeded')), this.timeoutMs);
    let summary = '',
      failure = '',
      execution;
    try {
      signal.throwIfAborted();
      execution = Promise.resolve().then(() =>
        this.runner({ cwd: entry.cwd, prompt: run.prompt, model: entry.model, signal }),
      );
      const result = await Promise.race([
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
        execution,
      ]);
      summary = String(result?.summary || '').slice(0, 24_000);
    } catch (err) {
      failure = String(err?.message || err || 'Agent failed').slice(0, 1800);
    } finally {
      clearTimeout(timer);
    }
    await this._queue(async () => {
      const current = await this._read(run.id);
      const candidate = current.candidates.find((x) => x.side === entry.side);
      if (candidate.status === 'running') {
        candidate.status = failure ? 'failed' : 'completed';
        if (failure) candidate.error = failure;
        if (summary) candidate.summary = summary;
      }
      if (current.status === 'running' && current.candidates.every((x) => x.status !== 'running')) {
        current.status = current.candidates.every((x) => x.status === 'completed') ? 'completed' : 'failed';
      }
      await this._save(current);
    });
    // Mark the result as soon as the timeout fires, but retain the activity
    // lease until both runners actually exit, including their shutdown grace.
    try {
      await execution;
    } catch {
      /* The candidate's error is recorded above. */
    }
    await this._queue(async () => {
      if (this.live?.id !== run.id || --this.live.remaining > 0) return;
      await this._release(this.live.claim, run.id);
      this.live = null;
    });
  }

  _candidate(run, side) {
    if (!sides.includes(side)) throw new Error('Invalid candidate side');
    const entry = run.candidates.find((x) => x.side === side);
    if (!entry || entry.cwd !== path.join(this._dir(run.id), side)) throw new Error('Invalid worktree path');
    return entry;
  }

  async _workspace(run, side) {
    const { cwd } = this._candidate(run, side);
    if ((await fs.realpath(cwd)) !== path.join(await fs.realpath(this.runs), run.id, side)) {
      throw new Error('Worktree path has changed');
    }
    const actual = await fs.realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trimEnd());
    if (actual !== (await fs.realpath(cwd))) throw new Error('Worktree is no longer available');
    return cwd;
  }

  async diff(id, side) {
    const run = await this.get(id);
    const cwd = await this._workspace(run, side);
    const options = await disableFilters(cwd);
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];
    const patch = await git(cwd, ['diff', ...flags, run.base, '--', '.'], { options, clip: true });
    const rawNames = await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], {
      options,
      clip: true,
    });
    // Only use complete NUL-terminated names if git's name output was capped.
    const names = rawNames
      .slice(0, rawNames.lastIndexOf('\0') + 1)
      .split('\0')
      .filter(Boolean);
    let remaining = maxDiff - Buffer.byteLength(patch);
    const chunks = [patch];
    for (const name of names.slice(0, 256)) {
      if (remaining <= 0) break;
      let extra;
      const info = await fs.lstat(path.join(cwd, name));
      if (info.isFile() || info.isSymbolicLink()) {
        extra = await git(cwd, ['diff', '--no-index', ...flags, '--', devNull, './' + name], {
          options,
          codes: [1],
          clip: true,
        });
      } else {
        extra = '\n[Untracked directory or special file] ' + JSON.stringify(name) + '\n';
      }
      const data = Buffer.from(extra);
      chunks.push(data.subarray(0, remaining).toString());
      remaining -= data.length;
    }
    if (remaining <= 0 || names.length > 256 || (rawNames && !rawNames.endsWith('\0')))
      chunks.push('\n[Diff truncated]\n');
    return chunks.join('');
  }

  async open(id, side) {
    const run = await this.get(id);
    await this.openFolder(await this._workspace(run, side));
    return run;
  }

  choose(id, side) {
    return this._queue(async () => {
      const run = await this._read(id);
      if (run.status === 'discarded' || this._candidate(run, side).status !== 'completed') {
        throw new Error('Select a completed candidate in an unarchived comparison');
      }
      if (run.status === 'running')
        throw new Error('Wait for the comparison to finish before selecting a candidate');
      if (run.chosen && run.chosen !== side) throw new Error('Another candidate is already selected');
      const cwd = await this._workspace(run, side);
      // Validate the two ends of Git's worktree registration before moving a
      // ref. A misplaced .git file can otherwise refer to another checkout.
      const metadata = await fs.realpath((await git(cwd, ['rev-parse', '--absolute-git-dir'])).trimEnd());
      const common = await fs.realpath(
        (await git(run.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd(),
      );
      const dotGit = path.join(await fs.realpath(cwd), '.git');
      if (!(await fs.lstat(dotGit)).isFile() || path.dirname(metadata) !== path.join(common, 'worktrees')) {
        throw new Error('This worktree is no longer registered to the selected repository');
      }
      const backlink = (await fs.readFile(path.join(metadata, 'gitdir'), 'utf8')).trimEnd();
      if ((await fs.realpath(path.resolve(metadata, backlink))) !== dotGit) {
        throw new Error('Git registration belongs to a different checkout');
      }

      let ref = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], { codes: [1] })).trimEnd();
      if (!ref) {
        const branch = 'worktree-compare/' + id + '/' + side;
        const options = await disableFilters(cwd);
        // -c creates a new branch transactionally and refuses a name collision.
        // Starting at this worktree's own HEAD keeps its index and files intact.
        await git(cwd, ['switch', '--no-track', '-c', branch], { options });
        ref = (await git(cwd, ['symbolic-ref', 'HEAD'])).trimEnd();
      }
      if (!ref.startsWith('refs/heads/')) throw new Error('This worktree is not on a local branch');
      run.chosen = side;
      run.chosenBranch = ref.slice('refs/heads/'.length);
      await this._save(run);
      return run;
    });
  }

  cancel(id) {
    return this._queue(async () => {
      const run = await this._read(id);
      if (run.status !== 'running') return run;
      if (this.live?.id !== id) throw new Error('This comparison is managed by another running service');
      for (const controller of this.live.controllers) controller.abort(new Error('Cancelled'));
      for (const entry of run.candidates) if (entry.status === 'running') entry.status = 'cancelled';
      run.status = 'cancelled';
      await this._save(run);
      return run;
    });
  }

  discard(id) {
    return this._queue(async () => {
      const run = await this._read(id);
      if (run.status === 'running') throw new Error('Cancel the comparison before archiving it');
      run.status = 'discarded';
      await this._save(run);
      return run;
    });
  }
}

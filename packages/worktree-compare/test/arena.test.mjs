import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Arena } from '../lib/arena.mjs';

const exec = promisify(execFile);
const git = async (cwd, ...args) =>
  (
    await exec(
      'git',
      [
        '-c',
        'user.name=Arena test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-C',
        cwd,
        ...args,
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
    )
  ).stdout.trim();
async function fixture(t, runner, options = {}) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'arena-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo with ' and space"),
    stateDir = path.join(dir, 'state');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, 'source.txt'), 'initial\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'base');
  return {
    dir,
    repo,
    stateDir,
    arena: new Arena({ stateDir, runner, ...options }),
    args: { repo, prompt: 'Improve it', models: ['alpha', 'beta'] },
  };
}
async function wait(arena, id) {
  for (let i = 0; i < 200; i++) {
    const run = await arena.get(id);
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('run did not finish');
}

test('two isolated trees from the same commit, selection and archival preserve all work', async (t) => {
  const opened = [];
  const { arena, repo, args, stateDir } = await fixture(
    t,
    async ({ cwd, model }) => {
      assert.equal(await fs.readFile(path.join(cwd, 'source.txt'), 'utf8'), 'initial\n');
      await fs.writeFile(path.join(cwd, 'source.txt'), model + ' committed\n');
      await git(cwd, 'commit', '-qam', 'candidate change');
      await fs.writeFile(path.join(cwd, "-agent's notes.txt"), model + ' untracked\n');
      return { summary: model + ' summary' };
    },
    { openFolder: async (dir) => opened.push(dir) },
  );
  await fs.writeFile(path.join(repo, 'source.txt'), 'personal unstaged change\n');
  const run = await arena.start(args);
  assert.equal(run.candidates.length, 2);
  assert.equal(run.base, await git(repo, 'rev-parse', 'HEAD'));
  const completed = await wait(arena, run.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.candidates));
  for (const entry of completed.candidates) {
    const patch = await arena.diff(run.id, entry.side);
    assert.match(patch, new RegExp(entry.model + ' committed'));
    assert.match(patch, new RegExp(entry.model + ' untracked'));
    assert.equal(entry.summary, entry.model + ' summary');
  }
  assert.equal((await arena.choose(run.id, 'a')).chosen, 'a');
  await arena.open(run.id, 'b');
  assert.deepEqual(opened, [run.candidates[1].cwd]);
  assert.equal(await fs.readFile(path.join(repo, 'source.txt'), 'utf8'), 'personal unstaged change\n');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), run.base);
  assert.equal((await arena.discard(run.id)).status, 'discarded');
  for (const entry of completed.candidates) assert.ok((await fs.stat(entry.cwd)).isDirectory());
  const restarted = new Arena({ stateDir, runner: () => assert.fail('unexpected replay') });
  assert.equal((await restarted.list())[0].status, 'discarded');
  await assert.rejects(restarted.choose(run.id, 'a'), /archived/);
  await assert.rejects(restarted.get('../path'), /Invalid comparison id/);
});

test('no hook or configured clean/smudge program executes during arena setup or diff', async (t) => {
  const { arena, dir, repo, args } = await fixture(t, async () => ({}));
  const marker = path.join(dir, 'fired');
  const program = path.join(dir, 'hook');
  await fs.writeFile(program, '#!/bin/sh\ntouch "' + marker + '"\ncat\n', { mode: 0o755 });
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=sideeffect\n');
  await git(repo, 'add', '.gitattributes');
  await git(repo, 'commit', '-qm', 'attributes');
  await git(repo, 'config', 'filter.sideeffect.smudge', program);
  await git(repo, 'config', 'filter.sideeffect.clean', program);
  await git(repo, 'config', 'filter.sideeffect.required', 'true');
  await fs.copyFile(program, path.join(repo, '.git/hooks/post-checkout'));
  await fs.chmod(path.join(repo, '.git/hooks/post-checkout'), 0o755);
  const run = await arena.start(args);
  assert.equal((await wait(arena, run.id)).status, 'completed');
  await fs.writeFile(path.join(run.candidates[0].cwd, 'source.txt'), 'changed\n');
  assert.match(await arena.diff(run.id, 'a'), /changed/);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('only one active run, cancellation and timeout abort the agents without retry', async (t) => {
  let calls = 0;
  const { arena, args, stateDir } = await fixture(
    t,
    ({ signal }) =>
      new Promise((_, reject) => {
        calls++;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = await arena.start(args);
  const second = new Arena({ stateDir, runner: () => assert.fail('duplicate run') });
  await assert.rejects(second.start(args), /already active/);
  await assert.rejects(arena.discard(run.id), /Cancel/);
  await assert.rejects(arena.choose(run.id, 'a'), /completed/);
  assert.equal((await arena.cancel(run.id)).status, 'cancelled');
  assert.equal((await second.get(run.id)).status, 'cancelled');
  const short = new Arena({
    stateDir,
    runner: () => {
      calls++;
      return new Promise(() => {});
    },
    timeoutMs: 35,
  });
  const timed = await short.start(args);
  const finished = await wait(short, timed.id);
  assert.equal(finished.status, 'failed');
  assert.ok(finished.candidates.every((x) => x.error === 'Time limit exceeded'));
  assert.equal(calls, 4);
});

test('interruption persists, no automatic resume, and malformed inputs never create a run', async (t) => {
  const { arena, args, repo, stateDir } = await fixture(t, async () => ({}));
  await assert.rejects(arena.start({ ...args, models: ['x', 'x'] }), /different models/);
  await assert.rejects(arena.start({ ...args, repo: 'relative' }), /absolute/);
  const unsafe = new Arena({ stateDir: path.join(repo, 'nested', 'state'), runner: () => {} });
  await assert.rejects(unsafe.start(args), /outside/);
  await assert.rejects(fs.access(path.join(repo, 'nested')), { code: 'ENOENT' });
  const run = await arena.start(args);
  await wait(arena, run.id);
  const metadata = path.join(stateDir, 'runs', run.id, 'run.json');
  run.candidates.forEach((x) => (x.status = 'running'));
  await fs.writeFile(metadata, JSON.stringify(run));
  const recovered = await arena.get(run.id);
  assert.equal(recovered.status, 'interrupted');
  assert.ok(recovered.candidates.every((x) => x.status === 'interrupted'));
});

test('a fresh service recovers a crashed owner without starting the interrupted comparison again', async (t) => {
  const { arena, args, stateDir } = await fixture(t, async () => ({}));
  const moduleUrl = new URL('../lib/arena.mjs', import.meta.url).href;
  const child = `
    import { Arena } from ${JSON.stringify(moduleUrl)};
    const arena = new Arena({stateDir:process.argv[1],runner:()=>new Promise(()=>{})});
    const run = await arena.start(JSON.parse(process.argv[2]));
    process.stdout.write(run.id);
    process.exit(0);
  `;
  const { stdout: id } = await exec(process.execPath, [
    '--input-type=module',
    '-e',
    child,
    stateDir,
    JSON.stringify(args),
  ]);
  assert.equal((await arena.get(id)).status, 'interrupted');
  const run = await arena.start(args);
  assert.equal((await wait(arena, run.id)).status, 'completed');
  assert.equal((await arena.get(id)).status, 'interrupted');
});

test('an agent still shutting down after cancel holds its paid-execution slot', async (t) => {
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const { arena, args } = await fixture(t, async () => stopped);
  const run = await arena.start(args);
  // Let both runner calls enter before issuing the cancellation.
  await new Promise((resolve) => setImmediate(resolve));
  await arena.cancel(run.id);
  await assert.rejects(arena.start(args), /already active/);
  stop({});
  for (let i = 0; i < 50 && arena.live; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const next = await arena.start(args);
  assert.equal((await wait(arena, next.id)).status, 'completed');
});

test('choosing a detached candidate preserves its commit, index, files and original checkout', async (t) => {
  const { arena, repo, args } = await fixture(t, async ({ cwd, model }) => {
    await fs.writeFile(path.join(cwd, 'source.txt'), model + ' commit\n');
    await git(cwd, 'commit', '-qam', 'agent commit');
    await fs.writeFile(path.join(cwd, 'source.txt'), 'staged\n');
    await git(cwd, 'add', 'source.txt');
    await fs.writeFile(path.join(cwd, 'source.txt'), 'work in progress\n');
    await fs.writeFile(path.join(cwd, 'new.txt'), 'untracked\n');
  });
  await fs.writeFile(path.join(repo, 'source.txt'), 'personal change\n');
  const beforeBranch = await git(repo, 'symbolic-ref', 'HEAD');
  const beforeStatus = await git(repo, 'status', '--porcelain');
  const run = await arena.start(args);
  assert.equal((await wait(arena, run.id)).status, 'completed');
  const [winner, other] = run.candidates;
  const tip = await git(winner.cwd, 'rev-parse', 'HEAD');
  const index = await git(winner.cwd, 'write-tree');
  const status = await git(winner.cwd, 'status', '--porcelain');
  const branch = 'worktree-compare/' + run.id + '/a';
  for (let i = 0; i < 2; i++) {
    const choice = await arena.choose(run.id, 'a');
    assert.equal(choice.chosen, 'a');
    assert.equal(choice.chosenBranch, branch);
    assert.equal(await git(winner.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/' + branch);
    assert.equal(await git(repo, 'rev-parse', 'refs/heads/' + branch), tip);
    assert.equal(await git(winner.cwd, 'write-tree'), index);
    assert.equal(await git(winner.cwd, 'status', '--porcelain'), status);
    assert.equal(await fs.readFile(path.join(winner.cwd, 'source.txt'), 'utf8'), 'work in progress\n');
    assert.equal(await fs.readFile(path.join(winner.cwd, 'new.txt'), 'utf8'), 'untracked\n');
  }
  assert.equal((await arena.get(run.id)).chosenBranch, branch);
  assert.equal(await git(repo, 'symbolic-ref', 'HEAD'), beforeBranch);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), run.base);
  assert.equal(await git(repo, 'status', '--porcelain'), beforeStatus);
  assert.equal(await fs.readFile(path.join(repo, 'source.txt'), 'utf8'), 'personal change\n');
  await assert.rejects(arena.choose(run.id, 'b'), /already selected/);
  await assert.rejects(git(other.cwd, 'symbolic-ref', '--quiet', 'HEAD'), { code: 1 });
});

test('a colliding branch is never overwritten and a user-selected branch is kept', async (t) => {
  const { arena, repo, args } = await fixture(t, async ({ cwd }) => {
    await fs.writeFile(path.join(cwd, 'source.txt'), 'result\n');
    await git(cwd, 'commit', '-qam', 'change');
  });
  const run = await arena.start(args);
  await wait(arena, run.id);
  const cwd = run.candidates[0].cwd;
  const generated = 'worktree-compare/' + run.id + '/a';
  await git(repo, 'branch', generated, run.base);
  const tip = await git(cwd, 'rev-parse', 'HEAD');
  assert.notEqual(tip, run.base);
  await assert.rejects(arena.choose(run.id, 'a'), /already exists/);
  assert.equal((await arena.get(run.id)).chosen, undefined);
  assert.equal(await git(repo, 'rev-parse', generated), run.base);
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), tip);
  await assert.rejects(git(cwd, 'symbolic-ref', '--quiet', 'HEAD'), { code: 1 });
  await git(cwd, 'switch', '-c', 'my-existing-development-branch');
  const choice = await arena.choose(run.id, 'a');
  assert.equal(choice.chosenBranch, 'my-existing-development-branch');
  assert.equal(await git(cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/my-existing-development-branch');
  assert.equal(await git(repo, 'rev-parse', generated), run.base);
});

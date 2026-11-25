# Worktree Compare · 双模型对比

Give the same coding task to two models from your Magpie gateway. Review both implementations in your own repository, run them yourself, and choose one to keep working on. Both candidates use the installed Codex CLI and start at the same committed Git revision.

## Use

Install Git, a recent Codex CLI (tested with 0.172.0), and configure two coding models in Magpie. Start the Magpie gateway locally. The page uses its local model list and Responses endpoint. A gateway that requires an explicit caller key for local requests is currently unsupported.

To try this PR, use **Plugins → Add → Folder** and select the `packages/worktree-compare` directory from a checkout of the PR, or run:

```sh
magpie plugin add ./packages/worktree-compare
```

1. Open **Worktree Compare / 双模型对比** in Magpie's plugin sidebar.
2. Enter an absolute path to a local Git repository, describe the task, and pick two different model IDs. Each worktree starts at the repository's current `HEAD`. Commit any local changes you want both candidates to see first.
3. Press **开始对比** to start both agents. Each can make multiple model calls using your gateway allowance. The page accepts one active comparison at a time. The runner has an eight-minute limit per candidate and requests zero transport retries. A routing-group model ID uses that group's policy.
4. Inspect each candidate's diff and open its folder to build or test it. The diff includes committed changes since the starting revision and new non-ignored files. The preview is bounded; use the working directory for the complete result.
5. **选用 A / B** gives the selected worktree a local branch and displays its name. An existing checked-out branch is kept. Your staged and unstaged files stay in the selected worktree. Commit there when you're ready, then merge or cherry-pick through your usual Git workflow. The plugin makes no automatic commit, merge or push.

**停止运行** cancels the candidate processes. **归档** marks the comparison as archived; both worktrees remain available. If one candidate fails, you can still choose a completed candidate. After a host restart, interrupted work remains on disk and is not run again automatically.

## Local execution and data

- The host serves the page on loopback (default port 3497). On first open the Magpie page creates an access key in this plugin's options. Requests with run data or actions require that key. The page passes it in a URL fragment, then uses a request header. Do not share a service URL containing that fragment.
- The service discovers models through the local Magpie gateway. Each invocation uses a temporary Codex home, a per-process provider configuration, and the Codex workspace-write sandbox. Model requests go through Magpie to the selected provider. The task and code read for it can be included in those requests. The plugin does not read personal API keys or change global Codex settings.
- Prompts, model IDs, summaries, the chosen branch, and the two worktrees are kept under `$XDG_STATE_HOME/magpie/worktree-compare` (default `~/.local/state/magpie/worktree-compare`). Worktrees are registered with Git. Review and save wanted work before removing a worktree using Git.
- Run trusted projects. A worktree separates edits; builds and previews you launch from its folder use your own environment. Git LFS filters, recursive submodule checkout and repository checkout hooks are disabled during setup. Projects depending on them may require manual setup.
- Set the plugin option `codexPath` to an absolute Codex executable path if the GUI cannot find it. On Windows this needs a native executable. macOS is the real-host test platform.

## Verify

```sh
node --test test/*.test.mjs
MAGPIE_TEST_INSTALLED_CODEX=1 node --test test/runner.test.mjs
```

The opt-in test runs the installed Codex CLI against a deterministic loopback Responses server. Each model asks the CLI to write a different file in a disposable worktree. It uses no vendor key or inference quota.

# omini-subagent-staff

Give a trusted Codex project access to explicitly approved local Codex CLI profiles. The Magpie tab explains setup. A project-scoped MCP server lists approved profiles, submits read-only jobs, and returns status and receipts using the original job ID.

为可信项目授权本机 Codex CLI 账号。Magpie 安装后显示「子代理工具」页签。下面的本地管理器负责授权，项目级 MCP 负责派单和查原 ID。

## Install and authorize

1. In Magpie, open **Plugins → Discover → Unofficial** and install **omini-subagent-staff**, or run `magpie plugin add github:Harzva/omini-subagent-staff`.
2. Download and extract the [v0.2.1 release](https://github.com/Harzva/omini-subagent-staff/releases/tag/v0.2.1) into a stable folder. The local runtime runs on macOS and Linux, including WSL. It requires Python 3.10 or later and a complete current OpenAI Codex CLI distribution with its bundled helper and an existing file-backed ChatGPT sign-in. The profile's `auth.json` must be readable only by its owner. The page plug-in itself requests no extra Magpie permissions and starts no processes.
3. From the extracted folder, register an existing signed-in Codex home and open the management page. Repeat the register command with a distinct name for each profile. If `codex` on your PATH is a wrapper or a bare extracted binary, pass `--codex-bin /absolute/path/to/codex` for the actual executable in the complete distribution.

   ```sh
   python3 runtime/executor_manager.py register personal --codex-home "$HOME/.codex"
   python3 runtime/executor_manager.py init
   ```

4. In the loopback management page, enter the absolute path of your project and grant a profile read-only access. Run the probe, inspect its receipt, and record a verdict before dispatching regular jobs. Stop the manager with Ctrl+C when you finish managing grants.

## Connect a project

Add this section to the trusted project's `.codex/config.toml`. Replace both absolute paths. If the MCP client has a different environment, use the full path to its Python 3 executable.

```toml
[mcp_servers.omini_subagent_staff]
command = "python3"
args = ["/absolute/path/to/omini-subagent-staff/runtime/project_bridge.py", "--project", "/absolute/path/to/project"]
```

Start a new Codex session in that project. Ask it to list the approved profiles with `pool`, then use `delegate` for a bounded read-only task. Keep the returned job ID and pass it to `status` and `collect`. Execution and acceptance are tracked separately. To record the evidence for a regular task after checking its result, use the management CLI:

```sh
python3 runtime/executor_manager.py record-acceptance JOB_ID \
  --verdict passed --reviewer maintainer --evidence "Verified the reported result"
```

Installation grants no profile access. The project binding limits dispatch and receipt access to the approved project. The Codex read-only sandbox prevents writes and may read local files outside the project. Only connect trusted projects and profiles. The worker sends tasks through the selected account to the official Codex service. If the profile executable or sign-in file changes, reauthorize and repeat the probe. Revocation blocks new dispatches and preserves prior receipts. Failed or unconfirmed jobs keep their original ID and are never automatically submitted again. Job and grant state lives outside the source tree in `~/.local/state/omini-subagent-staff` by default. If you set `OMINI_SUBAGENT_STAFF_STATE_DIR`, use the same value for the manager and the MCP server.

The first public adapter runs signed-in local Codex CLI profiles. Model and supplier quota routing is configured separately in Magpie's **Routing** tab. The package contains no account sign-ins or connected providers.

## Uninstall

Remove the plug-in from Magpie and the project's MCP section from `.codex/config.toml`. The local state directory keeps existing grants and receipts until you remove it.

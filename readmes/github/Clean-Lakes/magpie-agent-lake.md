# Lake 的 Magpie Agent 插件

在 Magpie 的 **Agent** 页面为 Lake 选择默认模型。插件会把 Magpie 提供的完整模型目录写入 Lake，随后可在 Lake 的模型设置或聊天输入区切换当前模型。新请求通过 Magpie 网关使用当前模型；在 Magpie 改选另一个默认模型时，Lake 跟随新的默认值。关闭接入后，Lake 恢复原来的模型配置。

安装前请先启动一次 Lake，让它创建仅当前用户可读的配置文件。随后在 Magpie 的非官方 Agent 插件列表中找到 **magpie-agent-lake** 并安装，或运行 `magpie plugin add github:Clean-Lakes/magpie-agent-lake`。Magpie 和 Lake 需在同一台机器上使用同一个用户账号。

## English

Choose a default [Magpie](https://usemagpie.ai/docs/plugins#agents) model for the [Lake](https://github.com/Clean-Lakes/Lake) AI workbench from Magpie's **Agents** page. The plugin also writes the available catalog, so Lake can switch models in its own interface. New requests use Lake's current selection through Magpie's local gateway.

## Install

1. Install a Lake release that supports the Magpie Agent configuration, and start Lake once. Lake prepares `~/.lake/secrets/magpie-agent.json` with owner-only permissions.
2. Install this plugin with `magpie plugin add github:Clean-Lakes/magpie-agent-lake`, or find **Lake** under Magpie's unofficial Agent plugins.
3. In Magpie's **Agents** page, select a default model for **Lake**. Lake's model picker then lists the models Magpie offers this agent.

Magpie and Lake must run under the same user account on the same machine. The plugin's default configuration path assumes Lake's default home, `~/.lake`. Lake's `LAKE_HOME` override is not supported by this plugin.

## What it writes

Magpie edits only `~/.lake/secrets/magpie-agent.json`. It writes the default model ID, available model catalog, gateway `/v1` URL, a Lake-specific gateway key, and model capability hints. Lake keeps its own provider catalog and credentials separately; its current Magpie model selection is stored in its private data directory. Disconnecting Lake in Magpie restores the file's previous values; if there was no prior selection, Lake returns to its own active provider.

**Keep the configuration file private.** Magpie preserves an existing file's mode but creates a missing file as `0644`. Start Lake once before connecting to let Lake create it as `0600`. Lake also corrects an existing owner-owned file to `0600` when it starts. The parent `~/.lake/secrets` directory must remain `0700`. Never commit this file or paste its gateway key into an issue.

If Lake does not appear in Magpie, ensure the `lake` executable is on `PATH` or that Magpie can see the `~/.lake` directory.

## Development

The plugin uses Magpie's `agent` and `connect` exports. It does not import Node APIs and has no install-time scripts or dependencies. Lake's reader lives in the Lake repository.

To connect the isolated Lake Dev app without changing the release config, start Lake Dev once, then add the standalone `lake-dev.agent.js` file as a separate local Magpie plugin (`magpie plugin add ./lake-dev.agent.js`). It uses `~/.lake-dev/secrets/magpie-agent.json` and the `lake-dev` agent identity; the package's regular entry still targets `~/.lake`.

## License

Apache-2.0. See [LICENSE](LICENSE).

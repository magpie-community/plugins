# ThinkFlow CLI

An Agent plugin for an existing [ThinkFlow CLI](https://github.com/muxueqingze/xuxiang-thinkflow) installation. Select a model in Magpie's **Agents → ThinkFlow** row, then restart ThinkFlow. Disconnect in Magpie to restore the previous settings. The plugin does not install the CLI or send model requests itself.

The connection uses `~/.thinkflow/config.json` and a `magpie-thinkflow` profile. The file contains the local gateway key while connected; do not share it. Project-specific settings, CLI flags, or a custom `THINKFLOW_HOME` may take precedence. Use `thinkflow config show --sources` to see which configuration is active.

在 Magpie 的 Agents 页为 ThinkFlow 选择模型后，重新启动 CLI。断开连接可恢复此前的设置。更多说明与离线冒烟测试见[独立插件仓库](https://github.com/x1051445024/magpie-thinkflow-agent)。

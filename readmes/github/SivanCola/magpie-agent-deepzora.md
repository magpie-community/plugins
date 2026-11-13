# Deepzora Agent for Magpie

[![Test](https://github.com/SivanCola/magpie-agent-deepzora/actions/workflows/ci.yml/badge.svg)](https://github.com/SivanCola/magpie-agent-deepzora/actions/workflows/ci.yml)

在 **Magpie → Agent** 中为 [Deepzora](https://github.com/SivanCola/deepzora)
选择模型。插件自带可恢复的 TOML 配置桥接，**无需修改或重新编译 Deepzora**。

## 安装

需要支持 Agent 插件的 Magpie（已用 `0.1.2710` 验证）。在终端执行：

```sh
magpie plugin add github:SivanCola/magpie-agent-deepzora
```

也可以在 Magpie **插件 → 发现** 页底部输入：

```text
github:SivanCola/magpie-agent-deepzora
```

安装的是整个包：它同时包含 Agent 入口和配置桥接，不能只安装单个
`deepzora.agent.js` 文件。依赖由 Magpie 安装，不需要额外启动服务。

`0.1.1` 起，插件列表和 Agent 页均内嵌 Deepzora 图标，不依赖外部图片地址。
已安装旧版时，在 Magpie 的已安装插件页更新此插件即可。

1. 在 **Agent → Deepzora** 中选择 Magpie 模型。
2. 保持 Magpie 运行，等待约一秒完成桥接。
3. 重启 Deepzora 并新建会话。CLI、ACP 和 Desktop 共享此配置。

项目 `deepzora.toml` 显式配置的默认模型、CLI `--model` 参数仍然优先。
已有会话不会自动切换。插件默认管理 macOS/Linux 的 `~/.deepzora`。

## 关闭接管与卸载

在 Agent 页选择恢复默认，等待桥接完成后重启 Deepzora。CLI 等价操作：

```sh
magpie deepzora default
# 加载桥接完成恢复；仅使用 CLI、没有常驻 Magpie 时也适用。
magpie plugin list --json
```

确认恢复后，再移除插件：

```sh
magpie plugin rm github:SivanCola/magpie-agent-deepzora
```

请先恢复默认再禁用或卸载插件，以便桥接仍能运行。如果已经卸载，可以重新
安装后恢复默认；备份与未完成事务位于 Deepzora 目录的 `.magpie-bridge/`。
不要删除该目录来处理尚未恢复的配置。

## 配置如何接入

[Magpie 的 Agent 插件 API](https://usemagpie.ai/docs/plugins#agent-plugins)
目前支持 JSON、YAML、dotenv，暂不支持 TOML。这个包包含两部分：

- `deepzora.agent.js`：在 Magpie 的 Agent 页添加 Deepzora，将选择的模型、网关
  地址及分配给此 Agent 的网关密钥写入 `magpie-agent.json`。
- `index.mjs` / `bridge.mjs`：由 Magpie 的 Bun 插件宿主运行，监听配置变化，
  在 Deepzora `config.toml` 中添加 `magpie-agent` 供应商并设置默认模型，
  将网关密钥写入全局 `.env` 的 `MAGPIE_DEEPZORA_API_KEY`。

在 Magpie 选择的模型只决定默认值。插件会同步此 Agent 可见的完整模型目录，
后续增删随 Magpie 的目录更新生效。旧版升级后，重新选择一次当前模型即可。
原有供应商、模型、其他凭据和设置保留。每个模型各自的名称、上下文长度、输出长度和图片
能力会同步；插件使用 OpenAI Chat Completions，具体上游协议由 Magpie 转换。
模型请求由 Deepzora 发往 Magpie，插件本身不调用模型或登录上游供应商。

桥接使用私有备份、原子文件替换及可重放事务。网关密钥不会写入 TOML 或
插件日志。断开时，如果文件未被其他工具修改，会按字节恢复原始文件；
如果有其他修改，则保留无关设置和新凭据。手工修改受管理的供应商会使桥接
暂停，备份保留供检查。不要在切换模型的同时编辑 Deepzora 模型设置。

接管期间 TOML 会被重新序列化，注释与排版可能暂时变化；未发生其他编辑时，
断开会恢复原始注释与排版。若发生其他编辑，按字段合并恢复，注释排版不保证。
`.magpie-bridge/` 含原始凭据备份，请按私密配置保管。

## 自定义目录与 Windows

默认路径面向 macOS/Linux。Windows 或使用自定义 `DEEPZORA_HOME` 时，先克隆
本仓库，再修改 `deepzora.agent.js` 的 `dir` 和 `config`：

```js
dir: "C:/Users/you/AppData/Roaming/deepzora",
config: "C:/Users/you/AppData/Roaming/deepzora/magpie-agent.json",
```

两者必须指向同一个实际 Deepzora 数据目录。配置桥接根据 Agent 的 `config`
定位 TOML 和 `.env`，不会猜测另一个应用进程的环境变量。然后安装本地文件夹：

```sh
git clone https://github.com/SivanCola/magpie-agent-deepzora.git
cd magpie-agent-deepzora
# 调整路径后：
magpie plugin add .
```

原生 Windows Magpie/Desktop 尚未实测；跨平台配置逻辑由 CI 测试。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
npm test
```

可选的原生验收会使用临时 HOME、虚拟供应商及本地模型接口，不读取真实
账户、不产生付费请求：

```sh
MAGPIE_BIN=/path/to/magpie DEEPZORA_BIN=/path/to/deepzora npm run test:magpie
```

只提供 `MAGPIE_BIN` 时验证 Magpie 安装、Agent 发现、模型配置和恢复；同时提供
`DEEPZORA_BIN` 时再验证未修改的 Deepzora 实际发送模型请求。该验收脚本的
临时路径布局面向 macOS/Linux。

仅通过 CLI 修改 Agent、没有常驻 Magpie 时，可从本仓库执行一次桥接：

```sh
node cli.mjs sync
```

仓库提供 GitHub 安装，尚未发布到 npm，也不属于 Magpie 官方社区插件列表。

## English

Adds Deepzora to Magpie's Agents page, with a companion bridge for Deepzora's
existing TOML configuration. No Deepzora source changes are required.

Install the **whole package** using
`magpie plugin add github:SivanCola/magpie-agent-deepzora`, choose a model,
wait about a second with Magpie running, then restart Deepzora and create a new
conversation. Explicit project defaults and CLI model flags take precedence.

The selected model is the default; the bridge imports and refreshes the whole
agent-visible catalog with per-model capabilities. Reselect the current model
once after upgrading from a single-model version.
The bridge preserves existing providers and other credentials. Its gateway key
is stored in Deepzora's global `.env`, never TOML. While connected, TOML formatting
is normalized; disconnect restores original bytes if untouched, otherwise it
merges unrelated edits. Backups contain credentials and must stay private.

**Before disabling or uninstalling**, run `magpie deepzora default` followed by
`magpie plugin list --json` to finish restoration. Restart Deepzora afterwards.
The default paths target macOS/Linux; for Windows or a custom Deepzora home,
clone the repo, edit the descriptor's `dir` and `config`, then install that folder.

Plugin code: MIT. Embedded Deepzora icon: AGPL-3.0-only; see
[asset notice](ASSET_NOTICE.md). Independent integration; not an official Magpie
community package.

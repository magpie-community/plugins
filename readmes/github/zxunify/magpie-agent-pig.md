# PiG for Magpie

让 Magpie 发现 PiG，并把 Magpie 的模型和路由组同步为 PiG 模型列表中的 **Magpie** 供应商。使用 Pi/PiG 通用的 `models.json` 格式，无运行时依赖。

## 安装并连接

需要已安装 PiG，以及支持 [Agent 插件](https://usemagpie.ai/docs/zh/plugins#agents)的 Magpie。已验证版本见 [TESTING.md](./TESTING.md)。

在 PowerShell 中运行：

```powershell
magpie plugin add github:zxunify/magpie-agent-pig
magpie pig provider magpie
```

也可以在 Magpie 的插件页面添加 `github:zxunify/magpie-agent-pig`，然后在 Agents 页面启用 PiG 的连接开关。

仓库使用 `magpie-plugin` GitHub topic，可从 Magpie 的“插件 → 发现 → 非官方插件 · GitHub”查找。GitHub 搜索索引与 Magpie 缓存更新后才会出现；无需发布 npm。

从源码开发时，在仓库目录运行 `magpie plugin add .`。本地文件夹就地加载，使用期间请保留目录。同一台机器只启用一份 PiG 插件；已有本地安装时，不要再同时启用 GitHub 副本。

进入项目目录启动 `pig`，输入 `/model`，选择 Magpie 供应商中的模型。选择后按 `Ctrl+S` 可保存 PiG 默认模型。也可指定完整模型名，例如你的 Magpie 已提供此模型时：

```powershell
pig --model magpie/codex/gpt-6.1-sol
```

模型可用性取决于你在 Magpie 配置的供应商与账号。无需在 PiG 中复制订阅 Token 或重复登录。

## 模型同步与配置

Magpie 中的模型、路由组以及给 PiG 设置的模型可见范围会同步到 `~/.pig/agent/models.json`。PiG 已运行时，重启 PiG 后查看更新后的 `/model`。

插件只声明以下配置键，由 Magpie 负责写入、备份和恢复：

| 配置键 | 内容 |
| --- | --- |
| `providers.magpie.name` | `Magpie` |
| `providers.magpie.baseUrl` | Magpie 传入的网关地址 |
| `providers.magpie.api` | `openai-responses` |
| `providers.magpie.apiKey` | Magpie 为 PiG 提供的网关凭据 |
| `providers.magpie.models` | Magpie 提供的模型列表与元数据 |

保留其他供应商、Magpie 块中的其他字段和 PiG 的 `settings.json`。模型 ID 保留 `codex/…`、`group/…` 等原始形式；上下文、输出上限、图片能力和已知推理档位转为 Pi 兼容字段。未知上限省略，采用 PiG 默认值。推理 `off` 映射为网关的 `none`，不支持的档位映射为 `null`。

Magpie 的 Agent 插件输入未提供原生协议、价格及独立 reasoning 标记，所以本插件统一走网关支持的 Responses API，不声明费用或缓存预热参数；推理能力根据传入的 `efforts` 判断。Magpie 负责转换到上游协议。

## 断开与卸载

先断开连接，再移除插件：

```powershell
magpie pig provider default
magpie plugin rm github:zxunify/magpie-agent-pig
```

断开会恢复插件管理的五个键。原先不存在的键会移除，框架可能留下空对象。PiG 自己保存的默认模型和历史会话不会被改写；如果仍选着已移除的 Magpie 模型，请在 PiG `/model` 中换到其他供应商。

## 范围与限制

- 使用 PiG 默认目录 `~/.pig/agent`。自定义 `PIG_HOME`、`PIG_CODING_AGENT_DIR`、XDG 路径或 `PIG_USE_PI_DIRS` 共享模式需要调整插件描述中的目录后测试。
- Magpie 显示 PiG 连接开关；模型在 PiG 内选择。与 Pi 原生适配器相比，本插件不管理默认模型、思考强度或 `enabledModels` 设置。
- 若已有受限的 `enabledModels` 列表，按需在 PiG `/scoped-models` 中加入 Magpie 模型。
- 独立第三方插件，通过 GitHub 分发，无需先发布 npm 或加入社区推荐列表。

## 开发与测试

单元测试使用 Node.js 内置测试器，不需要安装依赖：

```powershell
git clone https://github.com/zxunify/magpie-agent-pig.git
cd magpie-agent-pig
npm.cmd test
```

Windows 隔离集成测试需要指定已安装的两个原生可执行文件：

```powershell
$env:MAGPIE_TEST_EXE = (Read-Host "Magpie 原生可执行文件的绝对路径")
$env:PIG_TEST_EXE = (Read-Host "PiG 原生可执行文件的绝对路径")
npm.cmd run test:integration
```

测试复制 Magpie 到独立目录，使用隔离用户目录、配置、缓存和随机本地端口；上游为本地 Responses 模拟服务，不消耗订阅额度。每次结果和命令日志保存在 `.sandbox/run-*/`，并核对真实 Magpie/PiG 配置指纹未改变。

可选的实际目录兼容检查，只读取正在运行的本机 Magpie 模型列表，再让隔离 PiG 加载，不发送生成请求：

```powershell
node test/live-catalog.mjs
```

接口依据：[官方中文插件文档](https://usemagpie.ai/docs/zh/plugins#agents)、[官方 Aider 示例](https://github.com/magpie-community/plugins/tree/main/packages/aider)、[Magpie 内置 Pi 模型转换](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/internal/agent/agents.go#L516)。本插件为独立实现，不代表 Magpie 或 PiG 官方发布。

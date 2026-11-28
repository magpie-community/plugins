# Magpie 自动上下文压缩

Magpie 的 Provider 插件。对话历史超过设定条数时，自动压缩上下文，让长对话继续进行。

支持 OpenAI Responses、Chat Completions 和 Anthropic Messages。

## 安装

在插件目录运行：

```powershell
magpie plugin add "$PWD"
```

## 使用

1. 编辑 [`examples/options.jsonc`](examples/options.jsonc)，填入接口地址、API 密钥和模型 ID。
2. 在 PowerShell 7 或更高版本中，运行下面的命令导入配置。
3. 在 Magpie 中选择模型，例如 `responses-main/coder`。

自用配置见 [`examples/selfuse.jsonc`](examples/selfuse.jsonc)。使用时，将命令中的配置路径换成该文件。

```powershell
$options = Get-Content -Raw -Encoding utf8 examples/options.jsonc |
  ConvertFrom-Json -ErrorAction Stop |
  ConvertTo-Json -Depth 100 -Compress
magpie plugin options magpie-autocompact $options
magpie models
```

修改配置后，重新运行导入命令。

## 配置

示例默认启用 `responses-main`，其他供应商按需启用。所有供应商都放在 `providers` 中。

常用选项：

- `protocol`：接口类型，可选 `responses`、`chat`、`anthropic`。
- `models`：模型列表和别名。省略时尝试从接口获取。
- `maxMessages`：历史超过多少条时压缩。省略或设为 `0` 时不压缩。
- `compactionTargetRatio`：压缩后希望保留的消息数占 `maxMessages` 的比例，大于 `0` 且不超过 `1`，默认 `0.5`。安全边界或必须保留的内容可能使实际结果高于目标。
- `maxRetainedRatio`：可选，大于 `0` 且不超过 `1`。安全切分无法将保留项数降到 `maxMessages` 的此比例时，允许强制压缩、摘要或打包到最后一项，包括当前输入和未完成的工具调用。强制摘要与打包附加继续执行的提示。不透明上下文不能由摘要或打包处理；省略此项则不启用强制压缩。
- `compactionNotice`：设为 `true` 时按实际使用的压缩方式及保留消息数显示提示；默认关闭。
- `diagnostics`：设为 `true` 时记录请求结构和压缩诊断，默认关闭。日志写入该供应商的 `stateDir/diagnostics.jsonl`；默认 `stateDir` 为 `~/.local/state/magpie-autocompact/<供应商 ID>`，也可由 `XDG_STATE_HOME` 或 `stateDir` 指定。
- `timeoutMs`：请求超时，默认 `120000` 毫秒（2 分钟）。

更多选项见[配置示例中的注释](examples/options.jsonc)。

诊断日志按 JSON Lines 记录请求 ID、会话标识的哈希、输入项类型、角色、文本长度和是否为空、缓存命中的前缀长度、压缩前后项数及推理结果状态；不记录消息正文、工具参数、媒体内容、请求头或密钥。每个输入列表最多记录前 2000 项，其余数量写在 `omitted`。日志会持续追加，排查后可关闭 `diagnostics` 并按需删除该日志文件。

配置文件带有注释，请用上面的命令解析后导入。不要将真实密钥提交到版本库。

## 开发

需要 Node.js 22.13 或更高版本。

```sh
npm test
```

安装 Magpie 后，可运行集成测试：

```sh
npm run test:integration
```

## LICENSE

本项目使用 MIT License，详见 [`LICENSE`](LICENSE)。

## 致谢

感谢 Magpie 项目及所有为本项目提供反馈和贡献的使用者与维护者。

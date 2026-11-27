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
- `compactionNotice`：设为 `true`，压缩成功后显示提示。也可填写自定义提示文字，默认关闭。
- `timeoutMs`：请求超时，默认 `120000` 毫秒（2 分钟）。

更多选项见[配置示例中的注释](examples/options.jsonc)。处理图片、音频或文件时，摘要模型也需要支持这些内容。

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

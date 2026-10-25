# TokenDance 插件

将原 PR #762 的 API Key 接入能力改为独立插件，无需修改 magpie 主程序。目前未发布到 npm 或插件市场，可以安装本地目录。

在 magpie 的「插件 → 添加插件」中填写本目录的绝对路径，然后选择「TokenDance」并输入你在 [TokenDance](https://tokendance.space/keys) 创建的 API Key。

也可以在本仓库根目录运行：

```sh
magpie plugin add ./packages/tokendance
magpie plugin login tokendance
magpie plugin list
```

密钥由 magpie 保存在自己的 `plugin-auth.json` 中。插件不读取其他应用的密钥。供应商 ID 为 `tokendance`；如果已有同名自定义供应商，magpie 会显示为 `tokendance-plugin`，以插件列表中的实际名称为准。

支持 Chat Completions、Responses 和 Anthropic Messages。每个模型选择一种上游协议，客户端使用其他协议时由 magpie 转换。模型读取 TokenDance 实时目录，按 supported_protocols 选择协议，过滤仅支持视频、语音、向量等接口的条目。可用 plugin options 设置 protocol 偏好和可选 appURL 归因。

已测试真实 magpie 插件宿主和本地模拟上游；尚未使用真实 Key 验证收费调用。配置后，可自行运行 `magpie provider test tokendance` 验证，这会发出真实请求并可能产生费用。本插件不提供 OAuth、余额查询或媒体生成。目录未提供价格，不代表模型免费。

完整配置和验证命令见 [README](README.md)。

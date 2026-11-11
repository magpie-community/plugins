<p align="center">
  <img src="assets/cover.svg" alt="magpie Computer Use — Your agents. Your Mac." width="960">
</p>

<p align="center">
  <b>让你常用的 Agent 操作本机 macOS 应用。</b><br>
  从 magpie 安装一次，向所选 Agent 分发十个 Computer Use 工具。
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="docs/USAGE.md">使用指南</a> ·
  <a href="docs/ARCHITECTURE.md">工作原理</a> ·
  <a href="docs/TROUBLESHOOTING.md">故障排查</a>
</p>

## 你的 Agent，多一双手

读取应用界面、查看截图、点击按钮、输入文字、滚动与拖动。插件自动识别本机完整的 Codex 桌面安装，使用其原始 Computer Use 组件；通过标准 MCP，把这些操作交给你在 magpie 中选择的 Agent。

本仓库是基于 [wbb6517/magpie-computer-use](https://github.com/wbb6517/magpie-computer-use) 的社区维护版本，保留原项目和 LCU 的许可及来源；不是 OpenAI、Anthropic 或 magpie 官方产品。

| 安装一次 | 自动发现 | 原生授权 |
| --- | --- | --- |
| 自动加入 magpie 资源库，按需分发给 Agent | 不用填写 Codex 路径，没有独立设置页 | 沿用本机 Codex 的持久应用批准，新请求仍由用户决定 |

**适用环境：** Apple Silicon Mac、magpie，以及包含完整 Computer Use 组件且签名有效的官方 Codex 桌面应用。部分安装名为 `ChatGPT.app`，完整的重命名安装也可识别。普通使用不需要另装 Node 或 LCU。

## 开始使用

1. 在 magpie **扩展 → 插件** 添加 `github:SammySnake-d/magpie-computer-use-agent` 并启用。
2. 打开 **资源库 → MCP 服务器 → magpie-computer-use**，选择需要使用的 Agent。
3. 检测工具，确认列出十个操作，再重连 Agent 或新开会话。
4. 让 Agent 先发现应用，再读取目标界面，最后执行操作。

例如：

> 列出当前可用应用。打开一个空白测试文稿，读取界面，然后输入「Hello from magpie」。

首次访问目标应用时，请按授权提示自行选择。Agent 支持 MCP 表单时使用其原有提示；不支持时，macOS 会显示本插件的人工确认窗口。截图展示仍取决于 Agent 的 MCP 支持。

当前版本为 **0.5.2**，通过上述 GitHub 来源安装；本社区版本未发布到 npm，不能将同名 npm 包当作本仓库版本。无需克隆仓库或执行插件安装命令。

## 十个工具

| 工具 | 能做什么 |
| --- | --- |
| `list_apps` | 发现本机应用 |
| `get_app_state` | 获取目标界面树和截图，触发必要的原始授权 |
| `click` | 按元素索引或截图坐标点击 |
| `perform_secondary_action` | 执行界面列出的辅助操作 |
| `set_value` | 修改可编辑元素的值 |
| `select_text` | 选中文字或放置光标 |
| `scroll` | 滚动指定元素 |
| `drag` | 按截图坐标拖动 |
| `press_key` | 发送按键或组合键 |
| `type_text` | 输入文字 |

操作前读取 `get_app_state`，保持同一 `app` 标识，并使用最新的元素索引。点击等操作返回新的界面树，需要新截图时再读取状态。详见[完整参数与示例](docs/USAGE.md#十个工具的参数)。

## 授权留在本机

插件调用原始运行时，由它识别 Codex **Always-allowed apps** 中的持久批准。新应用的原始授权请求由 Agent 或 macOS 窗口交给用户；只有用户明确选择才返回批准。其他会话的临时允许不会自动借用。插件不读取登录 token、钥匙串或账号凭据，也不维护另一份应用批准清单。

macOS 辅助功能、屏幕录制及原生进程认证仍按官方流程处理。模型和账号继续在 magpie 中选择；本插件只提供本机操作工具。

## 更新与移除

更新扩展或 Codex 后，重新检测并重连 MCP。0.4 的精确旧条目可以保留 Agent 选择；旧 `--config` 参数只兼容命令格式，其选项文件不再读取。

**在 magpie 中移除插件后，会自动清理本插件登记的 MCP，并由 magpie 同步撤销 Agent 分发。** 普通宿主退出、关闭开关和版本更新不会触发删除；同名自定义 MCP 也不会被清理。实现与适用边界见[停用与移除](docs/USAGE.md#停用与移除)。

卸载不会撤销 Codex 的持久应用批准或 macOS 权限；需要调整时，在对应原生界面管理。

## 已验证到哪一步

此前在本机修复包中验证了 Claude Desktop 的 Chrome、Finder 和 TextEdit 只读访问，以及人工授权、永久批准复用和拒绝；0.5.1 发布源码的授权功能文件与该包逐字节一致。0.5.2 改变了空闲生命周期；其他 Agent 与所有交互动作没有逐一实机验收。历史验证边界见[验证记录](docs/VERIFICATION.md)。

MCP 连接不会因空闲 5 分钟主动断开。尚无待保留操作上下文时，内部运行时会在空闲后释放，下一次调用再启动；已有上下文时保留运行时，直到上下文清理或宿主断开，避免丢失应用对象与元素索引。

浏览器组件初始化成功也不等于已有可用浏览器会话；0.5.0 的历史只读检测返回零个浏览器，没有验证接管其他聊天的浏览器连接。

## 开发与来源

[贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [发布说明](docs/PUBLISHING.md) · [MIT 许可证](LICENSE)

必要 macOS 网关与共享客户端基于 [LCU 0.11.4](https://github.com/amontlabs/lcu) 适配，保留[第三方声明](THIRD_PARTY_NOTICES.md)、[网关来源](src/gateway/SOURCES.md)及[客户端修改记录](vendor/lcu-client/PATCHES.md)。插件不分发、下载、复制或修改 OpenAI 官方二进制。

本插件通过 `magpie.kind: "middleware"` 声明为中间件类型。

GitHub 仓库已设置 `magpie-plugin` topic。npm 发布、GitHub 发现与官方推荐是不同状态；推荐列表需另向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 申请。图标通过官方 `magpie.icon` 字段提供，发布标准见 [magpie 插件文档](https://usemagpie.ai/docs/zh/plugins#publish)。

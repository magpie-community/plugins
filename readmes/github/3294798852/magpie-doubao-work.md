# Magpie 豆包工作插件 · Doubao Work Plugin

[English](README.en.md)

`magpie-doubao-work` 为 Magpie 提供豆包工作供应商 `doubaowork`，支持 Windows、Linux 和 macOS。通过豆包网页登录或账号 JSON 导入接入，提供模型发现、文本对话、function 工具调用、流式输出、额度查询和每日签到。

## 安装

安装近期版本的 [Magpie](https://github.com/yetone/magpie)，运行以下命令。

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin login doubaowork
```

在 Magpie 的「插件 → 发现」中，也可搜索本插件并安装。供应商显示为「豆包工作 Doubao Work」。模型 ID 从账号实际目录获取，在客户端选择 `doubaowork/<模型ID>`。

## 搜索名称与关键词

中文与英文界面均可使用以下名称、别名和常用词组。

| 用途 | 可检索的词 |
| --- | --- |
| 中文名称 | `豆包`、`豆包工作`、`豆包插件`、`豆包工作插件` |
| 英文名称 | `Doubao`、`Doubao Work`、`Doubao Work Plugin` |
| 项目标识 | `magpie-doubao-work`、`doubao-work`、`doubaowork` |
| 供应商插件 | `Magpie 豆包工作`、`Magpie provider plugin`、`provider plugin`、`供应商插件` |
| 登录与导入 | `browser login`、`浏览器登录`、`JSON`、`导入` |
| 文本与流式 | `OpenAI`、`text chat`、`SSE`、`streaming`、`流式` |
| 额度与签到 | `quotas`、`额度`、`daily check-in`、`自动签到` |
| 系统 | `Windows`、`Linux`、`macOS` |

仓库描述、README、GitHub 主题和包关键词包含中英文检索信息。Magpie 的名称及两种语言摘要均包含上述检索词，并按其实际搜索规则做回归验证。Magpie 当前按连续词组匹配，可直接使用表中词组。发现列表通过 GitHub 的 `magpie-plugin` 标签收录，刷新后的列表使用最新元数据。

## 登录与账号

图形桌面需要 Chrome 或 Edge，Linux 也可使用 Chromium。登录会打开独立临时浏览器窗口。完成扫码或手机验证后，插件核验账号身份并交给 Magpie 保存。

无桌面的 Linux 可从 0.5.2 或更高版本的 [豆包工作独立网关](https://github.com/3294798852/doubao-work-gateway) 导出账号 JSON，再通过 Magpie 的账号导入入口导入。支持供应商账号导入的 Magpie 版本也可使用以下命令。

```sh
magpie accounts import doubaowork /absolute/path/doubao-accounts.json --yes
```

支持 v2/v3 豆包工作账号备份，每个文件最多 20 个账号、512 KB。备份包含登录凭据，应保存在私有目录。浏览器绝对路径可通过启动 Magpie 时的 `DW_CHROME_BIN` 或 `DW_EDGE_BIN` 环境变量指定。

账号开关、代理、路由和签到在 Magpie 中管理。开启签到后，由 Magpie 调度，插件在领取请求前持久记录当日提交状态。结果待确认时，后续操作回查上游状态。

### 710022004 与设备上下文

0.6.3 的浏览器登录会自动从豆包官网取得该会话的 Web ID、应用 ID和客户端版本，连同浏览器指纹、User-Agent 和官网签发的 Cookie 一并保存。模型、聊天、额度和签到使用对应的 Web 参数，无需安装豆包桌面客户端。

旧账号缺少设备上下文且本机客户端文件不可用时，正常加载会自动获取并保存官网上下文。已有完整桌面会话继续使用保存的信息。v2/v3 账号备份保留完整会话，支持迁入其他电脑和无图形界面的 Linux 服务器。

`710022004` 表示上游要求验证。使用同一个账号完成官网验证后，重新测试模型或发送新请求，完整成功回复会清除旧验证状态。持续失败的既有桌面会话可重新浏览器登录。自动获取路径和验证结果见[设备上下文修复说明](docs/web-device-context.md)。

## 从网关内置插件迁移

已通过旧仓库安装插件的用户，安装本仓库后，可指定由本插件提供 `doubaowork`。

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin use github:3294798852/magpie-doubao-work doubaowork
```

在 Magpie 的供应商页面核对账号和模型。独立网关的说明与发行版位于 [doubao-work-gateway](https://github.com/3294798852/doubao-work-gateway)。

## 能力与验证

支持 OpenAI 风格 `chat/completions` 文本接口、流式与非流式回复，以及 `reasoning_content` 透传。取消会中止上游请求，输出按消费者读取速度推进。

0.6.0 支持客户端 function 工具，包含 `auto`、`none`、`required`、指定函数、并行开关和工具结果回传。两版共用工具协议转换与响应编码，纯工具回复使用 `finish_reason=tool_calls`。工具在客户端执行，工具回合在完整响应校验后输出调用事件。[排查与修复方案](docs/tool-calling.md)

0.6.1 修复 SSE 提前结束、完整快照漏读和混合增量重复输出，并传递上游提供的标准 token 用量。[短回复排查与验收](docs/sse-output.md)

严格约束解码 `strict=true`、自定义 grammar 工具、结构化输出、图片和工作流待实现。模型上下文与输出上限仍待补充。

从源码验收可运行以下命令，需要 Node.js 22 或更高版本。

```sh
npm run check
npm test
```

真实 Magpie Bun 宿主的模拟联调通过 `MAGPIE_BUN_BIN` 和 `MAGPIE_HOST_FILE` 指定运行时与 `internal/plugin/host.js`，再运行 `npm run test:magpie-host`。结果与搜索覆盖见 [验证记录](docs/verification.md)。

## 来源与许可证

插件从 [doubao-work-gateway v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0) 拆分。新增 Magpie 集成采用 MIT 许可证，继承代码及品牌素材保留上游来源与声明。范围见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

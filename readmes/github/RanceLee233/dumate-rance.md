# dumate-rance

将百度搭子 DuMate 的个人积分接入 **magpie / OpenCode**。基于 [R227BOUT/magpie-dumate](https://github.com/R227BOUT/magpie-dumate) 的 MIT 版本修改，重点修复 macOS 找不到桌面登录态，以及只列出两个默认模型、缺少上下文长度的问题。

**非官方实验版本。** 百度可能调整接口；此前新进程获取 gateway token 曾返回“服务器内部错误”，2026-11-13 后续验证已能在新进程取 token 并正常调用，但尚未完成长期续期或卸载客户端后的验证。遇到此问题请保留 DuMate 客户端；本插件不会静默改走客户端本地代理。

## 安装与登录

```bash
magpie plugin add github:RanceLee233/dumate-rance
magpie plugin use github:RanceLee233/dumate-rance dumate
magpie plugin login dumate
```

选择“百度搭子桌面端登录态”。请先打开 DuMate 并完成登录。已有其他 DuMate 插件时，`plugin use` 用来指定由本插件提供服务；原插件可以保留或停用，避免重复显示。

插件包名是 `dumate-rance`，供应商 ID 继续使用 `dumate`，模型入口为 `dumate/<模型ID>`。这让已有客户端配置可以继续使用。

本地开发安装：`magpie plugin add /absolute/path/to/dumate-rance`。

## 自动寻找正确位置

| 系统 | DuMate 默认登录数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/qianfan-desktop-app/` |
| Windows | `%APPDATA%\qianfan-desktop-app\` |
| Linux | `$XDG_CONFIG_HOME/qianfan-desktop-app/`，未设置时为 `~/.config/qianfan-desktop-app/` |

先读取该目录中的 `auth.json` 和 `.cookie-key`，在内存中解密 Cookie；不修改 DuMate 登录文件。支持 `DUMATE_USER_DATA_DIR` 指定不同的数据目录。环境变量必须对运行 magpie 的进程可见，桌面应用不一定继承终端变量。

模型配置按当前激活账号查找：

```text
<数据目录>/qianfan_desk_xdg/<当前账号>/config/opencode/opencode.json
```

没有激活账号信息时，只在唯一账号目录存在的情况下自动选择；多个账号不猜测。可用 `DUMATE_OPENCODE_CONFIG` 指定配置文件的绝对路径。Linux 默认路径和 Windows APPDATA 路径经过离线测试；真实客户端登录验证仅在 macOS 完成。

## 模型与上下文

读取 `provider.QianfanPersonalQuota.models`，仅导入模型元数据。不会导入其中的 API key、本地代理 URL、headers、插件、命令或权限。

- 使用实际 API `id`；显示名称可能是别名，例如旧的 `glm-5` 配置实际指向 `model-text`。
- 保留配置声明的上下文、输出上限和输入模态；输入上限来自 `limit.context`，没有时取 `limit.input`。
- 排除内部任务路由、mock、OCR、embedding、reranker 和专用图像生成入口；重复别名去重。
- 保留用户在 magpie 中自定义的模型和设置。

2026-11-13 的清单中有 22 个对话入口，包括 DeepSeek、GLM、Kimi、Qwen、豆包和自动路由。**清单存在不代表账号有调用权限或每个模型均已测试。**

`dumate/deepseek-v41-flash` 的渠道配置为 1,000,000 tokens 输入/上下文、384,000 tokens 最大输出，支持图像输入；这是渠道声明，没有进行百万 tokens 极限测试。该模型通过本机 magpie 的小请求已返回成功。其他模型未逐一测试。

V4.1 前台统一提供 `none / low / high / max`。插件只对 `deepseek-v41-flash` 映射：`none` 删除 `reasoning_effort` 并显式关闭 `thinking` 和 `enable_thinking`；`low` 映射为 `high`；`high / max` 保留对应强度并显式开启思考。百度渠道的 `low` 与 `high` 实际使用同一强度，统一选项方便跨供应商切换，不代表上游拥有四种不同预算。未指定档位时保留上游默认行为。已用官方 DuMate 网关的小请求验证显式关闭时不返回推理内容，`max` 可返回推理 token；短请求不能证明实际计算预算。

2026-11-13 通过本机 magpie 实测 `high`：普通计算正确回答、SSE 流式工具调用完整返回、接收工具结果后续答正确；普通回答和续答均返回推理 token。这些检查验证基本调用链，不代表所有任务和长会话均已覆盖。

成功读取后，将纯模型清单保存到 magpie 配置目录下的 `dumate-rance/models.snapshot.json`。读取源文件失败或原文件删除时使用最近的快照；新安装且没有快照时使用包内带日期的参考清单。快照不包含 Cookie、密钥、源文件路径或 API 地址。清单回退只解决模型信息保存，不延长登录有效期。

```bash
magpie provider models dumate
magpie model spec dumate/deepseek-v41-flash
magpie provider test dumate deepseek-v41-flash
```

最后一条会发一个真实请求，消耗少量积分。源代码变更后，需要重载插件才能更新运行中 host；重载也会清除内存里的 gateway token，接口异常期间请谨慎操作。Codex 的旧聊天可能保留旧模型信息；圆环依赖客户端收到窗口长度，不是名称中的“1M”文字。

如果此前手动把 V4.1 限制为 `high,max`，更新插件并重新加载后，只重置推理档位覆盖即可保留窗口、输出和视觉设置：

```bash
magpie model spec dumate/deepseek-v41-flash --reasoning auto
```

## 登录、请求与隐私

沿用上游的三种方式：桌面登录态、浏览器登录后手动复制请求头 Cookie、直接粘贴 Cookie。浏览器方式需要完整请求头 Cookie；`document.cookie` 无法读取 httpOnly 字段。请只在本机 magpie 的登录界面操作，不要把 Cookie 发给维护者或贴进工单。

magpie 将登录态保存到自己的 `plugin-auth.json`；本插件不另存认证快照。Cookie 用于百度官方控制台的 token/积分接口，换取的 token 用于 `https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions`。聊天请求只允许该地址并拒绝重定向。不会向作者服务器上传凭证或对话，也不会调用配置里的 `127.0.0.1` 代理地址。

提供积分用量、到期信息和签到 hook；积分数额以服务器返回为准。签到由 magpie 的设置控制。本插件沿用桌面账号积分，不会生成百度云 API key。

**暂不建议卸载 DuMate。** 云端调用不经过客户端本地代理；虽然本次已验证新进程可获取 token，但尚未验证卸载后的登录恢复与长期续期，不能据此承诺长期独立运行。

## 测试与问题反馈

Node.js 20+ 或 Bun，无需安装依赖：

```bash
npm test
```

离线测试涵盖跨平台路径、当前账号选择、加密登录读取、模型字段和 1M 长度、快照回退、凭证隔离、请求地址约束、四档推理映射和 token 生命周期。不联网、不领取积分、不调用真实模型。

反馈请提供操作系统、DuMate/magpie 版本及已脱敏的错误信息；不要附 `auth.json`、`.cookie-key`、`plugin-auth.json` 或进程环境变量。

## 来源与许可证

[上游项目](https://github.com/R227BOUT/magpie-dumate) · [修改说明](NOTICE.md) · [MIT License](LICENSE)

DuMate 名称和图标用于识别百度的服务；本项目未经百度或 magpie 官方背书。

# TRAE 私有化供应商

通过 TRAE 企业协议连接私有化部署，为 Magpie 提供登录、模型目录、对话和用量。不需要运行 traecli。

## 登录

在供应商页选择「登录企业 TRAE（浏览器 SSO）」，填写企业 HTTPS 地址。插件从 `GetLoginGuidance.Result.LoginHost` 获取登录域，由 Magpie 打开浏览器。认证回调的 `userJwt` 包含凭据，核验账号后保存；续期使用 `ExchangeToken`，轮换后的凭据由 Magpie 保存。

也可以选择「从本机 traecli 导入登录」，读取本机 `~/.trae/cli/auth.json`。导入后插件独立续期，CLI 中的旧 refresh token 可能失效。

### 远程服务器

Magpie 在服务器上运行时，在本地浏览器打开它提供的授权链接。认证后若最终的 `http://127.0.0.1:<port>/authorize?...` 页面打不开，将完整地址粘贴回 Magpie 的回调输入框或 CLI 提示。宿主会在服务器本机转发本轮回调，不需要公网回调端口。请勿公开包含凭据的回调地址。

## 模型与对话

- 模型来自账号的 `get_config_list` 目录，成功后复用 60 秒；临时故障沿用同一身份最后一份有效目录。合法空目录撤回模型，鉴权失效报错。缓存仅在内存中。
- 上下文优先使用目录声明，未知时按 **128000** 上报。确认部署支持后，可在供应商选项开启扩展窗口，默认提高到 1000000。
- 支持流式和非流式回答、工具调用、图片、推理内容及 token 用量。
- 请求体默认预算 9 MiB，超限时先移除历史图片，再截短历史工具结果，仍超限返回 413。
- 上游 `4222 / ErrAllModelUserQuotaExceeded` 映射为 HTTP 429，保留错误码和登录状态；已开始的流以错误事件结束。
- 管理员配置的自定义模型不进入此聊天目录，其用量仍可展示；直连企业模型网关需另配供应商。

## 用量

`GetUserInfo` 使用登录 token 读取席位和权益。基础、超额及企业内置模型明细需要可选的网页会话，仅用于读取用量。可迁移已有会话文件，或按用量卡提示将 `X-Cloudide-Tob-Session` 的值写入本地 sidecar。会话缺失或失效时仍展示可读取的席位信息。

## 高级覆盖

GUI 安装无需环境变量。以下变量仅供部署差异覆盖；无效值在登录阶段报错。

| 变量 | 用途／默认值 |
| --- | --- |
| `TRAE_PRIVATE_APP_ID` | 协议应用 ID，内置默认值 |
| `TRAE_PRIVATE_AUTH_HOST` | 登录域覆盖，默认采用部署引导 |
| `TRAE_PRIVATE_OUTPUT` | 输出上限，32000 |
| `TRAE_PRIVATE_CONTEXT` | 扩展开关开启后的目标窗口，1000000 |
| `TRAE_PRIVATE_BODY_BUDGET` | 请求体字节预算，9 MiB |
| `TRAE_PRIVATE_TOOL_RESULT_KEEP` | 历史工具结果保留字符数，20000 |
| `TRAE_PRIVATE_USER_AGENT` / `_PROTOCOL_VERSION` / `_IDE_VERSION_CODE` / `_IDE_VERSION` / `_ORIGINATOR` | 协议头覆盖 |

## 验证

[真实部署记录](docs/real-deployment.md)包含 macOS 登录、Linux 远程回调、用量、连续续期和两种请求的额度拒绝结果。账号额度已用完，成功生成路径由离线协议测试覆盖，未标为真实成功对话。Windows 本轮未实测。

```sh
node index.test.mjs
bun test ./index.test.mjs
```

测试在隔离子进程中使用假凭据，限制文件访问和网络。安装与手工检查见 [MACHINE-SETUP.md](MACHINE-SETUP.md)。来源与许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；原始实现参考 [PR #235](https://github.com/magpie-community/plugins/pull/235)。

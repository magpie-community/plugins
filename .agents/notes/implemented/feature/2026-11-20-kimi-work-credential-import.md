# Agent Note: Kimi Work 凭据文件导入

Status: implemented

## Problem

Kimi Work 的对话密钥与会员令牌是两套凭据。原实现只把会员令牌保存到宿主认证库，每次对话仍从运行 Magpie 的本机 `daimon-share` 读取 Work 密钥，因此没有安装 Kimi 或没有挂载该目录的机器无法使用已有 Work 登录。

## Decision

使用 Magpie 已有的 `auth.import` 文件导入协议，让用户选择已登录 Work 的 Kimi 桌面版 `daimon/config.json`；同时在 `auth.methods` 中提供粘贴同一文件内容的第二种登录方案，使点击登录即可在本机读取和凭据导入之间选择。导入时复用本机文件的字段校验和官方 Work origin 限制，并用文件中的 Work 密钥请求 `/models` 验证后才返回成功账号。

导入账号在同一宿主账号项中显式保存 `workToken`、会员 access/refresh token、UID 和 `imported: true`。请求、模型发现和额度读取遇到这种账号时只使用已保存凭据，不调用 `readDesktop()`。原有本机及 reference-only 账号不自动迁移，仍按原路径读取桌面文件。

会员令牌继续由现有 `auth.refresh` 续期。Work 密钥没有续期接口，导入后的 Work 401 明确要求重新选择新文件，不能把会员续期误当成 Work 密钥续期。文件内容、Work 密钥和会员令牌不得写入错误信息或日志。

## Consequences

用户可以把可信机器上的 Work 凭据导入未安装 Kimi 的 Magpie，省去手工粘贴 JSON 的专用界面，并复用宿主的文件选择、代理、取消和账号保存流程。代价是 Work 密钥现在会按用户显式操作保存在宿主明文认证库中；文件仍须由某台已登录 Kimi 桌面版的机器生成，跨设备有效期和撤销策略仍由 Kimi 控制。

文件选择入口是 Magpie 扩展，OpenCode 会忽略 `auth.import`；粘贴凭据的登录方法使用标准 `auth.methods`，不依赖 Magpie 的文件选择界面。

## Alternatives considered

独立浏览器登录最接近 WorkBuddy 的体验，但当前源码没有 Kimi 服务端为插件独立签发 Work 密钥的流程，不能通过仿照 WorkBuddy 请求凭空实现。

只导入会员 access/refresh token 改动更小，却无法对话，因为推理使用的是独立的 `credentials.kimiCode.apiKey`，所以导入必须同时保存 Work 密钥。

自动把现有本机账号改为复制 Work 密钥可以减少一次用户操作，但会改变既有账号的凭据存储边界，并失去桌面重新签发密钥后自动读取新密钥的能力，因此保留原行为，只让显式文件导入复制密钥。

## Verification

合成 `config.json` 测试覆盖导入声明、登录菜单的粘贴方法、合法文件验证、导入后无桌面读取的对话/模型/额度请求、无 refresh token 的文件、无效 JSON/字段/origin、失效 Work 密钥和重新导入提示。既有测试继续约束本机登录不复制 Work 密钥及 reference-only 行为。未使用真实账号或真实凭据测试跨设备登录。

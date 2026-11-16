# AI Proxy

接入自己部署或使用的 [AiProxy](https://github.com/veildawn/ai-proxy-releases)
站点，在 Magpie 中调用模型并显示账号钱包、套餐及共享额度窗口。不预设站点，
不内置任何账号或密钥；它面向 AiProxy 控制台接口，并非所有 OpenAI 兼容网关。

## 安装与登录

```sh
magpie plugin add @magpie-community/opencode-aiproxy-auth
magpie plugin login aiproxy
```

在 OpenCode 中，将 `@magpie-community/opencode-aiproxy-auth` 加入
`opencode.json` 的 `plugin` 数组。`main` 是 Magpie / OpenCode 1.x 入口，
`exports["."]` 使用社区仓库的 OpenCode 2.x 适配器。原生额度展示和登录后协议
开关是 Magpie 功能。

登录时填写自己的 Base URL、API key、协议选项及控制台登录信息。可选择：

- **控制台邮箱与密码**：插件获取控制台会话，用于读取账号额度。
- **浏览器 Cookie**：先在浏览器完成登录及 2FA/SSO，再从已认证的 `/api/v1`
  请求中复制 Cookie 请求头。插件不代填验证码，也不自动执行 SSO。

API key 用于模型请求，控制台会话用于额度读取。登录信息由宿主凭据存储保存，
不要把 Cookie、密码或 API key 放进公开问题、截图或配置示例。
可填写自定义账号显示名；供应商显示名为 **AI Proxy**，ID 为 `aiproxy`。

公网地址要求 HTTPS；localhost、`.local`、回环及内网地址可使用 HTTP。

## 模型与额度

从 `/v1/models` 读取模型。支持 OpenAI Chat Completions 与 Responses；
可自动检测或在登录时手动选择。Magpie 登录后的供应商选项还可强制使用其中一种，
不必重新输入凭据；同时打开时 Responses 优先。

能力检测不发送提示词、不生成模型输出。Anthropic/Gemini 端点目前仅检测，
不提供其原生协议转换。Agent 发起的实际模型请求可能消耗站点额度。

钱包读取 `/api/v1/user/me`，套餐额度读取 `/api/v1/user/entitlements`；
旧版本回退到 `/api/v1/user/quotas`。分别保留每日、每周、滚动窗口及共享预算，
不把共享上限相加。管理员账号会尽力读取 `/api/v1/admin/quota`；
无权限或接口不可用不影响普通账号额度。额度读取有短时缓存及请求去重。

```sh
magpie quota aiproxy --json
```

使用随包附带的通用 AiProxy 图标。宿主目前不支持按账号 Base URL 动态选择 favicon。
此包基于 [violin321/magpie-aiproxy-plugin](https://github.com/violin321/magpie-aiproxy-plugin)
v0.5.0 适配，保留原 MIT 版权及 `aiproxy` provider ID。

## 检查

在社区仓库根目录执行：

```sh
node --test packages/aiproxy/aiproxy.test.mjs
bun scripts/check.mjs aiproxy
```

自动化检查使用模拟数据，不读取真实登录态。原独立插件有自定义站点的 Magpie
使用记录，不代表所有 AiProxy 版本或 OpenCode 2.x 的真实推理流程都已验收。

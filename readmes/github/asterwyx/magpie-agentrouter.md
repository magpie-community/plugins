# AgentRouter for Magpie

**插件和提供商均显示为 AgentRouter，默认模型前缀是 `agentrouter`。** 认证只有一个流程：先点击国际站或国内站按钮，再一次提交四项凭据。没有站点下拉框、OAuth、浏览器登录、授权码回填或额外 Key 查询。

一次性凭据包包含：账号、密码、API Key、系统访问令牌。为了匹配 Magpie 目前逐条显示问题的插件协议，四项以一个遮蔽的 JSON 输入框同时提交，不会拆成四轮提问：

```json
{"username":"你的账号","password":"你的密码","apiKey":"sk-你的模型Key","accessToken":"你的系统访问令牌"}
```

账号密码仅用于登录/签到，API Key 用于模型调用，系统访问令牌用于余额查询。三种凭据在认证请求中互不混用。

## 安装

### GitHub 安装

在运行 Magpie 的环境中执行（本仓库的 GitHub 分支更新后才有对应功能）：

```bash
magpie plugin add github:asterwyx/magpie-agentrouter
magpie plugin list
```

Kubernetes 集群中：

```bash
kubectl exec -n magpie deploy/magpie -- magpie plugin add github:asterwyx/magpie-agentrouter
kubectl exec -n magpie deploy/magpie -- magpie plugin list
```

已有安装应在 Magpie 的插件面板更新**本插件**。重复 `plugin add` 不保证刷新 GitHub 缓存；不要把“added”当成已加载新源码。避免 `plugin update` 意外更新其他插件，亦不要为更新而删除已有账号。GitHub 规格可追加 `#提交SHA` 固定版本。

### 本地源码安装

```bash
magpie plugin add /absolute/path/to/magpie-agentrouter
```

Docker / Kubernetes 中须使用容器内可见的目录。源码没有编译步骤，发布包须包含 `account.mjs` 和所有请求/响应模块。

## 配置账号

在 Magpie 的 AgentRouter 提供商中添加账号，或者执行：

```bash
magpie plugin login agentrouter
# Kubernetes：交互式填写，禁止把密码放在命令参数中
kubectl exec -it -n magpie deploy/magpie -- magpie plugin login agentrouter
```

首先通过两个**站点按钮**选择 AgentRouter 国际站或国内站；随后一个遮蔽输入框一次粘贴上述 JSON，四项凭据同时校验、一次提交。没有国家/站点下拉框、额外 Key、用户 ID 问题或浏览器步骤。Magpie 插件协议目前每次只显示一个原生问题，因此四项作为一个结构化遮蔽字段提交，而不是四个同时可见的独立输入框。

提交后插件执行：

- 用账号密码 `POST /api/user/login`，从响应取得用户 ID；不依赖浏览器 Cookie。
- 用填写的系统访问令牌和该用户 ID `GET /api/user/self`，核对是否属于同一账号。
- 成功时保存**你填写的 API Key**和账号凭据。Magpie 用 API Key 获取 `/v1/models` 的模型列表。

不会调用 OAuth、`/api/token/`、令牌生成/轮换或注册接口。不创建或擅自选择模型 Key。接口明确拒绝、账号不一致、二次验证或验证码时，直接显示失败原因，**不会打开浏览器或提供浏览器登录作为后续步骤**。

站点由登录第一步的按钮选择：国际站 `agentrouter.org` 或国内站 `ps.air-outer.com`。站点选择和四项凭据在同一次登录流程中完成；新账号保存对应的 API 地址。

四项凭据持久保存在运行 Magpie 的服务器认证文件中，并非仅在浏览器本机。仅在你信任的服务器保存，保护文件权限，不要发到聊天、截图、Issue 或 Git。API Key 只保存在 `key`，不重复写入 metadata；密码和系统令牌保存于 metadata，供后续 hook 使用。

## 查询模型和余额

```bash
magpie provider models agentrouter
magpie provider test agentrouter
magpie quota agentrouter
```

插件、提供商名称均为 **AgentRouter**，模型完整名称默认显示为 `agentrouter/<model-id>`。如 Magpie 中已有同 ID 提供商占用，则由 Magpie 自身的冲突规则处理。

插件图标使用 AgentRouter 国内站 HTML 声明的 `/logo.png` favicon。

模型读取顺序：先用登录 API Key 请求该账号 `/v1/models` 获取可用模型，再按模型 ID 合并 Magpie `models.dev` 中已有的上下文窗口、输入/输出上限、多模态、工具调用及思考档位信息；同时读取所选站点 `/api/pricing` 的实时模型列表与端点能力。来源没有提供的字段保持未知，不填入猜测值。接口暂不可用时仅用当前已验证的价格页模型列表作为兜底。

**凭据用途严格分离：**

- 模型列表、模型调用只发送 API Key。
- 余额查询只用系统访问令牌及登录取得的用户 ID。
- 登录/签到只发送账号密码，不带 API Key、系统令牌或 Cookie。

余额取 `quota`（剩余）与 `used_quota`（已消耗），默认每 500000 额度对应 1 美元。比例来自真实原始额度，美元显示四舍五入到分。缺字段、验证码、网络错误或令牌失效时显示“剩余额度未知”，**不使用密码重新登录、不用 API Key billing 回退、不把累计消耗推算成余额**。

Magpie 可能保留带历史读取时间的上次余额；那不是本次查询成功的证据。

## 自动签到

在 Magpie 中启用 AgentRouter 提供商的每日签到。Magpie 负责按北京时间的每日调度调用 `auth.checkin`；插件不创建后台定时器。

签到通过账号密码重新请求 `POST /api/user/login`，校验返回用户 ID 与保存账号一致，再检查 `data.checked_in`：

- `true` → `claimed`：站点确认本次新增额度。
- `false` → `done`：本次未新增额度，不凭此声称之前曾到账。
- 缺失或非布尔值 → `failed`：不能确认签到。
- 凭据错误或账号不一致 → `ineligible`。
- 站点验证码 → `captcha`，不打开浏览器、不破解验证码。

登录本身也可能触发当日额度，后续签到返回 `false` 是正常的无新增结果。系统访问令牌和 API Key 不参与签到。

可选独立 Node.js 签到工具也已改为账号密码方式，保留私有目录、24 小时限频与失败暂停机制，见 [LOCAL-CHECKIN.md](LOCAL-CHECKIN.md)。普通 Magpie 使用不需要配置此工具。

## 保留的模型请求功能

此次重构认证和账号读取，没有移除模型调用兼容功能：

- 模型按该模型目录中的 SDK/端点信息使用 Responses、Anthropic Messages 或 OpenAI-compatible API；Magpie 负责为客户端转换请求。
- 默认发送兼容的 Codex 客户端请求头。
- 默认无损内联完整 Responses 历史，保留工具关联和不透明状态。
- 可选本地文字替换，只作用于发送副本。
- 默认关闭的 `codex-session-repair` 有损资源清理。
- 429 等待提示、内容拒绝和空响应诊断，不自动重试模型请求。

提供商的四个布尔开关仍独立工作：

| 选项 | 默认 |
|---|---|
| `send-codex-headers` | 开启 |
| `portable-responses` | 开启 |
| `text-filter` | 开启，没有词表时不替换 |
| `codex-session-repair` | 关闭；开启可能丢失上下文 |

`content-filter.local.json` 是私有词表，勿提交。示例见 [content-filter.example.json](content-filter.example.json)。请求检查仍有 4 MiB / 2 秒边界，JSON 响应诊断保持 64 KiB / 2 秒边界。账号接口的响应最多读取 64 KiB，请求及正文读取最多 30 秒，异常不回显凭据。

插件级 JSON 可配置 `retryAfterSeconds`（缺省 10 秒）和 `site`；账号已有 metadata 中的 `retryAfterSeconds` 可覆盖。上游等待提示优先，不新增重试。

既有 `endpoint` / `apiBase` / `headers` 元数据继续生效。认证头、Cookie 和用户 ID 不从自定义头跨用途转发；账号密码与系统令牌只允许发往两个 AgentRouter 站点。

## 升级边界

旧账号不自动删除或改写。缺少四项凭据的旧账号仍可能调用模型，但查询余额/签到会提示重新配置。旧 `githubCookie` / `cookie` 不再参与认证或签到；不要继续复制浏览器 Cookie。

模型调用测试、系统令牌验证与签到确认是不同的验证，不要把“插件 on”或“账号已保存”视为真实模型回答成功。

## 开发验证

```bash
npm test
npm run test:policy
npm run test:headers
node --check index.mjs
node --check account.mjs
npm pack --dry-run
```

认证测试覆盖四字段一次提交、无浏览器/回调、用途隔离、错误与取消、同账号校验及签到结果。模拟接口测试不等于真实 AgentRouter 账号实测。

`npm run test:magpie-ui` 是可选真实 Magpie 网页交互测试。只允许隔离的本地地址：指定 `MAGPIE_TEST_WEB_URL`、该沙盒的 `MAGPIE_TEST_WEB_KEY` 和外部安装的 `playwright-core` 的入口路径 `PLAYWRIGHT_MODULE`。须先启动只使用模拟账号的 Magpie/接口沙盒；该测试不接受真实账号凭据，也不在普通 `npm test` 或发布包中安装浏览器依赖。

[CHANGELOG.md](CHANGELOG.md) 保留历史版本记录；[docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) 描述旧版本模型兼容背景，其中旧登录方式不适用于当前重构。

[贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [MIT](LICENSE)

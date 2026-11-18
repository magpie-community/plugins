# magpie-plugin-sub2api

给 [Magpie](https://github.com/yetone/magpie) 添加 **Sub2API 模型供应商**。登录时填写站点地址、邮箱和密码；插件自动取得账号的模型 API Key、读取模型列表，并将模型提供给 Magpie 中的代理。每日签到和余额查询是该供应商的附加功能。

## 功能

- 多站点、多账户：每次添加账户填写自己的 Sub2API 站点地址，模型请求使用该账户的站点和密钥。
- 支持 HTTPS，HTTP 仅允许本机回环地址；反向代理的路径前缀也可保留。
- 使用邮箱和密码登录；由 Magpie 保存模型 API Key、面板 JWT 与可选的刷新令牌。
- 登录后读取账号自己的模型 API Key，并将 Sub2API `/v1` 模型列表作为供应商模型目录。
- 查询站点账户余额。
- 签到前先读取状态；只在签到功能启用且今天未签到时领取。

## 签到兼容性

插件兼容两种签到接口：

- **Sub2API Pro 或兼容部署**：GET `/api/v1/redeem/checkin/status` 查询状态，POST `/api/v1/redeem/checkin` 领取。
- **apikey.casa 同类部署**：GET 和 POST 均使用 `/api/v1/redeem/checkin`，状态字段为 `checked_in` 和 `reward`。

插件优先查询 Pro 状态接口，仅在该接口返回 HTTP 404 或 405 时尝试同路径 GET，并校验对应的状态字段；不会因认证失败、网络错误或响应格式错误而尝试其他接口。两种接口的领取请求均为空请求体。关闭签到、权限不足、今天已签和网络错误会分别报告，不会伪报领取成功。签到响应不明确时只重新查询状态，不会重发领取请求。其他版本或定制部署仍可能不兼容。

## 安装

```bash
magpie plugin add github:gufeng0/sub2api-magpie-plugin
magpie plugin login sub2api
```

本地开发也可以从项目目录安装：`magpie plugin add /path/to/sub2api-magpie-plugin`。不要同时安装 GitHub 版本和本地版本，以免重复占用 `sub2api` 供应商。

按提示输入：

1. **站点地址**：例如 `https://your-site.example`，不含 `/v1` 或 `/api/v1`。
2. **登录邮箱**和**密码**：Sub2API 的站点账户，不是上游 OpenAI/Claude 账户。
3. **模型协议**：通常选自动；也可指定 Chat Completions、OpenAI Responses 或 Anthropic Messages。

登录后在 Magpie 供应商列表选择 **Sub2API**。模型来自所选 API Key 对应的站点分组，在代理中使用 `sub2api/<站点返回的模型 ID>`。再次登录可添加另一个站点或账户；每个账户独立使用自己的密钥和模型目录。

生产环境请使用 HTTPS。需要每日签到时，再在 **设置 → 额度 → 预热与签到 → 插件 → Sub2API** 开启。

## 凭据与模型

Magpie 将插件登录数据保存到本机 `plugin-auth.json`（文件权限由 Magpie 管理），包括站点地址、邮箱、密码、JWT、刷新令牌和用于模型请求的 API Key。面板 JWT 只用于站点接口，API Key 只用于 `/v1` 模型接口。凭据不会发送到用户填写的站点以外的地址，也不会写入插件源码或日志。

账号显示为 `邮箱 · 站点地址`，避免不同站点使用相同邮箱时被 Magpie 合并。真实登录邮箱另存为 `metadata.loginEmail`，刷新和重新登录仍使用它。

首次登录时插件会从 `/api/v1/keys` 读取账号拥有的 Key，优先选剩余额度最多的有效 Key，无限额 Key 排在有额度的 Key 之前；没有可用 Key 时需先在站点创建并启用 API Key。不会自动创建、删除或修改站点上的 Key。

自动协议依据所选 Key 的分组平台：Anthropic 使用 Messages，OpenAI/Grok 使用 Responses，其他或未知平台默认 Chat Completions。若部署只开放某个协议，请在登录时明确指定。插件不预置或编造模型名称、价格；站点未提供上下文与输出限制时，使用默认值 200,000 / 8,192 tokens，不代表运营方保证的真实上限。

若站点启用了验证码或 TOTP，当前版本没有交互验证流程，登录会提示该限制；不会绕过验证。该站点能否直接用密码登录，取决于部署的验证策略。

## 开发

```bash
npm test
```

自动化测试使用模拟接口，不使用真实账户，覆盖模型供应商登录链路、Key 选择、账户隔离、请求转发和两种签到接口的兼容性；同时在本机 Magpie 0.1.3960 的隔离配置目录验证了插件可加载，供应商具有登录、用量和签到钩子。真实站点登录、模型推理和领奖仍需用你自己的账户验证。

此插件为独立实现，未复制 Sub2API 服务端代码；按上游登录与 API Key 接口，以及上述两种每日签到接口对接。不同版本或定制部署可能有差异。插件本身使用 MIT 许可；Sub2API 服务端使用 LGPL-3.0。使用前请确认符合站点运营方条款。

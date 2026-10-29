# @magpie-community/opencode-string-ai-auth

[String AI](https://www.string.ink/) 的非官方社区供应商插件，供 [Magpie](https://usemagpie.ai/) 使用。登录账号后自动读取全部可用 API Key，加载各密钥可用的模型，并在请求时选择对应密钥。余额和分组额度显示在一张供应商卡片中。Provider ID 为 `string-ai`。

本插件源自 [Jiao77/magpie-string-ai](https://github.com/Jiao77/magpie-string-ai)，导入版本为 `1.1.0`（提交 `0457efbb0f85731fa96ff5188ee45d77dfea6801`），保留原作者署名和 MIT 许可。社区收录不代表 String AI 官方插件或官方背书。

## 安装和登录

收录并发布后可使用规范包名安装：

```bash
magpie plugin add @magpie-community/opencode-string-ai-auth
magpie plugin login string-ai
```

在本仓库审核、发布前，可从仓库根目录安装本地包：

```bash
magpie plugin add ./packages/string-ai
magpie plugin login string-ai
```

选择“登录 String AI，自动导入全部 API Key”。浏览器会打开插件在本机 `127.0.0.1` 提供的登录页面。输入 String AI 邮箱和密码；账号启用两步验证时，再输入验证码。登录完成后返回 Magpie。

密码只用于向 `https://www.string.ink` 提交本次登录请求。登录 Token 由宿主保存（Magpie 的 `plugin-auth.json`），并通过刷新 hook 续期。API Key 从账号接口读取，路由缓存仅保存在当前插件进程内，不另存模型密钥缓存文件。账号登录会授予插件读取账号密钥的能力；只安装你信任的版本，不要分享登录 Token 或 API Key。

使用 Google、GitHub 或微信登录的账号，需要先在 String AI 账号设置中设置密码。此入口使用邮箱和密码登录。

## 自动同步和模型

- 分页读取账号下的密钥，保留站点返回的分组 ID、名称和平台信息。
- 导入处于启用状态且未过期的普通 API Key，跳过停用和站点隐藏的托管密钥。
- 通过每个 Key 的 `/v1/models` 接口确定可用模型，请求使用实际提供该模型的 Key。
- 同一模型由多个 Key 提供时，按密钥列表顺序使用第一个可用 Key。
- 在 Magpie 重新获取模型时同步新增和删除的密钥；余额刷新时读取当前账号余额和密钥额度。
- 账号下没有可用 Key 时显示明确提示。插件不创建、修改或删除站点上的密钥。
- 不提供固定模型列表。Claude 使用 Messages，GPT / Codex 系列使用 Responses，其余使用 Chat Completions；实际模型以账号接口返回为准。

已有的手动 API Key 登录继续可用，也可以在登录方式中选择“手动填写 API Key”。账户登录固定访问 String AI；`baseURL` 选项只改变模型及用量请求地址，勿将它指向不信任的服务。

## 验证和兼容边界

```bash
node packages/string-ai/test.mjs
bun test packages/string-ai scripts/check.test.mjs
bun scripts/check.mjs string-ai
```

测试覆盖本地 HTTP 登录、两步验证、分页同步、模型与密钥关联、账号隔离、密钥移除、Token 刷新、配置和错误提示。String AI 服务响应使用接口契约数据，没有使用真实账号，也没有发起付费模型调用。

插件采用 OpenCode provider hook 结构；当前账号自动发现、刷新和余额路径依赖宿主对这些 hook 的支持。本次未进行 OpenCode CLI 或 Magpie 桌面端的真实账号端到端验证，不把 hook 结构检查等同于客户端兼容认证。

## 许可

[MIT](LICENSE)，原作者 Jiao77。

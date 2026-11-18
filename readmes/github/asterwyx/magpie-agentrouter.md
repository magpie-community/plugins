# magpie-agentrouter

AgentRouter 的 Magpie 提供商插件。安装后可以在 Magpie 中使用 AgentRouter 模型、查看余额，并启用每日签到。

## 功能

- 使用 AgentRouter 国际站或国内站账号登录。
- 在 Magpie 中查看和使用账号可用的 AgentRouter 模型。
- 查看账号余额。
- 由 Magpie 调度每日签到。

## 安装

在 Magpie 的插件页面添加：

```text
github:asterwyx/magpie-agentrouter
```

也可以在能访问 Magpie 的终端执行：

```bash
magpie plugin add github:asterwyx/magpie-agentrouter
```

安装后，在 Magpie 的 AgentRouter 提供商页面登录。

## 登录

1. 选择 **AgentRouter 国际站（agentrouter.org）** 或 **国内站（ps.air-outer.com）**。
2. 依次填写四个字段：
   - AgentRouter 账号
   - 账号密码
   - API Key（可留空）
   - 系统访问令牌（可留空）

四项凭据用途不同，不能互相替代：

- 账号和密码用于登录和签到。
- API Key 用于模型列表和模型调用。
- 系统访问令牌用于查询余额。

**留空 API Key 和系统访问令牌时：**

- 插件会用本次登录会话查找名为 `magpie` 的模型 API Key；没有则创建。`/api/token` 返回的 key 不带 `sk-`，插件保存时会补上。
- 系统访问令牌为空时，插件会从登录会话读取账号的访问令牌。
- 登录会话只用于本次自动获取凭据，不会保存，也不会用于模型请求。自动获取失败时，登录会失败；可以重新登录并在对应字段填写值。

站点选择决定模型和登录使用哪个 AgentRouter 站点，签到也使用所选站点。余额查询优先使用所选站点，站点暂时不可用时自动尝试另一个站点。

也可以在终端登录：

```bash
magpie plugin login agentrouter
```

不支持 OAuth 或浏览器授权；登录会话仅用于自动获取凭据。

## 使用

### 模型

在 Magpie 中选择 AgentRouter 模型即可。可用模型以账号实际返回的列表为准；列表变化时，以 Magpie 中刷新后的结果为准。

### 余额

在 Magpie 的提供商页面查看，或执行：

```bash
magpie quota agentrouter
```

余额读取失败时会显示“剩余额度未知”，不会用密码或 API Key 推算余额。

### 每日签到

在 Magpie 中开启 AgentRouter 的每日签到。Magpie 负责按日调度，插件使用账号密码登录并读取站点的签到状态，不需要额外的本地定时任务。

## 可选设置

遇到限流时，插件会返回建议等待时间，默认 10 秒。需要调整时，在 Magpie 的插件选项中设置 `retryAfterSeconds`。

## 常见问题

**看不到模型？**

检查 API Key 是否填写正确，或重新登录让插件自动获取。模型列表以账号实际可用的模型为准。

**余额显示未知？**

可能是站点接口暂时不可用、返回了验证页面，或系统访问令牌需要更新。稍后重试；这不代表账号一定失效。

**登录失败？**

核对账号、密码、API Key 和系统访问令牌四项内容。留空的字段会尝试自动获取；自动获取失败时，请重新登录并填写对应字段。账号密码与 API Key 不能混用。

**为什么提供商显示为 `agentrouter-plugin`？**

Magpie 中已有同 ID 的旧提供商。插件仍可正常使用；如需恢复 `agentrouter` 前缀，可移除或重命名旧提供商。

## 凭据安全

四项凭据保存在运行 Magpie 的服务器上，不会只留在浏览器。自动获取时使用的登录会话不会保存，也不会用于模型请求。请只在可信服务器使用，并保护 Magpie 的数据目录；不要把凭据发到聊天、截图、Issue 或 Git 仓库。

## 链接

- [贡献指南](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)
- [MIT 许可证](LICENSE)

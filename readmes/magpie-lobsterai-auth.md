# magpie-lobsterai-auth

把 **网易有道 LobsterAI（有道龙虾）** 的套餐模型接入 Magpie / OpenCode。

English: [README.en.md](README.en.md)

插件 id：`lobsterai`。登录后，Magpie 里会出现 `lobsterai/<模型>`，例如
`lobsterai/deepseek-flash`、`lobsterai/qwen3.8-max`、`lobsterai/kimi-k3`。

> 非官方项目，与网易有道没有隶属关系。它使用 LobsterAI 自己的账号、登录流程和模型接口；
> 上游接口属于未公开协议，可能随 LobsterAI 更新而变化。

参考：

- Magpie 插件文档：<https://usemagpie.ai/docs/zh/plugins>
- LobsterAI 开源仓库：<https://github.com/netease-youdao/LobsterAI>

## 能做什么

- **浏览器登录**：打开 LobsterAI 官方登录页，回调到本机临时端口，自动换取 access / refresh token。
- **Token 兜底**：无法完成浏览器登录时，可以手动粘贴已有 Token。
- **动态模型列表**：登录后读取账号可用的套餐模型，而不是写死一份静态列表。
- **思考档位**：复刻 LobsterAI 的 `lobsterai_options` 请求字段；Kimi K3 按其固定契约发送。
- **自动续期**：提供 `auth.refresh`，并在请求前检查 JWT 过期时间。
- **积分用量**：读取 `/api/user/quota`，在 Magpie 账号卡片和 `magpie quota` 中显示套餐积分。
- **多账号**：Magpie 的账号作用域内工作，不会把一个账号的 token 用到另一个账号。
- **企业账号**：识别登录响应里的企业上下文，并发送 `X-LobsterAI-Account-Mode` /
  `X-LobsterAI-Enterprise-Id`。

## 安装

先在 LobsterAI 官网或桌面端确认账号可用，然后：

```bash
magpie plugin add magpie-lobsterai-auth
```

也可以直接从 GitHub 安装，不经过 npm：

```bash
magpie plugin add github:BowlongRise/magpie-lobsterai-auth
```

登录并测试：

```bash
magpie plugin login lobsterai
magpie plugin
magpie provider test lobsterai
magpie quota
```

在 Magpie 桌面端：打开 **插件 → 添加插件**，填 `magpie-lobsterai-auth` 或 GitHub
仓库地址；然后在 **供应商 → LobsterAI** 里点登录。

## 登录方式

### 浏览器登录（推荐）

插件会：

1. 从 LobsterAI 的公开配置接口读取当前登录页地址；
2. 在本机 `127.0.0.1` 启动一个一次性回调服务；
3. 打开 `lobsterai.youdao.com/portal#/login`，带上 `source=electron`、
   `redirect_uri` 和随机 `state`；
4. 收到授权码后调用 `POST /api/auth/exchange`；
5. 把 access / refresh token 交给 Magpie 保存。

关闭浏览器或等待超过 5 分钟会结束本次登录。

### Token 登录（高级）

如果你已经有一组 LobsterAI Token，可以选择 **LobsterAI Token（高级）**，粘贴：

- Access Token（必填）
- Refresh Token（可选）

插件会先用 Access Token 调用 `/api/models/available` 验证；如果 Access Token 已过期但
Refresh Token 有效，会先续期再保存。Token 过期时间从 JWT 的 `exp` 读取。

## 模型

账号可用模型来自 `GET /api/models/available`，包括当前套餐里的 DeepSeek、Qwen、GLM、
Kimi、MiniMax、Doubao 等真实模型。

官方客户端的“快速”（`yd-fast`）和“旗舰”（`yd-ultra`）是服务端按会话解析的虚拟预设，
不是可直接请求的模型。本插件不列出这两个 ID，避免未经解析就把虚拟 ID 发到
`/chat/completions`；需要路由时可在 Magpie 里使用模型路由组。

如果模型列表读取失败，插件会保留内置的 2026-11-13 快照；登录后再次读取会刷新。

模型上的 `rate` 是 LobsterAI 的积分倍率，不是美元价格。`limitedFreeActive` 为 true 的模型
会标记为免费。

## 请求端点

插件直连 LobsterAI 的模型代理，不启动桌面客户端：

```text
https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions
```

每个请求带：

- `Authorization: Bearer <access token>`
- `X-LobsterAI-Client-Version`
- `X-LobsterAI-Client-Capabilities`
- `x-lobster-session-id`（来自 Magpie 的会话 id）

## 登录信息存在哪里

Magpie 把插件账号保存在自己的 `plugin-auth.json`（权限 600）。插件**不会读取** LobsterAI
桌面端的数据库、Cookie 或凭据文件，也不会把 token 写进日志。

## 开发

```bash
git clone https://github.com/BowlongRise/magpie-lobsterai-auth.git
magpie plugin add ./magpie-lobsterai-auth
npm test
npm run check
```

测试使用 Node 内置的 `node:test`，网络请求全部 mock，不需要 LobsterAI 账号。

发布流程见 [CONTRIBUTING.md](https://github.com/BowlongRise/magpie-lobsterai-auth/blob/main/CONTRIBUTING.md)。

## 许可

MIT。见 [LICENSE](LICENSE)。

LobsterAI 名称和图标属于网易有道；本项目只用于标识所接入的服务。

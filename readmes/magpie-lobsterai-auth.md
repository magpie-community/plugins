# magpie-lobsterai-auth

[![npm](https://img.shields.io/npm/v/magpie-lobsterai-auth)](https://www.npmjs.com/package/magpie-lobsterai-auth)
[![CI](https://github.com/BowlongRise/magpie-lobsterai-auth/actions/workflows/test.yml/badge.svg)](https://github.com/BowlongRise/magpie-lobsterai-auth/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/magpie-lobsterai-auth)](LICENSE)

把 **网易有道 LobsterAI（有道龙虾）** 的套餐模型接入 Magpie / OpenCode。

[English](README.en.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md) · [问题反馈](https://github.com/BowlongRise/magpie-lobsterai-auth/issues)

插件 id：`lobsterai`。登录后，Magpie 里会出现 `lobsterai/<模型>`，例如
`lobsterai/deepseek-flash`、`lobsterai/qwen3.8-max`、`lobsterai/kimi-k3`。

> 非官方项目，与网易有道没有隶属关系。它使用 LobsterAI 自己的账号、登录流程和模型接口；
> 上游接口属于未公开协议，可能随 LobsterAI 更新而变化。
> LobsterAI 的账号限制提示明确要求不要通过第三方插件转接额度，使用本插件可能导致账号受限。

参考：

- Magpie 插件文档：<https://usemagpie.ai/docs/zh/plugins>
- LobsterAI 开源仓库：<https://github.com/netease-youdao/LobsterAI>

## 能做什么

- **浏览器登录**：打开 LobsterAI 官方登录页，回调到本机临时端口，自动换取 access / refresh token。
- **粘贴回调地址**：在服务器、Docker 或远程浏览器环境中 `127.0.0.1` 回调无法直达时，复制跳转后的回调 URL（或 `code`）粘贴到文本框即可完成登录。
- **Token 兜底**：无法完成浏览器登录时，可以手动粘贴已有 Token。
- **动态模型列表**：登录后读取账号可用的套餐模型，而不是写死一份静态列表。
- **思考档位**：复刻 LobsterAI 的 `lobsterai_options` 请求字段；Kimi K3 按其固定契约发送。
- **自动续期**：提供 `auth.refresh`，并在请求前检查 JWT 过期时间。
- **积分用量**：合计套餐池和签到/活动赠送积分，在 Magpie 账号卡片和 `magpie quota` 中显示真实余额。
- **每日签到**：提供 `auth.checkin`，手动或每天自动领取 LobsterAI 的每日签到积分。
- **多账号**：Magpie 的账号作用域内工作，不会把一个账号的 token 用到另一个账号。
- **企业账号**：识别登录响应里的企业上下文，并发送 `X-LobsterAI-Account-Mode` /
  `X-LobsterAI-Enterprise-Id`。

## 环境要求

- Magpie（桌面端或 `magpie web` 都可以）；每日签到依赖 `auth.checkin`，需要 Magpie 0.1.1083
  或更新版本。
- LobsterAI 账号，免费版即可；**不需要**安装 LobsterAI 桌面端。
- 只有从源码开发或跑测试才需要 Node.js 20.3 以上。

## 安装

先在 [LobsterAI](https://lobsterai.youdao.com/) 官网或桌面端确认账号可用，然后：

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

### 粘贴回调地址（适合服务器 / Docker / 远程浏览器）

如果 Magpie 运行在服务器或 Docker 容器中，登录完成跳转 `http://127.0.0.1:<port>/auth/callback?...`
时浏览器会提示无法连接。此时可选择 **LobsterAI 账号（粘贴回调地址）**：

1. 在任意浏览器打开 Magpie 给出的登录链接并完成登录；
2. 跳转后即使页面报无法访问，直接复制浏览器地址栏中的完整回调地址（或其中的 `code` 参数）；
3. 粘贴到 Magpie 下方文本框提交，插件校验 `state` 后完成换取并保存 Token。

### Token 登录（高级）

如果你已经有一组 LobsterAI Token，可以选择 **LobsterAI Token（高级）**，粘贴：

- Access Token（必填）
- Refresh Token（可选）

插件会先用 Access Token 调用 `/api/models/available` 验证；如果 Access Token 已过期但
Refresh Token 有效，会先续期再保存。Token 过期时间从 JWT 的 `exp` 读取。

## 模型

账号可用模型来自 `GET /api/models/available`，包括当前套餐里的 DeepSeek、Qwen、GLM、
Kimi、MiniMax、Doubao 等真实模型。

上下文窗口取该接口返回的 `contextWindowOptions` 最大值，没有时回退 `contextWindow`；
数值由上游决定，可能调整，插件每次读取都会跟随。

官方客户端的“快速”（`yd-fast`）和“旗舰”（`yd-ultra`）是服务端按会话解析的虚拟预设，
不是可直接请求的模型。本插件不列出这两个 ID，避免未经解析就把虚拟 ID 发到
`/chat/completions`；需要路由时可在 Magpie 里使用模型路由组。

如果模型列表读取失败，插件会保留内置的 2026-11-13 快照；登录后再次读取会刷新。

模型上的 `rate` 是 LobsterAI 的积分倍率，不是美元价格。`limitedFreeActive` 为 true 的模型
会标记为免费。

## 积分用量

LobsterAI 把积分分成两块，插件两个接口都读：

- `GET /api/user/quota` —— 套餐自己的池子（免费版就是 `freeCreditsTotal` 300）。
- `GET /api/user/profile-summary` —— `creditItems` 列出每一笔来源（新用户赠送、每日登录奖励……）
  和各自到期日，`totalCreditsRemaining` 是合计数。

所以账号卡片会按来源分别显示，余额取 `totalCreditsRemaining`：300 的赠送 + 每天签到 100，
签到两天就是 500。只读 `/api/user/quota` 会少算签到和活动发的部分。

每行显示的是服务端给的剩余额度，插件不自己折算「已用 / 总额」。

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

插件只和 LobsterAI 自己的服务器通信（`lobsterai-server.youdao.com`、
`api-overmind.youdao.com`、`lobsterai.youdao.com`），不含遥测，不把任何数据发往别处。

## 每日签到

插件提供 Magpie 的 `auth.checkin` 钩子，走 LobsterAI 自己的活动接口：

- 手动：`magpie accounts checkin`（或账号卡片上的签到按钮），立刻执行一次。
- 自动：在 `设置 → 用量 → 插件` 里打开每日签到，Magpie 每天为每个账号调用一次。

流程是 `GET /api/client-activities/slot` 找当前活动，`GET …/context` 看今天是否已领，
没领就 `POST …/actions/check_in`。结果映射：

- 领取成功 → `claimed`，带上本次到账积分和连续天数。
- 今天已经领过 → `done`，不会再发请求。
- 活动没开、已结束或不是每日签到 → `inactive`，当天不再重试。
- 登录过期 → `failed`，并标记 `signIn: "expired"`。

返回里的 `until` 是活动时区（LobsterAI 用 `Asia/Shanghai`）的次日 0 点，Magpie 到那个
时间再问，而不是按本机时区猜。LobsterAI 的「登录送积分」一次性活动不在签到钩子里处理。

## 与 Providers Hub 的关系

Magpie 插件市场里的 `magpie-providers-hub` 也接了 LobsterAI 渠道（provider id
`hub-lobsterai`），登录方式和模型接口与本插件相同。两者的区别：

- 那个是十一个渠道的聚合包，本插件是只做 LobsterAI 的独立包，升级和排错都互不影响。
- 本插件发送 LobsterAI 的 `lobsterai_options` 思考档位，并遵守 Kimi K3 的固定请求契约；
  聚合包没有这两个。
- 本插件把套餐池和活动赠送积分合计后显示真实余额，聚合包的 LobsterAI 条目没有用量钩子。
- 本插件提供每日签到（`auth.checkin`），聚合包的 LobsterAI 条目没有签到钩子。
- 本插件识别登录响应里的企业上下文，发送 `X-LobsterAI-Account-Mode` /
  `X-LobsterAI-Enterprise-Id`。

同一个账号在两个插件里登录的是同一条渠道，积分池也是同一个。

## 常见问题

**在 Magpie 里搜不到这个插件？** npm 的搜索索引对新包有延迟，直接按名字安装即可：
`magpie plugin add magpie-lobsterai-auth`。

**登录成功但模型是空的？** 可能是账号套餐里没有可访问的模型，或 `/api/models/available`
暂时失败；插件会退回内置快照，稍后重新登录或刷新即可。

**卡片上的积分比 LobsterAI 客户端少？** 0.2.1 之前的版本只读 `/api/user/quota`，会漏掉
签到和活动赠送的积分。更新到最新版即可，见 [更新日志](CHANGELOG.md)。

**签到没领到？** 活动未开始或已结束时返回 `inactive`，当天不再重试；登录过期会返回
`failed` 并提示重新登录。

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

# u1s1 Magpie 插件

**u1s1 官方插件**：让 Magpie 网关出现 u1s1 模型服务，客户用自己的 u1s1 账号登录后，任何接入 Magpie 的 Agent（Claude Code、Codex、Gemini CLI、OpenCode…）都能直接使用 u1s1 模型。

协议实现完全对照 **u1s1-cli 1.14.5 官方源码**（`dist/api.js`、`device-auth.js`、`login.js`、`site.js`），并经网关实测校验：

| 项 | 实现 |
|---|---|
| 聊天端点 | `POST {base}/chat/completions`（OpenAI 兼容；Magpie 网关自动完成 Anthropic 等协议互转） |
| 站点 | 中国站 `https://api.u1s1app.com/v1`（默认）/ 国际站 `https://api.u1s1.dev/v1`（中国站连不上时自动切换） |
| 登录 | 设备码：浏览器批准，与 `u1s1 login` 同一套流程 |
| 鉴权 | 每请求 DPoP 签名（本机 P-256 私钥）+ `Bearer api_key` 兜底 |
| 请求头 | `User-Agent: u1s1-cli`（服务端 client integrity 识别官方客户端的依据）+ `x-u1s1-version` / `x-u1s1-client` / `x-u1s1-platform` / `x-u1s1-attestation`（从 `GET /v1/models` 获取、按 7 天有效期缓存、过期自动刷新） |
| 模型列表 | 登录后实时拉取 `GET /v1/models`（`context_length` / `max_tokens` / `price` / `vision` 完整映射） |
| 错误语义 | 401 → 提示重新登录；403 → 透传服务端原文（重登无用） |

**凭证安全**：每个用户登录**自己的** u1s1 账号，密钥对在本机生成，凭证只保存在本机 Magpie 的 `plugin-auth.json`，不共享、不导出。

## 安装

解压后在 Magpie 终端执行：

```sh
magpie plugin add ./u1s1-magpie
```

或在 Magpie → **Plugins** 页面添加本地目录 `u1s1-magpie`。

## 登录

```sh
magpie plugin login u1s1
```

会打开浏览器 → 登录 u1s1 → 点「批准」，回到终端自动完成。设备名显示为 `<主机名> (magpie)`，方便在仪表盘「我的站点」区分设备。

## 给 Agent 选模型

Magpie → **Agents** 页 → 点某个 Agent 的模型 → 从「u1s1」分组里选。开新会话生效。

```sh
magpie plugin            # 查看登录状态
magpie provider test u1s1  # 测试连通
```

## 卸载

```sh
magpie plugin remove u1s1
```

## 故障排查

| 现象 | 含义与处理 |
|---|---|
| **401** / 「登录已失效」 | 凭证失效（设备被移除/换过钥匙）→ 重新 `magpie plugin login u1s1` |
| **403** / 「账号当前无法使用」 | 登录有效但服务端拒绝（风控/客户端限制），重登无效。若提示「赠送额度仅限官方客户端使用」：赠送额度按服务端规则仅限官方客户端；充值余额不限制客户端，可充值后继续；误判可走服务端提供的申诉入口 |
| 模型列表为空 | 未登录时展示兜底列表；登录后自动替换为账号真实列表 |
| 中国站连不上 | 自动切换国际站（两站账号独立，需分别登录） |

## 常见问题

- **两站账号不通**：中国站（u1s1app.com）与国际站（u1s1.dev）是独立账号体系；登录时默认走中国站，失败自动尝试国际站。
- **余额**：扣除的是当前登录账号的余额；价格与模型可用状态以 u1s1 官网「模型与价格」页为准。
- **本地诊断**：`dev/_probe-u1s1.mjs`（开发用，不随包发布）可用插件同款签名直连网关，验证 `/models`、`/chat/completions` 与 attestation 链路：

  ```sh
  node dev/_probe-u1s1.mjs
  ```

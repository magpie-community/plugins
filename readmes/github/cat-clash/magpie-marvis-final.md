# 腾讯 Marvis · magpie 供应商插件（final 0.6.0）

> **⭐ 使用文档请读 [`README-FINAL.md`](./README-FINAL.md)。**
>
> 本插件把腾讯 Marvis（应用宝 AI 助手）背后的 DeepSeek V4.1 Flash / V4 Pro、
> Claude Sonnet/Opus 4.6、GPT-5.4、Hy3、HY-Vision 2.0 接进 magpie / OpenCode，
> QQ / 微信登录，不用粘贴 key。**PC 与手机通用（手机通过本地 OpenAI 网关）。**

## 传输通道（0.6.0）

| 模式 | 说明 | 适用 |
|---|---|---|
| `gateway`（默认推荐） | 本地 OpenAI 兼容网关 `http://127.0.0.1:8088/v1`，跨平台，PC 与手机共用；手机在 Termux / PRoot 里跑 Python 网关即可 | PC + 手机，默认 |
| `off`（PC HTTP 直连） | `https://yybadaccess.3g.qq.com/v1/chat/completions`，Beacon SDK 按请求上下文现签 uskey | PC（2026-11-24 实测 200） |
| `openclaw`（WS） | 手机会话域 WebSocket，凭据来自 `native/handshake.log` | 备选；凭据短命（≈15-20 分钟），失效重抓 |

模式选择：环境变量 `MARVIS_TRANSPORT=gateway|off|openclaw`，默认 `gateway`（自动探测本地 8088）。
旧变量 `MARVIS_WS_MODE` 兼容保留。网关地址 / 鉴权 / 超时分别用
`MARVIS_GATEWAY_URL` / `MARVIS_GATEWAY_KEY` / `MARVIS_GATEWAY_TIMEOUT_MS` 配置。
出票与配置资产放**稳定目录**（用户环境变量 `MARVIS_NATIVE_DIR`，建议
`C:\Users\<你的用户名>\.magpie-marvis-native`），在插件目录之外，`magpie plugin update` 清不掉 —— 跨更新免疫；详见 README-FINAL 第二节。

## 手机怎么用（Termux / PRoot / magpie 安卓壳）

手机端走 `gateway` 通道：登录 / 加号账号池由本地 Python 网关维护，插件用「免登录」占位账号出模型
（**不要**点 QQ / 微信登录 —— 手机壳只给旧包名打过补丁，final 版会卡在打不开浏览器）。
简要：① Termux 先 `pkg install python curl -y`，跑参考仓库 `yy158358/Marvis-proxy-public` 的 `sh run.sh start` 并加号登录；
② 插件目录通过 magpie 控制后台 `127.0.0.1:3430` → 插件 → 导入；
③ 复制 `plugin/gateway.example.json` 到 `~/.magpie-marvis-native/gateway.json` 开启网关模式
   （用 phone-kit 附件时直接 `sh phone-setup.sh` 会自动写这份配置）；
④ 加账号选「本地网关（手机推荐，免登录）」→ `magpie provider test`。
完整步骤见 [README-FINAL 第四节](./README-FINAL.md)。

## 历史

- 原版 `MYCF711/magpie-marvis`（HTTP-only）2026-11-18 起停更；
  2026-11-17 上游收紧 uskey 校验、2026-11-22 PC 端全局风控——HTTP 路线一度全灭。
- 本插件经历 0.2.x（现签修复）→ 0.3.x（openclaw WS 传输）→ 0.4.x（断网重连抓包、
  熔断器、中文首行护栏、AK/SK 休眠）→ 0.5.x（精简，HTTP 直连恢复后回归主链路）
  → 0.6.x（正名为纯 magpie 插件，新增本地网关传输，手机可通过 Termux / PRoot 使用）
  的完整演进，修复史见 [CHANGELOG](./CHANGELOG.md)。

## 帧协议参考（openclaw WS 模式）

- openclaw WS（手机会话域）：握手头 `sessionId` / `token` / `platform: mobile` / `role: operator`，
  `connect` 帧的 `auth` 必须带 `relaySessionId` / `relayToken`（0.4.1 定位）且**不带** accessToken（0.4.2 定位）；
  `chat.send` → `event: chat`（text 累积，`isAgentTextFinal` 终止）/ `event: agent`（phase end/error）。

以上协议细节均为 2026-11-21～24 真机抓包实测值，上游随时可能改。

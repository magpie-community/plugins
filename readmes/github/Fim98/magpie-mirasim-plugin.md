# magpie-mirasim-plugin

[Mirasim](https://mirasim.ai) 的订阅，作为 OpenCode / [magpie](https://github.com/yetone/magpie) 的插件使用，独立于 magpie 本体。

仓库：<https://github.com/Fim98/magpie-mirasim-plugin>

- 浏览器登录（GitHub / Google），或邮箱验证码登录；账号开了两步验证时，验证码登录会打开确认页并轮询到确认完成
- 请求按官方桌面客户端（0.0.797）的方式签名（Ed25519 设备密钥 + X25519/ChaCha20-Poly1305 密封），每次推理带上 `x-mirasim-call` 与 `x-mirasim-turn`（并由 turn 派生 `traceparent`），`x-mirasim-client` 报当前客户端版本
- 模型列表与 reasoning 档位来自账号自己的 roster：roster 带 `served` 时就是这份名单（与桌面端一致，含 Grok、MiMo），没有时才退回 catalog 并按家族前缀收窄；下架的模型不列
- 用量（额度窗口）来自 relay 的 limits 路由；额度本身（客户端「个人额度」那张卡的数字、明细与到期）来自 `/v1/credits/activity`，两者一起画一张卡：`30d ███ 83.97 / 85.91 · 98% left`。limits 给一个世纪以后的重置时间时（relay 从 2026-10-23 起这么回）只保留用量，不再显示这个倒计时；limits 一条窗口都没有时，只用额度账本画卡
- Claude/DeepSeek/GLM/Kimi/Gemini 走 Anthropic Messages，GPT 走 OpenAI Responses
- 所有 relay 模型标注为支持图片输入
- Kimi 用中继自己的 id `kimi-k3`；旧写法 `kimi-code/k3` 仍可用，转发时改写回 `kimi-k3`
- DeepSeek 用中继自己的 id `deepseek-flash`；另发布 `deepseek-v4.1-flash`（与 aliyun 等同名，便于 magpie 路由分组），转发时改写回 `deepseek-flash`
- 中继只把 `/v1/messages` 服务给 Mirasim 客户端和 Claude Code：调用方的 user-agent 是别的（node、Bun、编辑器自己的）时，插件按桌面端自己的 fetch 署名 `mirasim-host/<clientVersion> (Darwin|Windows|Linux; arch)`；Claude Code 的调用保留它自己的 UA
- 中继按**网络区域**提供服务：直连被拒（429 `shared_quota_unavailable`）时，给 magpie 或这个 provider 配一个能到中继的代理即可（Mirasim 桌面客户端自己就是这么做的）；插件取不到 catalog 时会沿用账号记录里的上一份模型列表，不会把 provider 清空
- 中继以 503 明确表示「排队未开始」时自动等待后重发（间隔取 `Retry-After`，1–60 秒，缺省 5 秒，单次最多约 4 分钟，调用方取消即停止）；中继以 401 拒绝旧 ticket 时换新 ticket 重发一次

## 安装

```
# 本机已有仓库
git clone git@github.com:Fim98/magpie-mirasim-plugin.git ~/Documents/magpie-mirasim-plugin
magpie plugin add ~/Documents/magpie-mirasim-plugin
```

本地路径安装的插件不会自动更新；改了 `index.mjs` 后在 magpie 里重启插件（或重启 magpie）即可生效，`git pull` 后同理。也可以发布成 npm 包后 `magpie plugin add <包名>`。

## 测试

```
node test.mjs    # 与 magpie Go 实现的字节级交叉验证（cross-check.json 里的向量）
node e2e.mjs     # 假 Mirasim 服务器驱动的端到端测试，535 项
```

（本机装了 bun 时用 `bun` 也行；两个脚本只用标准 Web API 与 node: 内置模块。`e2e.mjs` 会用 `MIRASIM_NO_OPEN=1` 关掉两步验证的确认页弹出，免得测试打开浏览器。）

`cross-check.json` 的向量由 magpie 源码仓库里 `internal/mirasim/cross_check_test.go` 生成（`go test ./internal/mirasim -run TestCross`，可用 `MIRASIM_CROSS_FILE` 指回本目录）；协议无改动时无需重新生成。

与上游参考仓库（`~/Documents/cpa-plugin-mirasim`）的同步记录见 [UPSTREAM.md](UPSTREAM.md)：哪次同步到哪个 commit、哪些改动适用、哪些刻意跳过，都在那里。

协议移植自 magpie 的 `internal/mirasim`（其又移植自 CLIProxyAPI 的 mirasim 支持与 Mirasim 桌面客户端）。

## 许可

[MIT License](LICENSE)。

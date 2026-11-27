# zfr-magpie

<img src="./assets/icon.png" width="112" align="right" alt="zfr-magpie" />

把 [zfr-core](https://github.com/wayne091106-hash/zfr-core) 的**多出口 IP 轮换 / OpenCode v2.1.3 协议伪装 / 冷却式故障切换**以纯 JS/TS 移植成 **Magpie provider 插件**。

**自包含：无 Rust、无 CLI、无 sidecar、不需要 `zfr serve`。** 装进 Magpie 就能用。当前版本 `0.2.0`。

## 安装

```sh
magpie plugin add github:ksmord/zfr-magpie
```

然后在 Magpie 里添加 **ZFR Core (multi-egress)** provider。它的登录是 keyless 的：填任意占位值（例如 `public`）创建账号即可，不会向上游发送这个值。

模型是内置的 30 个（`beam-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`mimo-v2.6-flash-free`、`gpt-5-mini`、`gemini-2.5-pro` 等），启动时不需要访问 `/v1/models`，也不需要额外服务。其中 `gpt-5-mini` 与 `gemini-2.5-pro` 走 OneSearch（begamob）lane，裸 id 和 `onesearch/` 前缀都指向它。

## 能力

| 能力 | 说明 |
|---|---|
| 多出口 | `EgressPool` 支持 `direct`、IPv4/IPv6、SOCKS5、HTTP CONNECT、relay；按会话种子选出口，失败进入冷却 |
| 协议伪装 | OpenCode v2.1.3 指纹：`ses_` 会话 ID、gateway headers、v2 body 编码 |
| 故障切换 | 出口级冷却 + 指数退避；模型级 failover 可关闭 |
| 流式 | SSE 逐行重写（工具名还原、占位调用丢弃），也支持非流式聚合 |
| OneSearch | begamob lane 自带 envelope：自有 HS256 JWT、`user-header`、`TOOL_CALL:` 标记双向翻译，输出仍是标准 OpenAI chunk。限流按 APK 原样重试：5 次、1500ms×2ⁿ、64KiB peek，且**正文**是限流话术的 200 也会重试 |
| 计费 | 全部按 0 成本登记，适合免费模型 |

## 配置

插件选项（Magpie 的插件选项面板，或 `plugins.json` 里的 `options`）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `egress` | `["direct"]` | 出口列表，例如 `["direct","socks5://127.0.0.1:1080"]` |
| `allowModelFailover` | `true` | 请求的模型不可用时是否按 catalog 的等价模型链切换 |
| `maxExitRetries` | `3` | 每次请求最多尝试的出口数 |
| `baseOverrides` | 空 | 覆盖上游 base URL（按 lane 或模型），一般不用 |

## 架构

```
index.mjs          Magpie 入口（仅 re-export，保持宿主契约稳定）
src/plugin.mjs     插件 hooks：config / auth / fetch
src/router.mjs     请求执行、lane 分发、模型 failover
src/egress.mjs     出口候选、冷却、退避、revive
src/transport.mjs  出口 spec 解析、sender、relay 信封
src/netutil.mjs    socket、HTTP CONNECT / SOCKS5、Response 适配
src/fingerprint.mjs ses_ 会话、gateway headers、body 编码
src/catalog.mjs    内置模型表、等价映射、failover 链
src/sse.mjs        SSE 重写与聚合
src/onesearch.mjs  OneSearch（begamob）lane：JWT、user-header、envelope、TOOL_CALL 翻译
src/constants.mjs  UA、base URL、lane、协议常量
```

## 验证

2026-11-11 在真实 Magpie 宿主（Bun 插件宿主，非 mock）验证：

- 内置模型全部注册，provider 可用（当时基线 28 个；现为 31 行 / 30 个宿主条目，多出 `gpt-5-mini`、`gemini-2.5-pro` 两条 OneSearch 行）
- `zfr/deepseek-v4.1-flash-free` 真实请求 200
- 同一段 2350 token 前缀连续两次：第二次 `cached_tokens = 2048`（命中 87%）
- 全程没有启动 `zfr serve` 或任何外部进程

### 本地自检

```sh
npm run check    # 每个源码/测试文件 node --check
npm test         # test:unit（纯函数）+ test:host（宿主侧 30 条目），Node 即可
npm run test:bun # Bun 才有：test-transport（loopback 出口）+ test-integration（真打 mock 上游）
npm run upstream # 比对上游 zfr-core 的新 commit
```

2026-11-27 在真实上游（`chat-ai.begamob.com`）跑通 OneSearch lane：

- `gpt-5-mini`、`gemini-2.5-pro` 两条都返回 `201` + SSE，聚合后是标准 OpenAI chunk
- 一次完整请求 1953ms，`finish_reason` / `usage` 齐全
- 踩到的坑：上游的 `messages[].content` **必须是 part 数组**（`[{"type":"text","text":"…"}]`）。传裸字符串会让服务端 `undefined.map` 崩掉并回 `500 Internal server error`；空 body 或 `{}` 反而回 `201` 带 `data:{"error":...}`，所以别把 500 误判成鉴权问题——把 JWT 签名改坏会得到 `401 invalid api key`，两者不同

注意：OpenCode / Kilo 的**免费额度**是上游限制。额度用尽会出现 429（`Retry-After` 约 39 分钟），这和插件缓存无关；等额度恢复或使用自己的账号即可。

### 推送（github.com 不可达时）

有些网络能连 `api.github.com`、连不上 `github.com`，`git push` 会超时。`scripts/ghpush.mjs` 走 Git Data API 完成同样的原子提交：

```sh
GITHUB_TOKEN=... node scripts/ghpush.mjs \
  ksmord zfr-magpie main . "commit message" README.md src/onesearch.mjs --noop
```

去掉 `--noop` 才真正提交；`--delete <path>` 删除仓库内文件。文件内容从磁盘读，二进制按 base64 上传，内容没变时直接返回 `changed false` 不产生空提交。

## 上游同步

`.upstream.json` 钉住 zfr-core 的基线 commit；GitHub Actions 每天检查上游更新并在有变化时建 issue。上游改了协议字段时，优先看 `src/constants.mjs` 与 `src/fingerprint.mjs`。

## License

MIT。上游 zfr-core 的作者与许可见 `NOTICE`。
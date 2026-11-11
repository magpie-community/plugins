# zfr-magpie

<img src="./assets/icon.png" width="112" align="right" alt="zfr-magpie" />

把 [zfr-core](https://github.com/wayne091106-hash/zfr-core) 的**多出口 IP 轮换 / OpenCode v2.1.3 协议伪装 / 冷却式故障切换**以纯 JS/TS 移植成 **Magpie provider 插件**。

**自包含：无 Rust、无 CLI、无 sidecar、不需要 `zfr serve`。** 装进 Magpie 就能用。当前版本 `0.0.1`。

## 安装

```sh
magpie plugin add github:ksmord/zfr-magpie
```

然后在 Magpie 里添加 **ZFR Core (multi-egress)** provider。它的登录是 keyless 的：填任意占位值（例如 `public`）创建账号即可，不会向上游发送这个值。

模型是内置的 28 个（`beam-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`mimo-v2.6-flash-free` 等），启动时不需要访问 `/v1/models`，也不需要额外服务。

## 能力

| 能力 | 说明 |
|---|---|
| 多出口 | `EgressPool` 支持 `direct`、IPv4/IPv6、SOCKS5、HTTP CONNECT、relay；按会话种子选出口，失败进入冷却 |
| 协议伪装 | OpenCode v2.1.3 指纹：`ses_` 会话 ID、gateway headers、v2 body 编码 |
| 故障切换 | 出口级冷却 + 指数退避；模型级 failover 可关闭 |
| 流式 | SSE 逐行重写（工具名还原、占位调用丢弃），也支持非流式聚合 |
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
src/constants.mjs  UA、base URL、lane、协议常量
```

## 验证

2026-11-11 在真实 Magpie 宿主（Bun 插件宿主，非 mock）验证：

- 28 个内置模型全部注册，provider 可用
- `zfr/deepseek-v4.1-flash-free` 真实请求 200
- 同一段 2350 token 前缀连续两次：第二次 `cached_tokens = 2048`（命中 87%）
- 全程没有启动 `zfr serve` 或任何外部进程

注意：OpenCode / Kilo 的**免费额度**是上游限制。额度用尽会出现 429（`Retry-After` 约 39 分钟），这和插件缓存无关；等额度恢复或使用自己的账号即可。

## 上游同步

`.upstream.json` 钉住 zfr-core 的基线 commit；GitHub Actions 每天检查上游更新并在有变化时建 issue。上游改了协议字段时，优先看 `src/constants.mjs` 与 `src/fingerprint.mjs`。

## License

MIT。上游 zfr-core 的作者与许可见 `NOTICE`。

# zfr-magpie

<img src="./assets/icon.png" width="112" align="right" alt="zfr-magpie" />

把 [zfr-core](https://github.com/wayne091106-hash/zfr-core) 的**多出口 IP 轮换 / OpenCode v2.1.3 协议伪装 / 冷却式故障切换**以纯 JS/TS 移植成 **Magpie provider 插件**。

**自包含：无 Rust、无 CLI、无 sidecar、不需要 `zfr serve`。** 装进 Magpie 就能用。当前版本 `0.2.2`。

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
src/upstream/      【生成层】上游 catalog.rs 的模型行，脚本写入，勿手改
src/local/         【本地层】OneSearch 行与裸 id 表，同步器永不写入
src/patches/       【补丁层】对生成层的手工偏差
scripts/lib/       extract（抽 Rust 语义）/ differ（三方裁决）/ emit（渲染）/ guard（写入守卫）
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
npm test         # test:unit（纯函数）+ test:host（宿主侧 30 条目）+ test:upstream-sync（同步机制离线自测），Node 即可
npm run test:bun # Bun 才有：test-transport（loopback 出口）+ test-integration（真打 mock 上游）
npm run upstream # 比对上游 zfr-core 的新 commit
npm run parity   # 门禁：ledger / 生成层指纹 / MANIFEST 对账 / 串层 / 运行时合成
npm run sync:dry # 走完整同步流程但一个字节都不写
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

上游是 [`wayne091106-hash/zfr-core`](https://github.com/wayne091106-hash/zfr-core)（Rust）。本项目是它的纯 JS/TS 移植，两边**没有共享文件** —— `git merge` 拿不到 base，只会把 `.rs` 原样堆进来。所以同步做在语义层，不是行级。

### 三层分区

```
src/upstream/     【生成层】上游 catalog.rs 的模型行，脚本写入，勿手改
src/local/        【本地层】OneSearch lane 等自有功能，同步器物理上不写
src/patches/      【补丁层】我们对生成层的手工偏差，一处一文件
upstream-ledger.json   【裁决表】每个语义键归谁
```

`src/catalog.mjs` 在运行时把生成层与本地层拼起来，所以上游加模型只动生成层，我们的行永远在本地层——这就是「跟随上游但不被覆盖」的落点。

### 裁决表

`upstream-ledger.json` 里每条语义键有四种归属：

| owner | 同步器行为 |
|---|---|
| `adopt-upstream` | 上游变了就改写生成层，跑门禁 |
| `keep-ours` | 上游变了只写进 PR 描述，一个字节都不动 |
| `keep-ours-plus-upstream` | 上游新增项合入，`preserve[]` 里锁死的尾部不动 |
| `local-only` | 连读都不读，整体剔出上游语义面 |

### 四道锁

1. **分区锁** —— `scripts/lib/guard.mjs` 的 `assertWritable()` 只放行 `src/upstream/` 与状态文件；`src/local/`、`src/patches/` 是硬拒绝路径，抛 `GuardViolation` 就退出。
2. **裁决锁** —— `diff()` 里 `keep-ours` / `local-only` 走 `continue`，物理上不产生写入决定。
3. **指纹锁** —— 生成层自带 `GENERATED_FINGERPRINT`（行数 + 行 id 序列，必须写字面量）。手改任一字段，`verify-parity` 立刻报红。
4. **串层锁** —— 门禁反查：本地行出现在生成层、生成层缺上游行、生成层多出上游没有的行，都算违规。

### 自动流程

`.github/workflows/upstream-watch.yml` 每天 `17 3 * * *`：

1. `check-upstream.mjs` 比对 `.upstream.json` 的 sha，无变化直接结束
2. `upstream-sync.mjs` 拉上游 tarball（走 `api.github.com`，与 `ghpush.mjs` 同一条通路）→ `extract()` 抽成语义单元 → `diff()` 三方裁决 → 只渲染生成层
3. 跑门禁：`npm run check && npm test && node scripts/verify-parity.mjs`
4. 全绿 → 开 PR；有 `conflict` / `pending` → 打 `needs-human` 并建工单

**advisory 项不进基线**：`constants`、`resolve_model`、`failover_chain` 这些是手工维护的移植实现，形状与 Rust 不同，机器改写只会毁掉它们。它们上游变过会写进 `.sync-pending.json`，基线不推进，门禁盯着——否则这次变更会被永久标成「已同步」，以后再也检测不到。

### 手工命令

```sh
npm run upstream            # 只看上游有没有新 commit
npm run sync:dry            # 全流程但一个字节都不写
npm run sync                # 真写（受 guard 约束）
npm run parity              # 门禁：ledger / 指纹 / 对账 / 串层 / 运行时合成
npm run gate                # check + test + parity
node scripts/upstream-sync.mjs --offline path/to/catalog.rs   # 网络受限时直接喂源码
```

需要停一轮同步时，放一个 `.sync-freeze.json`（内容 `{"reason":"..."}`），同步器整轮拒绝写。

### 配 SYNC_PAT

`GITHUB_TOKEN` 开的 PR 不会触发其它 workflow（GitHub 防递归），CI 不跟着跑。建一个 fine-grained PAT，只给本仓库 `Contents: RW` + `Pull requests: RW`，存成 `secrets.SYNC_PAT`。没配也能用，只是 PR 上没有 CI 结果。

## License

MIT。上游 zfr-core 的作者与许可见 `NOTICE`。
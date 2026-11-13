# poxian

![version](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/ksmord/poxian/main/package.json&query=$.version&label=version&color=blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/magpie-middleware-7A1512)

**magpie 网关中间件：把系统提示词写进每一个经过网关的请求。一个注入点，覆盖所有 Agent，客户端零改动。**

上游 fork 自 [YaoGuaiLi/hangong](https://github.com/YaoGuaiLi/hangong)（MIT）· 当前版本 `0.2.5`

---

## 安装

在 magpie 里搜索 `poxian`，点安装。完事。

- 装完即对网关生效，不用改任何 Agent / 客户端的配置。
- 卡片位置：插件 → 已安装 → `poxian`，类型显示为 **中间件**。
- 改配置文件后 1 秒内热重载，不必重启 magpie。

核对：

```bash
magpie plugin list      # poxian · gateway middleware onRequest · on
```

## 它做什么

任意 Agent 的请求经 magpie 转发时，中间件把系统提示词写进**该协议自己的系统提示词位置**：

| Agent API（`ctx.protocol`） | 落点 |
|---|---|
| `anthropic`（Claude Code、Claude Desktop…） | `body.system`（字符串或分块数组） |
| `chat`（OpenAI 兼容：Codex、OpenCode、ZCode、DSH、Kimi…） | 首条 `system`/`developer` 消息，没有就插一条 |
| `responses`（OpenAI Responses API） | `body.instructions` |
| `gemini`（Gemini CLI…） | `systemInstruction` / `system_instruction` |

默认 **`override: true` + `override_mode: "replace"`**：请求自带原生系统提示词时，整段替换成你的。

这条默认值来自实机 A/B，不是偏好。干净模型上四组对照，只有「system 位只留注入」能改写身份；prepend / append 拼接都仍按原生人格回答——原生 system 还在时，「前置 = 优先级更高」这条直觉不成立。代价是 `replace` 会丢掉 Agent 自己的工具调用规范；要保留原生 system 就显式设 `override_mode: "merge"`。完整实验记录见 [docs/design-notes.md](docs/design-notes.md)。

## 实现原理

中间件是网关内的第一跳：只改系统提示词字段，路由、账号池、用量统计原样通过。

一次请求的路径：

1. **挂载** — `poxian.hooks.mjs` 导出 `onRequest`，magpie 按 `package.json` 的 `magpie.hooks` 加载，每个请求调一次。
2. **取件** — 读原始 body，`gatewayTimeoutMs`（默认 3000 ms）内拿不到就原样放行。
3. **过滤** — `enabled` 总闸 → `agents_off` → `agents` 白名单 → `models` 前缀 → `skip_stream`，任一条命中即返回原请求。
4. **幂等** — 注入块首行带标记 `<!--poxian-->`；同一 body 过两次不会叠成两份。
5. **握手轻路由** — 末条用户消息恰好是激活词时走短回复，不必为一句「自检」灌满整份提示词。
6. **注入** — 按 `ctx.protocol` 选适配器，找到该协议的系统提示词位，写入（replace 或 merge + position）。
7. **回写与观测** — 只替换目标字段，其余引用原对象；每请求写一行 JSONL（`log`，默认开）。

```
Agent ──POST──▶ magpie 网关 ──▶ onRequest(body, ctx)
                                   │ 过滤 → 幂等 → 清洗 → 握手/选版本
                                   │ adapter(protocol) 定位 system 位
                                   ▼
                             body' ──▶ 路由 / 账号池 ──▶ 供应商
```

分层的原因：`src/core.mjs` 是纯函数，不 import 任何 `node:fs`，所以同步中间件壳也能复用、单测不需要起网关；加一个协议 = 在 `src/adapters/` 加一个文件并登记，核心代码不动。热路径全是字符串/数组操作，实测约 **1 ms/次**，成本大头是注入体积的 prefill，不是中间件本身（数据见 design-notes）。

## 框架结构来源（上游）

骨架不是自创的，是 magpie 插件契约 + 上游 hangong 的目录结构：

| 层 | 来源 | 本仓库做了什么 |
|---|---|---|
| 加载契约 | magpie 官方插件规范：`package.json` 的 `magpie.hooks` / `magpie.options` / `magpie.icon`，`onRequest(body, ctx)` 签名 | 沿用，未改签名 |
| 目录骨架 | 上游 hangong v1.3.0：`hooks.mjs` 薄壳 + `middleware.js` 兼容壳 + `src/` 核心 + `adapters/` 协议层 | 沿用分层，重写核心链路 |
| 协议适配 | 上游按协议定位 system 位的思路 | 四协议补齐（上游只处理 chat/responses），chat 不再假定 system 在第 0 位 |
| 控制台页面 | 上游页面 + magpie 的 options get/set bridge | 表单改成 `SCHEMA` 声明式，加选项只改一处；脏检测按语义比较 |
| 构建链 | 上游两个脚本各写一个产物 | 合成 `scripts/build-prompts.mjs`，`prompts/*.md` 为唯一源，版本元数据单点 |
| 提示词 | 社区提示词血统（寒霜 v3 → v5 / v5.2 净化版） | 全部落成独立 `.md` 源文件，构建成 `poxian-prompt.js` |

上游署名保留在 [LICENSE](LICENSE) 与 `package.json`，`prompts/` 里的文本可整体替换成你自己的——中间件与提示词内容无关。

## 目录结构

```
poxian/
├── poxian.hooks.mjs      # 入口：异步钩子，有 fs，空转/超时一律放行
├── poxian.middleware.js  # 兼容壳：同步中间件，无 fs，已弃用
├── src/
│   ├── core.mjs          # 纯逻辑：过滤 → 幂等 → 清洗 → 握手 → 注入
│   ├── options.mjs       # 选项归一 + ~ $VAR %VAR% 路径展开
│   ├── payload.mjs       # 外部提示词读取、BOM/UTF-16、frontmatter、mtime 缓存
│   ├── filter.mjs        # 报文清洗（纯函数）
│   ├── observe.mjs       # 每请求一行 JSONL
│   └── adapters/         # anthropic · chat · responses · gemini · index
├── prompts/              # 提示词源文件，唯一真相
├── poxian-prompt.js      # 构建产物，勿手改
├── page/                 # 应用内控制台（app.js / versions.js 为产物）
├── scripts/              # build-prompts · check-page · publish-release · probe-*
├── cases.json            # 声明式测试用例
└── test/                 # 单元 + 全链路
```

## 配置

应用内：插件 → 已安装 → `poxian` → 选项；或命令行：

```bash
magpie plugin options poxian '{"override":true,"override_mode":"replace"}'
```

常用几项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总闸，`false` 时什么都不做 |
| `override_mode` | `"replace"` | `replace` 整段替换原生 system；`merge` 保留并拼接 |
| `prompt` | `"v5"` | 内置版本回退：`v52` / `v5` / `v4` / `v3` 及各人格版 |
| `prompt_path` | 空 | 外部 `.md` 路径，每请求 stat，改完即生效，优先于内置版本 |
| `agents` / `agents_off` | 空 | 只对这些 Agent 生效 / 排除这些 Agent |
| `models` | 空 | 只对这些模型名前缀生效 |
| `handshake` | `true` | 激活词轻路由 |
| `cache` | `false` | Anthropic `cache_control` 断点，仅真 Anthropic 端点建议开 |

全部选项（含 `dry_run`、报文清洗、日志轮转、载荷上限等）见 [docs/options.md](docs/options.md)。

## 验证注入生效

用提示词规定的激活词打一拍——裸模型不可能知道握手行：

```bash
curl -s http://127.0.0.1:3425/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<任意模型>","messages":[{"role":"user","content":"寒霜"}],"max_tokens":50}'
```

返回握手行即说明提示词已进了请求。卡片上有实时遥测（`onRequest · 调用 N 次，约 1 ms/次`）。

## 版本与发布

版本号有四处信号，必须同步：`package.json` → `registry-entry.json` → `page/app.js` 的 `VERSION` → `page/index.html` 的 `?v=` 缓存戳（`npm run check` 会校验前两处是否对齐）。

**发布纪律：改版本就必须建 GitHub Release，不允许只打 tag、只推代码。** 市场按 `package.json` 的 `version` 判断是否重新拉取，用户按 Releases 判断有没有更新——Releases 落后等于对外宣称项目停在旧版。

```bash
npm run release         # 读 package.json 版本 + CHANGELOG 该版本段落 → 建 Release
```

## 测试

```bash
node --test test/        # 单元 + 全链路
node poxian.test.mjs     # 声明式用例 cases.json
npm run check            # 页面 SCHEMA ↔ 中间件选项 ↔ HTML 元素一致性
```

## License

MIT，见 [LICENSE](LICENSE)。上游：[YaoGuaiLi/hangong](https://github.com/YaoGuaiLi/hangong)。内置提示词为社区提示词血统的净化再分发，可自由替换。

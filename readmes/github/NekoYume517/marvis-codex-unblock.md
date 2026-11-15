# marvis-codex-unblock

一个 **magpie 网关中间件**：让 Codex 能正常使用腾讯 Marvis。

上游 `yybadaccess.3g.qq.com` 会对「Codex 官方系统提示词」做**指纹拦截**，直接回：

```json
{"code":4100406,"msg":"非法请求"}      // HTTP 403
```

同一个账号发无关 prompt 是 200，所以不是账号、不是配额、不是并发——是**内容**。
这个中间件只对 `marvis` 的请求，把系统提示词里那两句身份句换一个说法（`Codex` → `agent`），
请求的其它内容一个字节都不动。

## 安装

```bash
# 从 GitHub
magpie plugin add github:NekoYume517/marvis-codex-unblock

# 或者本地目录
magpie plugin add D:\code\marvis-codex-unblock
```

装完在 **设置 → 插件** 里能看到：

```
marvis-codex-unblock  on
  gateway middleware  onProvider
```

## 装完要配置吗？不用

规则是**内置**的（写死在中间件里），装完即生效，没有选项、没有开关、不用改 `plugins.json`。
我这边实测过：`magpie plugin add github:NekoYume517/marvis-codex-unblock` → 直接拿一条 64,782 字的
Codex prompt 过网关，`403` 变 `200`，中间没有任何配置步骤。

但下面这些**前提**得有，缺一个都不生效：

| 前提 | 怎么确认 |
|---|---|
| 装了 `magpie-marvis` 且账号已登录 | `magpie plugin` 里那行显示 `signed in` |
| 请求确实路由到 `marvis` | 中间件只在 `ctx.provider.id` 含 `marvis` 时改写；用别的 provider 不关它的事 |
| magpie 版本支持中间件（`magpie.middleware`） | `magpie plugin` 里能看到 `gateway middleware  onProvider` 这行 |
| Codex 的系统提示词是**已知的那两句** | 见下 |

**最后一条最容易踩**：规则只覆盖当前这两个版本的身份句。如果对方用的 Codex 版本导入了
别的开场白，那就还是会 403 —— 这时跑一次二分工具，把新句子加成一条规则：

```bash
node marvis-fingerprint-bisect.mjs --list    # 看 403 那条 prompt 的首句长什么样
node marvis-fingerprint-bisect.mjs           # 自动二分出最小触发句 + 可用改写
```

关掉 / 卸掉：

```bash
magpie plugin off marvis-codex-unblock
magpie plugin rm  marvis-codex-unblock
```

确认它在工作：magpie 的日志里会出现

```
[marvis-codex-unblock] 改写 1 处 Codex 身份句（marvis）
```

## 怎么定位到这两句的（二分过程）

把 `gateway-conversations` 里 403 那条请求的 system prompt 拿出来，
用 marvis 插件自己的 loader（固定账号，绕开 magpie 路由）直连上游复现，然后对半切：

| 步骤 | 长度 | 结果 |
|---|---|---|
| 完整 prompt | 64,782 | ✗ 403 |
| 前半 | 32,391 | ✗ 403 |
| 后半 | 32,391 | ✓ 200 |
| …反复取半… | | |
| 缩到首句 | 76 | ✗ 403 |
| `You are a coding agent.` | 23 | ✓ 200 |

结论是**首句的身份句**触发，而且用的是「精确句子匹配」：

```
✗ 403   You are a coding agent running in the agent CLI, a terminal-based coding assistant.
✓ 200   You are a coding agent running in Codex CLI, …          （当时去掉 the 就过）
✓ 200   You are a coding agent running in the C0dex CLI, …      （改一个字母就过）
✓ 200   You are a coding agent running in this CLI, …           （换个词就过）
✓ 200   无关填充 64940 字符                                      （跟长度无关）
```

## ⚠️ 上游的规则会翻转

同一个句子在几分钟内两个方向都出现过（2026-11-15 实测）：

| 时间 | 官方原句 | 结果 |
|---|---|---|
| 18:31 | `…running in Codex CLI`（无 the） | ✗ 403；**加 the → 200** |
| 18:45 | `…running in the Codex CLI`（有 the） | ✗ 403；**去 the → 200** |
| 18:45 | `You are an agent built on GPT-6.` | ✓ 200（自己放行了） |

**所以不要贴着当前规则去「加 the / 换 built」**——上一版就是这么失效的。
这个中间件改成统一把身份句里的 `Codex` 换成 `agent`：结果永远不等于官方原文，两个方向都躲得开。

## 规则

```js
// ① 老版 Codex CLI 身份句
/You are a coding agent (?:running|working) in (?:the )?Codex CLI/g
  → "You are a coding agent running in the agent CLI"

// ② 新版（GPT-5/6 系）
/You are an agent, an agent (?:built|based) on (GPT-[0-9][\w.]*)/g
  → "You are an agent built on $1"
```

只改身份句。实测把全文 26 处 `Codex` 全换成 `agent` 也能过，
但那样会改到工具名和指令，没必要。

## magpie 的三个运行时（为什么"UI 点一下"做不到）

magpie 里跑 JS 的地方有三处，能力完全不同：

| 运行时 | 跑什么 | 有 fs / 网络 | 能打补丁？ |
|---|---|---|---|
| **Bun 插件宿主** | 插件 `main`、`config`/`auth`/`provider` 钩子、`magpie.hooks`（`onRequest`） | ✅ 有 | **能** |
| **网关进程（moejs）** | 网关中间件 `*.middleware.js` | ❌ 无（文档：没有定时器、没有 fetch、没有 Node API） | 只能改字符串 |
| **插件页面（iframe）** | 页面 HTML/JS | ❌ 沙箱，`connect-src 'none'` | 不能 |

所以「在插件页面点一下按钮就打补丁」做不成 —— 页面里既没有 fs 也不能 exec。
能做的是把补丁放到 **Bun 侧自动执行**，而且比点按钮更省事：**零点击 + 自愈**。

本仓库就是这么做的：`marvis-patch.hooks.mjs` 是 `magpie.hooks`，每个 agent 请求跑一次，
幂等地检查并打补丁。magpie 更新 `magpie-marvis` 把补丁冲掉后，**下一条 agent 请求就自动补回来**。

实测日志：

```
plugin: [marvis-patch] 已给 magpie-marvis 打上 Codex 指纹改写补丁（…\loader.mjs）——重启一次插件宿主生效
```

> 注意：补丁写的是 marvis 插件的源码文件，**要等插件宿主重新加载才生效**
> （`magpie plugin off/on magpie-marvis@latest`，或重启 magpie）。

**这一步很容易漏**：补丁写盘了、但宿主没重载，内存里跑的还是旧 loader，你会看到 403 继续出现。
实测踩过：19:17 补丁写盘，19:18–19:19 仍 403（宿主还是旧代码），19:20 重载宿主后立刻全 200。

一键做这两步（Windows）：

```
apply-patch.cmd            # 打补丁 + 重载宿主
apply-patch.cmd --check    # 只看状态（不重载）
apply-patch.cmd --revert   # 回滚 + 重载
```

或者手动：

```bash
node patch-magpie-marvis.mjs
magpie plugin off magpie-marvis@latest && magpie plugin on magpie-marvis@latest
```

如果你的 magpie 版本没有 `magpie.hooks`，就用命令行脚本手动打，效果一样。

## 预测 / 自动标题仍然 403？（补丁管的正是这个）

中间的对话正常了，但 magpie 的两类**自己的**请求还是会 403：

| routing 里 `kind` | 中文 | 会不会经过本中间件 |
|---|---|---|
| （空） | 正常对话 | ✅ 会 |
| `memory_consolidation` | 记忆整理 | ✅ 会（是 agent 请求） |
| `thread_title` | 自动起标题 | ❌ **不会** |
| `composer_predictions` | 输入预测 | ❌ **不会** |

magpie 文档原话：

> magpie 自己的请求（会话标题、路由分类器，以及它为 agent 的请求做的网页搜索和图片描述）**不经过中间件**。

这两类请求**跟着会话的供应商走**（routing 日志里 `affinity` 指向 marvis），又带对话上下文 → 带 Codex 指纹 → 403。
中间件救不了，只能补在 **marvis 插件自己的 loader** 里 —— 它能看到所有经过 marvis 的请求，包括这些。

```bash
node patch-magpie-marvis.mjs --check    # 看有没有打过
node patch-magpie-marvis.mjs            # 打补丁（幂等；自动备份 loader.mjs.bak）
node patch-magpie-marvis.mjs --revert   # 回滚
```

打完后重启一次插件宿主：

```bash
magpie plugin off magpie-marvis@latest
magpie plugin on  magpie-marvis@latest
```

> ⚠️ **magpie 更新这个插件时补丁会被覆盖**，更新后重跑一次 `node patch-magpie-marvis.mjs` 即可。
> 真正的根治是给 [MYCF711/magpie-marvis](https://github.com/MYCF711/magpie-marvis) 提 PR，
> 在那个 loader 里内置这个改写。

## 侧请求改道（标题 / 描述 / 输入预测）

Codex 除了对话，还会发几类隐藏请求：`thread_title`（起标题）、`thread_description`（描述）、
`composer_predictions`（输入预测）。它们**默认跟随会话**，也就是跟着对话走同一个供应商。

页面上有个「侧请求改道」区，可以：

- **不改道**（默认）：跟随会话，由上面的改写兜住
- **改道到指定模型**：页面会读 `providers:list` 列出当前所有供应商与模型，选一个（也能手填 `provider/model`）

落地方式：页面只写插件选项，宿主侧的 `index.mjs` 把它写成 magpie 的全局设置
`codexTitles` / `codexDescriptions` / `codexPredictions`（源码 `internal/settings/settings.go`）。

> ⚠️ 三个坑，都踩过了：
> 1. **settings.json 会被覆盖**：宿主刚启动时 magpie 会把自己的内存状态写回这个文件，
>    所以写了立刻消失。现在改成**每 5 秒重写一次、最多 6 次**，写对了就停（实测 t+3s 被覆盖、t+5s 补回后稳定）。
> 2. **页面读不到 settings.json**（沙箱），状态区只能显示插件自己记的值。
> 3. 选项值必须是 `provider/model` 形式，否则会被忽略并记一条日志（`[marvis-side-route]`）。

## 上游又变了怎么办

同目录带了个二分工具，上游改规则时一条命令重跑：

```bash
node marvis-fingerprint-bisect.mjs --list     # 列出最近的 marvis 403 及各自的 prompt 首句
node marvis-fingerprint-bisect.mjs            # 自动抓最新 403 → 复现 → 二分 → 给出可用改写
node marvis-fingerprint-bisect.mjs --account "微信·xxx"
```

输出会直接给你一条能粘进 `RULES` 的正则。

前置条件：
- magpie 设置里打开「记录会话详情」（否则没有 403 的 prompt 可抓）
- `magpie-marvis` 插件已安装且账号已登录（脚本借它的 loader 签名）

## 局限

- **只对 `marvis` 生效**：`ctx.provider.id` 不含 `marvis` 就原样返回。
- **magpie 自己的辅助请求（会话标题、路由分类器等）不过中间件**，如果它们也带 Codex 指纹，仍可能 403。
- 中间件跑在 magpie 的网关进程里（moejs），只能导入插件目录内的相对文件，没有 Node API。
- 上游随时可能改规则；这不是"永久绕过"，是"跟着改"。

## 许可

MIT

# magpie 插件模板

一个可直接克隆的 magpie / OpenCode 供应商插件模板 —— **九项全实现，一项不缺**。

> 克隆这个仓库，改三处配置，实现五个 TODO，就是一个标准 magpie 插件。
> 然后**把它发出去** —— 那是另一套动作，见 [UPDATING.md](./UPDATING.md)：
> **分支 = 测试版通道**（`owner/repo#feat-x`），**`main` = 稳定版通道**（所有人）。
> 测试版走分支，稳定版才进 `main` —— 这样分支上怎么折腾都不会把正在用的人炸了。

> **生成新仓库的两种方式**：GitHub 的 **Use this template** 按钮，或本地
> `node scripts/create.mjs`（`npx github:MYCF711/magpie-plugin-scaffold create`）。
> 前者复制目录与文件、**不带 git 历史**，`check.mjs` 的占位符检查会立刻提醒你改显示名；
> 后者会同时改身份、删掉 `check:template`、切到严格模式（CI 的自测也走 `template: "false"`）。

---

## ⚠ 动手前先读这五份

> **0 号定顺序，1~3 号管「写出来」，4 号管「发出去」。** 4 号最容易被跳过 —— 跳过它的表现
> 不是报错，是东西永远发不到用户手上。
>
> **AI 执行者从这里进**：[GUIDE.md](./GUIDE.md) —— 30 分钟主线，每步带官方锚点。
> 卡在某条坑里再翻 [AGENTS.md](./AGENTS.md)（症状 → 判据 → 出处）。

**0. [GUIDE.md](./GUIDE.md) —— 说明书主线：30 分钟，从官方指导文件到 80 分插件。**
这是**唯一一份按时间顺序写的**：拿到模板 → 改身份 → 写 config → 写 auth → 写 models →
写 usage/checkin → 自检 → 打分 → 发布。每步都标了对应的官方锚点（如 `#provider` / `#signin`），
并指向本仓库里讲细节的那一节。**第一次做插件，从这一份开始。**

**1. [README-TEMPLATE.md](./README-TEMPLATE.md) —— 写插件介绍页的模板，照抄。**
用户只看 README 决定装不装：开头给数字、功能一句一条、不踩别人、安装放最后、
技术细节全进 `docs/internals.md`。**参考源是必填段** —— 用了别人的协议结论或实现思路，
列出来（MIT 要求，也让读者知道依据）。
**模型段写发行商，不写数量** —— `DeepSeek / GLM / GPT` 这样列，表格只留各家最新 / 热门，
全量交给 `magpie plugin list`；数量跟着平台上下架变，写死必然过期。

**2. [HOOKS.md](./HOOKS.md) —— 钩子契约。**
从 magpie 二进制里提取的 21 章，**字段级**：每个字段少写会怎样、写错会怎样。
官方文档 [`usemagpie.ai/docs/plugins`](https://usemagpie.ai/docs/plugins) 讲**行为**，
两者并用 —— 官方文档已经补上 `auth.checkin`（2026-10-26，v0.1.1582，见 [README 里那段](#一个曾经的缺口已经补上)），
所以「官方漏了什么」不再是这份文件的价值；它的价值是「官方写了规则，没写写错的后果」。
其中一条最容易错：**`usage` 的 `used` 是必填**，它不只画进度条，还是路由排序输入 ——
漏了会被当成 0% = 满额，空号反而排到队首。

**3. [MULTI-PROVIDER.md](./MULTI-PROVIDER.md) —— 同一厂商两套云，一个包放两个供应商。**
国内版 / 国际版这种情形，做对了在 magpie 里是**两张卡、两组登录态**；做错了是
登录态互相覆盖。判据、骨架、五条铁律、验证清单都在里面。**只有一个站点的插件不用读这份。**

**4. [UPDATING.md](./UPDATING.md) —— 发版本，以及用户怎么拿到它。**

每次发版本**必读**，而且一步不能少：

```
起功能分支 → 写 CHANGELOG + bump → 合规 / 测试 / pack → 推功能分支
  → PR 的 `rules` 全绿后合并 → npm publish → tag + GitHub Release → 五条验证
```

**禁止直接推默认分支。** 少了 PR + `rules` 门禁，坏提交会直接抵达 git 源用户；少了发布与验证，
npm 用户又可能停在旧版或拿到未验包。发版前逐条过 [CHECKLIST.md](./CHECKLIST.md) 的 B 表。

---

写完代码，这几件事**每件都踩过**：

| 事 | 判据 |
|---|---|
| `LICENSE` 必须是标准 MIT 正文 | 归属说明插在正文里，GitHub 返回 `NOASSERTION`，插件卡片就没有许可那一格 |
| 包名/依赖键是 slug | `package.json.name` 必须是小写 ASCII（无空格/中文/大写）；带空格会让 `magpie plugin update` 报 `unrecognised dependency format` |
| 显示名写 `magpie.name` | `华为云 HUAWEI` 这种中文 + English 放 `package.json.magpie.name`（可带空格），provider 与 registry 的 `name` 同步 |
| 包名先 `npm view <名> version` | 撞名 = magpie 的「更新」会装成别人的包 |
| `keywords` 含 `opencode` + `plugin`/`auth`/`provider` | 否则 npm 搜索找不到 |
| 改代码要 bump `version` 再打包 | 同版本重打，bun 命中缓存（`no changes`），装了个寂寞 |

细节见 [README-TEMPLATE.md](./README-TEMPLATE.md) 的「仓库里还该有什么」一节。

### 包名是 slug；显示名写 `magpie.name`

`package.json.name` 是 **bun 依赖键**（git 安装）和 npm 包名，必须匹配
`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$` —— 小写字母、数字、`.` `_` `-`，
**不能有空格、中文、大写**。例：`huawei`、`codearts-auth`。

中文 + English 显示名写在 `package.json.magpie.name`：

```json
{
  "name": "huawei",
  "magpie": { "name": "华为云 HUAWEI" }
}
```

magpie 的 `shownName()`（`internal/gui/assets/plugins.js:1120`）优先取社区 registry 名，
其次就是 `package.json` 的 `magpie.name`；不要再拿依赖键当标题。

| 位置 | 放什么 | 例 |
|---|---|---|
| `package.json.name` | **slug**（bun 依赖键 / npm 名） | `huawei`、`officeace-auth` |
| `package.json.magpie.name` | 卡片显示名（`<中文> <English>`） | `华为云 HUAWEI` |
| provider 的 `name` | 供应商显示名 | `华为云 HUAWEI` |
| `registry-entry.json` 的 `name` | 市场条目显示名 | `果办 OfficeAce` |

为什么不能把显示名塞进包名：bun 用包内 `name` 写 `plugins/package.json` 的依赖键；
`magpie plugin update` 对 git 插件会把这个键当包 spec 传给 `bun update`。键里有空格时直接失败：

```
unrecognised dependency format: 爱派AiPy Trustoken
```

`magpie.name` 不是依赖键，空格随便写；已有带空格 `name` 的安装按
[UPDATING.md](./UPDATING.md) 的「旧版带空格依赖键」迁移。**不需要 `rm` + `add`，登录态不丢。**

⚠ **bun 只吃 ASCII 键**：中文键即使没有空格也报 `unrecognised dependency format`（实测 bun 1.4.4）。
所以 `name` 必须 slug，这是硬约束，不是风格偏好。

模板默认：`package.json.name = "unnamed-plugin"`、`magpie.name = "⚠ 未命名插件 Unnamed Plugin"`、
provider `name = "⚠ 未命名供应商 Unnamed Provider"`。看到占位符 / `unnamed-plugin` 就说明身份还没改，
`check.mjs` 会失败。

英文部分以**厂商官方品牌字样的写法**为准，大小写照抄 —— 华为云官方是全大写 `HUAWEI`，
不要改写成 `Huawei`。`check.mjs` 只能查组合与占位符，查不了官方大小写，后者照官网/品牌页。

## 先跑一遍再动手

```bash
node scripts/check.mjs          # 派生项目：显示名/provider name 还是占位符就失败
npm run check:template          # 仅脚手架自身：允许「未命名」占位符
```

规定逐条过（脚本末尾自己报「通过 N · 警告 M · 失败 K」），退出码非 0 就是不合规。它查的是**能查的那部分**：

| 组 | 查什么 |
|---|---|
| 身份 | `package.json.name` 是 slug / version 语义化 / description / 入口声明 / files 白名单 |
| 显示名 | `magpie.name`、provider `name`、`registry-entry.json.name` 是「中文 + English」，不是占位符 |
| 能被搜到 | keywords 含 `opencode` + `plugin|auth|provider` + `magpie` |
| 许可 | `license: MIT` 且 `LICENSE` 是逐字 MIT 正文（归属说明不能夹在里面） |
| 图标 | `magpie.icon` 是 `https://` 或 `data:image/`、≤1MB —— **插件卡片只认它** |
| 导出形状 | 入口能 import、每个导出函数都真的返回钩子（官方：导出的每个函数都会被当插件） |
| 一致性 | `registry-entry.json` 的 `package` 与 **npm 包名**一致（不是显示名） |
| 卫生 | CHANGELOG 有当前版本、没有真 JWT、没有硬编码本机路径 |

CI 在功能分支与 PR 上跑合规、语义测试和 `npm pack --dry-run`（`ci.yml`）。
`rules` 是合并前的必需检查；它绿了只代表可以合并，发布还要走 `release.mjs` / `release.yml`。

> 它**不**做任何「提交到社区」的动作 —— 收不收、收哪个，是维护者的事。
> 把它的输出贴进 issue，比一句「我做了个插件」有用得多。

---

## 目录

- [说明书主线](./GUIDE.md) —— **30 分钟，从官方指导文件到 80 分插件；第一次做插件从这份开始**
- [在用插件回收记录](./RECYCLING.md) —— **17 个真实启用项、通用代码来源与择优/排除边界**
- [官方引用索引](./OFFICIAL-SOURCES.md) —— **官方 22 个锚点逐条映射到本仓库；每条结论都能追到官方原文和版本**
- [80 分评分卡](./SCORING.md) —— **100 分怎么算、80 分卡在哪、`node scripts/score.mjs` 一条命令跑出来**
- [给 AI 的入口](./AGENTS.md) —— **按「你在哪一步」给阅读顺序，外加十几条静默出错的坑（症状→判据→出处）**
- [交付清单](./CHECKLIST.md) —— **两张勾选表：代码交付前 / 发版前（check 脚本查不到的那部分）**
- [写 README](./README-TEMPLATE.md) —— **插件介绍页的模板，照抄这份**
- [更新途径](./UPDATING.md) —— **功能分支 + PR + `rules` 门禁、合并后受控发布，每次发版前必读**
- [单插件多供应商](./MULTI-PROVIDER.md) —— **同一厂商两套云（国内/国际），一个包两个供应商**
- [最小交付面](#最小交付面) —— 这个模板的设计原则
- [magpie 是什么](#magpie-是什么)
- [九项清单](#九项清单)
- [三条铁律](#三条铁律)
- [怎么用](#怎么用)
- [实现五个 TODO](#实现五个-todo)
- [调试](#调试)
- [常见坑](#常见坑)
- [怎么发布](#怎么发布)
- [参考](#参考)

---

## 最小交付面

**一个插件只交付 magpie 自己没有的那部分，别的一律不做。**

magpie 已经内置了这些能力，插件**重复实现就是错**：

| magpie 已提供 | 所以插件**不要**做 |
|---|---|
| 签到调度（北京时间，每账号每天一次，失败当天重试）| 不要写 `setInterval` 或启动定时器 |
| 签到记账（`plugin-checkin.json`）| 不要自己存状态文件 |
| 签到 UI（「今日已签到 +100 · 连续 21 天」）| 不要做界面 |
| token 续期调度（`refreshLead` + 串行化）| 不要在每个请求里判断过期 |
| 账号池（`provider` / `provider#xxxxxx`）| 不要自己管理账号列表 |
| 登录作用域（`inScope`）| 不要用模块变量按 provider 存状态 |
| 代理（`via.run(proxy, ...)`）| 不要自己做代理转发 |
| 故障转移（限流/5xx 换账号或模型）| 不要自己重试换号 |
| 额度趋势（`credits-daily.json`）| 不要自己画图表 |
| 登录态标记（`X-Magpie-Sign-In`）| 不要自己判断 401 该不该停账号 |
| SDK 请求头（按 npm 包自动加 `x-api-key` / `x-goog-api-key` / `Bearer`）| 不要手动拼这些头 |
| 流式转发（分帧 + 背压）| 不要在 fetch 里读流 |
| 多语言提示、插件卡片、路由策略 | 不要碰 |

**剥掉这些之后，剩下的才是插件的交付面：九个钩子。**

这就是为什么这个模板这么小 —— 它只写 magpie 自己做不到的事。

> ⚠ 实测：`magpie-community/plugins` 的 25 个包里，**没有一个把九项全用上**。
> codearts 最全（5/6，缺 `chat.headers`），zen-free 一个都没用（它靠 pi 包适配层）。
> 「最完美的插件」目前还不存在 —— 这个模板就是那个目标形态。

---

## magpie 是什么

[magpie](https://usemagpie.ai) 是一个供应商网关。它把「一个服务的登录 + 模型 + 额度」
变成所有 agent（Claude Code、Codex、DSH、OpenCode…）都能用的一排模型。

插件是一个 npm 包 / git 仓库 / 文件夹，导出**一个 async 函数**：

```js
export const AcmeAuthPlugin = async ({ client }) => ({
  config, auth, provider, "chat.headers"
})
```

magpie 把每个插件加载进一个 Bun 进程（plugin host），通过 stdin/stdout 传 JSON。

**插件负责协议，magpie 负责其余一切。**

---

## 九项清单

### 钩子（magpie 会调）

| # | 钩子 | 作用 |
|---|---|---|
| ① | `config(cfg)` | 声明 provider 和**静态模型表** |
| ② | `auth.methods[].authorize()` | 登录 |
| ③ | `auth.refresh(auth, provider)` | token 续期 |
| ④ | `auth.loader(getAuth, provider)` | 接管请求（返回 `fetch`）|
| ⑤ | `auth.usage(getAuth, provider)` | 额度 → 卡片进度条 |
| ⑥ | `auth.checkin(getAuth, provider)` | **每日签到** |
| ⑦ | `provider.models(provider, { auth })` | 每账号的模型目录 |
| ⑧ | `"chat.headers"(input, output)` | 每请求加头 |

### 数据字段（不是钩子，但决定 UI）

| # | 字段 | 作用 |
|---|---|---|
| ⑨ | 登录返回的 `accountId` / `uid` | 卡片显示名 / 区分同名账号 |
| | `auth.icon` 或 `magpie.icon` | 卡片图标 |
| | `auth.maxConcurrency` 或 `magpie.maxConcurrency` | 并发数 |
| | （没有字段）卡片上的「承载 X、Y」徽章 | magpie ≥ 0.1.1744 由插件**注册的 provider 名**派生；`magpie.carries` 从未发布过，别写。见 [MULTI-PROVIDER.md](MULTI-PROVIDER.md) 铁律 6 |

### 非钩子但必需

```
npm README      → 插件卡片上的介绍页正文（magpie 读 npm 的 README）
package.json    → 版本、许可证、repository 链接（卡片上自动显示）
```

### 一个曾经的缺口，已经补上

**2026-10-25** 官方文档的钩子清单里确实没有 `auth.checkin` —— 它只写了
「the hooks magpie calls are `config`, `auth` (its methods, loader and usage),
`provider.models` and `chat.headers`」。而 magpie 二进制里嵌着 **200 KB / 21 章**的
插件契约源码，其中有一整章 `// ---- check-in ----`。

这条以 issue 形式报给了社区仓库：
[magpie-community/plugins#392](https://github.com/magpie-community/plugins/issues/392)
（附二进制契约原文、社区三个包的实际用法、`plugin-checkin.json` 真实状态、第三方适配器引用）。

**2026-10-26 官方在 magpie v0.1.1582 补齐了**（commit `c28d3e8b0`），en / zh / ja 三语，
六个 outcome 全列。issue 当天关闭。

**所以现在：** 判断某个钩子「有没有、叫什么」，用官方文档；判断某个字段「写错会怎样」，
用这份 HOOKS.md 和 `extract-contract.py` 提的契约。前者讲行为，后者讲字段 —— 谁都不知道对方的全部。

> 这段留着不是因为「我们曾经更全」，而是因为它是这个仓库最有效的用法示范：
> **拿证据指官方漏了什么，比说「我做了个东西」有用一百倍。**

---

## 已经趟过的通用协议（直接抄，别从零推）

这几块都是厂商无关的通用协议 / 原语，派生仓库直接用（来源与 MIT 归属见 [`NOTICE.md`](./NOTICE.md)）：

| 模块 | 解决什么 | 一个必须知道的实测 |
|---|---|---|
| [`src/http.mjs`](./src/http.mjs) | 公共请求头、OpenAI 错误 Response、异构错误摘要、保守 401/403 判定、Retry-After | 401 纯模型错误不杀账号；403 只有明确登录文本才算 expired；429 等待钳制在 1–60 秒 |
| [`src/status.mjs`](./src/status.mjs) | 400/422 的余额 / 超时(504) / 暂不可用(503) / 渠道 / 模型 / 限流分类与安全改写 | 只读 clone；200/SSE 原对象返回且零 pull；schema 与上下文过长不换号 |
| [`src/credential.mjs`](./src/credential.mjs) | 凭据读取、SHA-256 指纹、种类识别与 uid | 种类顺序 cached → metadata → shape；不要按 `auth.type` 猜 Cookie 还是 API Key |
| [`src/oauth-device.mjs`](./src/oauth-device.mjs) | RFC 8628 设备码申请、轮询、刷新 | `slow_down` 后续间隔 +5 秒；总预算取 maxWait/expires_in 较小值；网络失败不冒充登录失效 |
| [`src/checkin.mjs`](./src/checkin.mjs) | 签到前后账单差集对账、一次性奖励防双计 | 没有 before 快照时保守 `done`，不能把历史账单算成本次新奖励 |
| [`src/stream-reader.mjs`](./src/stream-reader.mjs) | 通用 reader 的空闲超时、abort、结束/错误重放 | 超时只摘除等待者；在飞 `read()` 的数据块必须排队，不能丢首块 |
| [`src/refresh-lock.mjs`](./src/refresh-lock.mjs) | 一次性 refresh_token 的并发闸：同 key 合并 in-flight、成功回放 60 秒、失败不缓存 | 键必须是**凭据身份**（refresh_token / account），不能用 provider id —— 否则同渠道多账号会共享一次刷新结果 |
| [`src/oauth-pkce.mjs`](./src/oauth-pkce.mjs) | OAuth 2.0 PKCE（S256）+ 本机 127.0.0.1 loopback 回调 | state 必须恰好出现一次且匹配；错误 path 404、错误 state 400 都**不结束**等待；超时 / abort / close 必须 reject |
| [`src/model-context.mjs`](./src/model-context.mjs) | 查 magpie 自己的 `~/.cache/magpie/models.json` 拿真实上下文窗口 | 查不到返回调用方 fallback，否则 `undefined` —— **不猜**；填 256K 而实际 1M 会让 agent 提前压缩 |
| [`src/models.mjs`](./src/models.mjs) | 模型过滤/降级、稳定 slug ↔ 上行 code、同 id 静态元数据合并 | 未知模型不继承第一条能力，也不把静态权限表补回 live 列表 |
| [`src/openai-sse.mjs`](./src/openai-sse.mjs) | OpenAI 兼容 SSE 解析 / 非流折叠：CRLF、多行 data、BOM、`[DONE]`、UTF-8 跨块、32 MiB 上限 | 合并 tool_calls 分片并保留 usage；流末仍无名的调用不向外发送，整轮只有它时给 502 |
| [`src/usage-cache.mjs`](./src/usage-cache.mjs) | 按凭据 key 缓存 `usage()`：成功 60 秒 / 失败 5 秒、同 key 并发合并、stale-while-revalidate | 旧成功值可立即返回并后台单飞刷新；失败保留 stale，无旧值时有界等待，不串账号 |
| [`src/request-rewrite.mjs`](./src/request-rewrite.mjs) | JSON 请求体改写管道：identity 快路径、`ensureStreamUsage`、`clampMaxTokens`、`stripModelPrefix`、`stripHopHeaders` | 改 body 后不去掉 `content-length` / `content-encoding` 会截断/解码失败；工具 schema 的 `additionalProperties:false` 绝不能碰 |
| [`src/tool-schema.mjs`](./src/tool-schema.mjs) | 工具名超长截断（保持唯一）+ 工具 schema 兼容改写（`additionalProperties` 非布尔→`true`、删 `items:{}`、`items` 子树摊平且不留空 `{}`） | **默认关闭、只作显式 adapter**：会放宽模型看到的工具约束；`request-rewrite.mjs` 的「工具 schema 不动」铁律不变，两者不要同时挂 |
| [`src/rotation-captcha.mjs`](./src/rotation-captcha.mjs) | 旋转图片验证码：角度编码、WAF cookie、取图→判角→提交重试 | `/captcha/generate` 回的 `set-cookie: acw_tc=…` 必须带回 verify，否则 `2000 客户端信息不匹配`（Node fetch 默认没有 cookie 罐） |
| [`src/vision-clock.mjs`](./src/vision-clock.mjs) | 让 magpie 设置里的识图模型判断「主体朝几点」 | `max_tokens=400` 会把推理答案饿死（`content:null`）；两个判官分歧 >1.5 钟点要换图，不能取平均 |
| [`src/local-browser.mjs`](./src/local-browser.mjs) | 从本机浏览器 localStorage（LevelDB）读登录态 | 必须按 origin 截断：A 站的 jwt 配到 B 站的 org 就是「登录成功却拿错号」 |
| [`src/browser-login.mjs`](./src/browser-login.mjs) | 受控 Chromium 登录：候选浏览器（含 360/QQ/搜狗等国产壳）+ CDP 抓 Cookie | Chrome/Edge 之外也得能选；Windows 注册表 App Paths 优先，退出码不可靠，以 CDP 端口连上为准 |
| [`src/tempmail-client.mjs`](./src/tempmail-client.mjs) | 一次性邮箱建址 + 收验证码 | 域名有黑名单：`maxxspace.com` 会被部分上游拒，`yzcalo.com` / 常见邮箱域可过 —— 换厂商先用真实请求确认 |
| [`src/catalog-union.mjs`](./src/catalog-union.mjs) | 两份模型目录合并：`catalogRows` 归一化、`isChatLike` 过滤非聊天行、`mergeCatalogs` 定主次 | 厂商的「客户端配置」更新慢、「控制台/网页」那份带完整元数据 —— 只读一份会让插件里的模型比网页上少几个、倍率还是旧的（坑 37） |

表里的模块都有 `tests/*.test.mjs` 语义锁，`node --test` 全跑，照着测就能改。

**上游只回 SSE、客户端要非流式 JSON 时**，别把流读干再拼字符串 —— 显式调用解析/折叠原语：

```js
import { openAIEvents, foldOpenAI } from "./src/openai-sse.mjs"

// res 是上游返回的 Response；只在「上游是 SSE、调用方要 JSON」这条路径上调用
const completion = await foldOpenAI(openAIEvents(res.body), { model: requestModel })
return Response.json(completion)
```

---

## 三条铁律

### 1. `config.models` 必须有内容

```js
config: async (cfg) => {
  cfg.provider ??= {}
  cfg.provider["huawei"] ??= {
    name: "华为云 HUAWEI",      // 中文 + English，英文照抄官方大小写
    npm: "@ai-sdk/openai-compatible",
    api: BASE,
    models: staticModels(),   // ⚠ 没有它，未登录时显示 "0 models"
  }
}
```

magpie 在**未登录**时也会渲染供应商卡片。`provider.models()` 拿不到账号只能返回空，
所以静态表必须在 `config` 里给。

### 2. `authorize()` 必须立刻返回

```js
// ❌ 死锁
async authorize() {
  const token = await waitForUserToLogin()   // 在这里等 = magpie 双向死锁
  return { type: "success", access: token }
}

// ✅
async authorize() {
  const flow = startLoginFlow()
  return {
    url: flow.url,            // magpie 拿这个去开浏览器
    method: "auto",
    callback: async (code) => {   // 真正等登录的是这里
      const token = await flow.result
      return { type: "success", access: token }
    },
  }
}
```

### 3. `refresh` 返回的是**合并**

```js
// auth.refresh 的返回值合并到旧账号上
auth: { async refresh(auth) { return { access, refresh, expires } } }

// 而 client.auth.set 是整体替换 —— 两者语义不同，别搞混
await client.auth.set({ path: { id }, body: wholeObject })
```

---

## 怎么用

### 方式一：克隆到自己的 GitHub

```bash
# 1. 在 GitHub 上点 "Use this template"（或 fork）
# 2. 克隆下来
git clone https://github.com/YOUR_NAME/YOUR_PROVIDER.git
cd YOUR_PROVIDER
```

### 方式二：本地直接开始

```bash
git clone https://github.com/MYCF711/magpie-plugin-scaffold.git my-provider
cd my-provider
rm -rf .git && git init    # 换掉历史
```

### 方式三：一条命令生成（身份自动改对）

```bash
npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.13 create \
  --dir my-provider \
  --provider huawei \
  --name "华为云 HUAWEI" \
  --package huawei-auth \
  --base https://api.huawei.example/v1
```

它复制模板的源码、测试、文档和 CI，把 `package.json.name` 写成 `--package`（slug，bun 依赖键），
把显示名写进 `package.json.magpie.name` 与 provider `name`，并生成
`scripts/publish-npm.mjs`（`PUBLISH_AS` = npm 包名）；不会覆盖非空目录，也不会联网或装依赖。
生成后直接跑 `node scripts/check.mjs`。

### 在已有仓库里只跑 check（GitHub Action）

不想复制模板、只想让 PR 卡住不合规的插件：

```yaml
# .github/workflows/magpie-plugin.yml
name: magpie plugin check
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: MYCF711/magpie-plugin-scaffold/.github/actions/check@v0.3.13
        with:
          target: .
```

这个复合动作直接跑动作仓库里的 `scripts/check.mjs`，不下载 npm 包、不装依赖、不写你的目录。
本地等价命令：`npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.13 check .`。
上面引用里的 tag 是写这份文档时的最新 Release；固定 tag 能让行为可复现，
想跟随最新可以换成 `#main`（Action 的 `@main` 同理，但固定 tag 更安全）。

### 建好仓库后：四件 check 查不到的事

`scripts/check.mjs` 只看**仓库里的文件**。下面这些在 GitHub 上一律查不到，
漏了不会报错，但社区和 agent 都找不到你：

| 事 | 怎么做 | 漏了会怎样 |
|---|---|---|
| **topics** | 仓库页 → About 右边齿轮 → Topics，加 `magpie` `magpie-plugin` `opencode` `opencode-plugin` `provider` | 社区按 topic 收，搜不到就是不存在 |
| **仓库描述** | 同一个地方，一行话说清签入什么 | 发现页只显示它 |
| **首个 tag** | `git tag v0.1.0 && git push origin v0.1.0` | `release.yml` 不触发，没有 Release |
| **Actions 权限** | Settings → Actions → General → Workflow permissions → **Read and write** | `release.yml` 建不了 Release（403） |

命令行一次做完（`gh` 已登录时）：

```bash
gh repo edit --add-topic magpie,magpie-plugin,opencode,opencode-plugin,provider
gh repo edit --description "一句话说清楚签入什么"
git tag v0.1.0 && git push origin v0.1.0
```

> 这四项没写进 `check.mjs`，是因为它查的是本地文件 —— 硬要查就得连 GitHub API，
> 而 CI 里的 token 未必有权限读你自己的仓库设置。放在这里当清单，建仓库时照着做一遍。

### 然后改三处

**① `package.json`**

```json
{
  "name": "huawei",                        ← slug（bun 依赖键 / npm 名）
  "magpie": { "name": "华为云 HUAWEI" },   ← 卡片显示名：中文 + English
  "description": "…",                      ← 一句话说清楚签入什么
  "repository": { "url": "…" },            ← 改成你的仓库
  "keywords": ["opencode", "opencode-plugin", "huawei"],
  "scripts": { "publish:npm": "node scripts/publish-npm.mjs" },  ← npm 包名在脚本里
  "magpie": {
    "icon": "https://huawei.example/icon.svg",
    "maxConcurrency": 4
  }
}
```

⚠ **`name` 不是 npm 包名。** npm 包名写在 `scripts/publish-npm.mjs` 的 `PUBLISH_AS`
（例如 `huawei-auth`）；发布脚本会临时替换 `name`，发完再恢复。模板默认的
`⚠ 未命名插件 Unnamed Plugin` 不改，`check.mjs` 会失败。

⚠ **`keywords` 决定 magpie 市场能不能搜到你。**
搜索会问 npm `<query> opencode`，只显示名字或 keywords **含 `opencode`**
**且**含 `auth` / `plugin` / `provider` 之一的包。

**② `index.mjs` 顶部的配置**

```js
const PROVIDER = "huawei"                  // provider id
const PROVIDER_NAME = "华为云 HUAWEI"       // 中文 + English，英文照抄官方写法
const BASE = "https://api.huawei.example/v1"
const SDK = "@ai-sdk/openai-compatible"    // 决定 API 形状
const MODELS = [["acme-coder", "Acme Coder", 200_000], ...]
```

**`SDK` 决定 magpie 用哪个 API 形状**：

| SDK | API | 路径 |
|---|---|---|
| `@ai-sdk/openai-compatible` | Chat completions | `/chat/completions` |
| `@ai-sdk/openai` | OpenAI Responses | `/responses` |
| `@ai-sdk/anthropic` | Anthropic Messages | `/messages` |
| `@ai-sdk/google` | Gemini | `/models/<id>:streamGenerateContent` |

**③ `README.md`** —— 这个文件会显示在 magpie 的插件卡片上。
写清四件事：签入什么服务、怎么登录、登录态存在哪、支持哪几家发行商。

---

## 实现五个 TODO

模板里有五个 `TODO` 函数，全部集中在 `index.mjs` 底部：

```js
startLoginFlow(inputs)      // 启动登录流程 → 返回 { url, result }
exchangeRefresh(token)      // 换 token → 返回 { access_token, refresh_token, expires_in }
fetchUsage(auth)            // 额度查询 → 返回 { plan, used, total, resetsAt }
doCheckin(auth)             // 签到 → 返回 { supported, alreadyToday, credit, ... }
fetchLiveModels(auth)       // 模型目录 → 返回 [{ id, name }]
```

### 五个 TODO 的输入输出约定

**① `startLoginFlow(inputs)`**

```js
// 返回 url（立刻可用）和 result（promise，登录完成后兑现 token）
return { url: "https://acme.example/login?...", result: promiseOfToken }
```

如果登录要用户粘贴授权码，返回 `method: "code"`。

**② `exchangeRefresh(refreshToken)`**

```js
return { access_token, refresh_token, expires_in }   // expires_in 是秒
```

⚠ refresh_token **一次性**的厂商额外注意：模板的 `auth.refresh` 已经用
`src/refresh-lock.mjs` 的 `createRefreshLock` 包住了 `exchangeRefresh` ——
同一 `refresh_token` 的并发续期会合并成一次，成功后回放 60 秒。
派生仓库不要绕过它直接调 `exchangeRefresh`。

**③ `fetchUsage(auth)`**

```js
return {
  plan: "Pro",                    // 卡片上的套餐标签
  used: 370, total: 1000,
  resetsAt: "2026-11-01T00:00:00Z",
  windows: [{ name, used, display, amount, limit, unit, resetsAt, aside }]
}
```

**`usage.windows` 拼出卡片上的进度条**：

```
name     → 进度条上方的标签
used     → 已用百分比（0-100，超额 >100）
display  → 数字显示，如 "2,131.63 / 3,400 积分"
amount   → 已用
limit    → 总量
unit     → 单位
resetsAt → 重置时间
aside    → true 表示用光不停账号（附加额度，magpie 收进折叠区）
```

只给 `used` 不给 `display`/`amount`/`limit` → 只有一个光秃秃的进度条。

**④ `doCheckin(auth)`**

返回 magpie 的六种 outcome 之一：

```js
"claimed"     刚签到成功
"done"        今天已经签过了
"ineligible"  这个账号不能参加
"inactive"    没有签到活动        ← 厂商没有签到功能时用这个
"captcha"     厂商要验证码        ← 让用户去官方 App 手动签，永不解
"failed"      失败
```

⚠ **`done` 和 `failed` 必须分清。** 重复领取通常返回 2xx 但内容为空 ——
那是 `done`（今天已领完），不是 `failed`。只看 HTTP 状态码会误报。

⚠ **`captcha` 永远不要去解。** 契约原文：
> the vendor asks for a captcha: the user checks in in its own app; **never solved**

**⑤ `fetchLiveModels(auth)`**

```js
return [{ id: "acme-coder", name: "Acme Coder", context: 200_000 }]
```

⚠ 拉不到就**原样返回兜底表**（模板已经这么做了）——
不要抛异常，也不要标 `Symbol.for("magpie.fellBack")`（那会让 magpie 整份丢弃）。

---

## 卡片上的许可证和「源码」按钮

magpie 从**社区 registry** 读这几个字段：

| 卡片元素 | 来源 |
|---|---|
| 标题 | entry 的 `name` |
| 「源码」按钮 | entry |
| 摘要正文 | entry 的 `summary` |
| 版本、更新于、图标、许可证 | npm 或 GitHub 元数据（**不需要 entry**）|

包不在那个 registry 里，卡片标题就退回包名，也没有「源码」按钮。

### 载体是 registry 条目，不是缓存

模板根目录的 `registry-entry.json` 就是要提交的形状：

```json
{
  "package": "your-package-name",
  "name": "⚠ 未命名插件 Unnamed Plugin",
  "providers": ["your-provider-id"],
  "summary": { "en": "...", "zh": "..." }
}
```

把它加进 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的
`registry.json`（两行 diff），合并之后卡片就有「源码」按钮和正确的标题。
`community: true` 由维护者那边标，自己不用填。

### ⚠ 不要写 magpie 的缓存

`~/.cache/magpie/plugin-market.json` 是 **magpie 自己的文件**。早期模板（≤0.1.8）带过一个
`src/self-register.mjs`，在插件加载时把条目 merge 进那份缓存 —— 这条路已被上游否掉：

- 按包名 merge ⇒ 一旦包进了 registry，**每次启动都会把 registry 条目盖回**包里写死的那份；
- 那份缓存是全局的（`Symbol.for` 的共享队列跨所有插件），一个插件能改另一个插件的条目。

`magpie-community/plugins#399` 的 review 里，维护者要求把这个模块从包里删掉再发版。
0.1.9 起模板里没有它了 —— **插件对 magpie 的目录只有读的份**。

### 由此推出的两条

- 想改卡片上看到的东西 → 改 registry 条目，别改缓存。
- 想「绕开审核立刻生效」→ 没有这条路，也不该有。

## 调试

**永远在沙箱里试，不要碰你自己的 magpie。**

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
      MAGPIE_ADDR=127.0.0.1:3499 magpie "$@" ; }

m plugin add ./              # 文件夹就地加载，不安装
m plugin --json              # 插件列出的方法、账号、模型、加载错误
m plugin login acme          # 逐个走登录方式和问题
m provider test acme         # 每个 API 一个极小请求
m provider test acme acme-coder
m quota                      # usage 钩子
m plugin logout acme
```

**插件打印的任何东西都进 stderr**，magpie 记为 `plugin: …` 行。

**单元测试**：把要测的东西放到 `export const _internal = { ... }`，
然后 `bun test`。

⚠ **入口文件不要导出 helper 函数** —— magpie 会把**每个导出的函数**都当插件调用。
测试用的东西一律放进 `_internal`。

---

## 上下文窗口要实测，别凭印象填

`provider.models` 里每个模型的 `limit.context` 会被 magpie 转给 agent（DSH 等），
**决定它什么时候压缩对话**。

### 填错的两种后果

```
填小了  → agent 在 12.8 万就压缩，模型明明能收 100 万，浪费 8 倍容量
        → 更要紧：路由组按「组内最大」算窗口，一个填小的成员拉低整组
填大了  → agent 以为还有余量，超了上游才报错
        → 用户看到「内容太长了」，以为是 bug
```

### 最容易犯的错：把「最大输出」当成「上下文」

DeepSeek 系常见组合：

```
最大输出 128,000     ← 每次回复的上限
上下文   1,000,000   ← 能塞进多少历史
```

**两个数字长得很像，填反了差 8 倍。** 我们就填反过：

```js
// 错的
limit: { context: 128_000, output: 8192 }
// 对的（实测后）
limit: { context: 1_000_000, output: 128_000 }
```

### 实测办法

```js
// 造一份约 N token 的文本发过去，看 usage.prompt_tokens 和是否 200
for (const n of [200_000, 500_000, 800_000, 1_000_000, 1_100_000]) {
  const body = JSON.stringify({
    model: "your/model",
    messages: [{ role: "user", content: "填充文本".repeat(...) + " OK" }],
    max_tokens: 20, stream: false,
  })
  const r = await fetch(gatewayUrl, { method: "POST", headers, body })
  const d = await r.json()
  console.log(n, d.choices ? "OK " + d.usage.prompt_tokens : "ERR " + d.error.message)
}
```

**找到第一次失败的位置，取稍低一点的圆整值**（如 258,556 → 256K）。

### 另一个坑：路由组的窗口

magpie 的路由组可以按「组内最大」或「固定值」决定窗口。**如果组用「最大」，
而你在某个成员卡片里手动改小，组的值不会变——但这个成员的对外值变了，
agent 看到窗口变化会重新组装上下文，可能一次发出两倍的历史。**

**建议：组用「自定义」，固定成组内成员共同的一个值。**

## 常见坑

### 1. `magpie plugin add xxx.tgz` 有 bug

它把 tgz 当 JS 文件 `import()`，报 `exports no OpenCode plugin function`。

**手动安装**：

```bash
DST=~/.config/magpie/plugins/node_modules/<包名>
mkdir -p "$DST"
tar -xzf <包名>.tgz -C "$DST" --strip-components=1

# plugins.json 的 plugins 数组加 {"spec": "<包名>"}
# plugins/package.json 的 dependencies 加 "<包名>": "file:./node_modules/<包名>"
magpie-bun install
```

**删除时五处都要清**：`plugins.json`、`plugins/package.json`、
`plugins/node_modules/<包名>/`、`plugin-auth.json`、`plugin-providers.json`。

### 2. 模型级错误要用 404，不是 401

| 情况 | 做法 | magpie 的行为 |
|---|---|---|
| 模型不存在 | 返回 **404** + 错误 JSON | 只搁置**这个模型** |
| 登录被拒 | 401 或 `signIn: "expired"` | 标记**这个账号** |
| 这个 401 是别的事 | 响应头 `X-Magpie-Sign-In: kept` | 不标记 |
| 已续期 | 响应头 `X-Magpie-Sign-In: renewed` | 清除标记 |

用 401 报告「模型不存在」会把整个账号标成失效 —— 用户得重新登录。

### 3. User-Agent 常常是硬校验

很多厂商校验客户端身份。**照抄官方客户端的 User-Agent**，不要用自己的包名，
也不要留运行时默认值。

例：CodeBuddy 不是 `CodeBuddyIDE/<version>` 形状就返回 10085（拒绝服务）。

#### 3.1 为什么这条会静默出事

上游网关会按 **`<product>/<version>`** 这个形态识别「第三方客户端」，命中就回

```
403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}
```

**文案说的是「网络繁忙」** —— 用户会去重试、去换账号、去看上游状态页，全都修不好；
你在日志里也只看到 403，看不出是 UA 的锅。

实测（同一 AK/SK、同一签名、同一请求体，只换 `User-Agent`，交替 3 轮）：

| User-Agent | 结果 |
|---|---|
| `<产品名>/0.2.1-rc.2 (+https://github.com/…/…)` | **403** `TM.00000001` |
| `<产品名>/0.2.1-rc.2` | **403** `TM.00000001` |
| `<产品名>`（无版本号） | 200 |
| `curl/8.7.1` / `Mozilla/5.0` / 不发 UA | 200 |

#### 3.2 还有一半在宿主那边：不设 UA = 透传 `magpie/<version>`

magpie 给插件的请求带 `User-Agent: magpie/<version>`（插件型 provider 一律改写成它）。
**插件不显式设 UA，就把它原样转给上游** —— 那同样是 `<product>/<version>` 形态，一样命中。

所以规矩是两条，缺一都不算过：

1. 每个打上游的 `fetch` **显式**带 `User-Agent`；
2. 值是**该服务官方客户端**的 UA。

`loader` 的 `fetch` 包装里，`"user-agent"` 必须在**跳过名单**里（否则客户端传来的 UA 会穿透），
再由插件自己补上官方值。

#### 3.3 官方 UA 怎么取（按优先级）

| # | 情形 | 取什么 |
|---|---|---|
| ① | 仓库 / 抓包里已经有过官方 UA | **逐字节照抄**，别改版本号，别「顺手美化」 |
| ② | 厂商有 App / CLI / Electron 客户端 | 那个客户端自己的 token：`WorkBuddy/<app> … CLI/<ver>`、`aipy-pro/2.1.1 … Electron/34.3.3`、`Loomy\|Desktop\|Electron\|macOS`、`okhttp/4.12.0`、`cnb-cli/<ver>` |
| ③ | 官方就是网页（Cookie / 网页会话） | **完整合法**的 Chrome UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |

③ 必须是**完整**的一条 —— 截断的 `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`
（缺 `(KHTML, like Gecko) Chrome/… Safari/537.36`）是残句，等于自报「不是浏览器」。
模板里把它固化成了 `src/http.mjs` 的 `OFFICIAL_UA`，派生仓库直接引用、按需覆盖。

#### 3.4 判据

```bash
node scripts/check-ua.mjs        # 0 = 合规；2 = 有违规（打印 文件:行 + 值 + 修法）
node scripts/check-ua.mjs ../my-plugin
```

`npm run check` 也卡这一条。它查四类：自产品名形态（`magpie/…`、`magpie-xxx/<ver>`、
`alysis-magpie/…`）、运行时默认（`node` / `Bun/…` / `undici`）、截断的 Mozilla、
以及「打非本机上游却没设 UA」（这一类是警告：静态拼不出来的，在 CHECKLIST A 表人工确认）。

查不到的：UA 在运行期才拼出来、或从配置读的 —— 那部分只能靠 A 表那条人工过一遍。

### 4. 一次性 refresh_token 必须串行

两个并发请求同时看到临期 → 各发一次续期 → 第二次消费已被消费的 token
→ 凭据**永久失效**，只能重新登录。

**去重的键要用凭据身份（refreshToken），不是 provider id** ——
账号池下同一 provider 有多个账号，按 provider 键控会让账号 B 共享账号 A 的结果。

### 5. 别在 `fetch` 里读流

magpie 负责分帧转发。插件改写响应体时要去掉
`content-length` 和 `content-encoding`。

### 6. 单章解析：magpie 二进制里的契约怎么提

```bash
python extract-contract.py
# 或指定路径
python extract-contract.py /path/to/magpie
```

⚠ Windows 上**没有 `strings` 命令**（Git for Windows 不带），必须用 Python。

### 7. 卡片标题：`magpie.name`；依赖键仍是 slug

**magpie 的标题优先级**（`internal/gui/assets/plugins.js:1120` 的 `shownName()`）：
社区 registry 名 → **`package.json.magpie.name`** → bun 依赖键 → spec。
所以显示名写 `magpie.name`，不要写进 `package.json.name`：

```json
{
  "name": "huawei",
  "magpie": { "name": "华为云 HUAWEI" }
}
```

| 位置 | 放什么 | 例 |
|---|---|---|
| `package.json.name` | bun 依赖键 / npm 名（slug） | `huawei`、`codearts-auth` |
| `package.json.magpie.name` | 卡片标题（中文 + English，可带空格） | `华为云 HUAWEI` |
| provider 的 `name` | 供应商列表显示名 | `华为云 HUAWEI` |
| `registry-entry.json.name` | 市场条目显示名 | `果办 OfficeAce` |

git 安装时，`gitName()` 反查的**依赖键同时是 `node_modules` 下的目录名**；它必须无空格。
`package.json.name` 带空格时 `magpie plugin update` 会直接报：

```
unrecognised dependency format: 爱派AiPy Trustoken
```

已有带空格依赖键的安装按 [UPDATING.md](./UPDATING.md) 的「旧版带空格依赖键」迁移：
把依赖键/目录/lock 改成 slug，加上 `magpie.name`；**不用 `rm` + `add`，登录态不丢**。

⚠ **`magpie plugin add` / `update` 会把键名改回包自己的 `name`（slug）。** 手改键名不是永久的；
正路是包内 `name` 用 slug、显示名放 `magpie.name`。

完整说明见 [HOOKS.md](./HOOKS.md) 的「九之二、插件名」。

### 8. 已安装卡片只显示版本和 README

publisher、周下载量、license、stars **只在「发现」面板显示**，已安装列表没有这些字段
（`internal/gui/plugins.go` 的 `pluginEntryJSON` 不传出它们）。

想让某条信息出现在已安装卡片上，**写进 README** —— 卡片正文就是 README 的内容。

另外：`weekly` 为 0 时下载量整个元素不渲染（`if (l.npm?.weekly)`），新发布的包看不到它。

---

## 怎么发布

### npm

```bash
npm run publish:npm
```

用户就能 `magpie plugin add huawei-auth` 了。

`package.json.name` 是 slug（如 `huawei`），`package.json.magpie.name` 才是显示名（`华为云 HUAWEI`）。
`scripts/publish-npm.mjs` 的 `PUBLISH_AS` 是 npm 名（如 `huawei-auth`）；两者不同时发布脚本临时替换
`name`，**`finally` 里还原**，失败也会还原。裸 `npm publish` 在两者不同时会被 registry 拒。

同版本已存在时脚本会报可读错误并提示 bump，不会留下被改过的 `package.json`。

#### CI 发布：必须先配 `NPM_TOKEN`

`release.yml` 的 npm 步骤用 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。
**没配 secret 时 0.3.0 起会显式失败**（旧版 `exit 0` 跳过 = 假绿，npm 上其实什么都没发）：

1. [npmjs.com](https://www.npmjs.com/) → Access Tokens → Generate New Token（Automation / publish 权限）。
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret →
   Name `NPM_TOKEN`，Value 粘 token。
3. 推 tag 或手动跑 `release.yml`，npm 日志必须看到 `+ <包名>@<版本>`。

细节见 [UPDATING.md](./UPDATING.md) 的「NPM_TOKEN：CI 发布不能假绿」。

**已经手工发过 npm 后重跑 workflow 是安全的**：`release.yml` 会先 `npm view` 同版本；
已存在就 `already published, skipping` + `exit 0`（保持绿），不会再 E409。
`release.mjs --npm` 也会先查一次，已存在就跳过 npm、继续 tag/Release。

### 收录进 magpie 的市场

**方式一：GitHub topic（最快）**

给仓库打上 `magpie-plugin` 标签：

```bash
# 在 GitHub 仓库页面 → About 齿轮 → Topics → 加 magpie-plugin
# 或用 API
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/topics \
  -d '{"names":["magpie-plugin","magpie","opencode","opencode-plugin"]}'
```

**package.json 必须在仓库根目录。**

打了标签的仓库会出现在 magpie 的 **Plugins → Discover → Unofficial**
（按 star 排序，标注「未经审核」）。magpie 最多每 10 分钟问一次 GitHub。

⚠ fork、archived 的仓库会被排除。
⚠ 没发 npm 的从仓库原样安装，所以**加载的文件必须提交**。

**方式二：提 PR 到 magic-community**

放到 `packages/<name>/`，命名规则：

```
provider    @magpie-community/opencode-<name>-auth
middleware  @magpie-community/middleware-<name>
tools       @magpie-community/tools-<name>
page        @magpie-community/page-<name>
agent       @magpie-community/agent-<name>
```

推到 main 的版本号变更会自动发布。

**方式三：registry.json —— 不必费心**

社区的 [registry.json](https://github.com/magpie-community/plugins) 是上游的
**推荐位**（商业化入口），进不进、什么时候进不由 PR 决定。**不要指望它**：

- 对自用/自发布的插件来说，前两条（npm + GitHub topic）已经够用；
- 把精力花在这上面，回报接近零。

想让卡片显示对的标题与「源码」按钮，唯一的路是把 `registry-entry.json` 提交成
`registry.json` 里的一条 —— 但那属于「上架」，和能不能用无关：包不在里面，
卡片标题退回包名，其余功能一律照常。**没有绕开的办法**（写本地市场缓存这条路
已被上游否掉，见上面「不要写 magpie 的缓存」）。

### 之后每一次更新

上面讲的是**第一次**发出去。后面每发一个版本，照
[UPDATING.md](./UPDATING.md) 走 —— 那份只讲「之后」：

- magpie 怎么发现新版本（npm 源比 `version`、git 源比默认分支 HEAD 的 commit，
  **两条路都不看 GitHub Release / tag**）
- **分支 + PR + `rules` 门禁，一步不能少**：起功能分支 → CHANGELOG + bump → 合规 / 测试 / pack →
  推功能分支 → 提 PR 等 `rules` 绿 → 合并 → `npm run publish:npm`（显示名不是 npm 包名）→
  tag + GitHub Release → 五条验证
- 用户侧怎么拿到更新（npm 源自动、git 源要手动点「更新」；`rm` + `add` 会把卡片显示名
  重置成包内 `name`，所以显示名必须写在仓库里）

> ⚠ 直接推默认分支会把未验证代码交给 git 源用户；只推代码不打 tag / 不发 npm，
> 又会让版本状态彼此错位。逐条过 [CHECKLIST.md](./CHECKLIST.md) 的 B 表，
> 并把 GitHub 的「Require a pull request」与 `rules` 检查都打开，才算有发布门。

---

## 参考

| 资源 | 地址 |
|---|---|
| 官方文档 | https://usemagpie.ai/docs/plugins |
| 社区插件仓库 | https://github.com/magpie-community/plugins |
| 官方文档说的钩子 | `config`, `auth`(methods/loader/usage), `provider.models`, `chat.headers` |
| **实际存在的钩子** | 上面**加上 `auth.checkin`**（文档漏了）|

**看真实实现**：

- 最小骨架（免登录）：[`packages/zen-free`](https://github.com/magpie-community/plugins/tree/main/packages/zen-free)
- 最全（5/6 钩子）：[`packages/codearts`](https://github.com/magpie-community/plugins/tree/main/packages/codearts)
- 多站点工厂：[`packages/workbuddy`](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)

**别参考的**：聚合形态（一个 provider 里塞多个渠道）。会破坏故障转移、
额度展示、单独停用。magpie 的 25 个官方社区包**全是**一个包一个供应商。

---

## 鸣谢

模板里的钩子契约来自 **[yetone/magpie](https://github.com/yetone/magpie)**（MIT）。

| 来源 | 用在了哪 |
|---|---|
| `internal/plugin/` 的 Go 实现 | 九个钩子的调用时机、返回值形状、错误语义 |
| 二进制里嵌的契约注释（约 200 KB / 21 章） | `HOOKS.md` 的正文，以及官方文档漏掉的 `auth.checkin` |
| `internal/plugin/market.go` 的 `market()` | 市场缓存由 magpie 整体替换、且属于 magpie —— 所以插件不该去写它 |

**`extract-contract.py`** 是提取那份嵌入契约的脚本，可以重新跑一遍核对。

上游是 MIT，本模板也是 MIT。

## 许可

MIT
# 讯飞 Loomy for magpie

> **改这个插件前先读 [AGENTS.md](./AGENTS.md)** —— 尤其是「不要重启 magpie」那一条。

把 [Loomy（讯飞 Loomy 桌面端）](https://loomy.xunfei.cn) 的模型接进 magpie：**三种登录**、
实时模型目录、两个积分池，外加一个管理面板（新手任务 / 邀请码 / 批量导入）。

```
供应商   loomy（模型名 loomy/<id>）
```

---

## 功能

- **三种登录** —— 本机客户端登录态自动导入 / 手机号 + 短信验证码 / 粘贴 session
- **从文件批量导入** —— magpie 原生的「从文件导入账号…」按钮；认数组 / 单对象 / 每行一个 / 裸 session
- **模型表跟随账号** —— 上游**按账号权限**下发不同模型集，所以每个账号各拉一份，magpie 取并集
- **两个积分池分得清** —— `额度 · 每日赠送`（次日重置、会作废）参与路由；`说明 · 永久积分` 只展示
- **倍率标在模型上** —— 从官方展示名后缀解析（`GLM 5.3 Flash(x0.8)` → `x0.8`），拉不到就不显示
- **新手任务面板** —— 8 项共 10000 积分，可单项完成或一键全做
- **邀请码面板** —— 查「我生成的码」（含已用/上限/状态）、绑定别人的码、补首登初始化

---

## 安装

```bash
# 本地开发
magpie plugin add D:/path/to/magpie-loomy

# 或从 GitHub
magpie plugin add owner/magpie-loomy
```

装完在插件 → 已安装里能看到两张卡：`loomy`（供应商）与 `Loomy 面板`（管理面板）。

---

## 三种登录

| 方式 | 前提 | 说明 |
|---|---|---|
| **Loomy 桌面端登录态** | 本机装并登录了 Loomy | 读客户端 Local Storage 的 `loomy-auth-session`，零交互 |
| **手机号 + 验证码** | 无 | 走讯飞账号网关（`account.xfinfr.com`，HMAC-SHA1 签名），**任何机器都能用** |
| **粘贴 session** | 你手上有 session | 32 位小写 hex；形态只告警不拒绝 |

> 客户端登录态与积分摘要都是**明文**存在 leveldb 里的（Electron Local Storage）。
> 本插件只**只读扫描**，不创建 `LOCK` 文件、不干扰运行中的客户端。

---

## 管理面板

点侧栏的「Loomy 面板」进入。**只有两个页面**：

| 页 | 内容 |
|---|---|
| **账号** | 每个账号**一行**：名字 · 每日赠送 · 永久积分 · 合计 · 重置倒计时 |
| **邀请码** | 单账号绑定 / **批量绑定** / 我生成的码 / 新手任务进度 |

**面板地址 `http://127.0.0.1:4391/`**，可用插件选项 `port` 覆盖。

### 账号页：一行解决

```
150****3411    每日 4,975/5,000    永久 30,000    合计 34,975    21 小时 58 分后重置
```

三块额度靠分隔与字重分层，不换行。每日剩余 ≤20% 时数字变橙、用光变红。

### 邀请码页：批量绑定

对口 register-machine 的两种口径：

| 方式 | 输入 | 效果 |
|---|---|---|
| **一行一个码** | 多行，每行一个邀请码 | 每个码绑 1 个**未绑定**账号（自动挑） |
| **单个码绑多个** | 只填一个码 + 数量 N | 该码绑 N 个未绑定账号 |

⚠ 候选池只取 `activation.activated === false` 的账号 —— 已绑定的号换不了码（平台侧不可逆），
硬绑只会失败。顶部会显示「N 个账号可绑」。并发默认 3（太高容易触发风控）。

### 新手任务

8 项共 10000 积分。已完成项显示「已完成」标签，未完成的给「上报」按钮；
也可以「一键上报全部」。⚠ 少数任务需要先在 Loomy 客户端真的做过一次才能上报。

### ⚠ 什么时候面板才会起来

页面服务由 **magpie 的宿主进程**跑，而这些宿主只在特定入口里提供页面服务：

| 入口 | 提供页面服务？ |
|---|---|
| magpie 应用（桌面窗口） | ✅ |
| `magpie web` / `magpie serve` / `magpie tray` / `magpie tui` | ✅ |
| `magpie plugin list/on/off/update` 等命令行 | ❌ 不提供 |

也就是说：**命令行操作不会启动面板**，这是 magpie 的设计（命令行宿主不该占着端口）。
面板随 magpie 应用的启动而启动，应用退出即停。

端口被占用（例如 app 宿主已经在跑）时，面板会每 500ms 重试、最多 30 秒，不会顺延到别的端口
—— 因为端口是 magpie 指定的，改了就与它记的地址对不上。

> **为什么面板不是一个普通的插件页？**
> magpie 的插件页跑在沙盒 iframe 里（`sandbox="allow-scripts"`，CSP `connect-src 'none'`），
> 页面内**不能 fetch**。所以「账号列表 / 任务进度 / 邀请码」这些需要实时数据的界面
> 只能画在插件自己的服务里 —— 由 `magpie.page.service` 声明端口，
> 插件页（`page/gateway.html`）只做**带路**，把自己导航过去。
> 导航之后就是插件自己的 origin，沙盒 CSP 不再适用。

⚠ **不要把 4391 发布到公网**。面板默认只绑 `127.0.0.1`，能连上它的人就能触发任务、
读到你账号的 session。

---

## 设置

| 选项 | 默认 | 作用 |
|---|---|---|
| `port` | `4391` | 面板服务端口 |
| `baseUrl` | 空 | 覆盖上游基址（一般不用填） |

---

## 模型能力从哪来

**全部来自上游，一个都不写死。**

`provider.models` 每次拉 `GET /api/v1/models` 时，上游会随每个模型下发能力声明：

```json
{"id":"DeepSeek-V4.1-Flash",
 "capabilities":{"reasoning":true,"vision":true,"function_calling":true,
                 "input_modalities":["text","image"],"output_modalities":["text"]}}
```

插件把它原样映射成 magpie 的两组声明（`src/hooks/models.mjs` 的
`mapUpstreamCapabilities`，**唯一一处映射**）：

| 上游 | magpie |
|---|---|
| `capabilities.vision` / `input_modalities` 含 `image` | `capabilities.input.image`、`modalities.input`、`attachment`、`supportsImage` |
| `capabilities.input_modalities` | `capabilities.input.{text,image,audio,video,pdf}` 与 `modalities.input` |
| `capabilities.output_modalities` | `capabilities.output.*` 与 `modalities.output` |
| `capabilities.function_calling` | `capabilities.toolcall` |
| `capabilities.reasoning` | `capabilities.reasoning` |

两条纪律：

* **上游没给能力字段 ⇒ 回落 `["text"]`**，不按模型名猜（猜错的表现是「发图卡死」）。
* **生图模型保持现状**：`doubao-seedream-5-lite` / `qwen-image-3.0-pro` /
  `Hy-Image-3.5-preview` 的模态是「收文本 → 出图片」，与上游的文本能力无关。

想核一份真实形状的映射结果：`node scripts/print-model-mapping.mjs`。

---

## 批量导入

用 magpie 原生的 **「＋ 从文件导入账号…」**（供应商编辑页 → 账号区）。

认这些形态：

```jsonc
[{ "phone": "138****0000", "userid": "le2609...", "session": "32位hex", "nickname": "NK..." }]  // 数组
{ "session": "32位hex" }                                                                          // 单个对象
{ "session": "..." }\n{ "session": "..." }                                                        // 每行一个
"32位hex"                                                                                          // 裸 session
{ "auth": { "session": "..." } }                                                                  // 嵌套包装
```

也接受整段文本里散落的 32 位 hex（会去重）。一条坏数据只影响它自己，
同批其它账号照常导入。上限 100 条（magpie 的限制）。

字段认 `session`（必需）、`phone`、`userid`、`userId`、`nickname`、`uid`，其余忽略 ——
状态类信息（`isnew` / `boundInvite` / `tasksDone`…）以网关自己查询为准，
免得把一份可能已经过期的快照当真。

---

## 已知限制

| 卡片上的窗口名 | 含义 | 字段 |
|---|---|---|
| `额度 · 每日赠送` | 每天重置的赠送额度，**参与路由** | `used` + `amount`/`limit`/`unit:"积分"` + `resetsAt` |
| `说明 · 永久积分` | 永久池，只展示 | `aside:true` + `amount` |
| `说明 · 可用总额` | 两池合计，只展示（`display` 带缓存时间戳） | `aside:true` + `amount` |
| `停用 · 上游改路由` | 上游把这个号改派了，**立刻停派** | `used:100` + `display:"实际由 X 服务；换回后自动恢复"` |
| `说明 · 上游限制` | 同上原因的解释行；**名字固定**，模型名只进 `display` | `aside:true` + `display:"全部模型实际由 X 服务"` |
| `停用 · 积分耗尽` | 余额为零，满额（路由跳过） | `used:100` |
| `停用 · 限流冷却` | 429 后短暂避开，到期自动恢复 | `used:100` + `resetsAt` |
| `说明 · 登录失效` | 真正的登录问题 —— 开关是顶层 `signIn:"expired"` | `aside:true` + `signIn:"expired"` |
| `说明 · 额度读于 …` | 这份额度是多久前读的（恒在最后一条） | `aside:true` + `display` |
| `说明 · 额度未读` | 还没有读数：点面板「刷新额度」 | `aside:true` + `display` |

- **`auth.usage` 零上游**（T-54）。它只读 `<configDir>/loomy-usage-cache.json`。
  额度要更新，只能点面板的「刷新额度」（`POST /api/usage/refresh`，可只刷勾选的号，
  并发 / 间隔取设置）。**打开面板与 magpie 启动都不会自动查额度** —— 曾经这里每个账号
  打一次 `/points/records`，301 个号全挤在启动瞬间，上游风控直接成批掉号。
- **所有真实上游调用都过一个进程级令牌桶**（`src/rate-gate.mjs`）：容量**跟着设置走**
  （默认 ≥20，用户把并发调高容量也跟着涨），它不是并发上限，只负责把意外爆发摊平。
  `/api/hello` 的 `gate: { waiting, capacity }` 可观测。

- **session 不会过期，也没有 refresh token** —— 所以本插件**不实现** `auth.refresh`。
  凭证失效时只能人工重登（会如实标 `X-Magpie-Sign-In: expired`）。
  造一个空的 refresh 会让 magpie 以为「能自动恢复」，从而把换号重试当成有效处置。
- **没有签到** —— 上游的日额度由服务端按自然日**自动**重置，没有任何「领取」动作。
  所以本插件**不实现** `auth.checkin`。
- **`额度 · 每日赠送` 的上限按 5000 算**（实测观测值，服务端重置到的那个数）。上游改了这个数时，
  `src/usage.mjs` 的 `DAILY_RESET_AMOUNT` 要跟着改。
- **`plugin-auth.json` 的格式不在 magpie 的插件契约里**。批量导入直接写它属于钻实现细节 ——
  所以：写前一定备份、只增不删、写完提示用户重载插件。
- **生图模型在对话列表里也会出现**（`doubao-seedream-5-lite` / `qwen-image-3.0-pro` /
  `Hy-Image-3.5-preview`）。它们走 `/v1/images/generations` 是好的，走 chat 会 404 ——
  这是 magpie 的 `DrawsID` 判据决定的，不是本插件能过滤的。

---

## 开发

```bash
npm test        # 单元测试（网络被禁用，任何真实请求都会失败）
node server.mjs # 单独跑面板，便于排障
```

设计约定与「会静默出错的坑」见 `AGENTS.md`。

## 许可

MIT。

# loomywork

> **magpie 侧边页插件** · v0.0.1
>
> Loomy 每日首登积分 + 8 项新手任务一键领取。
> **上游**：[L0NE-6/Loomy-Daily](https://github.com/L0NE-6/Loomy-Daily) —— 协议常量由脚本自动解析同步，不手抄。

打开 magpie 侧边栏点一下，两个已登录的账号的每日赠送积分和 8 项新手任务
就领完并回读确认。**只保留「自动做任务」这一件事**，其余全部砍掉。

## 插件说明

### 它做什么

| 动作 | 上游接口 | 说明 |
|---|---|---|
| 每日赠送积分 | `POST /points/first-login` | 按自然日幂等，同一天重复调不会多发 |
| 读任务进度 | `GET /onboarding/tasks` | 8 项新手任务的完成表 |
| 一键领取 | `POST /onboarding/tasks/complete` | 逐项上报，每项 `{key}` |
| 回读确认 | 再 `GET /onboarding/tasks` | 拿 after 快照与 before 比对 |

### 它不做什么

| 不做 | 为什么 |
|---|---|
| 登录 / 短信验证码 | magpie 的 loomy provider 插件已经登录好了，重复实现会让账号指代不一致 |
| 模型请求代理 | 那是 magpie-loomy 的职责，本插件只碰积分网关 |
| 推送通知 | 侧边页本身就是通知面 |
| 邀请码 / 额度 / 倍率 | 属于 magpie-loomy |
| 定时 cron | magpie 里点一下就有结果 |

### 界面

单列布局，按 magpie 侧边栏宽度（320~420px）设计。顶部两个账号 tab 切换，
每个账号显示：已得积分 / 总分 / 未领项数 / 每日赠送余额 / 缓存时间。
8 项任务按三个板块分组（初识 Loomy / 打造你的专属 Loomy / 遇见你的 AI 搭子），
每项显示标题、分值、完成状态。

按钮只有四个：`全部刷新`、`读上游进度`、`刷新每日积分`、`一键领取`。
**打开面板只发一个请求**（读本机缓存），任何打上游的动作都要点一下 ——
这是配额纪律，不是性能优化。

### 沙盒相关的两个硬约束

magpie 给插件页下的 CSP 实测是：

```
default-src 'none'; connect-src 'none';
script-src https://127.0.0.1:3430/_magpie/plugin/<token>/ …
```

1. **`connect-src 'none'` → fetch 全废**，同源也一样，报错永远是
   `Failed to fetch`。唯一能出网的通道是 `<script src>`，所以传输层用
   **JSONP**（四个接口都支持 `?cb=函数名`）
2. **10 秒内必须回 hello**，否则卡片显示「此页面已停止工作」。靠
   `_magpie/bridge.js` + `await magpie.ready` 完成握手

## 上游出处

本项目的全部上游协议知识来自 **[L0NE-6/Loomy-Daily](https://github.com/L0NE-6/Loomy-Daily)**
（青龙 / GitHub Actions 型 Python 脚本）。我们把它移植成了 magpie 的侧边页插件，
并额外做了两件事：

1. **不再手抄常量** —— 从上游 Python 源码里解析端点、成功码、任务表、分值
2. **上游改了能跟着改** —— GitHub Actions 每 6 小时比对一次，变了自动提 PR

```
上游  L0NE-6/Loomy-Daily@main/loomy_daily.py
同步  .github/workflows/sync-upstream.yml（每 6 小时 + 手动触发）
```

## 从 Loomy-Daily 砍掉了什么

| 原功能 | 处理 | 原因 |
|---|---|---|
| 短信登录 / `loomy_login.py` | 删 | magpie 的 loomy 插件已经登录好了，再写一套会让「哪个号是哪个号」两处不一致 |
| `LOOMY_TOKENS` 环境变量 / 多账号分隔 | 删 | 账号从 `plugin-auth.json` 自动读 |
| PushPlus / Bark / 企微 / 钉钉推送 | 删 | 侧边页本身就是通知面 |
| 青龙 / GitHub Actions 定时跑任务 | 删 | magpie 里点一下就有结果，不需要 cron（CI 只用来同步上游常量） |
| 本地结清快照 `loomy_onboarding.json` | 换 | 改成按 uid 分桶的 `loomywork-state.json`，两个号互不覆盖 |
| 邀请码 / 额度路由 / 倍率解析 | 删 | 属于 magpie-loomy 的职责，不是本插件 |
| 任务清单 `GET` + 领取 + 回读 | **保留** | 核心 |

## 保留了哪三条判据

这三条是整个移植里唯一不能改的东西，改错任一就会静默出错：

1. **鉴权头是 `token:`**，不是 `Authorization: Bearer`。
   用错会拿到 HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。

2. **业务错误也是 HTTP 200**。判据必须看 `code === "000000"`。
   看状态码的代码会把「登录失效」当成功。

3. **任务清单是 `data.tasks` 的 key→bool 扁平映射**，不是
   `[{key, done}]` 数组。而且只认严格 `=== true`，`1` / `"true"` / `` 都不算完成。

## 双回读确认（已被实测修正）

原本按 Loomy-Daily 的设计，领取后用**两条互相独立的证据**交叉验证：
状态迁移 + 积分增量。**2026-11-28 打真号实测推翻了这一点。**

上游 `GET /api/v1/onboarding/tasks` 的真实原始响应：

```json
{"code":"000000","desc":"成功","data":{
  "tasks":{"configure_remote":true,"create_soul":true,"first_message":true,
           "generate_ppt":true,"install_skill":true,"pick_skill":true,
           "set_schedule":true,"share_soul":true},
  "earned":10000,"total":10000}}
```

`earned` **完全由 tasks 推导**（∑ 已完成任务分值），不是账本余额。
所以「积分增量」和「状态迁移」是同一份数据 —— 它不是第二证据，
只是同一件事换了个算法。Loomy-Daily 里的双回读在这条上游上无法成立，
硬写成两条只会让人以为「验证过了」。

因此判据是**单条**，并且如实这么实现：

```
GET  /onboarding/tasks            → before 快照
POST /onboarding/tasks/complete {key}  × N
GET  /onboarding/tasks            → after 快照
```

`before.done=false → after.done=true` 即视为领取成功。

| 结论 | 含义 | 界面显示 |
|---|---|---|
| `confirmed` | 状态从 false 变 true | 已确认 |
| `already_done` | 上游说本来就完成了 | 本就完成 |
| `unconfirmed` | 回了 000000 但状态没变 / 回读失败 | 无变化（可重试） |
| `failed` | 上游报错 / 会话失效 | 失败 |

`earned` 仍会与任务分值交叉核对；**对不上时界面会显式提示**
「上游积分增量与任务分值不一致」—— 这是唯一能及时发现上游改算法的信号。

## 安装

### 前提

- magpie 已安装并运行（`magpie web`，默认 `3430`）
- **已经装好并登录了 Loomy 账号**（用 magpie 的 `magpie-plugin-loomy-auth` 插件登录）
- 本插件**不提供登录**，只读 `plugin-auth.json` 里已有的 session

### 方式一：本地目录（推荐）

```bash
# 1) 把仓库放到 magpie 的用户目录下
git clone https://github.com/ksmord/loomywork.git \
  ~/.loomywork

# 2) 写进 plugins.json 的 plugins 数组（追加一条即可）
#    {"spec": "/data/data/com.termux/files/home/.loomywork"}
#    文件位置：~/.config/magpie/plugins.json

# 3) 让 magpie 重新加载插件
#    magpie 界面里「更新」一下，或重启 magpie web
```

> **⚠ 权限**：magpie 以 `u0_a353` 运行。`cp` 过来的文件属主是 root，
> magpie **读不到**，会表现为页面空白但日志无错。必须：
>
> ```bash
> chown -R 10353:10353 ~/.loomywork
> chmod -R u+rwX,go+rX ~/.loomywork
> ```

### 方式二：npm spec

```json
{ "spec": "github:ksmord/loomywork#v0.0.1" }
```

### Android / Termux 的特殊一步

面板后端是独立 node 进程，必须在 Termux 的 mount namespace 里跑
（才有 node 和 `/data/data/com.termux` 路径）。而且 **magpie 重启不会自动
把它拉起来** —— 走了就要重起：

```bash
sh scripts/start-panel.sh          # 首次
sh scripts/start-panel.sh --restart # 换代码后
```

脚本做三件事：杀旧实例 → `nsenter` 进 magpie 的 namespace → 后台起。

### 独立调试（不经过 magpie）

```bash
MAGPIE_CONFIG_DIR=/path/to/magpie/config node server.mjs
# 打开 http://127.0.0.1:4392/
```

端口默认 **4392**（与 magpie-loomy 的 4391 错开），可用插件选项 `port` 覆盖。

### 装完自检

```bash
curl -s http://127.0.0.1:4392/api/health          # 应回 {"ok":true,...}
curl -s http://127.0.0.1:4392/api/accounts | head # 应列出两个账号
```

侧边栏出现「Loomy 任务」卡片，标题下方显示 `每日赠送积分 · 8 项新手任务`
即成功。若卡片显示「此页面已停止工作」，是握手没完成，见下方说明。

## 接口

**GET 只读本机，零上游请求** —— 这条是纪律，不是优化：

| 方法 | 路径 | 做什么 |
|---|---|---|
| GET | `/api/accounts` | 读 `plugin-auth.json` + 本机缓存，不打上游 |
| GET | `/api/tasks?uid=` | 同上，单个账号视图 |
| GET | `/api/health` | 纯内存 |
| POST/GET | `/api/refresh` | 读一次上游任务清单（只读，不写上游） |
| POST/GET | `/api/claim` | 领取 `{uid, keys?}`，不传 keys = 全部未完成 |
| POST/GET | `/api/first-login` | 刷新每日赠送积分 |

三个写入口同时接受 POST(JSON body) 和 GET(query) —— 因为沙盒页只能用
JSONP，而 JSONP 只能是 GET。直连 4392 时前端走 POST。

任意接口加 `?cb=函数名` 就返回 `函数名({...})`，Content-Type 变
`text/javascript`。回调名做了白名单校验（`/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/`），
不合法就当作没有、退回 JSON。

`/api/claim` 对同账号并发请求会**复用进行中的那一次**：
before/after 快照被两个请求交叉写会让结论彻底错乱。

## 侧边页

`page/index.html` 是面板主体，直接在 magpie 侧边栏里渲染，不再是带路页。

### 传输层：为什么是 JSONP

magpie 给插件页下的响应头（实测原文）：

```
default-src 'none'; connect-src 'none';
script-src https://127.0.0.1:3430/_magpie/plugin/<token>/ …
```

- `connect-src 'none'` → `fetch` / XHR / WebSocket / EventSource **全被拒**，
  同源也一样，报错永远是 `Failed to fetch`，跟「服务没起来」长得一模一样
- `script-src` 放行整条插件前缀 → `<script src>` 能过

而插件后端被代理在 `/_magpie/plugin/<token>/_magpie/service/` 之下，
**正好落在放行范围内**。所以页面插 script、服务端吐 `cb({...})`，这是唯一
可靠的通路，不是降级方案。

`bridge.js` 由宿主内联（页面里会出现 `globalThis.__magpieInlined=1`），
不内联时它由 `/_magpie/plugin/<token>/_magpie/bridge.js` 提供。

### 握手：不做会被判死

`page.js`（magpie 自己的前端）里有这么一段：

```js
const HELLO_MS = 10e3;
// how long a page has to say hello before it is taken as broken
```

页面必须在 **10 秒内**回一次 `hello`，否则整张卡显示「此页面已停止工作」。
做法：`<script src="_magpie/bridge.js">` 先挂桥，app.js 里 `await magpie.ready`。
桥不在（独立开 4392）时静默降级，不报错。

界面按 magpie 侧边栏宽度（320~420px）设计：单列、数字大、文字小。
两个账号用顶部 tabs 切换，进度条各自独立。

## 测试

```bash
node --test test/
```

**32 条**，全部用 `fetchImpl` 桩，不打真实上游。测的是**判据**不是网络：
业务错误 200、扁平 bool 映射、回读失败不能判成功、证据缺席不能判成功、
单项失败不中断整批、会话失效立即中止。

另有 21 条守上游常量链与同步脚本的退出码契约（见下）。

## 上游同步（自动适配）

协议常量**一个都不手写**。`src/constants.mjs` 只做转发，真正的值由脚本
从 `L0NE-6/Loomy-Daily` 的 `loomy_daily.py` 解析生成：

```
src/upstream.mjs             纯函数：把 Python 常量区解析成结构化 spec
scripts/sync-upstream.mjs    取上游 → 解析 → 写 src/upstream.generated.mjs + upstream.lock.json
scripts/summary.mjs          把 lock 渲染成人读的变更摘要（给 PR 正文用）
```

```bash
npm run sync          # 取上游重生成（本地有 _ref/ 用它，否则走网络）
npm run sync:local    # 强制用 _ref/ 里的本地副本
npm run sync:check    # 只比对：0 已最新 / 3 上游变了 / 2 形状不符 / 1 取不到
npm run summary       # 看当前解析结果
```

`upstream.lock.json` 存结构化快照。比对时**只比 `spec` 那一层**，
不碰 `fetchedAt` —— 否则每次运行都判「有变化」，CI 会每 6 小时提一个
只改时间戳的空 PR（实测踩过）。

### GitHub 自动适配

`.github/workflows/sync-upstream.yml`，每 6 小时跑一次 `--check`：

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 与上游一致 | 什么都不做 |
| 3 | 上游变了 | 重生成 → 跑测试 → 提 PR（正文含逐字段变更）|
| 2 | 解析器认不出新形状 | 开 `upstream-broken` issue，不猜 |
| 1 | 取不到上游 / 写盘失败 | 作业失败，等人看 |

测试不过就不提 PR —— 闸门排在 `create-pull-request` 之前。

### 为什么分成「改值」和「改形状」两种

- **改值**（端点路径、成功码、任务分值）→ 自动处理，人只需看 PR 正文
- **改形状**（常量改名、任务表从 list 变 dict、改成 `os.environ.get()`）→ 自动处理会写出半对半错的常量，比不处理更危险，所以停手开 issue

三条兜底纪律都钉在测试里：

1. **任一项解析失败就用内置兜底 + 告警**，绝不让服务起不来
2. **`totalPoints` 与 `declaredTotalPoints` 分开存** —— 后者是上游原文，
   前者以任务表合计为准。合成一个字段就再也看不出「上游加任务却忘改
   `TOTAL_POINTS`」
3. **三条端点路径共享同一个前缀**，绝不混用两个前缀（那必然 404）

## 发布到 GitHub

不需要本地装 git。用 GitHub REST API 一次推完（blob → tree → commit → ref → tag）：

```bash
GITHUB_TOKEN=<值> GITHUB_USER=ksmord npm run publish
```

### token 从哪来

**它是 Operit 的包环境变量，不是文件。** 取法只有一条：

```
operit_editor:read_environment_variable  { key: "GITHUB_TOKEN" }
→ { exists: true, value: "..." }
```

实测**没有**的位置，别再去找：`~/.config/gh`、`~/.netrc`、`~/.git-credentials`、
`~/.gitconfig`、magpie 的 `plugin-auth.json` / `mcp-hub-servers.json` /
`gateway.json`、Operit datastore 的 `*.preferences_pb`。

也别把 `github_pat_idempotencyrec...` 当 token —— 那是 GitHub 的**幂等键字段名**，
48 字符，拿去请求永远 401。

脚本行为：

| 步骤 | 幂等处理 |
|---|---|
| 建仓库 | 已存在就跳过 |
| 空仓库初始化 | 先写 `.gitkeep` 建初始 commit（Git Data API 要求仓库非空）|
| 上传文件 | 逐文件建 blob，按 `.gitignore` 排除 `_ref/`、`data/`、`*.log` |
| 建分支 | 不存在就 POST，存在就 PATCH（强制指向新 commit）|
| 打 tag | 已存在就跳过，避免重复发布 |

推送前 `test/publish.test.mjs` 会先过一遍 40 条判据：该传的在、该排除的排除、
无 token/密钥外泄、体积合理、全部可 base64 编码。

## 目录

```
index.mjs                    插件入口（导出 LoomyWorkPage 页面服务）
server.mjs                   侧边页后端（四个接口 + 静态文件 + JSONP）
src/constants.mjs            常量转发层（协议值全部来自生成文件）
src/upstream.mjs             上游 Python 常量解析器（纯函数，可单测）
src/upstream.generated.mjs   由脚本生成，禁止手改
src/points.mjs               积分网关的三个调用 + 三条判据
src/claim.mjs                双回读确认
src/accounts.mjs             读 plugin-auth.json，多账号解析
src/state.mjs                按 uid 分桶的缓存
scripts/sync-upstream.mjs    同步 / 比对 / 退出码契约
scripts/summary.mjs          lock 的人读摘要
scripts/start-panel.sh       在 magpie 的 namespace 里拉起面板（Android 专用）
upstream.lock.json           上游结构化快照（用于逐字段 diff）
page/index.html              侧边页
page/assets/app.js           前端逻辑（含 magpie 握手 + JSONP 传输）
page/assets/style.css        样式
test/points.test.mjs         三条判据
test/claim.test.mjs          五态结论
test/upstream.test.mjs       上游常量解析 + 形状变更
test/sync.test.mjs           同步脚本退出码契约（CI 依赖它）
```
```
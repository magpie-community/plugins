# 交接：quick 与 gemini-web-relay 续做

写于 2026-11-22，接在目录被清空的事故之后。**只读这一份就够，不要再去翻两个旧会话。**

旧会话（`sess_cce61528`「moss插件接亚马逊」、`sess_903ff9f2`「moss插件续接gemini」）已经不再使用，
里面混着 moss 的开发过程，继续用会串味。moss 已完成，不需要再动。

---

## 一、仓库现状

仓库：`C:\Users\Yun\Desktop\Projects\AI与网关\magpie-community-plugins`
远端：`origin` = magpie-community/plugins（上游），`fork` = nonamelane/plugins（你的）
HEAD：`63308c1`「restore local work lost when the repo directory was emptied」，本地领先上游 1 个，**未推送**。

### 2026-11-22 13:42 事故

那个目录（含 `.git`）在 13:42:18 被清空，三个本地插件的未提交工作全部丢失。
已从 zcode 会话的 artifacts（每次编辑前的文件全文 + 补丁）逐字节重建，并提交为 `63308c1`。

- 空目录保留为证据：`AI与网关/magpie-community-plugins.EMPTIED-20261122`
- 重建草稿仍留在：`临时/restore-draft`（仓库已包含其内容，可删）
- 未能定位清空动作的来源。已排除：zcode 的任何 Bash 命令、magpie 的插件安装。
- 旧 commit `653e9cd9`、`b92765f5` 的 git 对象已彻底丢失，远端也没有，无法恢复。

### 三个包的状态

| 包 | 状态 | 测试 |
|---|---|---|
| `packages/moss` | **完成，不再开发** | 136 pass |
| `packages/quick` | 代码完整，**一键登录从未真实验证过** | 63 pass |
| `packages/gemini-web-relay` | **不完整，加载不了** | 无测试 |

`bun scripts/check.mjs quick` 和 `... moss` 都通过。`bun.lock` 是本地生成物，未跟踪，别提交。

---

## 二、quick 的任务（会话 A）

### 待办核心

用户最初报的 bug：**「一键浏览器登录这个功能并不正常。回调有问题。」**

代码修复已完成（见下），但**从未在真实浏览器里跑通过一次**。所以第一件事是验证，不是继续改代码。

### 已确认的两个根因

**根因 A — `lib/browser.mjs` 的 cookie 读取错了**
- 旧代码：`SESSION_COOKIE_NAMES = ["mbtc"]`
- 事实：`mbtc` 不是 cookie，是页面配置里的 CSRF 令牌。真正的会话 cookie 是 httpOnly 的。
- 修复：删掉按名读取，改为按域名精确匹配 `quick.aws.com` / `.quick.aws.com`。

**根因 B — `lib/session.mjs` 的 discoverAccount 拿错了页面**
- 旧代码：请求 `https://quick.aws.com/`，拿到 QuickSuiteLanding 落地页，其 page-config 里 `csrf: null`
- 而且那个配置是 HTML 转义的（`&quot;`）
- 修复：新增 `pageConfigOf()` 解析 `<div id="page-config">` 并反转义 `&quot; &amp; &lt; &gt;`；
  `discoverAccount` 改为从 `/sn/start` 的 Location 头或 HTML 里读 accountId，
  再请求 `/sn/account/<id>/start/chat` 取 csrf；`redirect: "manual"`；csrf 为 null 时**明确报错**。

### 验证步骤（关键：必须真人操作）

> **不要自己打开浏览器，不要访问真实主机。** 违反过一次，用户被 WAF 封过。

1. `cd 仓库 && bun test packages/quick`（应 63 pass / 0 fail）
2. 让用户手动在 magpie 里点「一键登录」，观察：
   - 专用 profile 是否打开（`%LOCALAPPDATA%\magpie\quick-browser`）
   - 登录完成后回调是否成功
   - 失败的话，看 magpie 日志 `AppData\Local\magpie\logs\app.log` 里 quick 的报错
3. 如果还失败，用 `临时/quick-recon/` 里的录制材料对照（`landing.html`、`RECON-REPORT.md`、`PHASE2-RECON.md`）

### 参考实现

`packages/moss/lib/browser.mjs` 是**已验证可用**的一键登录实现，遇到浏览器编排问题先看它。

### 必须遵守的约束

- 只用专用 profile `%LOCALAPPDATA%\magpie\quick-browser`
- 清理残留进程时，**只能按命令行里的 `--user-data-dir=<该 profile>` 精确匹配**，绝不按进程名杀
  （曾经按 `msedge.exe` 批量杀，把用户正在用的浏览器关掉了）
- 不存整段粘贴的 Cookie 字符串，只留具名会话凭据；日志里脱敏
- 测试不得访问真实主机、不得打开真实浏览器（除用户手动触发的验证）
- 思考档位每轮显式下发；不做自动降级

---

## 三、gemini-web-relay 的任务（会话 B）

### 现状：加载不了

`package.json` 声明了 8 个文件，实际只有 4 个可用：

```
index.mjs          OK
relay.mjs          OK
browser.mjs        OK
opencode.mjs       OK
webchannel.mjs     OK
session_pool.mjs   OK
selftest.mjs       OK
openai.mjs         ❌ 缺失
prompt.mjs         ❌ 缺失
README.md          ❌ 缺失
LICENSE            ❌ 缺失
```

**为什么缺**：`openai.mjs` 和 `prompt.mjs` 从创建起就没被编辑过，所以从未进入会话 artifacts，
无法还原。这是**要新写**的文件，不是还原。README 和 LICENSE 同理。

### 这两个文件要提供的接口

`index.mjs` 只 import 三个函数：

```js
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"
```

**调用点（index.mjs:192-202）：**

```js
const prompt = flatten(body)                          // body = 请求体
const promptTokens = () => Math.ceil(prompt.length / 3)
const final = await session.ask(prompt, { model: m, signal, strictModel })

if (body.stream)
  return await sse({
    id, model, signal: request?.signal, promptTokens,   // 注意：传的是函数本身
    newId: () => "call_" + Math.random().toString(36).slice(2, 14),
    ask: (onUpdate, sig) => wrapAsk(session, prompt, m, onUpdate, sig, strictModel)
  })

return Response.json(completion({
  id, model, final, promptTokens: promptTokens(),        // 注意：这里已经调用过
  newId: () => "call_" + Math.random().toString(36).slice(2, 14)
}))
```

**`final` 的形状**：`{ text, reasoning }`（见 index.mjs:221-223）

**`ask` 的回调契约**：`ask(onUpdate, sig)`，`onUpdate({ text, reasoning })` 会被调用（可能多次）

### 参考

- `packages/quick/lib/relay.mjs` 里有一个 `flatten(messages)`，结构几乎相同，可直接借鉴
- `临时/mgw-ref/magpie-gemini-web/` 是同类插件的参考实现
- `临时/mgw-ref/gemini-web2api-go/` 是 Go 版参考

### 建议顺序

1. 先写 `prompt.mjs` 的 `flatten`（最简单，可照 quick 的写）
2. 再写 `openai.mjs` 的 `completion`（非流式，容易验证）
3. 最后写 `sse`（流式，注意 `[DONE]` 结尾和增量的 `delta`）
4. 写一个测试用假的 `ask` 验证两者，不碰网络

### 注意

- gemini-web-relay **没有 registry.json 条目**（自用未注册）。如果不需要在 magpie 市场显示，可以不加。
- 包名 `@nonamelane/magpie-gemini-web-relay`（不是 `@magpie-community/`）

---

## 四、给两个会话的共同提醒

**关于开发习惯（用户的核心关切）**
写完就 commit。这次损失惨重就是因为 quick 的修复和 gemini 的代码全停在未提交状态。
用户明确选择不建备份仓库、不挪 `.git`，靠这个习惯防护。

**只本地 commit，绝不推送。** 不要 `git push`，不要改远端。

**不要碰的东西**
- `AI与网关/magpie-community-plugins.EMPTIED-20261122`（事故证据，保留）
- `AI与网关/magpie-community-plugins-sensenova`（另一个 fork，工作区有 60 个未提交删除，与本次无关）
- `~/.config/magpie/`（改之前必须先问用户，包括 `magpie plugin add`、重启 magpie）

**关于 N2.6 "账号没有 key"**
已确认根因是 moss 插件没加载（日志：`MOSS: 缺少 API Key`）。moss 已恢复并通过测试，
重新装上后即可验证。**不需要改代码。**

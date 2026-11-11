# WorkBuddy 双区 · magpie 供应商插件

**一个插件包，两张供应商卡：`workbuddy` 接腾讯 WorkBuddy 国服，`workbuddy-ai` 接 WorkBuddy AI 国际服。登录态、模型目录、额度与签到互不覆盖。**

把国服 `copilot.tencent.com` 与国际服 `www.workbuddy.ai` 放进同一个 magpie 插件包，做成两个独立供应商、两组登录态、两份模型目录。它保留 `magpie-community/plugins` WorkBuddy 0.2.20 的完整行为，并补上 Jet Hub 的 scoped 双目录与国服限时补偿。浏览器登录、桌面登录、API Key、刷新、企业头、Messages/Chat 分流和额度由共享核心处理；域名、产品码、图标、静态模型与签到/补偿能力放在两个站点适配器里，互不覆盖。下面先给安装和功能，再解释共享与独立边界、验证证据和已知限制。

```
2 个供应商    浏览器登录 / 桌面登录 / API Key，三选一
31 条静态模型  登录后跟随账号的 /v3/config 实时上下架
2 种协议      Claude 走 Anthropic Messages，其余走 OpenAI Chat Completions
3 个开关      仅免费模型 · 增强模型目录 · 签到后自动领取限时补偿
318 + 173     社区兼容回归 + 本仓库单元 / 契约测试
```

> 非官方社区插件。WorkBuddy 的接口与客户端指纹可能变化；本仓库不代理、不缓存对话内容，请求直接发往对应站点。

---

## 功能

- **一个包，两个独立供应商**：`WorkBuddyAuthPlugin` 与 `WorkBuddyAIAuthPlugin` 是两个具名导出，magpie 把每个导出当成独立插件实例；两个 `auth`、两组账号、两份模型列表，不会串号。两个 provider 共用 WorkBuddy 官方应用图标（取自官方 Windows 客户端安装包的 256×256 圆角方形图标，内嵌 PNG data URI）。
- **三种登录**：
  - WorkBuddy 官方登录页：插件打开浏览器，按桌面客户端的方式轮询登录状态，最多 5 分钟，不用粘贴。
  - 桌面客户端登录态：读取本机 WorkBuddy 客户端自己的登录文件，只读不改；5.6 以后加密的版本会明确提示改用浏览器登录。
  - API Key：在站点 `/profile/keys` 创建，插件按官方 CLI 的方式同时发送 `X-API-Key` 与 `Authorization: Bearer`。
- **企业 / 团队账号**：登录时保留企业 id，之后每个模型、额度与对话请求都带 `X-Enterprise-Id` / `X-Tenant-Id`；个人号不会被误当成企业号。
- **静默续期**：一次性 `refresh_token` 全程单飞，请求前、额度前、magpie 的 `auth.refresh` 共用同一把锁；刷新结果按合并语义返回，失败不误标账号。
- **实时模型目录**：读账号自己的 `/v3/config`，按 `cli` agent 的列表给出模型、上下文、输出上限、思考档位、图片能力、倍率与折扣；读不到时退回内置快照，不会把列表清空。
- **双协议自动分流**：国服 `claude-*` 走 `/v1/messages`（Anthropic Messages），其余走 `/v2/chat/completions`；国际服没有 Messages 路由，所有模型走 Chat。
- **完整流式体验**：SSE 原样透传，reasoning、工具调用、`content_filter` 截断、空工具调用、工具结果后继续对话等社区已处理的情况全部保留。
- **额度与路由**：套餐积分、赠送积分、每日切片、到期时间、企业额度各自成窗口；免费模型与免费窗口单独计算，不让 0 倍率模型把额度条算错。
- **国服每日签到**：北京日每账号一次；已签到幂等，活动未开始 / 已结束 / 资格不符分别返回明确结果。
- **国服限时补偿**：查询 `/billing/meter/compensation-status`，只有用户显式打开选项才在签到后领取一次；默认关闭，避免悄悄消耗一次性奖励。
- **国服成长中心全自动**：签到那次在后台跑一轮成长中心 —— 任务列表里的可领项、首只 Buddy、猫猫旅行、连登补签与兑换、成长抽奖、新手礼包、活动补偿。每个动作按北京自然日幂等，重复触发只重新读一次列表；小程序族任务按 45 秒 + 0~10 秒抖动上报（连发会被上游回滚），上报后回读进度、达标才领。没有页面、没有按钮、不用在 magpie 里再开什么。
- **错误分得清**：登录失效落 401，模型不可用落 404，账号受限 / 积分耗尽 / 频道拒绝都有专门提示与稳定 code；流式错误保留上游原文。

---

## 两个供应商

| Provider id | 显示名 | API | Messages | 签到 | 限时补偿 |
|---|---|---|---|---|---|
| `workbuddy` | 腾讯 WorkBuddy | `https://copilot.tencent.com/v2` | ✅ Claude 系 | ✅ | ✅ |
| `workbuddy-ai` | 国际版 WorkBuddy AI | `https://www.workbuddy.ai/v2` | ❌ | ❌ | ❌ |

在 agent 中用 `<provider>/<model>` 选择，例如 `workbuddy/glm-5.3`、`workbuddy-ai/gpt-5.5`。安装后以 `magpie plugin list` 和模型页显示的实时目录为准；静态表只用于未登录和接口失败时兜底。

---

## 安装

已发布到 GitHub 与 npm：

```bash
# 从 GitHub 安装（git 源）
magpie plugin add github:MYCF711/magpie-workbuddy

# 从 npm 安装
magpie plugin add magpie-workbuddy
```

仓库：<https://github.com/MYCF711/magpie-workbuddy> · npm：<https://www.npmjs.com/package/magpie-workbuddy>

安装后打开 **设置 → 供应商**，会看到两张独立的卡：

1. **腾讯 WorkBuddy**：扫码/浏览器登录，或导入桌面登录，或粘贴 API Key。
2. **国际版 WorkBuddy AI**：独立登录，不会复用国服账号。

⚠ 不要同时安装 `@magpie-community/opencode-workbuddy-auth`。两个包声明相同的 provider id，会争用模型列表与登录态。

### 本地验证

```bash
npm test                 # Node 单元 / 契约测试
npm run test:community   # 社区 318 条兼容回归（用 magpie 自带 Bun）
node scripts/check.mjs   # 脚手架合规检查，必须 0 失败
npm pack --dry-run       # 检查发布内容
```

`test:community` 会在临时 HOME 中运行，绝不读取本机真实登录态。

---

## 选项

| 选项 | 默认 | 作用 |
|---|---|---|
| 仅免费模型 / Free models only | 关 | 列表只留厂商声明免费的模型；其他请求在插件内返回 404，不发出、不消耗积分 |
| 增强模型目录 / Extended model catalogue | 关 | 合并账号的 scoped 主目录（`/console/enterprises/personal/models`）与 `/v3/config`，两边 id 取并集；scoped 的模型元数据优先，config 补集并叠加促销 |
| 签到后自动领取限时补偿 | 关 | 仅国服。每日签到成功后查询限时补偿，未领取则领取一次；一次性奖励，不是每日任务 |
| 签到顺带跑成长中心 | 开 | 仅国服。每日签到成功后后台跑一轮成长中心（任务 / 旅行 / 连登 / 抽奖 / 礼包 / 补偿）；全部按北京自然日幂等。关掉则只签到 |

选项是 magpie 的布尔开关，切换后即时生效，不需要重启 host。

---

## 登录与账号

- **浏览器登录**打开站点自己的登录页；登录完成后插件轮询 token 与 account，不经过第三方中转。
- **桌面登录**只读取系统里 WorkBuddy 客户端的登录文件：macOS `~/Library/Application Support/CodeBuddyExtension/…`，Windows `%LOCALAPPDATA%\CodeBuddyExtension\…`，Linux `~/.local/share/CodeBuddyExtension/…`。5.6 以后加密的登录文件无法由外部解密，插件会提示使用浏览器登录。
- **API Key** 只用于推理；用 key 登录时查不到积分余额，这是 WorkBuddy 自身客户端的限制，卡片不会伪造 0。
- 同一账号重复登录是替换，不会生成重复卡片；不同账号按 `uid` 区分。
- 企业账号在登录页选择团队后，插件保留企业 id；同一人的个人号与企业号会显示为两张卡。

---

## 数据与隐私

- 对话内容不落盘、不转发到第三方；`fetch` 只把请求交给模型自己的 api.url。
- 登录凭据由 magpie 的账号存储管理；插件不复写 token 文件。
- 桌面登录文件只读，不修改。
- 测试夹具使用假 token / 假域名，不包含真实手机号、邮箱或本机路径。

---

## 与社区插件的关系

本项目的 WorkBuddy 协议核心来自 [`magpie-community/plugins · packages/workbuddy`](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)（MIT），并原样保留其 318 条回归测试作为兼容基线。Jet Hub 的 WorkBuddy 实现用于补充 scoped 双目录、限时补偿与认证超时等结论；客户端请求头仍采用社区 WorkBuddy 的指纹。完整功能对照、超越项和未接入项见 [docs/COMMUNITY-MATRIX.md](./docs/COMMUNITY-MATRIX.md)。

共享与独立边界见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，协议来源与版本见 [docs/SOURCES.md](./docs/SOURCES.md)。

---

## 已知限制

- 没有在本环境用真实 WorkBuddy 账号做在线端到端测试；离线契约、社区回归和打包均已验证。上游接口变更时以实际返回为准。
- WorkBuddy AI 没有 Claude Messages 路由，也没有签到；这不是插件遗漏。
- API Key 的额度不可查询；桌面登录 5.6+ 的加密登录态不可导入。
- 限时补偿是一次性活动，活动结束后接口会返回未开始 / 已结束，插件不会重试轰炸。
- 国服签到与补偿受上游活动规则约束；插件只如实报告，不绕过风控。

---

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。

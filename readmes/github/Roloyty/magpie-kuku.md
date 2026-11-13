# 百度库库 AI · Magpie 插件

Unofficial **Baidu Kuku AI / GenFlow** provider for [Magpie](https://github.com/yetone/magpie): website sign-in, multiple accounts, daily check-in, account credit balance, account-scoped model discovery and streaming text chat. No Agent2API server is required.

**状态：0.1.3 预览版。** 已修复官网签到风控被隐藏为普通失败的问题，网页登录后为每个账号保留专用浏览器环境。更新版经 Magpie 对另一个真实账号完成今日签到（+10），已独立回查确认并开启每日调度。原账号的官网 `8001` 风险限制仍未解除，跨日自动签到尚未验证，详见 [实测记录](VALIDATION.md)。

## 安装

在 Magpie → 插件 → 发现中搜索 **magpie-kuku**、**Kuku** 或 **库库**，核对仓库为 `Roloyty/magpie-kuku` 后安装。

仓库发布并添加 `magpie-plugin` 话题后，由 Magpie 的社区发现任务定时索引。刚发布时可能尚未显示；可在添加插件入口直接输入：

```text
github:Roloyty/magpie-kuku
```

命令行等价操作（Windows 请使用自己机器上的 Magpie 可执行文件路径）：

```powershell
magpie plugin add github:Roloyty/magpie-kuku
magpie plugin login kuku
```

本插件通过 GitHub 安装；`magpie-kuku-auth` 暂未发布到 npm。AGPL-3.0-only，公开完整源码，无安装脚本、无第三方运行依赖。

## 网页登录与多账号

1. 安装后，在 Magpie 的订阅/供应商账号入口选择 **百度库库 AI**。
2. 选择 **库库官网网页登录（Chrome / Edge）**。
3. 在独立浏览器窗口中完成百度登录、扫码或短信验证，并进入库库工作台。用户名、密码和验证码直接填写在百度官网。
   登录窗口最多等待 30 分钟；超时后自动关闭，可重新发起登录。
4. 插件校验账号与业务会话后自动保存到本机 Magpie，关闭自己的登录窗口。
5. 添加更多账号时重复上述步骤。每次登录创建独立浏览器环境，校验成功后保留供该账号每日签到使用；相同百度 UID 再次登录会更新原账号。

从 0.1.2 升级后，已有账号需要通过“添加另一个账号”再网页登录一次，才能保存专用浏览器环境；同一个 UID 会更新原账号。手动 Cookie 导入没有对应的浏览器环境，仍使用临时环境签到。

网页登录需要本机安装 Chrome 或 Edge；Windows、macOS、Linux 的常用路径可自动检测。网页登录必须在运行 Magpie 的机器上完成；纯无头服务器请使用 Cookie 导入。浏览器企业策略禁用远程调试时也可使用手动导入。

备选入口 **手动导入库库 Cookie** 接受 `BDUSS=…; STOKEN=…; PTOKEN=…`，或 Cookie 编辑器导出的 JSON。BDUSS 是百度账号凭证，完整登录 Cookie 只应输入自己信任的本机 Magpie，不要提交到 Issue、截图、日志或公开仓库。

Magpie 负责账号显示、改名、启停、删除、分组、切换和路由。插件没有独立账号数据库，不会读取现有 Chrome/Edge 配置或其他桌面客户端的凭证。登录失效后重新登录即可；没有伪造的自动续期。

## 每日签到与余额

- 在 Magpie → 供应商 → 百度库库 AI → 高级 → 签到中开启“每日自动签到”；账号卡片上的“立即签到”仅执行一次，不会开启每日签到。界面位置随 Magpie 版本略有变化。
- 调度、账号开关、当天结果和重试由 Magpie 原生签到系统管理；本插件不另启计时器。Magpie 需要运行。
- 优先读取库库当前 30 天签到活动配置，查询今日状态，再提交签到。已签到不重复提交；上游明确确认后才显示成功。
- 旧签到凭证接口为空时，使用无头 Chrome/Edge 打开官方签到页面，运行页面原有脚本并只点击“立即签到”，随后再次查询服务器确认结果。网页登录账号复用该账号的专用浏览器环境；旧账号及 Cookie 导入使用临时环境。此备用路径需要本机浏览器，不点击抽奖、补签或其他领奖按钮。
- 活动配置为空时，仅尝试旧活动的 **LOGIN 每日登录**奖励；不代领对话、邀请、下载或付费任务。
- 直接读取官网签到响应，遇到 `8001` 等风控或验证码时保留真实错误码和提示并停止提交，请到官网人工核验。浏览器环境复用不保证解除上游账号风险限制，不伪造风控凭证、不解验证码。
- 积分按账号从库库读取。未知余额显示错误，不显示成零；库库扣减的是自己的积分，Magpie 的美元 Token 成本不代表库库积分费用。

## 模型与功能范围

登录后刷新模型列表，在 Magpie 里选择 `kuku/<模型 ID>`。目录来自当前账号；尚未登录时只有 `auto` 占位项，不宣称该账号拥有某个具体模型。未识别到真实上下文/输出上限时报告未知（0），不编造模型规格。

| 功能 | 当前实现 |
| --- | --- |
| 官网网页登录、独立账号会话 | 单个真实账号实测通过 |
| Magpie 多账号、重复 UID 去重 | 官方宿主模拟测试通过 |
| 每日签到、已签判断、结果确认 | 0.1.3 当前账号签到 +10 并回查成功；原账号仍被官网风控拒绝；跨日调度未验证 |
| 按账号模型列表与积分 | 真实账号读取 13 个模型及积分成功 |
| OpenAI 格式文本对话、SSE 流式/非流式 | 真实非流式对话及模拟流式测试通过 |
| 原生工具调用、图片/文件输入、Office 成品生成 | 未实现，会明确拒绝不支持的请求 |

多轮消息会合并为提示词，每次请求创建新的库库会话。此插件接入库库的文本对话链路，不是把库库全部办公 Agent 能力移植到其他客户端。

## 数据与网络边界

只在插件创建的独立浏览器环境中读取百度 Cookie；浏览器调试端口仅绑定 `127.0.0.1`。登录成功后关闭自己的浏览器，保留该账号环境内的 Cookie 和网站存储；登录失败、取消或超时则清理新建环境。临时签到环境会在结束后清理。

专用环境默认位于 Windows `%LOCALAPPDATA%\Magpie\kuku-profiles`、macOS `~/Library/Application Support/magpie-kuku/profiles` 或 Linux `${XDG_DATA_HOME:-~/.local/share}/magpie-kuku/profiles`，每个账号分别存放在 `kuku-*` 子目录。该目录包含敏感登录数据，不要上传、公开或同步给他人。在 Magpie 删除账号不会自动删除浏览器环境；不再使用时，可关闭对应浏览器后删除该子目录。重新登录可能留下旧环境，同样可按此方式清理。系统仍占用文件时清理可能失败。

凭证保存在 **Magpie 自己管理的本机凭证文件**，本插件没有声称该文件经过加密。模型提示词与账号请求发送到 `kuku.baidu.com`；在确需换取库库业务 STOKEN 时，请求百度官方 `passport.baidu.com`。凭证请求拒绝 HTTP 跳转，不向第三方转发登录态；无遥测。Magpie 自身的遥测/同步设置由 Magpie 管理。

非百度官方产品，也未获百度或 Magpie 官方背书。上游网页接口可能变更，请使用自己的账号并遵守服务条款。

## 开发与验证

Node.js 22+ 或 Bun；运行无需安装 npm 依赖。

```powershell
npm test
npm run check
npm pack --dry-run
```

额外的真实 Magpie 宿主兼容性测试（不读取真实账号、不向上游发请求）：

```powershell
node scripts/host-smoke.mjs PATH_TO_MAGPIE_INTERNAL_PLUGIN_HOST_JS PATH_TO_BUN
```

测试覆盖 Cookie 域名与账号隔离、登录态错误脱敏、业务 STOKEN 交换、按账号模型与余额、签到结果核验及风控、SSE 中文分片与断流、消费者取消，以及官方宿主的多账号保存/去重。真实账号实测须单独记录，不能用模拟测试代替。

协议来源与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# 超算互联网 · SCNet Token Plan（Magpie 插件）

[English](README.en.md)

把你的[超算互联网 Token Plan](https://www.scnet.cn/help/docs/mainsite/mass/plans/token-plan.html)接入 [Magpie](https://usemagpie.ai)。在浏览器里登录 SCNet 官网，插件自动读取账号、现有套餐 Key、套餐模型和剩余 Credits，Magpie 里的各个 Agent 就能直接使用这些模型。

- 浏览器登录：用 SCNet 官方登录页，登录后自动完成，不用复制 Key 或 Cookie
- 账号显示为「超算互联网 · 用户名 · 套餐名」，带剩余 Credits、用量进度和到期时间
- 支持多个账号，可在插件内移除旧账号
- 流式输出和工具调用；Magpie 负责把 OpenAI Chat、Responses、Anthropic Messages 协议转发给 SCNet

社区开源项目（MIT），不是 SCNet 或 Magpie 官方插件。

<img src="docs/account-quota.png" width="600" alt="Magpie 中的账号与额度">

*示例截图：手动配置的演示账号，余额为演示数据。浏览器登录的账号名为「超算互联网 · 用户名 · 套餐名」。*

## 安装

在 Magpie 打开 **插件 → 发现**，搜索「超算」「超算互联网」或「scnet」，在「非官方插件 · GitHub」区找到 `scnet-auth`，点 **安装**。这个区域列的是作者自行发布到 GitHub 的插件，未经 Magpie 官方审核。

也可以用命令行：

```sh
magpie plugin add github:bbingz/scnet-auth
```

**更新：** 打开 **插件 → 已安装**，在 `scnet-auth` 上点 **更新**。更新会重新加载插件进程，建议在没有 Agent 正在请求时进行。

## 登录（推荐：浏览器登录，macOS）

1. 安装后按 Magpie 的提示登录；或打开 **供应商**：
   - 第一次添加：**添加供应商 → 来自插件 → 超算互联网 · SCNet Token Plan**
   - 已有账号：在该供应商里点 **添加另一个 … 账号**
2. 选择 **浏览器登录超算互联网（macOS 官网）**。Magpie 会在默认浏览器打开 SCNet 官方登录页，用账号密码、短信或扫码登录都可以；浏览器里已经登录过的也行。
3. macOS 弹出「钥匙串访问」提示时，点 **允许**。插件需要用它解密浏览器里的 SCNet 登录状态。
4. 等待自动完成。通常几秒到半分钟（浏览器把登录状态写入磁盘需要一点时间），之后 Magpie 里就会出现账号、模型和剩余 Credits。

说明：

- 支持 macOS 上的 Chrome（含 Beta / Dev / Canary）、Edge、Brave，要求是**默认浏览器**的普通窗口，无痕窗口的登录读不到。目前只用 Chrome Beta 做过真实账号验证。
- 浏览器里登录的是哪个 SCNet 账号，就连接哪个。要换账号，先在官网退出或切换，再重新发起浏览器登录。
- 同一用户、同一套餐再次登录，会更新原来的账号，不会重复添加。
- 五分钟内没读到登录结果会超时，不保存任何内容。

Windows、Linux、Safari 或没有桌面环境时，用下面的手动配置。

## 手动配置（Windows / Linux / Safari / 无桌面）

选择 **手动配置 API Key（高级 / 无桌面环境）**，按向导填写：

| 步骤 | 怎么填 |
| --- | --- |
| 账号备注 | 例如「主账号」，显示为「超算互联网 · 主账号」。同名备注再次登录会更新原账号。 |
| 模型配置 | DeepSeek 活动套餐选 **Event**（模型 `DeepSeek-V4.1-Flash-1017-Event`）；其他套餐选 **自定义**，填写控制台里的完整模型 ID，用逗号或换行分隔。 |
| 剩余额度 | 想显示 Credits 选 **连接额度查询**，否则选 **暂不查询额度**。 |
| 控制台 Cookie | 仅在连接额度查询时需要，获取方法见下方。 |
| 套餐 | 选与你的 API Key 对应的套餐。 |
| API Key | Token Plan 页面的专属 Key（以 `sk-tp-` 开头）。普通按量付费 Key 不能抵扣套餐额度。 |

<details>
<summary>如何获取控制台 Cookie（仅手动配置需要）</summary>

1. 在浏览器登录 [Token Plan 控制台](https://www.scnet.cn/ui/console/index.html#/llm/token-plan)。
2. 打开开发者工具（macOS `⌥⌘I`，Windows / Linux `F12`），切到 **Network / 网络**。
3. 刷新页面，在请求列表里筛选 `tokenplan/list`。
4. 点开这个请求，在 **Request Headers / 请求标头** 里复制 `Cookie` 的**值**（不要带 `Cookie:` 前缀，也不要复制 `Set-Cookie` 或整段 cURL）。
5. 粘贴到向导里的遮罩输入框。

Cookie 相当于登录凭据，不要发到 Issue、聊天或截图里。

</details>

## 模型

- 浏览器登录：自动使用该套餐包含的模型。
- 在 Agent 里选择 `scnet-token-plan/<模型 ID>`，例如 `scnet-token-plan/DeepSeek-V4.1-Flash-1017-Event`。
- 插件只列出你的套餐包含的模型，不会把 SCNet 平台上的全部模型都加进来。
- SCNet 没有公布上下文和输出长度上限，插件不设置（显示为 0，即未指定）。

## 剩余额度

账号下会显示剩余 Credits、已用 / 总额、用量百分比和套餐到期时间。

- Credits 由 SCNet 按模型折算，不等于 token 数。
- 额度查询绑定登录时选中的套餐。套餐用完后**新买了套餐**，请重新浏览器登录一次，额度才会切换到新套餐。
- 额度查询失败（会话过期、网络问题等）只影响额度显示，不影响模型调用。重新浏览器登录即可恢复。

## 移除账号

1. 打开「超算互联网」供应商，点 **添加另一个 … 账号**。
2. 选择 **管理已保存账号（移除旧 KEY）**，再选要移除的账号。
3. 核对名称或 Key 尾号，点 **确认移除这个账号**。确认前点「取消」不会删除任何东西。
4. 看到「已移除」后点「取消」关闭，再重新打开供应商查看。

这里只删除 Magpie 本机保存的这条记录，不会撤销 SCNet 官网的 Key，也不影响其他账号。第一个和最后一个账号都可以移除。

移除全部账号或卸载插件：

```sh
magpie plugin logout scnet-token-plan
magpie plugin rm github:bbingz/scnet-auth
```

## 常见问题

**市场里搜不到？**
确认在 **插件 → 发现** 里搜索，结果在「非官方插件 · GitHub」区。Magpie 会缓存 GitHub 列表约十分钟；如果该区提示有插件没能读取，点 **重试**。

**浏览器登录一直没完成，最后超时？**
确认登录的是**默认浏览器**、普通窗口，且是上面支持的浏览器；钥匙串提示需要点 **允许**。仍不行可以用手动配置。

**连接成了另一个账号？**
插件连接的是浏览器当前登录的 SCNet 账号。在官网切换账号后重新登录，再用「移除账号」删掉不需要的那个。

**额度显示「控制台会话已失效」？**
SCNet 网页登录过期了。重新浏览器登录即可，模型调用不受影响。

**请求返回 401 / 403 / 429？**
检查套餐是否到期或额度用完，以及模型 ID 是否完整（大小写、日期和 `-Event` 后缀都要一致）。SCNet 的错误会原样交给 Magpie，方便它重试或切换账号。

**使用限制**
SCNet 规定 Token Plan 仅限本人在 AI 工具中交互式使用，不能用于自动化脚本、应用后端或批量调用，违规可能导致 Key 被封。详见[官方说明](https://www.scnet.cn/help/docs/mainsite/mass/plans/token-plan.html)。

## 隐私与安全

- **读取什么：** 只读访问默认浏览器最近使用的那个资料里 `scnet.cn` 的 Cookie，在数据库查询阶段就限定域名和路径。不扫描其他资料，不复制整个 Cookie 数据库，不读其他网站、密码或浏览记录。钥匙串里的解密密钥只在本次登录的内存中使用，结束即清除。
- **保存什么：** 套餐 Key、SCNet 控制台会话、套餐 ID 和模型列表，保存在 Magpie 的凭据文件 `~/.config/magpie/plugin-auth.json`（或 `$XDG_CONFIG_HOME/magpie/plugin-auth.json`）。
- **发往哪里：** 模型请求只发到 `https://api.scnet.cn/api/llm/v1/chat/completions`；控制台会话只发到 `https://www.scnet.cn` 的固定查询地址。两者都不跟随重定向，也不会混用。
- **不会做：** 创建或重置 Key、购买套餐、修改浏览器或系统的安全设置。

## 技术信息

| 项目 | 值 |
| --- | --- |
| Provider ID | `scnet-token-plan` |
| 模型 Base URL | `https://api.scnet.cn/api/llm/v1` |
| 额度接口 | `https://www.scnet.cn/acx/charge/account/currentuser/tokenplan/list`（控制台内部接口，可能随网站更新变化） |
| 运行环境 | Magpie 内置 Bun；独立运行需 Node.js ≥ 22.13 |

登录和额度的实现细节见 [docs/quota-api.md](docs/quota-api.md)。插件按 Magpie 的 OpenCode 插件接口编写，未在原生 OpenCode 中验证。

## 开发

```sh
npm ci --ignore-scripts
npm test                                   # 单元测试
npm pack --dry-run --ignore-scripts
# macOS，已安装 Magpie 和 Bun：在隔离环境中跑真实 Magpie + 模拟 SCNet
SCNET_TEST_BUN=/absolute/path/to/bun npm run test:magpie
```

集成测试使用临时目录、假凭据和 macOS 沙箱，不会读取或修改你现有的 Magpie 账号，也不会请求真实的 SCNet。

## 参考

- [SCNet Token Plan 说明](https://www.scnet.cn/help/docs/mainsite/mass/plans/token-plan.html)
- [Magpie 插件指南](https://usemagpie.ai/docs/plugins)
- [更新记录](CHANGELOG.md)

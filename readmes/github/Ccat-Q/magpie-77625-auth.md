# 77625路由站 for Magpie / OpenCode

<p align="center"><img src="icon.png" width="96" height="96" alt="77625 图标"></p>

一个 Magpie（以及 OpenCode）供应商插件，用来登录 [77625路由站](https://ly.77625.xyz)：

- **注册提供商**：把 `77625` 声明为 Magpie 供应商，agent 可直接选它的模型。
- **自动签到**：在 Magpie 里打开签到开关后，每个北京日替你签到领积分。
- **查询剩余积分**：`magpie quota`、账号卡片和 `GET /v1/magpie/quotas` 显示积分余额与今日调用/消费。
- **聊天代理**：用站点的 OpenAI 兼容 `/v1` 接口。

> 站点是公益免费站，积分来自注册奖励、每日签到和邀请；没有充值入口。插件不提供站点注册功能（站点当前关闭注册并需管理员审核）。

## 安装

从 GitHub：

```bash
magpie plugin add github:Ccat-Q/magpie-77625-auth
magpie plugin login 77625
magpie quota 77625
```

从本地文件夹：

```bash
magpie plugin add /path/to/magpie-77625-auth
```

安装后插件宿主会自动重载，不需要重启 Magpie 容器。供应商行会显示：

- `77625-plugin`：如果你的 Magpie 里已经有一个手工配置的 `77625`；
- `77625`：如果没有冲突，插件直接接管这个 id。

## 登录方式

登录时有三条路，按需选一条：

### 1. 账号登录（自动续期，推荐）

输入站点用户名、密码。插件会：

1. 用 `POST /api/auth/login` 取得会话 Cookie；
2. 校验账号，并按需创建聊天 API Key；
3. 把密码保存在 `plugin-auth.json` 的 `refresh` 字段（文件权限 0600），会话过期时自动重新登录。

API Key 输入框可以留空：留空时插件会在账号可用的第一个分组里创建一个名为 `magpie` 的密钥。也可以粘贴已有密钥，或填写 `keyGroup` 指定分组。

### 2. 浏览器会话 Cookie（不保存密码）

不想把密码交给 Magpie 时用这个：

1. 在浏览器登录 `https://ly.77625.xyz`；
2. 打开开发者工具 → Network → 任一 `/api/...` 请求 → 复制请求头里的 `Cookie`；
3. 粘贴到登录框。

插件只保存 Cookie，不保存密码。Cookie 失效后需要重新登录，签到会暂停到重新登录为止。

### 3. 仅 API Key（不签到、不查积分）

只想聊天时用。这个账号不会读取积分，也不会签到。

## 打开签到

Magpie 不会自动给新供应商开签到。登录后：

1. 打开 Magpie 的供应商/插件设置；
2. 给 `77625` 打开“签到”开关（`settings.json` 里的 `pluginCheckins`）；
3. 在账号卡片点“签到”即可立即触发一次。

Magpie 之后每个北京日为每个已登录账号调用一次 `auth.checkin`。结果会显示在账号卡片、`magpie quota` 和 `plugin-checkin.json` 里：

| 结果 | 含义 |
| --- | --- |
| claimed | 签到成功，`credit` 是本次积分 |
| done | 今天已经签过 |
| ineligible | 账号没有签到权限 |
| inactive | 当前没有签到活动 |
| captcha | 站点要求验证码，请去站点手动签 |
| failed | 失败，Magpie 当天稍后重试 |

## 查询剩余积分

```bash
magpie quota 77625
magpie quota 77625 --json
```

插件返回：

- 积分余额（顶层 `balance`）+ “积分用量”窗口；
- “积分用量”窗口显示「累计消费 / 当前总量」并给出用量百分比：站点没有单独的总量字段，插件用 `当前余额 + 累计消费` 得到当前总量（消费时不变，只有新增积分才变大）；余额为 0 时百分比到 100%；
- “今日”窗口：当天调用次数与消费积分（`aside: true`，只展示，不参与路由）。

## 迁移：从手工 provider 到插件

插件声明 `provider id = 77625`。如果 Magpie 里已经有手工 provider `77625`，插件会以 `77625-plugin` 出现，避免直接冲突。推荐分阶段迁移：

1. 备份 Magpie 配置（`providers.json`、`plugin-auth.json`、`plugin-providers.json`、`settings.json` 等）；
2. 安装插件、登录，确认 `magpie provider test 77625-plugin x-deepseek-v4.1-flash` 成功；
3. 确认 `magpie quota 77625-plugin` 有积分；
4. 删除手工 provider：`magpie provider rm 77625`；
5. 等插件宿主重载后确认插件显示为 `77625`；
6. 检查自动组（例如 `auto-deepseek-v4-1-flash`）是否仍包含 `77625/x-deepseek-v4.1-flash`；
7. 如果组里丢了这一项，用 `magpie group set` 按原顺序补回。

删除手工 provider 前请务必确认插件聊天与积分已经可用。回滚时恢复备份并重载插件即可。

## 模型与上下文

> 站点 `/api/account/models` 的 `context_limit` 为 0（未知），下表采用厂商文档值，站点分组可能再限制；按实际使用调整。

| 模型 | context | max output | 备注 |
| --- | ---: | ---: | --- |
| deepseek-flash | 1,000,000 | 393,216 | |
| deepseek-v4-flash | 1,048,576 | 384,000 | |
| gemini-3.1-pro | 1,048,576 | 65,536 | |
| gemini-3.6-flash | 1,048,576 | 65,536 | |
| gemini-3.8-flash | 1,048,576 | 65,536 | |
| gemini-4 | 1,048,576 | 1,000,000 | 输入/思考/输出共享 |
| glm-5.2 | 1,000,000 | 65,536 | |
| kimi-k3 | 1,000,000 | 131,072 | |
| opus5.5 | 1,000,000 | 131,072 | |
| sensenova-6.8-flash-lite | 262,144 | 65,536 | 站点价格 0，标记 free |
| x-deepseek-v4.1-flash | 1,000,000 | 393,216 | |
| 不可信-grok-4.7 | 524,288 | 262,144 | 输入/输出共享，输出取保守值 |

登录后，插件优先用 `/api/account/models` 拉账号实际可用模型；失败时回退到上表。模型统一走 OpenAI Chat Completions，不填 USD 价格，只有价格 0 的模型标记 `free: true`。

## 排障

**登录提示 Cloudflare 人机验证**：站点对凭据接口可能开启挑战。在浏览器完成验证并登录，然后用“浏览器会话 Cookie”方式粘贴 Cookie。

**登录提示“失败次数过多，请 5 分钟后再试”**：站点对连续失败登录限流。等待 5 分钟；插件本身也会做本地退避，不会继续打站点。

**登录成功但没有聊天密钥**：账号可能没有 `key.create` 权限或没有可用分组。到站点 `/keys` 手动创建密钥，重新登录并粘贴。

**`magpie quota` 没有积分**：确认用的是“账号登录”或“Cookie 登录”，不是“仅 API Key”。

**模型列表为空/不全**：站点按账号权限返回模型。确认账号分组；插件会回退到静态清单。

**签到显示 ineligible / inactive**：账号没有签到权限，或站点当前没有活动；这不是插件错误。

**签到要求验证码**：插件不会解题，请去站点自己的页面签到。

## 安全

- “账号登录”会把密码存在 Magpie 的 `plugin-auth.json`（0600）里，仅用于会话自动续期；不接受这一点就用 Cookie 登录。
- “Cookie 登录”不保存密码，但 Cookie 本身等价于登录态，仍按凭据对待。
- 聊天 API Key 存在同一个账号记录里；站点只能显示密钥前缀，插件自动创建的密钥名为 `magpie`，可随时在站点吊销。
- 插件不记录对话内容、Cookie、密码或密钥，错误信息会截断站点返回的正文。
- `plugin-auth.json` 不要提交到 Git，也不要截图分享。

## 开发

无运行时依赖，Node 24 或 Bun 都能跑测试：

```bash
node --test
```

测试使用 mock HTTP，不访问真实站点。真实签到/积分接口需要账号，请在 Magpie 里手动验证。

## 许可

MIT
## 已验证

在 Magpie `0.1.2454` 上验证：

- 账号登录成功，账号保存为 OAuth，API Key 自动创建；
- `magpie provider test 77625 x-deepseek-v4.1-flash` 返回 2xx；
- `magpie quota 77625` 显示积分余额与今日调用/消费；
- 手动触发签到返回 `done`（当天已签到），记录写入 `plugin-checkin.json`；
- 删除手工 provider 后插件接管 `77625`，自动组 `auto-deepseek-v4-1-flash` 的成员与 `off` 状态保持。

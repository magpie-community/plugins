# opencode-vyceai-auth

把 [Vyce AI](https://vyceai.com) 接进 [magpie](https://usemagpie.ai)（也适用于 OpenCode）：用账号自己的 API 密钥登录，显示余额与连续签到天数，并可领取每日奖励。

插件只做三件事：注册供应商、用你的密钥发请求、在 magpie 的用量卡上显示余额与签到。它不代理、不转发、不上报任何数据。

## 安装

```sh
magpie plugin add SunnyRx/opencode-vyceai-auth
```

或在 magpie 窗口里：插件 › 发现 › 添加插件，填 `SunnyRx/opencode-vyceai-auth`。

装好后在供应商列表里给 `vyceai` 登录，即可在 Agent 里按 `vyceai/<model>` 选用模型。

## 登录

登录会问两个值，第二个可以留空：

| 问题 | 必填 | 从哪来 | 用途 |
| --- | --- | --- | --- |
| API 密钥 | 是 | vyceai 控制台 › API 密钥，形如 `sk-…` | 推理与模型列表 |
| 控制台 Cookie | 否 | 见下方「怎么找到那条 Cookie」 | 余额、连续签到、每日奖励 |

两个值都只保存在 magpie 本机的插件登录信息里（`~/.config/magpie/plugin-auth.json`），插件不会把它们发给 vyceai 以外的任何地方。

**只填 API 密钥也能用**：对话和模型列表正常，只是看不到余额，签到按钮会提示缺少 Cookie。

### 怎么找到那条 Cookie

只需要一条：名字叫 **`session`**。

1. 在已登录 vyceai 的浏览器里按 `F12`（或右键 › 检查）打开开发者工具。
2. 切到 **Application / 应用** 标签，左侧 **Storage › Cookies** 下点开 `https://vyceai.com`。
3. 在列表里找到 **Name = `session`** 的那一行，复制它的 **Value**（形如 `sess_…`，很长，带点号）。
4. 把这条 Value 粘到 magpie 的登录提问里即可；带不带 `session=` 前缀都行。

**不要复制这几条**：`_vfp_s`（设备指纹）、`cf_clearance`、`__cf_bm`、`CF_VERIFIED_DEVICE_*`、`_ga`、`OptanonConsent`。它们与登录态无关，粘进来反而会导致 401。

如果列表里同名的 `session` 有好几条，选 Domain 是 `vyceai.com`（不是 `.vyceai.com` 的其它站点）且过期时间最晚的那条。

### Cookie 会过期

Cookie 来自浏览器会话，过期时间由 vyceai 决定。过期后插件会在用量卡上提示，重新在 vyceai 登录一次、复制新 Cookie，再到 magpie 里重新登录本插件即可。对话不受影响。

## 模型

模型列表在登录后从 `GET https://vyceai.com/v1/models` 读取，按账号实际可用的模型显示，因此不同账号、不同套餐看到的范围可能不同。

插件预设了两个模型作为初始项（`glm-5.3-flash`、`nemotron-3.5-super-vl`），其余在供应商的「调整」里勾选。

## 用量与签到

- **余额**：来自控制台余额接口，显示在供应商卡与 `magpie quota`。
- **连续签到**：显示当前天数与今天是否已领。
- **每日奖励**：在供应商设置里打开「自动签到」后，magpie 每个北京日调用一次；只读取状态、可领时才领取，重复调用不会重复扣或报错。

奖励规则由 vyceai 决定（当前为免费账号每天 $10，按 UTC 零点重置，连续签到有加成），插件只负责按规则触发。

## 它不会做什么

- 不读取浏览器数据，Cookie 由你手动粘贴。
- 不改账号设置、不创建或删除密钥。
- 不把凭证发送给第三方；插件唯一的对外请求目标是 `vyceai.com`。

## 注意

- 余额与签到用的是 vyceai 控制台自己的接口（`/user/balance`、`/user/daily-reward`），不是公开文档化的 API，站点改版时可能失效；对话走的是稳定的 `/v1` OpenAI 兼容接口，不受影响。
- 这是第三方插件，与 Vyce AI 无关。
- Vyce 会把请求转发给上游模型厂商，隐私与训练条款以 vyceai 及其上游的条款为准。

## 许可

MIT

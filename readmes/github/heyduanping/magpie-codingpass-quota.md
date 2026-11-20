# CodingPass for Magpie

在 Magpie 中登录 CodingPass 账号，调用各账号套餐可用的模型，并在「观测 → 用量 → 概览」查看各自的 5 小时、每周和每月额度走势。Magpie 从首次成功读取开始积累历史。

这是非官方插件。`v0.2.0` 已在 Windows 上用 Magpie `0.1.4113` 和 CodingPass Plus 验证额度查询及模型调用。多账号验证使用了两个模拟账号。

## 安装

首次安装时，添加 GitHub 仓库并登录。以后可在 Magpie 的「插件 → 已安装」更新 CodingPass。

```sh
magpie plugin add https://github.com/heyduanping/magpie-codingpass-quota
magpie plugin login codingpass-quota
```

从本地目录试用时，可在仓库根目录运行 `magpie plugin add .`。也可以在 Magpie 的「插件」页面安装，再到「供应商 → CodingPass」登录。每次登录使用同一个 CodingPass 账号里的两项凭据。

1. 在 CodingPass 控制台获取这个账号的 `cp-live-…` API Key。
2. 保持同一账号登录，打开用量页。在浏览器开发者工具的「应用 → Cookie」中，复制 `https://codingpass.ai` 下的 `cp_session` 值。 [CodingPass 用量页](https://codingpass.ai/zh/app/usage)
3. 将两项凭据填入 Magpie 的隐藏输入框。账号可用的模型会出现在选择器里，额度会出现在「观测 → 用量 → 概览」。添加另一个获授权使用的账号时，按同样方式登录。

插件会分别验证 API Key 和 Cookie。CodingPass 的模型列表接口没有返回可与额度接口比对的账号或订阅标识，填写时要确认两项来自同一个账号。订阅按 CodingPass 返回的标识区分，同一订阅更换 Key 或 Cookie 会更新同一条登录记录。同一订阅的多个 Key 共用套餐额度。 [CodingPass API 文档](https://codingpass.ai/zh/docs) · [额度规则](https://codingpass.ai/zh/usage-limits)

## 选用指定账号

在 Magpie 的「路由组」里把模型成员绑定到指定账号。API 客户端也可以用请求头 `X-Magpie-Account` 固定账号。单账号路由组或固定请求头时，指定账号不可用就会收到错误。没有指定账号的请求按 Magpie 的路由规则处理。CodingPass 条款禁止用多个账号规避额度。 [Magpie 账号路由](https://github.com/yetone/magpie/blob/v0.1.4113/docs/subsystems/gateway-routing.md#L1617-L1642) · [CodingPass 服务条款](https://codingpass.ai/zh/terms)

## 更新登录和保留旧额度历史

Cookie 过期后，重新登录 CodingPass 网页，再用该订阅的 API Key 和新 Cookie 登录插件。只要 API Key 仍然有效，过期的 Cookie 不影响模型调用。安装旧版 `0.1.0` 时留下的 Cookie 登录仍会显示原额度和历史。添加完整登录后会出现新的账号卡，完整登录的趋势从自己的首个读数开始记录。

API Key 只用于模型目录和推理。Cookie 只用于额度查询，发送到 CodingPass 的网页控制台接口 `https://codingpass.ai/api/app/usage`。这两项凭据均保存在 Magpie 本机 `plugin-auth.json`，也可能留在它的备份里。网页接口可能随 CodingPass 网站更新而变化。

## 检查额度和历史

```sh
magpie quota refresh codingpass-quota
magpie quota history codingpass-quota
```

首个读数是一个点，后续读数会连成曲线。5 小时窗口尚未开启时，卡片可以显示剩余额度，重置时间会在窗口开启后显示。[CodingPass 用量规则](https://codingpass.ai/zh/usage-limits)

## 预热 5 小时窗口（v0.3.0）

通过 GitHub 仓库地址安装的用户，更新现有插件即可沿用原账号。从 `v0.3.1` 起，两个自动预热开关位于「供应商 → CodingPass」的模型列表下方，在「插件选项」中可以分别设置。

预热会通过本机 Magpie 网关向指定 CodingPass 账号发送一条 `hi`，最多请求 16 个输出 token，按所选模型消耗套餐额度。首个请求开启 5 小时窗口。周额度和月额度按账单周期重置。[CodingPass 用量规则](https://codingpass.ai/zh/usage-limits)

| 触发方式 | 操作 |
| --- | --- |
| 立即预热 | 在插件目录运行 `node warmup.mjs list` 查看账号，然后运行 `node warmup.mjs now "CodingPass 账号标识" deepseek-v4.1-flash`，把引号内的整段替换为列出的账号。窗口运行期间手动执行也会发送。 |
| 重置后预热 | 在「供应商 → CodingPass」打开「5 小时窗口重置后预热」并保存。窗口空闲且周、月额度充足时发送。 |
| 每日定时 | 在同一处打开「每日定时预热」并保存。默认按本机时间 09:00 检查。恢复运行晚于设定时间一小时会跳过当次。 |

两个自动开关默认关闭。账号列表来自 Magpie 的额度卡，空列表可先在用量页刷新 CodingPass。仅有一个完整登录账号时自动选用它。有多个账号时，在「插件 → 已安装 → CodingPass Usage → 选项」中填写目标账号。这里也可更换套餐内的模型，或指定每日的多个时间。例如：

```json
{
  "warmupAccount": "CodingPass 0123456789abcdef",
  "warmupModel": "deepseek-v4.1-flash",
  "warmupTimes": ["08:30", "14:00"]
}
```

Magpie 插件宿主运行期间每分钟检查一次。两个开关同时启用时，如果现在开窗会跨过下一个定时时刻，就等到该时刻。自动发送前会核对该账号的最新额度。窗口已开启、额度用完或读取失败时跳过。自动发送尝试按账号记录，同一账号在随后 5 小时内不会再次自动发送，宿主重启或上次响应丢失也适用。手动命令会显示结果，自动请求可在 Magpie 请求日志中查看。[Magpie 内置订阅的定时预热规则](https://github.com/yetone/magpie/blob/v0.1.4479/internal/provider/warmup_daily.go)

手动命令默认连接 `127.0.0.1:3425`。使用其他本机端口时，在运行命令前设置环境变量 `MAGPIE_ADDR`。

## License

[MIT](LICENSE)

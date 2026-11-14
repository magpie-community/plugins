# CodingPass for Magpie

在 Magpie 中登录 CodingPass 账号，调用各账号套餐可用的模型，并在「观测 → 用量 → 概览」查看各自的 5 小时、每周和每月额度走势。Magpie 从首次成功读取开始积累历史。

这是非官方插件。`v0.2.0` 已在 Windows 上用 Magpie `0.1.4113` 和 CodingPass Plus 验证额度查询及模型调用。多账号验证使用了两个模拟账号。

## 安装

从 GitHub 安装 `v0.2.0` 后登录：

```sh
magpie plugin add 'github:heyduanping/magpie-codingpass-quota#v0.2.0'
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

## License

[MIT](LICENSE)

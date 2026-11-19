# APIConnect for Magpie

将 APIConnect 的模型和订阅额度放到同一个 Magpie 供应商。登录后，在「供应商 → APIConnect」刷新并选择模型，在「观测 → 用量 → 概览」查看额度。模型列表随绑定的 API Key 更新。

## 安装与登录

在装有 Magpie 的终端运行：

```shell
magpie plugin add https://github.com/heyduanping/magpie-apiconnect
magpie plugin login apiconnect
```

选择适合自己的登录方式：

| 登录方式 | 需要填写 | 可以查看 |
| --- | --- | --- |
| 官网账号与套餐 API Key | APIConnect 登录邮箱、密码，以及同一账号下属于有效订阅分组的 API Key | 官网返回的有效订阅额度、到期时间和钱包余额 |
| 套餐 Key | 能通过 `/v1/usage` 返回订阅详情的 API Key | 该 Key 对应的订阅额度和到期时间 |

**选哪个 Key。** 打开 APIConnect 官网「我的订阅」，点击套餐下的「查看可使用套餐的 Key」，选择对应分组的有效 Key。如果单独填写 Key 时只查到钱包余额，请选第一种登录方式。官网账号启用二次验证时，插件支持使用能直接查询订阅的套餐 Key。

**已有同名供应商。** 如果先前手动添加过 ID 为 `apiconnect` 的供应商，Magpie 可能给插件供应商分配 `apiconnect-plugin`。登录命令仍使用插件 ID `apiconnect`。选择模型时，以 Magpie 实际列出的完整名称为准；已有路由继续使用原本的供应商。

## 使用

- **调用模型。** 点击「重新获取模型」，勾选要向 Agent 提供的模型。通常使用 `apiconnect/<模型 ID>`。模型请求通过 APIConnect 的 Anthropic Messages 接口发送。
- **查看额度。** 切换到卡片的「剩余」视图，可查看套餐提供的每日、每周或本期用量上限和剩余金额。同一笔用量可能同时计入周额度和本期额度，两个余额无需相加。官网账号模式在成功取得钱包读数时会另列「钱包余额」。
- **查看时间。** 有明确重置时间的窗口会显示重置时间。单个有效订阅会显示到期时间。多个有效订阅会按套餐名标注各自的窗口。
- **命令行刷新。** 运行 `magpie quota refresh apiconnect`；如果同名供应商共存，请用插件在 Magpie 中的实际供应商 ID。

## 凭据与请求

官网账号模式把邮箱和密码发送至 `https://apiconnect.lol/api/v1/auth/login`。插件核对 Key 属于该账号和有效订阅分组后，将 API Key 与可续期的会话交给 Magpie 在本机保存。密码仅用于首次登录或重新登录。插件使用自己的登录会话，浏览器无需保持打开。

模型列表来自 `GET /v1/models`。模型请求仅发往 `https://apiconnect.lol/v1/messages` 或 `/v1/messages/count_tokens`，使用模型 API Key。项目无运行时 npm 依赖。具体模型可用性和扣费以 APIConnect 的用量记录为准。

[APIConnect](https://apiconnect.lol) · [Magpie 插件文档](https://usemagpie.ai/docs/plugins) · [MIT 许可证](LICENSE)

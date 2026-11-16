# Magpie Provider Quota（账号额度）

`magpie-provider-quota` 是用于统一查看 Magpie 各供应商账号额度的页面插件。

统一查看 Magpie 中已接入的订阅、密钥套餐和 API 余额，每个账号一张卡片。
支持 Kiro、Claude、ChatGPT / Codex、Copilot、Gemini CLI 以及 Magpie 插件返回的其他订阅。
按各服务实际返回的小时、每日、每周、每月、模型池、积分或请求数展示。
支持 Magpie 桌面侧边栏、服务器 Magpie Web，以及本机独立运行。

![show](./artifacts/light.png)

## 安装

```sh
magpie plugin add ./magpie-provider-quota
```

在 Magpie 插件列表开启后，点击侧边栏的「账号额度」。
服务器安装、远程浏览器访问及域名部署见 [DEPLOY.md](DEPLOY.md)。

## 接入账号

在 Magpie 的「订阅」中接入所需账号，并在 Magpie 中取得额度读数。
已有账号不需要重复登录。也可以通过 CLI 接入，例如 `magpie accounts add codex`。
其他订阅只要出现在同一台 Magpie 的额度记录中，就会在下次刷新时自动显示，
无需逐个修改插件，也不需要在本插件中配置密钥。

分类优先使用 Magpie 的 `kind` 字段：

- `subscription`：订阅账号，包括任何插件提供的订阅，不依赖供应商白名单。
- `plan`：通过密钥购买的套餐，与订阅同区展示，并标注「密钥套餐」。
- `balance`：API 密钥的钱包余额，单独展示，不会因为供应商名称相同而混入订阅。

旧版记录未提供类型时，兼容识别 Kiro、Claude、Codex、Copilot 等常见订阅及余额读数。
无法确认类型的记录放在「其他额度」，保留读数并标注「类型待确认」，不会直接归入 API。
Kiro 的订阅积分属于订阅额度，有金额或积分字段也不会因此被误分为 API。
同一供应商的订阅、密钥套餐和余额，以及不同远端 Magpie 的账号分别保留。

卡片以账号邮箱为标题，不展示头像。订阅与套餐使用 Magpie 返回的 `until`（当前付费周期结束时间），
在套餐标签后展示「到期 YYYY/MM/DD」标签，鼠标悬浮可查看完整时间；供应商未提供日期时显示「到期 未提供」。
额度窗口的重置时间和登录凭证有效期不作为订阅到期时间。

页面只能显示 Magpie 已接入并返回的额度，不能发现尚未接入的订阅，
也不能从第三方中转 API Key 推算其背后的订阅额度。
Codex 窗口属于 Codex 使用额度，不是 ChatGPT 网页聊天各模型的消息上限。
供应商尚未提供读数的账号显示「暂无额度读数」，不会填入虚构的周期或满额百分比。

API 金额余额由 Magpie 的供应商余额探测提供，与订阅和套餐独立显示。
若供应商提供 `balance`，直接显示金额；提供 `limit` 和已用积分 `amount` 时，
以 `limit - amount` 计算剩余。没有总额度时不生成百分比。
不提供余额接口的供应商需要先在 Magpie 中配置相应的余额探测。

## 单独运行

Node.js 20 或更新版本，无第三方依赖：

```sh
npm start
```

打开终端输出的本机地址，默认是 `http://127.0.0.1:3497/`。
`MAGPIE_PROVIDER_QUOTA_PORT` 可以修改独立运行时的端口；插件中通过 `options.port` 修改。
`MAGPIE_CONFIG_DIR` 可以指定 Magpie 配置目录，`MAGPIE_ADDR` 可以指定本机网关。

## 数据与刷新

优先读取本机 `GET /v1/magpie/quotas?kept=1`，保留各账号的额度窗口，页面不展示图片生成（Image generation）条目。
支持按渠道筛选。标题右侧的问号在鼠标悬浮或键盘聚焦时显示接入与自动同步说明。
百分比表示剩余，按 `remaining`、`100 - used` 或 `1 - amount / limit` 计算；
有计数时同时显示剩余数量及总额。不限量显示「不限量」，文本读数按原文展示，
没有总额的钱包余额不生成百分比。供应商返回的多个同周期窗口分别保留。
网关不可用时读取配置目录的 `quotas.json`，并明确标注快照。
`used`、`remaining` 和计数都缺失时显示「—」，不会当作 100%。
重置时间已过也不会自行把额度填满。五分钟以前或更新时间未知的读数以较淡颜色显示。
鼠标停在更新时间或额度上可查看详情。

点击刷新只重读 Magpie 的额度记录，不触发账号登录、切换或向 OpenAI 发送模型请求。
若供应商读数已旧，请先在 Magpie 中更新对应账号的额度。
自动读取间隔为 60 秒；页面不可见时暂停。

服务仅监听 `127.0.0.1`，前端只收到所需的额度字段。
本插件不读取登录凭据、API Key、聊天内容，也不向外部服务上传数据。
服务器侧页面使用 Magpie 提供的 `magpie.service` 地址，API 和静态资源均通过相同的服务前缀加载。
无需把插件的回环端口直接开放到公网。

## 开发检查

```sh
npm test
```

`artifacts/light.png` 和 `artifacts/dark.png` 是使用演示账号生成的桌面界面预览，不含真实账号数据。
发布时在项目根目录执行 `npm pack --pack-destination artifacts` 更新发布包，
当前版本的文件名为 `magpie-provider-quota-0.5.0.tgz`。

在完整源码中运行。发布包无第三方依赖，由 Magpie 的 Bun 插件宿主运行，无需执行 `npm install`。

实现参考 Magpie 官方插件文档及社区 `packages/page-model-quota` 的页面服务模式：

- https://usemagpie.ai/docs/plugins#pages
- https://github.com/magpie-community/plugins/tree/main/packages/page-model-quota

[English](./README.en.md)

# magpie-jmds

给 [jmds](https://api.jmds.dev) 付费用户使用的 [magpie](https://usemagpie.ai) 插件。用 API key 登录，就能在 magpie 里看到订阅用量、额外用量、钱包余额，以及可用模型与价格。

**只报事实，不替你调度。** 插件只有一个 provider：`jmds`，不安装或导出路由策略。用量和价格供 magpie 展示，也供你选择的路由方式读取。

## 安装与登录

需要 **magpie ≥ v0.1.1937**（包含多 provider 钱包余额路由支持）。

```sh
magpie plugin add magpie-jmds
magpie plugin login jmds
```

也可以在 magpie 应用的插件页安装 `magpie-jmds`，再添加 `jmds` 账号。

经 magpie 使用 Claude Code 时，插件会根据请求中的 Claude Code 归因信息补齐客户端身份头。

登录时只需要自己的 API key（`sk-…`），不用输入站点地址或网页登录密码。插件会先问一个**可选账号名**，直接回车即可，再粘贴 API key。每次登录对应一个账号；有多个 key 时可重复登录。

填写账号名后以它显示；留空则显示 `api.jmds.dev …key后四位`。插件第一次使用账号时写入名字，第一次用量读取前可能暂时显示默认名字。magpie 用名字保存账号设置：登录后要换名，请删除账号再登录。同一 key 不必重复添加。

## 在 magpie 里能看到什么

| key 类型或限制 | 显示内容 |
|---|---|
| 订阅 key | 套餐名、到期时间、`24 hours` / `7 days` / `30 days` 用量窗口及站点返回的重置时间 |
| 额外用量 | `额外用量` 的已用 / 累计额度；订阅有窗口用满且池还有剩余时，打满窗口暂时只展示，额外用量池参与可用量判断；其余情况下池只展示 |
| 余额 key | 套餐名 `按量付费`、`余额` 钱包窗口和美元余额。钱包为零时 magpie 可据此判断已耗尽 |
| key 自身限额 | `Key 总额度` 以及设置了限额的 `5 hours` / `24 hours` / `7 days` 窗口，与订阅窗口同时显示 |
| 可用模型 | 该 key 可用的模型，名称为 `jmds/<模型ID>`；有 token 价格时显示 USD / 百万 token 单价，包括输入、输出及缓存读写 |

没有限制的窗口不虚构额度；未返回的重置时间不推算。总额度和额外用量池不虚构周期或重置时间。没有 token 价格的模型不报价格，而不是显示为免费。

订阅 key 只展示该 key 绑定分组的订阅，**不展示钱包**；余额 key 使用账号的钱包，**不展示订阅**。同一用户拥有两种 key 时，可以分别登录。订阅缺失或过期会直接显示中文错误提示；key 被拒绝时会提示重新登录。

模型使用适合的接口：Claude 系列为 `/v1/messages`，OpenAI 系列为 `/v1/responses`，其余为 `/v1/chat/completions`。思考档位优先取站点 Codex 清单，其次取 [models.dev](https://models.dev) 官方条目，再保留 magpie 已知档位；仍未知的思考模型使用 `low` / `medium` / `high`。models.dev 同时补充上下文、输出上限和 interleaved 能力，一天缓存一次，网络不可用不阻断模型列表。

## 路由方式由你决定

在 magpie 里按需要配置账号或路由组，例如按用量最少、按顺序，或使用最便宜路由组。插件不会选一种策略、修改你的顺序或创建路由组。订阅窗口与余额是不同事实；不要把订阅标价误当成当前请求一定从钱包扣款的报价。

插件会把站点已知的拒绝原因整理成 magpie 能理解的额度、余额、登录或短期限流错误；需要的重置时间只取该账号最近一次用量读数，没有读数时不猜。

## 地址与兼容读取

默认连接 `https://api.jmds.dev`，正常使用不用配置。测试其他部署时可覆盖整个插件的地址，不在登录时询问：

```sh
magpie plugin options magpie-jmds '{"baseURL":"https://api.example.com"}'
```

用量和模型价格来自 `/v1/sub2api/key-status`。接口返回 404 时，自动改用旧用量接口和 `/v1/models`；旧接口无法同时提供所有限制、额外用量池、钱包路由读数及模型价格，因此只展示其实际返回的信息。其他错误不会当作 404 降级。

## 开发与测试

需要 Node.js ≥ 20 和 Docker，无 npm 依赖。

```sh
SUB2API_IMAGE=sub2api-fork:key-status ./test/run.sh
SUB2API_IMAGE=weishaw/sub2api:latest ./test/run.sh
```

`SUB2API_IMAGE` 是完整镜像引用，本地已有镜像直接使用。测试启动独立的临时网关、Postgres、Redis 和假模型上游，发送真实请求后调用插件 hooks。测试结束会清理容器及卷，输出在 `test/artifacts/<镜像标签>/`。

真实 magpie 手动冒烟会发送一条真实模型请求，可能计费；配置与登录保存在 `.e2e/`，不碰日常配置：

```sh
JMDS_KEY=sk-... JMDS_NAME=测试 ./e2e.sh
# 可选 JMDS_BASE_URL；MAGPIE 可指定二进制路径
```

发布流程见 [RELEASE.md](./RELEASE.md)。

## 许可证

MIT。图标为 jmds 站点图标。

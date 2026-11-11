# magpie-route-cost

Usage and cost for Magpie in one page: **one row per model**, with every agent and provider behind it, a provider speed/reliability view, and a request log.  
在 Magpie 里按模型、Agent、Provider 拆开用量与成本，并给出供应商速度/成功率视图和逐条请求日志。

![Models](docs/screenshot-models.png)

## 中文

### 这是什么

Magpie 的账本会记录每次请求实际落到的模型和价格，但不会把同一模型在不同 Provider、不同 Agent 下的用量合并展示。这个页面补齐这一层：

- **按模型合并**：`kimi-k3.1-pro`、`kimi-k3.1-pro-max`、`k3d1-agent`、`kmodel_latest` 都归为 **Kimi K3.1 Pro**，不再出现四个 K3.1。
- **按 Agent × Provider 展开**：每个模型点开后能看到不同 Agent 在不同 Provider 的请求数、成本、Tokens、成功率、速度和首字延迟。
- **供应商视图**：按 Provider 汇总，展开到 Agent × 模型，用来看不同 Agent 下这个供应商的速度和稳定性。
- **请求日志**：逐条请求，带分页；时间、Agent、Provider、模型、路由、成本、Tokens、状态、速度、首字。

数据来自 Magpie 网关和 CC Switch 本地账本，默认去重：Magpie 网关为准，CC Switch 只补每个 Agent 在网关首次出现之前的历史。页面上约 4 个真实模型、10 个供应商。

### 功能

- 今天 / 7 天 / 30 天 / 全部；Agent / Provider / 模型筛选（带厂商图标）；搜索。
- **最少 Tokens** 阈值（默认 1M），过滤只跑过测试的模型。
- USD / CNY 切换；汇率默认 6.8（和 CC Switch 显示一致），可在插件选项 `usdCny` 修改。
- 53 周用量热力图、总成本 / 请求数 / Tokens / 缓存命中率。
- 不显示 Credits：不同 Agent 的积分不可比。
- 列表价为 0 的显示“未定价”，不显示“免费”；使用免费不等于模型定价免费。
- 系统探测（curl / node / Session / Magpie）不单独成为 Agent 或 Provider 行，也不进明细。

### 安装

```sh
magpie plugin add github:2250750360-boop/magpie-route-cost
```

也可以从本地路径安装：

```sh
magpie plugin add /path/to/magpie-route-cost
```

安装后在 Magpie 侧边栏打开 **用量成本 / Usage cost**，服务只监听 `127.0.0.1:3495`。

### 数据与隐私

- Magpie 网关：`GET /v1/magpie/usage/requests`、`GET /v1/models`。
- CC Switch：`~/.cc-switch/cc-switch.db`（只读，`bun:sqlite` 或 `node:sqlite`）。
- Magpie 配置：`providers.json`、`settings.json`（只读）。
- 不写回任何账本或配置；只写本机缓存令牌和浏览器本地筛选偏好。
- 数据全部在本机聚合，不上传。

### 开发

```sh
node serve.mjs --port 3495
node --test test/*.test.mjs
```

### 图标与商标

厂商图标来自 CC Switch（MIT）和 Magpie 的 `page-agent-office` 图标集，仅用于识别 Provider；商标归各自厂商所有。详见 [NOTICE](NOTICE)。

### 许可证

MIT，见 [LICENSE](LICENSE)。

## English

### What it is

Magpie's ledger records the model that served each request and the price it applied, but it does not fold the same model across providers and agents into one line. This page does:

- **One row per model**: `kimi-k3.1-pro`, `kimi-k3.1-pro-max`, `k3d1-agent` and `kmodel_latest` all become **Kimi K3.1 Pro**.
- **Agent × Provider detail**: open a model for requests, cost, tokens, success rate, output speed and first-token time under each agent and provider.
- **Providers**: per-provider totals and speed/reliability, expandable to Agent × model.
- **Request log**: one row per request with pagination.

Data comes from Magpie's gateway and CC Switch's local ledger. Deduplicated by default: the gateway is the request of record, and CC Switch fills the history before each agent's first gateway call.

### Features

- Today / 7 days / 30 days / all; agent, provider and model filters with vendor icons; search.
- **Minimum tokens** threshold (1M by default) hides test-only models.
- USD / CNY switch; rate is `usdCny` (6.8 by default, the rate CC Switch shows).
- 53-week heatmap; cost, requests, tokens and cache hit.
- No Credits: different agents' credits are not comparable.
- A zero list price is shown as **unpriced**, never as a free model.
- System probes (`curl`, `node`, `Session`, `Magpie`) are not separate agents or provider rows and stay out of the detail views.

### Install

```sh
magpie plugin add github:2250750360-boop/magpie-route-cost
```

Or from a local path:

```sh
magpie plugin add /path/to/magpie-route-cost
```

Open **Usage cost** under Plugins. The service listens on `127.0.0.1:3495` only.

### Data and privacy

- Magpie gateway: `GET /v1/magpie/usage/requests`, `GET /v1/models`.
- CC Switch: `~/.cc-switch/cc-switch.db`, read-only through `bun:sqlite` inside Magpie or `node:sqlite` in plain Node.
- Magpie config: `providers.json`, `settings.json` (read-only).
- Nothing is written back; only the local token cache and browser filter preferences.
- Aggregation stays local; nothing is uploaded.

### Develop

```sh
node serve.mjs --port 3495
node --test test/*.test.mjs
```

### Icons and trademarks

Vendor icons come from CC Switch (MIT) and Magpie's `page-agent-office` set, used only to identify providers. All trademarks belong to their owners. See [NOTICE](NOTICE).

### License

MIT. See [LICENSE](LICENSE).

## Screens

![Providers](docs/screenshot-providers.png)

![Request log](docs/screenshot-log.png)

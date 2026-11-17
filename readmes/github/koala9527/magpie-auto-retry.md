<div align="center">
  <img src="ui/icon.svg" width="64" height="64" alt="Magpie Auto Retry" />
  <h1>Magpie Auto Retry</h1>
  <p>让任务等到提供商恢复，而不是等到重试次数用完。</p>
  <p><a href="README.en.md">English</a> · <a href="https://usemagpie.ai/docs/zh/plugins">Magpie 插件文档</a> · <a href="docs/architecture.md">架构</a> · <a href="docs/api.md">管理 API</a></p>
</div>

## 做什么

- **默认无限重试**：连接失败、408/425/429/5xx、单次超时持续重试，没有次数和总故障时长上限。
- **自动愈合**：持有同一个推理请求，提供商恢复后返回结果，Agent 继续当前任务，不消耗它自己的有限重试预算。
- **流式保活**：等待期间发送 SSE 注释心跳；输出前的流内错误、空流、断流可以重试。
- **不重复执行**：已经输出文本、思考或工具调用的请求不会从头重放；用户取消、断开或关闭服务立即中止。
- **本地仪表台**：设置热更新、当前等待请求、按提供商的失败/重试/恢复、故障区间、观测可用时长和可用率。
- **轻量开源**：原生 HTML/CSS/JS，零运行时依赖，无遥测、外部字体或 CDN；MIT。

## 安装与接入

### 1. 添加 Magpie 插件

```sh
magpie plugin add github:koala9527/magpie-auto-retry
```

在 Magpie 的插件列表中启用它，侧边栏出现 **自动重试**。插件通过官方本地服务机制运行，监听 `127.0.0.1:3430`。

### 2. 让 Agent 使用重试地址

只把 Agent 原来指向 Magpie 的 API 基址改为：

```text
http://127.0.0.1:3430/v1
```

**原来的模型名（例如 `provider/model`）、Magpie key、协议和任务保持不变。** 本机 Magpie 的默认网关是 `http://127.0.0.1:3425`；改过网关端口时，在仪表台的设置里填实际地址。

```text
Agent ──► Auto Retry :3430 ──► Magpie :3425 ──► Provider
              │
              └── 本地设置与观测仪表台
```

服务转发 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 和 Gemini 的 `/v1beta/models/<id>:generateContent` / `:streamGenerateContent`（`<id>` 支持 `provider/model` 与模型冒号标签）；`GET /v1/models` 用于读取原有模型列表。文件上传、删除、工具执行等接口不在代理链路中。

插件不会自动改写任何 Agent 的配置文件。直接使用 Anthropic 客户端时，其地址通常填 `http://127.0.0.1:3430`，由 SDK 添加 `/v1/messages`；OpenAI 兼容客户端通常填带 `/v1` 的地址。

### 本地开发或独立启动

需要 Node.js 22+；Magpie 插件运行在它管理的 Bun 宿主里，不需要另装 Node。

```sh
git clone https://github.com/koala9527/magpie-auto-retry.git
cd magpie-auto-retry
npm ci --ignore-scripts
npm run dev
# 打开 http://127.0.0.1:3430/
```

```sh
node bin/magpie-auto-retry.mjs --port 3430 --upstream http://127.0.0.1:3425 --data-dir .local/state
```

独立启动时，未启用配套中间件的提供商按请求模型归属；路由组的名字不是它背后的真实提供商。作为 Magpie 插件安装时，随包的无 I/O 中间件传递实际响应提供商的 id/name，服务在返回给 Agent 前去掉该标记。

## 设置

仪表台的设置保存后立即应用到后续尝试，活跃请求不因保存而重启。恢复默认只回填表单，仍需点击保存。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 自动重试 | 开启 | 关闭后只尝试一次；已等待的请求停止重试 |
| 初始等待 | 2 秒 | 指数退避的起点 |
| 最大等待 | 60 秒 | 退避封顶；提供商的 `Retry-After` 可以要求更久，最长 24 小时 |
| 随机抖动 | 开启 | ±25%，减轻同时恢复时的重试风暴 |
| 单次超时 | 120 秒 | fetch 响应头及非流式回复的等待上限，不是任务总时限 |
| 流空闲超时 | 120 秒 | 上游长时间没有数据时识别断流 |
| 心跳间隔 | 10 秒 | SSE 注释，不混入模型正文 |
| 并发请求 | 32 | 满载返回 429；无限重试不等于无限内存 |
| 历史保留 | 30 天 | 可设置 1–90 天，按小时聚合 |
| Magpie 上游 | `http://127.0.0.1:3425` | 仅本机 loopback，禁止代理回环 |

启动端口在 Magpie 插件选项里设置，修改后重启插件：

```sh
magpie plugin options magpie-auto-retry '{"port":3430,"upstreamUrl":"http://127.0.0.1:3425"}'
```

其中上游选项用于首次初始化；之后以仪表台保存的设置为准。界面中的设置与统计归本插件自己的数据目录管理。

## 统计口径

- **失败次数**是失败的上游尝试数，不是用户任务数；同一请求可以失败很多次后成功。
- **恢复请求**是经历至少一次失败、随后完整成功的请求。
- **观测可用时长**只累计真实成功之后的有效观测区间；失败之后累计故障观测区间。
- 无流量超过 **5 分钟**即视为未知；服务离线/重启间隙不计为可用。没有观测的可用率显示 `—`，不是 100%。
- 可用率 = 观测可用时长 /（观测可用时长 + 观测故障时长）。它是被动观测指标，不是主动探活 SLA，也不是账户额度。
- 一个 Magpie 路由请求可能在内部尝试多个成员；仪表台记录重试服务实际收到的结果，不推断被网关隐藏的每次内部尝试。

## 任务与错误语义

临时故障持续重试。401/403、无效请求/模型和明确的余额不足直接交回客户端处理，不当作成功或无限认证刷新。

“继续任务”指**客户端请求仍然存续**时恢复后继续。用户已取消、Agent 进程已退出、服务已重启的请求不持久化重放。部分输出后的断流发送原协议错误并结束，避免重复文字、推理或工具调用；客户端负责后续任务生命周期。非流式客户端的 HTTP 总超时也由客户端配置。

## 数据与隐私

插件模式保存到 Magpie 配置目录下的 `magpie-auto-retry/`；独立模式默认 `~/.magpie-auto-retry/`，可用 `--data-dir` 指定。

- `settings.json`：非敏感设置。
- `statistics.json`：提供商 id/name、聚合计数、小时观测、故障区间、最近 200 条结构化事件。
- 推理请求/认证头仅在内存中驻留。提示词、对话、工具参数、密钥和账号不写入日志、统计或导出文件。
- 页面只访问自己的服务。管理 API 使用每次启动随机令牌，校验 Host/Origin；推理接口拒绝浏览器 Origin。本服务只绑定 loopback，Magpie key 原样转发。
- 损坏的状态文件保留为 `.corrupt-<时间>`；落盘异常显示存储状态，不伪装成保存成功。
- 导出会打开可选择/复制的聚合 JSON 对话框，兼容 Magpie 的沙盒；独立浏览器可另点击下载。

## 验证与贡献

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm pack
```

测试包含真实 loopback HTTP/SSE 恢复、1001 次失败、取消、热停用、不重放工具调用、协议终止帧、权限边界、持久化及真实浏览器页面。[1.0.0 验证记录](docs/verification.md)包含官方宿主和覆盖率结果。完整标准见 [CONSTRAINTS.md](CONSTRAINTS.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 回退

将 Agent 基址改回原来的 Magpie 地址，停用或移除插件即可。它没有改动提供商账号、Agent 文件或 Magpie 本身。数据需要时可先从页面导出。

## License

[MIT](LICENSE) · [koala9527/magpie-auto-retry](https://github.com/koala9527/magpie-auto-retry)

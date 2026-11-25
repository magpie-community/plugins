<p align="center"><img src="logo.png" width="96" height="96" alt="AG Relay 标志"></p>
<h1 align="center">AG Relay · 喜鹊插件</h1>
<p align="center">少打一次「继续」，让任务接着跑。</p>

[AG Relay 桌面网关](https://github.com/xinxinxiaoxin/ag-relay) 的独立喜鹊版。Claude 或 Codex 遇到 AgentRouter 限流、空回，或者刚开始思考就断流时，插件在当前请求里尝试恢复。只需一个模型 Key，不用启动桌面网关，也不用把客户端指向 `8787`。

## 安装与试用

在装有喜鹊的电脑上运行：

```sh
magpie plugin add github:xinxinxiaoxin/magpie-agentrouter-relay
```

1. 图形界面入口：**插件 → 发现 → 非官方插件 · GitHub**，搜索 `AG Relay`。保持喜鹊内置的 Middleware 功能开启。
2. 在喜鹊找到 **AgentRouter · AG Relay**。只聊天就选 **AgentRouter API Key**，填模型 Key。还要查余额就选 **API Key + 可选账户余额**，依次填 **模型 API Key → AgentRouter 用户 ID → 系统访问令牌**。已有模型 Key 可以继续用，旧提供商不用删除。系统访问令牌只用于本站 `/api/user/self`，不用于模型转发。
3. 在一条新对话中选择 `agentrouter-relay/gpt-6.1-sol`，或在供应商里手填账号可用的模型名。插件在本地声明 Responses 接口，不向 AgentRouter 请求模型列表；列表中的名称不代表账号一定有权限。Claude Desktop 发来的 Messages 由喜鹊转换成 Responses。

**透传客户端 UA** 是供应商里的勾选项，默认开启。模型请求和重试沿用本次请求的 `User-Agent`。关闭后使用发送请求的运行时默认值，不拦截请求。余额查询不借用上一条请求的 UA。

**临时限流由插件重试** 也默认开启。关闭时，插件仍识别 HTTP、JSON 或正文前 SSE 中的普通限流，返回 429，由喜鹊决定下一次尝试。不会关闭历史修复或流式保护。提供商开关通过界面保存后对下一次调用生效。

**最长重试等待**：在「插件 → 已安装 → AG Relay → 选项」的 JSON 中填写 `{"retryBudgetSeconds": 60}`。支持 1 至 300 整数秒，默认 300 秒，同一条请求的后续宿主重试不会重新计时。沿用旧网关预留 30 秒给下一次发送的规则，设置得太短可能只发一次。它不是输出超时，不中途截断健康长回复。

余额区分「未配置余额查询」「查询失败」和真实金额（包括 `$0.00`）。只填模型 Key 不会查询余额，站点余额查询失败不影响聊天。

## 行为与限制

**与桌面版对照：** 沿用错误分类、Codex/通用组历史处理和正文交付前的重试规则。7 组对照用同一假上游验证了正常首发、HTTP 限流、200 内嵌限流、鉴权失败、历史修复、流式前导重试和工具已下发这七种场景；新旧两边的实际发送次数、请求体和客户端回复一致。插件不是桌面程序的逐项复制：喜鹊可以再次调用 Provider，因此插件跨调用共用预算；遇到未知流式载荷时优先交付，不冒重放风险。插件已在隔离喜鹊验证，尚未使用真实 AgentRouter 账号完成线上验收。

- 默认每个带请求标记的客户端请求最多实际向上游发送 **110 次，300 秒**内准入新尝试；明确的历史错误有更小的专用上限。有效 `Retry-After` 超出预算时不提前重发。已开始的健康长回复不按总预算截断。
- 中间件仅在选中本插件时标记一次客户端请求，Provider 在发送前移除标记。插件按同一请求共享计数；结束或已经交付后，重复的宿主尝试不再发送。同一次普通限流交由宿主时，宿主再次调用也继续计数。缺少标记时（如某些宿主内部请求）每次 Provider 调用最多只发送一次，不开启长重试；此时无法跨宿主调用共享计数。手动重发或客户端重新发起的请求本来就是新请求。
- 已知客户端的正文前思考及只读搜索失败可在插件内恢复。正文、客户端工具或未知内容交付后不重放。有人在生成过程中取消、或在退避等待时取消，都会中止当前工作。
- Codex 与 Claude 由调用方身份和实际协议判定，不靠模型名猜。明确历史错误允许去旧推理；不是每次限流都删历史。保留工具调用与结果的配对，不能安全改写的服务端引用不盲删。宿主可能把双协议模型的 Messages 转为 Responses；插件按**实际收到**的协议处理。
- 余额使用 `data.quota / 500000` 美元。查询失败不等于余额为零；模型 Key 和可选的余额凭据由喜鹊保存。本插件不接收自定义上游地址，不跟随跨站重定向，不写会话、凭据或请求日志。

## 修改策略

| 文件 | 修改什么 |
| --- | --- |
| `lib/settings.mjs` | 次数、时间、流式限制、Codex/通用组默认策略 |
| `lib/relay-core.mjs` | AgentRouter 错误分类、历史修复、重试编排、流式交付判断 |
| `relay.middleware.mjs`、`lib/transport.mjs` | 宿主重复调用的关联、实际发送预算、取消和流式背压 |
| `lib/provider.mjs`、`lib/balance.mjs` | 喜鹊接口、本地模型声明、UA 透传、限流开关和可选余额 |

## 验证与打包

Node.js 24：`npm test`。Windows x64 隔离宿主验证使用已安装的喜鹊和 Bun；`npm install --prefix .local-tools --ignore-scripts --no-audit --no-fund @oven/bun-windows-x64@1.4.5` 可只为本仓库准备测试 Bun。默认安装路径运行 `npm run test:host`，或指定可执行文件：

```powershell
node tests/magpie-host.mjs <magpie.exe> <bun.exe>
node tests/parity.mjs <旧版的relay-retry-proxy.mjs>
npm pack --pack-destination .
node tests/magpie-host.mjs <magpie.exe> <bun.exe> ./magpie-agentrouter-relay-0.1.0-rc.4.tgz
```

`parity` 核对旧源码哈希后另起测试进程，两边使用同一回环假上游，比较发送次数、实际请求体和客户端输出。对照脚本不是运行依赖。宿主测试使用独立配置、假账号和随机回环端口；带归档时先验证原包无凭据加载，再使用测试专用入口，把同一份包内实现接到可观测的假上游。持续 429 用缩小到 3 次的预算验收两层重试是否相乘。

通过 GitHub 分发，未发布到 npm。问题反馈请附上客户端、协议和错误类型，不要附模型 Key、管理令牌或完整会话。

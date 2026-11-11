# Magpie for AgentRouter

**自动重试，少传一点，连接更稳一点。**

面向 [Magpie](https://github.com/yetone/magpie) 的 [AgentRouter](https://agentrouter.org) Provider 插件。把自动重试、多账号接续和 gzip 请求压缩接入 Magpie：临时上游故障交给重试链路处理，长对话通过压缩减少上传数据。

## 安装

在已经安装 Magpie 的终端运行：

```sh
magpie plugin add github:Molaison/magpie-agentrouter
magpie plugin login agentrouter-retry
```

登录时输入自己的 AgentRouter API key。需要多个账号时，再次登录添加；随后在 Magpie 中选择 **AgentRouter Retry** 下的模型。账号轮换范围由 Magpie 的账号启用状态和路由配置决定。

也可以从源码安装：

```sh
git clone https://github.com/Molaison/magpie-agentrouter.git
cd magpie-agentrouter
npm ci --ignore-scripts
magpie plugin add .
```

使用 Magpie 插件运行时。独立运行源码或测试需 Node.js 20.18.1 及以上。当前发布验收基于 Windows、Magpie 0.1.3694；其他版本和平台未做完整矩阵测试。

## 插件市场发现

仓库带有 Magpie 官方发现机制要求的 **`magpie-plugin`** GitHub topic。Magpie 的 Plugins → Discover（发现）通过这个 topic 扫描独立插件：默认分支根目录的 `package.json` 声明 `main` Provider 入口，以及 `magpie.middleware` 请求中间件；`magpie.name` 和中英文 `magpie.summary` 提供卡片展示信息。

官方发现目录按计划每小时第 7、37 分钟更新，客户端还有缓存，因此新发布或更新可能需要等待刷新。这是独立作者插件的发现渠道；社区审核推荐列表由 `magpie-community/plugins/registry.json` 单独维护。本插件通过 GitHub 安装，无需先发布到 npm。

## 两个核心功能

### 1. 自动重试与多账号接续

- 接入 Magpie 原生账号系统：每次调用获取当前选中的账号，不在插件里保存另一份 API key。
- 对临时上游故障、限流、账号额度及超时进行分类处理，将失败结果交回 Magpie 的账号重试和轮换流程。
- 分别管理连接、响应头、首个有效输出和输出空闲超时。
- 保留客户端取消；已经向客户端发送有效输出后，不在插件内透明重放生成请求。

**重试由插件和 Magpie 配合完成。** AgentRouter 模式下，每次原生账号调用只执行一次上游尝试；账号切换、重试轮次、冷却及等待节奏由 Magpie 管理。添加第二个账号能增加可轮换候选，但不保证上游故障一定恢复。

超时或断线后，上游是否已经执行可能无法确定；重试不提供“恰好执行一次”的保证。

### 2. gzip 请求压缩

默认启用，作用于 AgentRouter 的 **`/v1/responses`** 请求：

1. 完成请求整理，再序列化最终 JSON。
2. JSON 正文达到 **64 KiB** 时尝试 gzip。
3. **只有压缩后更小才发送 gzip**，并设置 `Content-Encoding: gzip`；小请求保持原样。

压缩的是上传的请求字节，不裁剪对话、不减少上下文 token，也不改变 JSON 内容。长对话、重复结构和工具定义较多时，减少上传数据可以降低传输开销；实际端到端加速取决于网络和上游处理时间，不承诺固定倍数。

`/messages` 和 `/responses/compact` 不走这个 gzip 分支。压缩格式为 gzip，不使用 zstd。

## 默认时间设置

| 设置 | 默认值 |
| --- | --- |
| 连接上限（自管直连/HTTP 代理） | 5 秒 |
| 响应头等待 | 45 秒 |
| 首个有效输出等待 | 120 秒 |
| 输出空闲等待 | 90 秒 |
| 插件共享总预算 | 不额外限制（`budgetMs: 0`） |
| 插件共享尝试次数上限 | 100,000；每次原生账号调用仍只执行一次尝试 |

这些值沿用本地 AgentRouter 设置。响应头等待包含请求发送阶段；连接上限仅在插件自管连接时生效，继承 Magpie 代理的请求由宿主管理连接。它们不代表 Magpie 整条调用链的最终上限。

## 请求与工具兼容

支持 Responses 和 Anthropic Messages 请求路径，保留原始请求结构，整理可迁移的 Responses 历史项并去重工具定义。模型及推理档位在 `agentrouter/index.mjs` 定义；当前公布 low、medium、high、xhigh、max。

可选的稳定工具标识中间件位于 `agentrouter/stable-tools.middleware.js`，默认不额外注册。

## 验证

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

测试覆盖发布入口、默认压缩可达性、gzip 解码后的正文、小请求直传、临时失败后重试、永久请求错误停止重试和客户端取消。测试使用合成输入和替代上游，不使用个人 key 或真实会话；这不等同于完整线上性能测试。

## 项目说明

这是独立社区插件，不隶属于 Magpie 或 AgentRouter。公开包不包含账号、日志、个人模型目录和本机工具快照。压缩与重试不需要修改 Magpie 主程序。

问题反馈请到 [Issues](https://github.com/Molaison/magpie-agentrouter/issues)，附 Magpie 版本、错误类型和已脱敏的复现步骤。

MIT License.

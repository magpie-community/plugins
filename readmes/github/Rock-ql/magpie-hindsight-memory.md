# magpie-hindsight-memory

把 Docker 里的 **Hindsight 记忆库** 当成 magpie 的一个 **Agent** 接进来：在 magpie 的 **Agents 页**给这个 Agent 选模型，插件会把选择同步成 hindsight 容器里 5 个对话角色的模型环境变量，并用新 env 重建容器；断开（或换模型）时自动恢复/切换。

```
magpie Agents 页                    插件宿主（Bun）                         hindsight 容器（Docker）
┌────────────────────┐   bridge.json  ┌──────────────────────┐   docker run  ┌───────────────────────┐
│ Hindsight 记忆库    │ ─────────────▶ │ 盯桥接文件 → 换算 env │ ────────────▶ │ 5 个角色改走 magpie    │
│   模型: <选一个>    │   (magpie 写)  │ 备份旧容器 → 重建     │  同一卷/端口  │ embedding/rerank 不动  │
└────────────────────┘                └──────────────────────┘               └───────────────────────┘
                                              │ 断开：恢复原 env → 再重建
                                              ▼
                                       回到连接前的模型配置
```

## 它接管什么

hindsight 的模型是**启动时读的环境变量**，没有运行时改模型的接口，所以「同步」= 用新 env 重建容器。插件改的是这 5 个角色（都指向 magpie 网关 + 你选的模型）：

| 角色 | 环境变量前缀 |
| --- | --- |
| 默认 LLM（查询分析等） | `HINDSIGHT_API_LLM_*` |
| 抽取 retain | `HINDSIGHT_API_RETAIN_LLM_*` |
| 反思 reflect | `HINDSIGHT_API_REFLECT_LLM_*` |
| 归并 consolidation | `HINDSIGHT_API_CONSOLIDATION_LLM_*` |
| 知识页刷新 | `HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_*` |

**不动**：嵌入（`HINDSIGHT_API_EMBEDDINGS_*`）、重排（`HINDSIGHT_API_RERANKER_*`）以及容器里其它一切设置（卷、端口、重启策略、超时/并发等），都会按原样保留。需要单独改嵌入/重排时，用下面的插件选项显式写端点。

## 要求

- magpie `0.1.3697+`（用 `magpie.page.service` 之前就够；本插件只要 Agent 机制）
- Docker 与 `docker` 命令行在本机可用，容器名默认 `hindsight`
- 容器能从内部访问 `host.docker.internal:<magpie 网关端口>`（macOS / Windows 的 Docker Desktop 默认可以；Linux 需要给容器加 `--add-host=host.docker.internal:host-gateway`）
- hindsight 镜像 `ghcr.io/vectorize-io/hindsight`（API 1.2.0 起环境变量如本页所列）

## 安装

```sh
magpie plugin add github:Rock-ql/magpie-hindsight-memory
# 或者从文件夹就地加载
magpie plugin add /path/to/magpie-hindsight-memory
```

装好后在 **Agents 页** 会多一行「Hindsight 记忆库」：选一个模型 → 打开连接。插件后台会开始同步，约 10～30 秒后 hindsight 的 5 个角色全部走 magpie。换模型会再重建一次；断开则恢复连接前的配置。

命令行同样可以：

```sh
magpie ls                          # 确认出现 Hindsight 记忆库
magpie hindsight-memory workbuddy/deepseek-v4.1-flash   # 选模型（= Agents 页选择）
magpie hindsight-memory default    # 断开并恢复
```

## 插件选项

Agent 插件没有独立界面，需要更细的控制时用插件选项（写在 `~/.magpie-agent/hindsight-memory/options.json`，或走 magpie 的插件选项入口）：

```json
{
  "container": "hindsight",
  "hindsightUrl": "http://127.0.0.1:8888",
  "dryRun": false,
  "roles": {
    "reflect": "deepseek/deepseek-chat",
    "consolidation": "group/develop"
  },
  "embeddings": { "base": "https://api.siliconflow.cn/v1", "model": "BAAI/bge-m3", "key": "sk-…" },
  "reranker": { "base": "https://api.siliconflow.cn/v1", "model": "BAAI/bge-reranker-v2-m3" }
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `container` | `hindsight` | Docker 容器名 |
| `hindsightUrl` | `http://127.0.0.1:8888` | 用来等容器就绪的地址 |
| `dryRun` | `false` | 只把要改的 env 打进日志，不重建容器（第一次接建议先开一次） |
| `roles` | `{}` | 给单个对话角色覆盖模型；没写的角色跟随 Agents 页选的模型 |
| `embeddings` / `reranker` | 未设置 | 只有显式写了才改；嵌入换模型会改向量维度，需先清空已有 embedding |
| `pollMs` | `2000` | 轮询桥接文件的间隔 |

> 换嵌入模型会把向量维度改掉：库里已有 embedding 时 hindsight 会启动失败，必须先清空 `memory_units` / `mental_models` 的 embedding 再重嵌入。插件不会替你清库。

## 同步与安全

- **桥接文件**：magpie 把选择写到 `~/.magpie-agent/hindsight-memory/bridge.json`；插件轮询它，要求文件连续两轮不变才动手（避免读到半个写入）。
- **备份**：每次重建前把旧容器 `docker rename` 成 `hindsight-bak-<时间>` 并停掉（数据卷不动），同时把这次要用的 env 完整写进 `~/.magpie-agent/hindsight-memory/panel/backups/apply-*.json`（权限 600）。
- **失败自动回滚**：新容器起不来或 4 分钟内没就绪，插件会把失败的容器删掉、把旧容器改回原名并启动，日志里写明原因；同一改动 2 分钟后才会再试，避免反复重启。
- **断开恢复**：连接前的原值记在 `state.json` 的 `applied.previous` 里；断开时把原值写回、把插件新加的键删掉，再重建一次。实测恢复后容器 env 与连接前逐行一致。
- **耗时**：实测「改 19 个 env + 重建 + 等到 `/version` 就绪」约 12～15 秒；期间记忆检索会失败，MCP 客户端下一次调用会自动重连。

## magpie 侧的可见性

hindsight 的请求会带上这个 Agent 自己的网关 key，所以 magpie 的用量页会把它们记成 **agent: hindsight** 的调用（实测 `usage.jsonl` 里 `agent=hindsight`、`provider=workbuddy`）。hindsight 自己的请求记录 / 分类统计也仍然可用：

```sh
curl -s 'http://127.0.0.1:8888/v1/default/banks/<bank>/llm-requests/stats?period=7d&split_by=operation'
curl -s 'http://127.0.0.1:8888/v1/default/banks/<bank>/llm-requests?limit=20&call_type=llm'
```

注意 hindsight 默认只保留 **1 天** 的请求记录（`HINDSIGHT_API_LLM_TRACE_RETENTION_DAYS=1`），要更久就自己在容器的 env 里调大。

## 开发与测试

```sh
bun test        # 桥接解析、角色 env 换算、diff/恢复、同步状态机（21 个用例，不碰真容器）
```

目录：

```
package.json         插件清单（magpie.agent + 选项默认值）
hindsight.agent.js   Agent 声明与 connect()（moejs，不能读写文件）
index.mjs            宿主入口：启动同步引擎
lib/bridge.mjs       bridge.json 解析、校验、容器内网关地址换算
lib/roles.mjs        7 个角色 ↔ env，magpie 模型 → env，diff / 原值快照 / 恢复
lib/engine.mjs       轮询、去抖、应用、断开恢复、失败退避
lib/docker.mjs       inspect、docker run 参数、备份重建、健康检查、回滚
lib/state-store.mjs  state.json 读写
test/                单测
```

## 已知限制

- 只支持本机 Docker（插件用 `docker` 命令行）；远程 Docker 需要自行配置 `DOCKER_HOST`。
- 容器必须能访问 `host.docker.internal`；Linux 上要像上面那样加 host-gateway。
- 换模型会重建设置：正在跑的 retain/reflect 会被中断（hindsight 自己会重试或留下失败操作）。
- 嵌入 / 重排不在「跟随 Agent 模型」的范围内（magpie 的 `/v1/models` 不暴露这两类模型）。

## License

MIT

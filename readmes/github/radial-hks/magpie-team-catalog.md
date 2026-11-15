# magpie-team-catalog

一个 magpie 插件：把团队内部的公共资源——自研 / 公共服务提供的 CLI 工具、GitHub / P4 等项目地址——集中注册在一处，然后：

1. **让每个 Agent 显式可调**（探测后把团队 skill 落盘到 `~/.agents/skills`，附本机路径/版本，分发交 `magpie library`）；
2. **让每个 Agent 能查详情**（经 `/mcp/magpie/tools` 的 `catalog` 工具：用法、版本、安装方式、项目地址）;
3. **让人能看能配**（窗口页面：浏览目录、按本机覆盖路径 / 禁用条目）；
4. 可选回退：`injectIndex: true` 时回到网关中间件往 system prompt 注索引的旧形态。

新增：**团队目录 + 个人注册层**。页面可增删改个人 CLI、扫描 npm 全局命令候选，
个人文件保存在插件目录之外，不受团队刷新/插件升级影响。包名可与命令名不同；
扫描不自动执行候选 CLI。详见 [docs/personal-registry.md](docs/personal-registry.md)。

团队声明（应该有什么）与本机实测态（这台机器上真有什么）彻底分离；探测只读、
fail-open，不负责安装 CLI。用户确认后可写个人注册/本机覆盖，可随时关闭；
个人注册文件保留，便于恢复与备份。

> 状态：**本机核心功能完成**：团队/个人 CLI 注册、Git/P4 项目与工作区管理、
> GUI 和分页只读 MCP 均已验收；当前 UI 与分发配置优化后共 137 项测试通过。历史核心阶段记录见
> [docs/milestone-projects-mcp.md](docs/milestone-projects-mcp.md)。
> Skill 导出/提示词注入默认关闭；团队 npm 发布、双机同步、Skill/library 分发实机验收
> 属于后续部署项，见 [docs/plan.md](docs/plan.md)。使用与部署见 [docs/usage.md](docs/usage.md)。

## 从仓库安装

在 magpie 的“添加插件”地址输入框填：

```text
github:radial-hks/magpie-team-catalog
```

CLI：`magpie plugin add github:radial-hks/magpie-team-catalog`。
源码入口已提交，不需要安装时构建。**仓库已公开，并设置 `magpie-plugin` topic**；
可使用仓库地址安装。市场“非官方 GitHub 插件”发现受 GitHub 搜索缓存/索引延迟影响，
不代表官方审核。
完整地址、私有仓库排障、更新和离线分发见 [docs/distribution.md](docs/distribution.md)。

## 使用手册

首次使用请从 **[使用指南手册](docs/usage.md)** 开始：安装 → CLI 注册 → 本机覆盖 →
Git/P4 项目与工作区 → 插件设置 → MCP 查询 → 备份与排障。
常用按钮和保存步骤速查见 **[UI 操作速查](docs/ui-guide.md)**。

## 本机开发项目（Git / P4）

页面支持注册本机项目、按明确目录发现 Git 仓库、授权查询 P4 Client，
以及为团队项目绑定本机路径/工作区。MCP 返回项目路径、Git branch/HEAD、P4 元数据；
周期刷新不访问 Git remote/P4 server，不自动同步/提交。见 [docs/local-projects.md](docs/local-projects.md)。

## skill 落盘（F3/F4，主路径，默认关）

开启后，每轮探测把「团队 skill 仓库」里的 `skills/<id>/SKILL.md` 与本机实测数据
合成，写到 `~/.agents/skills/team-<id>/`：实测块含真实绝对路径与版本，未安装/
禁用的工具不生成或移除，只碰带托管标记的文件，内容不变不重写。

分发交给 magpie 自己的 library：hand-over 一次之后，插件检测到 library 副本
就改维护那里（不再重建共享点副本），内容变化时自动 `magpie library sync`
重推给各 Agent。skill 源仓库是独立公共仓库（与 CLI 一起发版）。

完整选项、三条使用路径与工作机部署清单见 **[docs/usage.md](docs/usage.md)**；
分发命令先看：

```sh
magpie library skill hand-over <name>   # 搬进 library 记账（一次）
magpie library skill agents <name> …    # 指定给哪些 Agent
magpie library skill router on          # 或聚合入口按需读取
```

## registry 数据源

`options.registry` 支持三种形态（详见 [registry-workflow.md](docs/registry-workflow.md)）：

- 本地路径 / `file://`（单机试运行）；
- `http(s)://…/registry.yaml`：后台刷新时下载，失败保留已有文件；MCP 仅读来源匹配的缓存；
- git 仓库（`git@…` / `git+https://…` / `https://….git`，可带 `#ref`）：
  首次 clone、之后 fetch+reset，凭据走本机 git 配置，刷新失败沿用缓存。

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 插件入口：后台 worker 触发、`catalog` / `catalog_status` 工具、窗口页 service |
| `worker.mjs` | 一轮探测的独立进程：读 registry → 探测 → 写 state → 索引发布 → skill 同步（F3/F4） |
| `catalog.middleware.js` | 网关中间件（moejs）：`injectIndex: true` 时才注入（默认关，可回退） |
| `lib/yaml.mjs` | registry.yaml 的最小 YAML 子集解析器（纯函数） |
| `lib/catalog.mjs` | 团队/个人目录合并、来源标记、个人文件版本校验与原子保存 |
| `lib/npm-discovery.mjs` | npm 全局包 bin 元数据发现（只读候选，不执行 CLI） |
| `lib/core.mjs` | registry 校验、平台/用户覆盖合并、状态判定、索引构建（纯函数） |
| `lib/probe.mjs` | 本机探测：npm/pipx/brew 清单 + PATH/绝对路径，5s 超时并发≤8 |
| `lib/inject.mjs` | 各协议 system 注入（anthropic/chat/responses/gemini，纯函数） |
| `lib/cycle.mjs` | 一轮刷新的编排：跨进程锁、state 原子写、经 magpie CLI 发布索引 |
| `lib/tool.mjs`、`lib/mcp-contract.mjs` | MCP 概览、分页筛选、精确详情/文档分段与显式 probe，统一参数校验 |
| `lib/project-model.mjs`、`lib/project-discovery.mjs` | Git/P4 项目模型、只读发现、本机路径检查 |
| `lib/snapshot.mjs` | 探测身份指纹与快照新鲜度 |
| `lib/skill.mjs` | 团队 skill + 本机实测 → SKILL.md 渲染与同步（F3）；hand-over 后分流 library（F4，方案 C） |
| `lib/service.mjs` | 窗口页本地 service：状态/覆盖/个人注册/npm 扫描接口、页面会话校验，端口占用时后台重试 |
| `page/` | 带路页：`index.html` 在外壳 + `boot.js` 交接主题后 `location.replace` 到 service；主界面 `main.html` 由 service 提供 |
| `test/` | bun test（纯函数全覆盖 + 假 CLI 探测/工具/service 实测，共 137 项） |

测试：`bun test`；沙箱验收步骤见 plan.md M1 的验收标准。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 详细设计：架构、配置分层、探测状态机、Agent 暴露方式、安全边界 |
| [docs/plan.md](docs/plan.md) | 分阶段实施计划与各阶段验收标准（含基线后 F1–F4） |
| [docs/milestone-local-catalog.md](docs/milestone-local-catalog.md) | 历史本机核心基础阶段交付与验收 |
| [docs/milestone-projects-mcp.md](docs/milestone-projects-mcp.md) | Git/P4 与 MCP 核心完成阶段验收、兼容性和后续项 |
| [docs/distribution.md](docs/distribution.md) | 仓库地址安装、私有权限、市场收录要求、更新与包校验 |
| [docs/ui-guide.md](docs/ui-guide.md) | UI 操作速查：按钮路径、分组/筛选、草稿与安全确认 |
| [docs/usage.md](docs/usage.md) | 完整使用手册：安装、CLI/Git/P4、配置、MCP、Skill、备份与排障 |
| [docs/mcp-design.md](docs/mcp-design.md) | MCP 发现/详情/显式检查、分页/筛选/快照与安全边界 |
| [docs/local-projects.md](docs/local-projects.md) | 本机 Git/P4 项目、工作区发现、团队绑定与只读检查 |
| [docs/personal-registry.md](docs/personal-registry.md) | 个人注册、npm 候选扫描、ueb 示例、冲突与安全边界 |
| [docs/registry-schema.md](docs/registry-schema.md) | `registry.yaml` 的字段规范 |
| [docs/registry-workflow.md](docs/registry-workflow.md) | registry 变更流程：PR 模板、check 命令纪律、min 升级流程、数据源形态 |
| [registry/registry.example.yaml](registry/registry.example.yaml) | 示例注册表 |

## 要解决的问题

- 团队除 npm / python 等标准公共命令外，还有自研 CLI，安装途径各异（npm scope、pipx、brew tap、手动二进制）；
- 各成员机器上是否装了、装在哪、版本是否达标，无法断定，只能逐机探测；
- GitHub / P4 项目地址等汇总信息散落在各处，Agent 无从得知。

设计参照 npm / pip 的集中注册机制；CLI 的**分发安装**不归本插件管（继续走 npm scope / brew tap / mise），插件只做**发现与感知**。

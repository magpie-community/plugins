# respire-memory for Magpie

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="page/icon-respire-ai-memory.svg"><img src="page/icon-respire-ai-memory-light.svg" width="112" height="112" alt="Respire AI 记忆"></picture></p>

> 吸即存，呼即取——给 AI Agent 装上记忆，让经验成为下一轮行动的起点。

**respire-memory 帮助 AI Agent 持续自进化。** 它通过 Magpie 接入 Respire：每轮先召回并读取引擎完整政策，再读选中正文；每个完成回合自动保存过程日记，并从对话中提炼决定、方法和教训，查重、更新或挂靠，供后续任务使用。“记住”是强调意图，不是唯一存储入口。

这里的自进化来自记忆与经验的持续积累，不涉及修改模型权重；效果取决于记录质量、召回结果和 Agent 的实际采用。

插件支持自动召回正文、显式存储、会话规则、后台提炼与查重归档、大回合分段、证据回读、持久去重，以及只读和显示偏好。

审查修复：[0.3.1 审查逐项回复与验证](https://github.com/risense-ai/respire-magpie/blob/main/docs/REVIEW-RESPONSE-0.3.1.md)。

0.3.16 追加修复：后台 `update` 一律拒绝 `--importance value` / `--importance=value`，避免已读 trivial 日记被直接升为无父节点的 important 根条。普通 update 和 `remember --importance trivial` 保留；0.3.15 只覆盖父节点参数，不代表它已拦截重要性提升。

0.3.15 父节点校验：后台 `memoryTools` 禁止 `update --clear-parent`，并要求显式替换的 `--parent value` / `--parent=value` 均为已读条目。原有 force/merge 禁令覆盖等号写法；不改父节点的普通 update 和真实 trivial 日记沿用原流程。Magpie 网关没有客户端工具的硬拒接口，因此本插件不声称拦截客户端自行执行的 shell/MCP 写入；这些路径仍需引擎约束。已读只证明读取发生，不证明父节点在语义上合理。

0.3.14 审查修复：`update` 前备份改为经 Store 同一 AES-256-GCM 密钥加密并原子替换持久化（磁盘不含明文），写入前先校验 `show` 回执，失败关闭；备份保留七天，worker 队列排空后自动清理；README 修正停用取消边界表述，不宣称新增停用通知路径。

详细说明：[功能与边界矩阵](https://github.com/risense-ai/respire-magpie/blob/main/docs/FEATURES.md) · [0.3.0 政策修复报告](https://github.com/risense-ai/respire-magpie/blob/main/docs/TEST-REPORT-0.3.0.md) · [0.2.1 历史验收](https://github.com/risense-ai/respire-magpie/blob/main/docs/TEST-REPORT.md)。核心链路已经实现并验收；自动识别客户端 plan、真实 SessionStart/恢复/压缩事件和原生状态行仍受宿主接口限制，不能视为与 Codex 全功能等价。

0.3.0 每轮自动存检默认开启，使用前必须配置生成模型。没有模型、主动关闭归档或处于只读模式时，插件会说明未满足完整读存流程；不会把待处理当作已存。原始对话采集仍默认关闭。网关不会取得或复用客户端私有登录凭据，也不会注册或执行客户端工具。

[npm](https://www.npmjs.com/package/@rsrsai/magpie) 已提供公开包，首次发布版本为 0.3.2。[GitHub Releases](https://github.com/risense-ai/respire-magpie/releases) 同时提供分发包与 SHA256SUMS。

[0.3.3 npm 自动发布验收报告](docs/NPM-PUBLISH-0.3.3.md)：Chrome 可信发布连接显示 Valid；GitHub OIDC 发布、公共 npm 安装及签名/attestation 校验通过。

[0.3.10 安装入口更正与实机页面验收](docs/NPM-LIVE-0.3.10.md)：本体安装统一使用 `rsrs-cli`；首次使用说明、公共包与隔离 Magpie 页面已核对，验证范围和已知限制见报告。

## 让 AI 安装

复制给本地助手：

```text
请从 npm 安装 @rsrsai/magpie 作为 Respire Magpie 插件。
先读 README.md，检查 Magpie、Bun 和 rsrs --client-only status --json。
若尚未安装 rsrs，先向我说明需要 Respire 本体并给出 https://github.com/risense-ai/respire-cli 的安装入口；仅安装 Magpie 插件不能读存记忆。
复用现有 Respire 账号、模型和 Runtime；不自行安装、启动或升级 Runtime，不索取凭据。
检查 magpie plugin list --json，避免重复；尚未安装时执行 magpie plugin add @rsrsai/magpie。
安装完整包，不只安装 respire.hooks.mjs。保留无关插件和配置，不自行升级 Magpie。
在插件页面配置实际 Runtime、项目和独立生成模型。archive 默认开启，每轮需保存过程日记；capture 原始采集保持关闭。未授权后台处理时先设 readOnly 并说明完整读存尚未启用。
如启用 archive，说明发送的消息、工具结果和相关记忆、额外模型用量及本地状态存储。
在我自己的终端环境配置密钥；页面仅填写环境变量名称，不接收密钥。
先用无敏感问题验证召回。写入验收先取得我对测试事实的授权，再读取实际记录。
报告实际执行及未验项目，不能把保存配置、模拟检查或成功回执当作完整部署验收。
```

## 安装

**首次使用须先安装 Respire 本体。** 本插件只负责 Magpie 接入，记忆库与本地 Runtime 由 [Respire CLI](https://github.com/risense-ai/respire-cli) 提供。安装方法见 [CLI npm 说明](https://www.npmjs.com/package/rsrs-cli)，也可从 [CLI Releases](https://github.com/risense-ai/respire-cli/releases) 下载对应平台版本。

```powershell
npm install -g rsrs-cli
```

按 [Runtime 使用指南](https://github.com/risense-ai/respire-cli/blob/main/docs/runtime.md)在 Respire 中准备账号、模型，启动并解锁本地 HTTP Runtime。插件不会代为安装本体、启动服务或管理账号。

需要 Magpie **0.1.1273+** 和 Bun **1.3.6+**，Respire HTTP Runtime 必须已运行并解锁。推荐 Magpie **0.1.2208+**，以正确识别本机 Agent 的 magpie-key 来源；旧版对此来源可能跳过。页面配置热更新需要 **0.1.1531+**，更早版本需重启 Magpie。

```powershell
rsrs --client-only status --json
magpie plugin add @rsrsai/magpie
```

需要本地安装时，可在完整插件目录执行 `magpie plugin add .`，或执行 `magpie plugin add <插件完整目录>`。本地安装引用此目录，不要移动或删除它。可检出仓库，也可解压 Release tgz 后安装其中的 package 目录。目录必须包含 package.json 和全部运行模块。

在 respire-memory 插件页面配置 Runtime、项目和开关。页面只保存配置，不检测连接或模型。原生 `magpie plugin options <标识>` 也可修改；本地安装的实际标识请先通过插件列表确认。

## 配置

```json
{
  "runtimeUrl": "http://127.0.0.1:15169",
  "project": "",
  "gatewayTimeoutMs": 5000,
  "requestTimeoutMs": 1500,
  "maxBytes": 8000,
  "limit": 3,
  "remember": true,
  "readOnly": false,
  "showMemoryStatus": false,
  "capture": false,
  "archive": true,
  "generationBaseUrl": "",
  "generationModel": "",
  "authorizationEnv": "RESPIRE_MAGPIE_AUTHORIZATION",
  "stateDir": ""
}
```

| 选项 | 说明 |
| --- | --- |
| runtimeUrl | 仅字面回环 127.0.0.1 / [::1] 的 HTTP/HTTPS，不接受路径、URL 凭据、查询参数、DNS 名或远程服务。 |
| project | 非空时过滤召回、标注新写入并限制后台更新目标；留空可使用当前整个库。不是权限或账号边界。 |
| gatewayTimeoutMs | 宿主 Hook 超时，100–10000 毫秒；整个链另有总预算。后台模型处理不占用这段预算。 |
| requestTimeoutMs | 前台每个 Runtime 请求含正文读取的预算，100–5000 毫秒。 |
| maxBytes | 记忆与回执注入预算，1024–32768 字节。因果链超预算时保留匹配的完整正文，明确标记链正文未注入。完整政策另有最多 128 KiB 预算及固定宿主适配说明，不裁剪政策。每轮仍读取完整政策；同一会话只在首次和政策变化时注入全文，其余回合只增加记忆与读取回执。 |
| limit | 候选 1–5 条，默认 3；超预算或含疑似凭据的正文跳过。 |
| remember | 处理“记：”“存：”“记录：”“记住：”“remember:”前缀，默认开启。 |
| readOnly | 禁止本插件显式存储、采集及后台写入，不限制其他客户端工具。 |
| showMemoryStatus | 提供 Memory、Used 及上次归档状态提示，默认关闭；不能保证客户端显示，严格格式应省略标签。 |
| capture | 完成回合原始文字与工具记录保存为 trivial 日记，默认关闭。日记按来源标记与有界片段核验；原文超出片段预算时不能确认完整回读，不会宣称采集成功或自动重放写入。 |
| archive | 每个完成回合保存过程日记，并用独立模型提炼、查重、更新或挂靠与回读，默认开启；必须配置模型。日记写入回执中的整日正文会被宿主剔除；回读用来源标记、4000 字符预算及最多相邻一片段逐字核验，只给模型本轮正文与定位信息。接口不支持、定位失效或正文不完整时保持未确认。关闭即不满足完整每轮必存。**时序契约**：归档在宿主 `onResponse`（回复完成）后异步执行——这是已确认的产品方向，不承诺「答前已存」。**取消边界**：每次写前与每轮模型调用前都会重读控制租约/账号/引擎只读态；**控制状态已更新之后**发起的这类检查会读到新状态并停止该任务。停用/卸载后若没有后续请求，已分离的 worker 无法立即获知，其停止延迟受 280 秒总预算与当前检查点约束；本插件没有停用主动通知路径。**更新防丢**：任何 `update` 覆盖旧正文前，先校验 `show` 回执（状态 ok、返回条目 id 与目标一致、旧正文非空），再用状态目录同一密钥以 AES-256-GCM 加密、原子替换持久备份旧条目标题/正文到 `backups/`，磁盘文件不含明文；校验或备份写入失败都使该次更新失败关闭（任务转 unconfirmed），绝不无备份覆盖。备份保留七天，worker 队列排空后自动清理更早的备份。 |
| generationBaseUrl | 兼容 Chat Completions 的基础地址，如 https://provider.example/v1；插件追加 /chat/completions。远程须 HTTPS，回环可 HTTP，不跟随重定向。 |
| generationModel | 服务实际支持的模型名，启用 archive 时须填写。 |
| authorizationEnv | 凭据所在环境变量名称，默认 RESPIRE_MAGPIE_AUTHORIZATION。无认证服务可不设置变量。 |
| stateDir | 可选绝对路径，默认用户目录 .rsrs/magpie；加密保存去重状态、队列、证据、进度、结果和更新前加密备份。 |

生成凭据由用户在 Magpie 启动环境中设置。配置只保存变量名；密钥不进模型上下文、队列或状态日志。启用 archive 意味着允许将本轮消息、工具内容和相关记忆发给该服务，并产生额外模型用量。

## 使用方式

首次使用按顺序完成：[安装 Respire CLI](https://github.com/risense-ai/respire-cli) → 在 CLI 中准备并解锁本地 Runtime → 安装 Magpie 插件 → 打开 respire-memory 设置页填写 Runtime 与归档生成模型。设置页顶部始终保留本体安装链接和检查命令；仅安装插件或保存配置不代表读存已经可用。

## 记忆流程

1. 只接受宿主标记的 local 或 magpie-key。远程、其他具名密钥、代理和未知来源全部跳过。
2. 核对当前 Runtime 账号与库，并隔离缓存和任务；不能确认账号或未解锁时继续原推理，报告不可用。
3. 每个新回合先 recall，再 prompt 完整政策，再 show 正文；涉及决策、报错、教训或约定的记录读 chain。政策单独标注为引擎规则，记忆仍是不可信历史参考；保留设备与来源，放不进记忆预算的条目整条跳过。
4. 显式存储也先召回与读政策，不在前台绕过分类直接 remember。前台 pending 表示等待本轮完成后的后台处理，不是引擎已存回执。旧版本未知回执仍禁止自动重试。
5. 完成回复后，将任务写入加密队列，再启动独立 worker。失败、截断、工具未完成、疑似凭据或缺失历史的回合不入队。
6. worker 复核当前账号、插件控制记录和引擎模式，再做可选日记采集及模型归档。模型只有受限记忆与本轮证据工具，不能调用 Shell、任意网络工具、凭据、配置或服务生命周期操作。
7. 归档先召回、读完整政策和候选，优先更新，或挂到已读 parent；每轮必须写过程日记并回读。没有新长期结论也不能以 nothing-to-store 成功结束。长期结论另存并附本轮来源，原始证据可通过 CLI 精确读回。
8. 下一条请求可提示上次归档状态。Used 仍由实际采用资料的模型报告，不是网关独立测量；回读成功只证明落库，不证明正文真实。

`/nomem`、`#nomem` 只跳过本条召回；后台仍可按用户已启用的 capture/archive 运行，与 Codex 插件语义一致。要禁止本插件写入，请打开 readOnly，或关闭 remember、capture、archive。引擎的只读、暂停和权限规则始终有效。

## 大回合、来源与恢复

原始回合最多 2 MiB。归档复用 Codex 的证据处理：直接预算 256,000 字符；超预算才缩短工具预览，用户和助手原文不裁剪；仍超预算按最多 48,000 字符分段，最多 12 段，每段最多 6,000 字符候选。候选必须引用真实来源，不能视为独立验证。

最终归档收到或回读全部用户原文后，才允许写入或成功结束。工具中段仍可通过证据工具读取。模型交互最多 40 轮，总预算 280 秒，单次生成最多 60 秒。超限或失败标为 unconfirmed，不假装完成。

状态目录使用 AES-256-GCM 加密记录并原子替换文件；state.key 同目录保存，只保护未同时取得密钥的离线记录，不等同于系统密钥链或 Respire 库的加密。应保护和备份整个目录。队列上限 512 只计等待和运行任务，完成回执不会耗尽容量。终态原始证据保留 24 小时；完成回执及回合/会话缓存保留七天；`update` 前的加密备份写入 `backups/`，同样保留七天，worker 队列排空后自动清理更早的备份。维护在前台每小时及 worker 启动时执行；未确认写入只保留紧凑标记，不重放。证据过期后 evidence 明确报错，不伪造原文。以上只清理本地队列/缓存，不删除 Respire 库里的记忆。宿主关闭时不会运行清理，过期数据在下次维护时移除。

在完整插件目录，用 Node.js 24+ 或对应 Bun 解释器运行：

```powershell
node worker.mjs setup
node worker.mjs status
node worker.mjs run
node worker.mjs recover
node worker.mjs evidence <完整回合来源摘要>
```

setup 检查默认 Runtime、模式及状态目录，不发模型请求或安装引擎。status 显示安全进度、回执 ID 和错误类别。run 自动恢复已确认 PID 死亡的锁并处理队列；新任务唤醒 worker，每个宿主生命周期只额外唤醒一次恢复。活跃锁最多等待五秒。recover 复用同一安全恢复流程；未尝试写入且未过期的中断任务可重新入队，曾尝试写入的标为 unconfirmed，绝不重放。

自定义目录时，setup/status/run/recover 的第二个参数为绝对目录；evidence 的第二个参数是来源摘要，第三个参数是目录。evidence 会输出原始内容，应只在获准查看的终端运行。已确认 PID 死亡的记录锁可自动恢复；无 PID 的旧锁或未知所有者仍须人工核对。不要删密钥、回执或未知写入标记绕过失败。

持久队列不能弥补宿主入队前丢失完成通知。当前版本跳过 Responses previous_response_id 的历史续接，不伪造未观察到的完整历史。图片、音频和私有推理不保存。

**后台有效期**：任务和控制租约最多五分钟；worker 在每次新模型请求及写入前复核控制、账号和引擎模式。插件停用/卸载且没有后续请求时，宿主不能立即通知已分离的进程，已接受操作可能在有效期内继续，但到期后不再发起生成请求。账号身份仍逐请求实时核对，不使用可能跨账号复用旧记忆的 TTL 缓存。

## 与 Codex 的对齐及宿主限制

| 能力 | 当前状态 |
| --- | --- |
| 自动召回、显式存储、待决与未知回执 | 已实现；自动注入正文而非只注入标题。 |
| 规则与引擎检查 | 每个新回合读取并注入完整政策；没有真实 SessionStart/恢复/压缩事件。 |
| 后台提炼、查重、更新/挂靠和回读 | 已实现独立 worker，另配生成服务，不依赖 Codex app-server。 |
| 分段、证据读取与成功出口校验 | 已实现并保留来源。 |
| 持久去重、进度、未知写入不重放 | 已实现；不弥补入队前的通知丢失。 |
| 状态显示偏好 | 已实现提示与配置；Hook 不能改写已发送回复或保证原生 UI 状态行。 |
| plan 禁写 | 提供 readOnly 开关；当前宿主没有可信 permission_mode，无法自动识别客户端 plan，不能根据用户文字猜授权。 |
| setup/settings | 提供本地 setup 命令和配置页面，不是 Codex 专用技能。 |

开关在下一条请求同步给 worker；已接受的写入不能撤销。切换生成服务、模型或项目后，应先查看旧任务状态，不把配置保存当成旧任务已取消。

**时点限制**：本插件只能在宿主完成回复后归档，无法保证引擎要求的“发出回复前已经落库”。这是尚未满足的严格时点要求，不能因每轮后台成功而声称完整政策已全部对齐。

## CI/CD 与发布

- main 与 PR 运行 Windows、Linux、macOS 检查，覆盖四协议、HTTP 模拟服务、独立 worker、受限工具、加密状态、只读、未知写入、分段来源及加密更新备份（磁盘无明文、可解密恢复、失败关闭、七天保留）。
- 推送 v<package.version> 标签触发三系统验证，通过后自动上传 tgz 与 SHA256SUMS 到 GitHub Release；预发布标签标为 prerelease。
- npm 首发 0.3.2 通过用户 Chrome 的双重验证完成；后续 npm job 使用 OIDC 和 provenance，不上传长效 token。
- 可信发布绑定 risense-ai/respire-magpie 的 release.yml，允许直接 publish；仓库变量 NPM_PUBLISH_ENABLED=true 控制 npm job。稳定版使用 latest，含连字符版本使用 next。只有同版本三系统验证与 GitHub Release 成功后才运行 npm 发布。
- npm run check 做检查；npm run release:package 打包和生成校验，发布环境还校验标签与版本一致。
- 稳定版 Release 全部成功后，`Sync Magpie community` 自动同步社区副本并提交或更新官方 PR。有未合并的机器人 PR 就继续更新；合并后的下次发布才新建 PR。需要一次性配置专用跨仓库授权，维护者审核仍保留，详见[商店自动同步](docs/COMMUNITY-SYNC.md)。

## 排查与验收状态

| 现象 | 处理 |
| --- | --- |
| 来源跳过 | 检查宿主版本与来源分类，不放宽到共享网关的其他调用者。 |
| invalid | 检查配置、预算和响应格式；启用规则时须容纳完整规则。 |
| worker 不处理 | 查看 status 和进程锁，确认原进程已死亡才 recover。 |
| generation-not-configured/unavailable | 配置服务、模型及 Magpie 启动环境中的凭据变量，不向聊天发送密钥。 |
| unconfirmed | 先读取 records 和实际记忆，不能直接重放曾尝试写入的任务。 |
| account-changed、read-only、job-disabled | 账号、权限或开关改变，任务停止，不扩大权限。 |
| 加密状态或锁报错 | 保留目录排查，不自动删密钥、密文或锁绕过失败。 |

自动检查使用隔离目录、HTTP 模拟 Runtime/生成服务及真实独立 worker，不向生产记忆库写测试事实。历史 0.2.x 验收曾核对真实网关召回、显式存储、后台归档及 Magpie web 名称与亮暗图标；未直接操作原生桌面窗口。

2026-10-31 的 [0.3.6 npm 实机报告](docs/NPM-LIVE-0.3.6.md) 记录了当前结果：通过 Magpie 自身安装器安装 npm 包，三轮真实请求均完成逐轮召回、完整政策读取和日记片段核验，两次独立会话召回正确测试事实与实际 ID。同一会话没有重复累积政策全文。主网关已切换为 npm 0.3.6 并按用户授权开启，独立普通回合也完成自动存储。此前 [0.3.4 的失败验收](docs/NPM-LIVE-0.3.4.md) 保留，不能用成功存储回执掩盖错误回答。验证范围为 Chat 实机及四协议隔离检查，不代表所有客户端现场验收或答前落库保证。

0.2.1 修复 Runtime 将 pending 作为退出码 2 返回时被误判失败的问题；待处理请求仍只尝试一次，后台按引擎政策处理，不伪报已保存。

## 图标与来源

亮暗 SVG 取自项目 icon/，副本在 page/。配置页跟随官方 bridge 的 data-theme，README 用 picture。插件列表内嵌自适应 SVG data URI，侧栏使用 page/icon.svg，无需外网。单文件复用同源 DSH 组合。已验收跟随系统亮暗主题的实际显示；宿主强制主题与系统主题不一致的情况尚未验收。

参考 [Magpie Hook 契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md) 和 [PowerContext 插件](https://github.com/magpie-community/plugins/tree/main/packages/powercontext)。对话解析器为 MIT 改编；证据处理和受限工具复用 Respire Codex。见 NOTICE 和 LICENSE。

0.3.7 的写后日记核验按回合来源标记执行 lexical 精确定位；一般历史查询仍默认 hybrid。两者都按实际 details JSON 检查请求预算，不放宽 4000 字符上限。见 [预算与回读跟进](docs/NPM-LIVE-0.3.7.md)。

0.3.8 会在最多五个同来源候选中核验本轮完整正文，避免重复标记先命中旧正文而误报未确认；预算和失败不重放规则保持。参见[验收记录](docs/NPM-LIVE-0.3.8.md)。

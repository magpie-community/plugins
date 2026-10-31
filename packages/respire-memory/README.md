# respire-memory

Community distribution of [respire-memory for Magpie](https://github.com/risense-ai/respire-magpie), runtime code synchronized from upstream v0.2.1, with post-release documentation. MIT; see NOTICE for reused components.

```sh
magpie plugin add @magpie-community/gateway-respire-memory
```

Requires an existing unlocked local Respire Runtime. Recall and explicit remember are enabled; capture and model-based background archival are off until configured. Helps AI agents evolve through reusable memories and lessons, without changing model weights.

Run the package checks from this directory with `npm run check`. The checks use isolated simulated services and a real detached worker, without production accounts.

# respire-memory for Magpie

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="page/icon-respire-ai-memory.svg"><img src="page/icon-respire-ai-memory-light.svg" width="112" height="112" alt="Respire AI 记忆"></picture></p>

> 吸即存，呼即取——给 AI Agent 装上记忆，让经验成为下一轮行动的起点。

**respire-memory 帮助 AI Agent 持续自进化。** 它通过 Magpie 接入 Respire：回答前找回相关经验，用户明确要求时存下事实；开启后台整理后，再从完成的对话中提炼决定、方法和教训，查重并保存，供后续任务使用。

这里的自进化来自记忆与经验的持续积累，不涉及修改模型权重；效果取决于记录质量、召回结果和 Agent 的实际采用。

插件支持自动召回正文、显式存储、会话规则、后台提炼与查重归档、大回合分段、证据回读、持久去重，以及只读和显示偏好。

详细说明：[功能与边界矩阵](https://github.com/risense-ai/respire-magpie/blob/main/docs/FEATURES.md) · [0.2.1 测试报告](https://github.com/risense-ai/respire-magpie/blob/main/docs/TEST-REPORT.md)。核心链路已经实现并验收；自动识别客户端 plan、真实 SessionStart/恢复/压缩事件和原生状态行仍受宿主接口限制，不能视为与 Codex 全功能等价。

后台整理默认关闭，需要明确配置生成模型。没有生成服务也能使用基础召回和显式存储。网关不会取得或复用客户端私有登录凭据，也不会注册或执行客户端工具。

[GitHub Releases](https://github.com/risense-ai/respire-magpie/releases) 提供分发包与 SHA256SUMS。npm 首发按用户决定暂缓，**不要假定 @rsrsai/magpie 已可从 npm 安装**。

## 让 AI 安装

复制给本地助手，并替换目录：

```text
请安装 D:\sources\repos-new\gh\1memory\respire-magpie 中的 Respire Magpie 插件。
先读 README.md，检查 Magpie、Bun 和 rsrs --client-only status --json。
复用现有 Respire 账号、模型和 Runtime；不自行安装、启动或升级 Runtime，不索取凭据。
检查 magpie plugin list --json，避免重复；尚未安装时执行 magpie plugin add <完整目录>。
安装整个目录，不只安装 respire.hooks.mjs。保留无关插件和配置，不自行升级 Magpie。
在插件页面配置实际 Runtime 与项目。capture 和 archive 保持关闭，除非我明确允许采集或后台处理。
如启用 archive，说明发送的消息、工具结果和相关记忆、额外模型用量及本地状态存储。
在我自己的终端环境配置密钥；页面仅填写环境变量名称，不接收密钥。
先用无敏感问题验证召回。写入验收先取得我对测试事实的授权，再读取实际记录。
报告实际执行及未验项目，不能把保存配置、模拟检查或成功回执当作完整部署验收。
```

## 安装

需要 Magpie **0.1.1273+** 和 Bun **1.3.6+**，Respire HTTP Runtime 必须已运行并解锁。推荐 Magpie **0.1.2208+**，以正确识别本机 Agent 的 magpie-key 来源；旧版对此来源可能跳过。页面配置热更新需要 **0.1.1531+**，更早版本需重启 Magpie。

```powershell
rsrs --client-only status --json
magpie plugin add D:\sources\repos-new\gh\1memory\respire-magpie
```

也可在完整插件目录执行 `magpie plugin add .`。本地安装引用此目录，不要移动或删除它。可检出仓库，也可解压 Release tgz 后安装其中的 package 目录。目录必须包含 package.json 和全部运行模块。

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
  "injectRules": true,
  "showMemoryStatus": true,
  "capture": false,
  "archive": false,
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
| maxBytes | 注入块 UTF-8 字节上限，1024–32768。首次规则占此预算，不足以完整放入时报告 invalid，不静默删减。 |
| limit | 候选 1–5 条，默认 3；超预算或含疑似凭据的正文跳过。 |
| remember | 处理“记：”“存：”“记录：”“记住：”“remember:”前缀，默认开启。 |
| readOnly | 禁止本插件显式存储、采集及后台写入，不限制其他客户端工具。 |
| injectRules | 首次观察会话时注入 Respire 规则并检查 Runtime，默认开启。 |
| showMemoryStatus | 提供 Memory、Used 及上次归档状态提示，默认开启；不能保证客户端显示，严格格式应省略标签。 |
| capture | 完成回合原始文字与工具记录保存为 trivial 日记，默认关闭。 |
| archive | 用独立模型提炼、查重、更新或挂靠并验证回执，默认关闭。 |
| generationBaseUrl | 兼容 Chat Completions 的基础地址，如 https://provider.example/v1；插件追加 /chat/completions。远程须 HTTPS，回环可 HTTP，不跟随重定向。 |
| generationModel | 服务实际支持的模型名，启用 archive 时须填写。 |
| authorizationEnv | 凭据所在环境变量名称，默认 RESPIRE_MAGPIE_AUTHORIZATION。无认证服务可不设置变量。 |
| stateDir | 可选绝对路径，默认用户目录 .rsrs/magpie；加密保存去重状态、队列、证据、进度和结果。 |

生成凭据由用户在 Magpie 启动环境中设置。配置只保存变量名；密钥不进模型上下文、队列或状态日志。启用 archive 意味着允许将本轮消息、工具内容和相关记忆发给该服务，并产生额外模型用量。

## 记忆流程

1. 只接受宿主标记的 local 或 magpie-key。远程、其他具名密钥、代理和未知来源全部跳过。
2. 核对当前 Runtime 账号与库，并隔离缓存和任务；不能确认账号或未解锁时继续原推理，报告不可用。
3. recall 选标题后 show 正文，被取代的条目优先读新条。资料作为不可信历史参考注入，保留完整标识与正文，放不进预算就跳过整条。
4. 显式存储只尝试一次，不 force。pending 是未写入；未知回执可能已经写入，不能自动重试。启用 archive 后可在回复完成时处理 pending；成功或未确认的显式写入不重复启动归档。
5. 完成回复后，将任务写入加密队列，再启动独立 worker。失败、截断、工具未完成、疑似凭据或缺失历史的回合不入队。
6. worker 复核当前账号、插件控制记录和引擎模式，再做可选日记采集及模型归档。模型只有受限记忆与本轮证据工具，不能调用 Shell、任意网络工具、凭据、配置或服务生命周期操作。
7. 归档先召回、读完整政策和候选，优先更新，或挂到已读 parent；写后读回实际记录。长期结论附本轮来源标识，原始证据可通过 CLI 精确读回。
8. 下一条请求可提示上次归档状态。Used 仍由实际采用资料的模型报告，不是网关独立测量；回读成功只证明落库，不证明正文真实。

`/nomem`、`#nomem` 只跳过本条召回；后台仍可按用户已启用的 capture/archive 运行，与 Codex 插件语义一致。要禁止本插件写入，请打开 readOnly，或关闭 remember、capture、archive。引擎的只读、暂停和权限规则始终有效。

## 大回合、来源与恢复

原始回合最多 2 MiB。归档复用 Codex 的证据处理：直接预算 256,000 字符；超预算才缩短工具预览，用户和助手原文不裁剪；仍超预算按最多 48,000 字符分段，最多 12 段，每段最多 6,000 字符候选。候选必须引用真实来源，不能视为独立验证。

最终归档收到或回读全部用户原文后，才允许写入或成功结束。工具中段仍可通过证据工具读取。模型交互最多 40 轮，总预算 280 秒，单次生成最多 60 秒。超限或失败标为 unconfirmed，不假装完成。

状态目录使用 AES-256-GCM 加密记录并原子替换文件；state.key 同目录保存，只保护未同时取得密钥的离线记录，不等同于系统密钥链或 Respire 库的加密。应保护和备份整个目录。来源证据随任务保留，最多 512 个队列记录；满额拒绝新入队，不自动删除证据。

在完整插件目录，用 Node.js 24+ 或对应 Bun 解释器运行：

```powershell
node worker.mjs setup
node worker.mjs status
node worker.mjs run
node worker.mjs recover
node worker.mjs evidence <完整回合来源摘要>
```

setup 检查默认 Runtime、模式及状态目录，不发模型请求或安装引擎。status 显示安全进度、回执 ID 和错误类别。run 处理队列，正常后续请求也会唤醒队列。recover 只在原 worker 已死亡时清理进程锁：未尝试写入的中断任务重新入队，曾尝试写入的标为 unconfirmed，绝不重放。

自定义目录时，setup/status/run/recover 的第二个参数为绝对目录；evidence 的第二个参数是来源摘要，第三个参数是目录。evidence 会输出原始内容，应只在获准查看的终端运行。遗留回合记录锁不会自动删除，应先核实写入结果，不要删状态绕过未知回执。

持久队列不能弥补宿主入队前丢失完成通知。当前版本跳过 Responses previous_response_id 的历史续接，不伪造未观察到的完整历史。图片、音频和私有推理不保存。

## 与 Codex 的对齐及宿主限制

| 能力 | 当前状态 |
| --- | --- |
| 自动召回、显式存储、待决与未知回执 | 已实现；自动注入正文而非只注入标题。 |
| 规则与引擎检查 | 首次观察会话时执行；没有真实 SessionStart/恢复/压缩事件。 |
| 后台提炼、查重、更新/挂靠和回读 | 已实现独立 worker，另配生成服务，不依赖 Codex app-server。 |
| 分段、证据读取与成功出口校验 | 已实现并保留来源。 |
| 持久去重、进度、未知写入不重放 | 已实现；不弥补入队前的通知丢失。 |
| 状态显示偏好 | 已实现提示与配置；Hook 不能改写已发送回复或保证原生 UI 状态行。 |
| plan 禁写 | 提供 readOnly 开关；当前宿主没有可信 permission_mode，无法自动识别客户端 plan，不能根据用户文字猜授权。 |
| setup/settings | 提供本地 setup 命令和配置页面，不是 Codex 专用技能。 |

开关在下一条请求同步给 worker；已接受的写入不能撤销。切换生成服务、模型或项目后，应先查看旧任务状态，不把配置保存当成旧任务已取消。

## CI/CD 与发布

- main 与 PR 运行 Windows、Linux、macOS 检查，覆盖四协议、HTTP 模拟服务、独立 worker、受限工具、加密状态、只读、未知写入及分段来源。
- 推送 v<package.version> 标签触发三系统验证，通过后自动上传 tgz 与 SHA256SUMS 到 GitHub Release；预发布标签标为 prerelease。
- npm job 已配置 OIDC 和 provenance，当前默认跳过。按用户决定，npm 首发及可信发布绑定稍后处理。
- npm 就绪后，可信发布绑定 risense-ai/respire-magpie 的 release.yml 并允许直接 publish，再设仓库变量 NPM_PUBLISH_ENABLED=true。不上传长效 token。稳定版使用 latest，含连字符版本使用 next。
- npm run check 做检查；npm run release:package 打包和生成校验，发布环境还校验标签与版本一致。

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

自动检查使用隔离目录、HTTP 模拟 Runtime/生成服务及真实独立 worker，不向生产记忆库写测试事实。另于 2026-10-31 在本机 Magpie 0.1.1908 完成实机验收：真实网关召回、显式存储 pending 回执、独立 worker 通过已配置的 WorkBuddy 模型归档、落库回读，以及新会话召回均通过。配置页与侧栏的名称、介绍及亮暗图标在 Magpie web 中核对通过；未直接操作原生桌面窗口，也未升级宿主。

0.2.1 修复 Runtime 将 pending 作为退出码 2 返回时被误判失败的问题；待处理请求仍只尝试一次，后台按引擎政策处理，不伪报已保存。

## 图标与来源

亮暗 SVG 取自项目 icon/，副本在 page/。配置页跟随官方 bridge 的 data-theme，README 用 picture。插件列表内嵌自适应 SVG data URI，侧栏使用 page/icon.svg，无需外网。单文件复用同源 DSH 组合。已验收跟随系统亮暗主题的实际显示；宿主强制主题与系统主题不一致的情况尚未验收。

参考 [Magpie Hook 契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md) 和 [PowerContext 插件](https://github.com/magpie-community/plugins/tree/main/packages/powercontext)。对话解析器为 MIT 改编；证据处理和受限工具复用 Respire Codex。见 NOTICE 和 LICENSE。

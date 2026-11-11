# Magpie Comate Auth — independent plugin

本地主线开发版本 `0.5.12`。通过 HTTPS 直接请求 Comate 云端，复用这台电脑的 Comate 登录态。
不调用 Comate 本地服务的会话、工具执行或取消接口；云端不可用时直接报错。
本插件独立维护，通过 Magpie 的非官方插件发现机制分发，未获官方市场审核批准。
仓库是公开的非 fork 项目，并带有 `magpie-plugin` GitHub topic。无需 npm 发布。

## 在 Magpie 中安装和使用

本插件是跨平台 JavaScript，不需要编译 Magpie，也不需要把文件复制进 `Magpie.app` 或 Magpie 的程序安装目录。
三种安装方式任选一种，推荐直接从 GitHub 安装。

### 方式一：直接安装公开插件（推荐）

在 Magpie → **插件 → 非官方** 中搜索 `magpie-comate-auth`，选择 `PengJunchen/magpie-comate-auth` 并安装。
GitHub 索引及 Magpie 的十分钟缓存可能延迟显示；找不到时可以在终端运行：

```sh
magpie plugin add github:PengJunchen/magpie-comate-auth
magpie plugin login comate 1
```

这种方式由 Magpie 下载、管理文件，不需要自己选择存放目录。
已安装后，可在 Magpie 插件页面对本插件执行更新。

### 方式二：下载构建产物，用本地文件夹安装

从 [最新 Release](https://github.com/PengJunchen/magpie-comate-auth/releases/latest) 下载
`magpie-comate-auth-0.5.12.zip`（附件里的安装包，不是 GitHub 自动生成的 Source code.zip），
解压到准备长期保留的目录，例如 `~/MagpiePlugins/`：

```text
~/MagpiePlugins/
└── magpie-comate-auth/     ← Magpie 要添加的文件夹
    ├── package.json
    ├── index.mjs          ← 插件入口，无需单独点击运行
    ├── cloud.mjs
    ├── tool-adapter.mjs
    └── …                 ← 其他运行模块必须保留
```

从上述父目录执行，**相对路径就是 `./magpie-comate-auth`**：

```sh
cd ~/MagpiePlugins
magpie plugin add ./magpie-comate-auth
magpie plugin login comate 1
```

也可在 Magpie 的插件添加入口选择解压后的 `magpie-comate-auth` 文件夹。
应选中**同时包含 `package.json` 和 `index.mjs` 的这一层**，不要选 ZIP、单个 `index.mjs` 或外层父目录。
本地安装登记的是文件夹路径，不会替你保管原文件；安装后不要移动或删除该文件夹。
ZIP 是运行文件归档，没有安装脚本。`.tgz` 是相同运行文件的 npm 格式包，普通用户使用 ZIP 即可。
Release 同时提供 `SHA256SUMS` 和 `BUILD-INFO.json` 用于校验和追溯，后者记录源码提交、未提交变更标记和各运行文件哈希。

### 方式三：从源码构建后安装

克隆仓库并在**仓库根目录**执行（需要 Node.js 22+、npm；没有第三方依赖）：

```sh
git clone https://github.com/PengJunchen/magpie-comate-auth.git
cd magpie-comate-auth
npm run build
magpie plugin add ./dist/magpie-comate-auth
magpie plugin login comate 1
```

**相对于仓库根目录，安装目录是 `./dist/magpie-comate-auth`。** 构建产物如下：

```text
dist/
├── magpie-comate-auth/                  ← 本地安装时添加这一层
│   ├── package.json
│   ├── index.mjs
│   └── …
├── magpie-comate-auth-0.5.12.zip          ← 可直接解压的运行文件
├── pengjunchen-magpie-comate-auth-0.5.12.tgz
├── BUILD-INFO.json
└── SHA256SUMS
```

下载 ZIP 的用户不需要运行 `npm install` 或 `npm run build`；构建命令仅用于完整源码仓库。
`dist/` 由命令生成，不提交进 Git；可下载产物发布在 Releases。

### 登录、选模型与确认安装

在提供方页面添加 **Comate**，选择 **Comate account (this computer)**。
电脑需已有可读的 Comate 登录凭据；不需要 Comate 本地服务保持运行。
登录后把需要使用的客户端模型切换为实时目录中的 `comate/<model ID>`。
仅添加插件不会自动改变 DeepSeek Harness、Codex 或 Claude Code 的模型选择。

```sh
magpie plugin list
```

列表应显示 `comate`、已登录状态和模型数量；未登录时先在 Comate 中登录，再运行上面的插件登录命令。
如果同一提供方装了多份插件，可明确指定由哪份提供服务，例如：

```sh
magpie plugin use github:PengJunchen/magpie-comate-auth comate
```

也支持手工输入 license。宿主会保存凭据；对话、系统提示、工具定义、图片和客户端工具结果会发往
`https://comate.baidu.com`。插件只读 Comate 设置，不修改该文件；macOS 默认位置为
`~/Library/Application Support/Comate/User/settings.json`，可用绝对路径 `COMATE_SETTINGS_PATH` 覆盖。
Windows/Linux 的路径有单元测试，但尚未完成本版本原机验收。

## 工具和续聊

默认使用云端原生 conversation/task。Magpie 的 `chat.headers` 钩子将客户端 session ID
通过插件专用头传给插件；该头不发送给 Comate。同一账号、模型和会话的连续请求复用原 task，
只发送本轮新增输入。工具用云端原始函数名/参数发出，插件校验后转换为客户端 `tool_calls`；
客户端执行后，插件把返回的 call ID 映射到云端原始 ID，以 `toolUseResults` 原生回传。
原生工具结果可携带一张内联图片，客户端报告的执行失败会原样标为失败。
不会伪造执行成功，也不会把未声明工具交给客户端猜测。原生 `TOOL` 执行事件仍报错。
Comate 的 `list_dir` 若不在客户端目录内，但客户端提供参数兼容的 `bash`/`Bash`，
插件会将其转换为该客户端工具的 `ls -la -- '<目录>'` 调用，并补齐声明的 description。
目录作为完整 shell 字符串转义；原生 `depth` 支持 1–64 的整数或整数字符串，深度大于 1 时转换成有深度边界的 `find`。
从 `0.5.4` 开始，原生 `ignore_globs` 支持字符串数组及其 JSON 编码字符串（例如 `"[]"`、`"[\"**/node_modules/**\",\".git\"]"`）。
空数组保持原有目录命令；非空规则转换为 BSD/GNU `find` 的匹配与剪枝，排除匹配条目及被忽略目录的子树，并保留深度限制。
支持 `*`、`?`、完整路径段 `**`、基础字符类和反斜线转义；单个 `*` 不跨越目录分隔符。
无分隔符规则匹配任意层级的名称，含分隔符的规则相对列举目录；前导 `/` 或 `./` 锚定该目录，尾随 `/` 只匹配目录。
不支持 gitignore 否定规则、花括号展开、extglob 或 POSIX 命名字符类；这些规则及非法 JSON 会明确报错，不会静默取消过滤。
0.5.0 的 JSON 参数规范化没有覆盖这条派生目录操作的 `ignore_globs`，因此旧版遇到该可选字段仍会失败；这不是深度字符串修复被撤回。
不附加提权/审批绕过参数；仍由客户端的审批和沙箱控制执行。
工具结果回传时保留云端原始 `list_dir` 名称、ID 和参数。
同样，原生 `run_command` 转为客户端已声明的 `bash`/`Bash`，保留命令本身，并按客户端 schema 映射工作目录、超时和后台执行选项。
不执行插件内 shell、不生成成功结果、不增加提权参数；结果回传保留原生调用名及参数。
无兼容工具、`tool_choice:none`、歧义参数或无法保留的执行选项明确报错。

会话状态位于每个插件实例内，按账号、模型、session ID 隔离，最多保留 64 个会话。
同一会话正在生成时，再次提交返回 409，避免并发写坏云端任务。
没有 session ID、宿主重启/缓存淘汰、历史分叉、工具目录变更或中间有其他客户端产生的轮次时，
自动新建云端 task 并回放完整历史。失败、断流和取消会废弃受影响状态；待回传原生工具结果必须完整匹配 ID。
完整回放会重传历史图片，也会增加长历史的开销；正常原生续聊不重复上传已有图片。

支持文本、流式和非流式、`auto` / `none` / `required` / 指定函数。
工具参数需是 JSON 对象；不保证完整 JSON Schema 验证，拒绝 `strict: true`。
推理可返回，但不转发推理档位、temperature、max_tokens 等生成控制。
目录仅来自当前账号的云端实时列表，图片能力按该列表的 `supportImage` 字段展示；没有固定模型种子。

### 通用工具适配

`0.5.4` 增加网络搜索参数适配。Comate 的 `web_search({query: "...", max_results: "5"})`
可转换为 Harness 声明的 `web_search({queries: ["..."]})`，也支持 `WebSearch` / `websearch`。
客户端有结果条数参数时保留并校验该值，否则使用客户端默认结果数量。
多条查询不会合并成一条，空查询、冲突查询和无法表达的域名等筛选条件会报错。
原生工具结果回传保留 Comate 的原始 ID、查询参数及结果条数提示。

插件按本次请求的工具目录工作，不依赖应用名称或固定的全局工具表。
`tool-adapter.mjs` 负责有序策略选择与结果关联；`tool-profiles.mjs` 声明等价能力及字段映射；
`tool-schema.mjs` 按客户端声明规范化参数并检查基础约束。`tool-search.mjs` 处理搜索输出模式和选项语义。
新增客户端通常只需增加能力描述或单独的策略及回归测试。

| 能力 | 已覆盖的客户端声明形式 |
| --- | --- |
| 命令/目录查看 | Harness `bash`、Claude Code `Bash`、Codex `exec_command` 的 `command`/`cmd` 及工作目录字段 |
| 文件操作 | `read`/`Read`、`write`/`Write`、`edit`/`Edit` 的路径字段；搜索用 `glob`/`Glob`、`grep`/`Grep` |
| 任务清单 | `todo_write`/`TodoWrite`/`todowrite`，以及 `update_plan` 的 `plan[].step` |

如果 schema 要求数组或对象而模型传来了合法 JSON 字符串，会解码并递归验证；如
`{"todos":"[{\"content\":\"检查工具\",\"status\":\"pending\"}]"}` 会变成真正的 todos 数组。
同理可处理声明为数值/布尔值的 JSON 编码标量。声明为字符串的命令、文件内容保持字符串，不按外观猜类型。
非法 JSON、类型不符、缺少 required 字段、enum 不符、歧义转换，以及无法保留的执行选项会报错。
这不是完整 JSON Schema 引擎，仍拒绝 `strict:true`；客户端仍负责最终参数和权限验证。

仅当前请求实际提供的工具才可能被选中，不创建不存在的能力，不降级绕过审批。
从 `0.5.5` 开始，遇到未声明且没有可用等价适配的原生函数名（例如 `delete_file`，或客户端只提供 `find` 时的 `glob_path`），
插件在完整云端回合结束、且没有其它合法待执行调用时，将这次真实的边界校验失败以 `success:false` 回传原云端 task，附上当前可用函数名称，只允许一次纠正。
不会添加删除能力、自动生成删除命令或伪造执行成功；模型重新选择的函数仍须通过相同的客户端 schema、tool_choice 和执行审批。
从 `0.5.6` 开始，已声明工具的参数契约失败也可通过同一个一次上限回传纠正，包括额外字段、缺少必需字段、类型/枚举错误和无法保留的参数语义。
明确等价的路径别名按目标 schema 转换：`ls/find` 的 `target_directory/directory/path`、文件工具的 `target_file/target_path/file_path/path`；
`find` 的深度别名、`grep` 的 `include/glob` 和 shell 的 `command/cmd` 等也以客户端实际声明字段为准。冲突别名或多个可能目标不猜测选择。
不会将 `glob_path` 的递归 glob 直接等同于 `find` 的名称模式，不会为缺少 cwd 字段的 shell 自动拼接 `cd`，也不会删除未知参数来强行通过校验。
错误信息保留原函数名和失败字段，不包含失败参数值。参数纠正后仍必须重新通过原 schema；函数名错误和参数错误不会各获一次额外重试。
客户端原始工具说明、完整参数 schema，以及由已声明能力推导的受支持原生别名，同时明确写入模型可见提示；不再仅列名称或笼统禁止所有原生名称。
函数按名称排序，JSON 对象键和别名列表按固定顺序渲染，去除内部随机别名包装；同一契约不引入时间戳或随机值。原生 `TOOL` 服务端执行事件仍拒绝。
重复非法调用、混合合法与非法调用、未完成流和网络错误仍明确失败；不会重放用户输入、已执行工具结果或图片上传。
流中顶层 `error` 表示失败，即使 HTTP 为 200 且最后有 `[DONE]`；调用方应先识别该错误，不能仅凭 `[DONE]` 判断成功。
流式与非流式使用同一适配器，回传云端时保留原始工具名、参数及调用 ID，客户端参数转换不污染原始记录。
搜索支持 `content`、`files_with_matches`、`count`。优先使用能完整表达请求的客户端搜索工具；
Harness 固定内容搜索可等价接收 `content`，其他模式或额外选项则交给客户端已声明的 shell 执行转义后的 `rg`。
shell 路径需要客户端环境中可用的 ripgrep；插件不会在后台安装它或直接在本机执行搜索。
支持 glob/type、大小写、行号、上下文、跨行和输出分页；无匹配正常返回，非法正则及其他执行错误保留。
未知选项和没有可用表达能力的请求仍明确报错，不把文件列表、计数和内容三种语义混为一谈。
这里的 Codex/Claude Code 格式已通过兼容性测试；真实应用的完整联调范围以 VALIDATION.md 为准。

### 图片

支持 PNG、JPEG、WebP、GIF 的内联 base64：OpenAI `image_url` / `input_image`，
以及 Anthropic `image` + `source.type=base64`。
支持纯图片消息、文字与图片混合消息及工具图片结果。每次上传最多 5 张，每张解码后不超过 10 MiB。
图片通过 Comate 文件上传接口和 IMAGE contexts 传输，base64 不塞入文本提示。
不抓取远程图片 URL，不支持 PDF/文档/音视频；非法输入明确报错，不丢弃图片后降级成纯文本。

### 长任务

**没有生成总时限。** 持续输出的任务不会因运行超过五分钟而中断，用户仍可取消。
保留独立故障检测：元数据请求 15 秒、单张图片上传 30 秒、生成响应头 5 分钟，
流式首字节 5 分钟、收到首字节后连续无字节 3 分钟。每次收到字节（包括保活）重置空闲计时。
这些阶段/空闲预算不限制持续活动任务的累计时长。宿主、网关及调用客户端自身的限制独立存在。
云端请求拒绝重定向；创建会话/任务和执行 POST 不自动重试，防止重复提交含副作用的工具结果。

云端路径避免了旧桌面执行端点，但这不等同于服务端所有工具均关闭或社区已接受新方案。
真实 Codex/Claude Code 完整网关验收、维护者重新审核仍需分别记录。

### Token 用量与上下文百分比

当前实测的 Comate 云端 execute 流不返回 token 用量。旧版本也没有向客户端提供 `usage`，
DeepSeek Harness 因而将每步用量记为 0，长任务的上下文指示器也可能一直显示 0%。
从 `0.5.3` 开始，插件提供**明确标注来源的估算值**，用于上下文参考，不是云端实测或计费凭据。

- 非流式响应包含标准 `usage.prompt_tokens`、`completion_tokens`、`total_tokens`。
- 流式在成功结束后、`[DONE]` 前发送一次 `choices: []` 的 usage chunk；默认发送，
  显式设置 `stream_options.include_usage: false` 可关闭。失败或取消不会输出成功用量。
- `usage.comate_usage` 中 `source: "estimated"`、`method: "unicode-density-v1"` 标注估算来源，
  响应头另有 `X-Comate-Usage-Source: estimated`。网关或客户端可能只保留标准计数，不显示来源标签。

输入按**完整可见历史**、工具定义和适配提示估算，包含历史工具调用及返回结果；原生续聊只上传增量时，
仍计算保留的上下文。输出包含正文、推理及原生工具调用参数，推理同时列在
`completion_tokens_details.reasoning_tokens` 中，已包含于输出总数，不重复相加。
不声明未知的缓存命中。估算规则为 ASCII 每 4 字符约 1 token、其他 BMP 字符约 1 token、
补充平面字符约 2 token；每张历史图片固定预留 1,024 token，不按 base64 长度计价。

这不是各模型的专用 tokenizer：云端隐藏提示、自动压缩、图片切片及真实缓存均不可见，数值可能偏高或偏低。
百分比还依赖客户端配置的模型容量；插件没有按模型名猜测容量。已有日志中的零值不会被回写，
更新生效后的新请求才会带用量。请在长任务完成后更新插件并开启新请求，避免中途替换插件宿主。

## 验证

```sh
npm test
MAGPIE_HOST=/absolute/path/to/host.js MAGPIE_BUN=/absolute/path/to/bun npm test
```

`cloud.test.mjs` 和 `cloud-features.test.mjs` 验证新云端传输、原生续聊、图片及长任务，`cloud-host.test.mjs` 使用显式指定的生产 Magpie 宿主和假云端服务。
`usage.test.mjs` 验证完整历史、工具/图片/推理估算和流式用量；0.5.3 已完成本机独立 Magpie 网关到真实 Comate、再到 Harness CLI 的用量联调。
测试不会自行寻找邻近仓库。没有显式宿主/Bun 时宿主测试跳过。
`local-transport.fixture.mjs` 仅保留旧本地传输回归，未由生产入口导入，也不进入 npm 包。
旧 `models.test.mjs`、`protocol-transport.test.mjs` 和 `integration.test.mjs` 对它的测试不能作为新云端传输验收。
协议及发现测试继续覆盖两代实现的共有行为。

npm 载荷只有 LICENSE、README.md、index.mjs、cloud.mjs、cloud-session.mjs、usage.mjs、tool-adapter.mjs、tool-profiles.mjs、tool-schema.mjs、tool-search.mjs、images.mjs、protocol.mjs、discovery.mjs、package.json。
没有安装器、二进制或生命周期脚本。当前使用 GitHub 分发；未来若发布 npm，也使用个人作用域包名。
详见源码中的 [VALIDATION.md](./VALIDATION.md)。

## 来源与维护

独立项目的运行源码来自 [PengJunchen/plugins](https://github.com/PengJunchen/plugins/tree/codex/comate-cloud-local-20261102/packages/comate) 提交 `48801b2`；保留 MIT 许可及贡献者声明。吸收 Liu-LingYu 0.2.13 的部分云端协议思路。后续以本仓库根目录源码和测试维护公开插件。

旧社区 PR [#77](https://github.com/magpie-community/plugins/pull/77) 已关闭；本项目不是该 PR 获批或市场重新上架的声明。

当原生 `todo_write` 返回 `todos` 数组，而客户端同名工具声明单条 `action` 时，0.5.7 在一次纠正回合中提供显式调用标记。只转发经原客户端 schema 验证的单条操作。下一轮以完整客户端历史回传真实工具结果。

0.5.8 将一次纠正中的文本调用通道扩展到所有客户端工具合约错误，覆盖客户端尚未提供 `todo_write` 的动态工具集合。混合有效与无效调用的待执行批次整体退回，逐条以原生 ID 和参数报告未执行失败，最多纠正一次；不注册客户端未提供的工具。首回合和纠正回合的文本调用均校验完整客户端 schema、工具选择和并行约束。文本调用的下一轮仍通过完整历史回传真实客户端结果。

0.5.9 消除纠正回合中“禁止文本标记”与“使用文本工具块”的指令冲突。若上游已明确结束，纠正文本仍缺少闭合工具块，且没有任何待执行原生调用，则整段文本保留不派发，以显式适配器格式反馈请求一次完整重生成。单次客户端请求最多三次云端 execute：初始执行、一次原生合约纠正、一次格式重生成；重生成不会续接残缺 JSON、伪造原生 ID、重发查询或工具结果。最终输出仍校验原客户端工具/schema/choice/parallel。重复不完整、其他合约错误、断流、网络错误、取消和服务端工具执行均明确失败，不再重试。此版本仅完成合成离线及生产宿主模拟上游验证，真实长任务覆盖仍待后续评测。

0.5.10 保持三次 execute 上限，统一纠正格式为客户端原名，取消完整 schema 与随机别名协议的重复发送。完整客户端合约只在 systemReminder 中保留一份；原生失败反馈只保留真实失败原因及可用客户端名称。纠正和最终格式反馈建议选择能完整输出的最小下一步调用，优先使用客户端支持的增量操作，不补 JSON、不省略必需参数、不自行拆分或执行工具。

云端流适配失败时，错误 message 末尾附 ` [comate_diagnostics={...}]`，只记录有界的每回合事件/字符/字节/调用计数、明确终止状态、标记出现次数、JSON 语法状态和白名单停止原因。不记录正文、推理内容、参数、工具名/ID、标记值或任意上游字段。缺少云端停止原因时标记为 `not_reported`，不据此断言输出预算耗尽。客户端 max_tokens/max_completion_tokens 当前没有映射到 Comate execute 的生成控制字段，诊断显式标注 `client_output_limit_forwarded:false`；不猜测未核实的云端 API 参数。最终格式反馈仍是 query 内标注 system 角色的 JSON 行，不能视为已证明的 SDK 原生 system 消息。真实长任务效果需后续评测确认。

0.5.11 将此前分散在修复分支上的 0.5.4–0.5.10 修改汇总至 main，并保留 main 已有的网页搜索参数兼容修复。网页搜索的参数语义错误接入同一有界合约纠正流程；保留原始原生 ID、参数与真实客户端结果的对应。三次 execute 上限及客户端工具/schema/choice/parallel 校验保持一致。

0.5.12 修复 Comate 流式响应交还后调用方取消但尚未消费 body 时会遗留会话锁的问题，并让每次请求仅能释放自己持有的锁，避免旧流迟到 cleanup 解锁正在续轮的请求。云端工具仍只交由客户端审批和执行。

## 自动构建与发布

`.github/workflows/build-release.yml` 在面向 main 的 PR、main 更新及手动触发时运行测试、构建，并校验源码、ZIP/TGZ、BUILD-INFO.json 和 SHA256SUMS。每次运行保留 30 天构建产物。PR 作业只有读取权限；只有 main 的测试构建通过后，发布作业才获得 Release 写入权限。

发布版本取自 package.json：新版本号会自动创建对应 `vX.Y.Z` Release，上传 ZIP、TGZ、BUILD-INFO.json 和 SHA256SUMS；先暂存为草稿，核对远端附件 SHA-256 后才公开。相同版本号已发布时，只生成本次构建产物，不覆盖旧 Release；需要更新下载包时，请在 PR 中递增 package.json 版本号。上传中断的草稿可在同一提交上重新运行恢复。

GitHub runner 无本机 Magpie 宿主，宿主集成测试会按现有测试规则明确跳过；其他测试全部运行，使用合成上游，不访问真实模型或登录态。本地完整宿主测试仍使用前述 MAGPIE_HOST/MAGPIE_BUN。构建发布流程不会安装或重载任何本机插件。

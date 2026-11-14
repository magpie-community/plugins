# Comate for Magpie

把本机已经登录的百度 Comate 账号，变成一个 Magpie 供应商。

装上插件、登录一次，接进 Magpie 的 Codex、Claude Code、DeepSeek Harness 等客户端就能直接选
`comate/<模型 ID>`，不需要再开一个 IDE 窗口。插件只从 Comate 桌面客户端读取登录凭据，其余全部直连
`https://comate.baidu.com`：模型目录、对话、图片和用量都走云端接口。

当前版本 `0.5.21`。纯 JavaScript（`type: module`），没有第三方依赖、安装脚本和二进制，Mac 与
Windows/Linux 使用同一份代码。

| 你要的东西 | 插件的行为 |
| --- | --- |
| 模型 | 每次按账号向云端拉取实时目录，不内置固定模型表 |
| 续聊 | 同账号、模型、会话复用云端 conversation/task，每轮只发新增内容 |
| 工具 | 云端原生函数调用转成客户端的 `tool_calls`，由客户端审批和执行 |
| 图片 | 内联 PNG/JPEG/WebP/GIF 输入与工具结果图片 |
| 用量 | 优先上报云端真实 token，拿不到才标注为本地估算 |
| 额度 | 套餐、授权剩余天数、日/月额度、积分余额，设备上直接可查 |
| 签到 | 可选的每日签到钩子，替账号领活动积分 |

## 安装

Magpie 的插件就是 npm 包、git 仓库或文件夹，三条路都指向同一份源码，任选其一。

```sh
# 1. 从 GitHub 安装（推荐）
magpie plugin add github:SherlockGougou/magpie-comate-auth

# 2. 从 Release 的 zip 解压出的文件夹安装
magpie plugin add ./magpie-comate-auth

# 3. 从源码构建后安装
git clone https://github.com/SherlockGougou/magpie-comate-auth.git
cd magpie-comate-auth && npm run build
magpie plugin add ./dist/magpie-comate-auth
```

| 方式 | 适合 | 注意 |
| --- | --- | --- |
| GitHub | 日常使用 | 仓库带 `magpie-plugin` topic，出现在 **插件 → 发现 → 非官方插件**；GitHub 索引与 Magpie 的十分钟缓存可能延迟 |
| Release zip | 离线、固定版本 | 下载 `magpie-comate-auth-0.5.21.zip`，不是自动生成的 Source code.zip；解压到长期保留的目录，登记后别移动或删除 |
| 源码构建 | 改代码、自己验证 | 需要 Node.js 22+ 与 npm；`dist/` 由命令生成、不提交进 Git |

同一个 Release 还提供 `.tgz`、`SHA256SUMS` 和 `BUILD-INFO.json`（记录源码提交、是否有未提交变更，以及每个运行文件的哈希）。

装完确认一下：

```sh
magpie plugin list          # comate 是否出现、登录状态、模型数量
magpie provider test comate # 用账号真发一个小请求
```

## 登录

打开 Comate 供应商的登录入口，有两种方式：

| 方式 | 用什么 | 适合 |
| --- | --- | --- |
| **Comate account (this computer)** | 本机 Comate 客户端里已经登录的账号 | 本机只有自己的账号，最省事 |
| **Comate license (paste)** | 手动粘贴 Comate 设置里的 `baidu.comate.license` | CI、远程机器、同时挂多个账号 |

第一种方式读本机设置拿到 license，一次点击就完成，不需要 Comate 客户端保持运行，也不需要打开浏览器。
第二种方式每粘贴一个 license 就是一个独立账号，`comate` 下可以有多个账号，由 Magpie 负责轮换和故障切换。

凭据由 Magpie 保存在它的配置目录（`plugin-auth.json`，权限 600），格式与 OpenCode 的 `auth.json` 相同。
插件读取的 Comate 设置默认在 `~/Library/Application Support/Comate/User/settings.json`，可以用绝对路径
环境变量 `COMATE_SETTINGS_PATH` 覆盖。

登录后把客户端模型切成供应商 `comate` 下的某个模型即可。只安装插件不会自动改变任何客户端的模型选择。
装了两份同名插件时，指定提供服务的那一份：

```sh
magpie plugin use github:SherlockGougou/magpie-comate-auth comate
```

## 一次对话怎么走

```
客户端 ──chat.headers──▶ Magpie 网关 ──HTTPS──▶ comate.baidu.com
   ▲                                              │
   └──── tool_calls / 文本流 ◀── 网关转换 ◀─────────┘
```

1. 客户端每轮带着会话 ID 请求 Magpie；插件的 `chat.headers` 把会话 ID 写进插件专用头
   `x-magpie-comate-session`（只发给插件，不外发）。
2. 插件按「账号 + 模型 + 会话 ID」找到云端的 conversation/task，把新增消息追加进去；同一轮的工具结果
   以原始 tool call ID 通过 `toolUseResults` 回传。
3. 云端在终止事件 `ANSWER` 之后另发 `TOKEN_USAGE`，插件读完再结束回合，真实用量随响应上报。
4. 流里出现顶层 `error` 就是失败，即使 HTTP 200 且末尾有 `[DONE]`。

需要新建 task 的情况：缺少会话 ID、宿主重启或缓存被淘汰、历史分叉、本轮提供的工具目录发生变化。此时回放
完整历史，图片会重新上传。会话与别名缓存上限 64 条。

## 模型目录

`provider.models` 在每个账号的作用域里查询云端接口 `POST /api/v2/api/models/available`，失败时保留上次的
列表，不会把账号标记成未登录。模型映射规则：

- 模型 ID 用云端 `modelId`，显示名取 `displayName`；请求里写 `modelType`、`displayName` 或模型 ID
  都能落到同一个模型，精确的实时模型 ID 优先；
- `thinking: true` 的模型声明 `reasoning`，`supportImage: true` 的模型声明图片输入；
- `limit` 只填云端明确给出的正整数，0 视为未知，不按模型名字猜窗口；
- `tool_call` 一律可用，`temperature` 一律关闭。

## 工具

云端只把 Comate 自己的工具集交给模型，客户端只执行客户端声明过的工具。适配与品牌无关，按固定顺序查找
第一个可用表达：

| 顺序 | 找到什么 | 怎么用 |
| --- | --- | --- |
| 1 | 同名工具 | 原样传入，按它自己声明的 schema 校验 |
| 2 | 等价能力 | `Read`/`Write`/`Edit`/`Bash`/`Grep`/`Glob`/`TodoWrite` 与 `read`/`write`/`edit`/`bash`/`glob`/`grep` 等按能力对应，字段按目标 schema 改名 |
| 3 | 补丁工具 | 客户端声明只收一个字符串的 Begin Patch 工具时，`write_file`/`edit_file`/`delete_file` 改写成一段补丁；`overwrite` 用删除加新增表达 |
| 4 | shell | 只声明 shell 时，`read_file` → `cat -- <path>`、`glob_path` → `find <dir> -name <pattern> -print`，`list_dir` 用 `ls -la`、搜索用转义后的 `rg` |
| 5 | 以上都没有 | 按未声明函数失败，附上本次真实可用的函数名 |

约束：

- 带 `offset`/`limit` 的 `read_file` 会被拒绝，合成 shell 无法安全表达行号语义；含路径分隔符的
  `glob_path` 模式也会被拒绝，`find -name` 只匹配文件名。
- 不合成 `rm` 这类破坏性命令，也不把写操作伪装成 shell 调用；`delete_file` 只能通过补丁工具表达。
- 单次客户端请求最多三次云端 execute：初始执行、一次合约纠正、一次格式重生成。未声明函数、参数不合、
  混合合法与非法调用都走同一次纠正，错误信息保留原函数名和失败字段，但不含失败参数值。
- 断流、网络错误、取消、服务端 `TOOL` 执行都明确失败；不重放用户输入、工具结果或图片。

搜索支持 `content`、`files_with_matches`、`count`；其他模式和额外选项交给客户端已声明的 shell 执行
`rg`（插件不安装 ripgrep，没有 `rg` 就没有这条兜底）。无匹配正常返回，非法正则与执行错误原样保留。

## 图片

PNG、JPEG、WebP、GIF 的内联 base64，OpenAI `image_url`/`input_image` 与 Anthropic
`image` + `source.type=base64` 都认。支持纯图片消息、图文混合消息和工具结果图片。

| 限制 | 值 |
| --- | --- |
| 每次云端请求 | 最多 5 张 |
| 单张解码后 | 不超过 10 MiB |
| 单条工具结果 | 最多 1 张，更多请放到用户消息里 |
| 传输 | Comate 文件上传接口 + IMAGE contexts |
| 不支持 | 远程图片 URL、PDF、文档、音视频 |

非法输入直接报错，不会丢图后降级成纯文本。

## 时间预算

持续输出没有总时限，用户可以随时取消。每个阶段单独计时：

| 阶段 | 预算 |
| --- | --- |
| 元数据请求（模型目录、额度、上传接口调用） | 15 秒 |
| 单张图片上传 | 30 秒 |
| 等待生成响应头 | 5 分钟 |
| 流式首字节 | 5 分钟 |
| 收到首字节后连续无字节 | 3 分钟（任何字节，含保活，都会重置） |
| 读取尾部 `TOKEN_USAGE` | 5 秒 |

云端请求拒绝重定向；创建会话、创建 task、执行 POST 不自动重试，避免重复提交带副作用的工具结果。
宿主、网关和调用客户端自身的限制独立存在。

## 用量

| 情形 | 上报内容 |
| --- | --- |
| 上游发了 `TOKEN_USAGE` | 真实 `inputTokens`、`cachedInputTokens`、`outputTokens`；缓存命中写进 `prompt_tokens_details.cached_tokens` |
| 上游没发或尾部读取失败 | `source: "estimated"`、`method: "unicode-density-v1"` 的本地估算，不影响已完成的回答 |
| 非流式响应 | 标准 `usage`；`X-Comate-Usage-Source` 标出是 `upstream` 还是 `estimated` |
| 流式响应 | `[DONE]` 前发一个 `choices: []` 的 usage chunk（`stream_options.include_usage: false` 可关）；响应头先于读流发出，因此不声明来源 |

估算基于完整可见历史、工具定义和适配提示，包含历史工具调用与结果；输出含正文、推理与原生工具调用参数，
推理同时列在 `completion_tokens_details.reasoning_tokens` 且已计入总数。规则是 ASCII 每 4 字符约 1
token、其他 BMP 字符约 1 token、补充平面字符约 2 token，每张历史图片固定预留 1,024 token。它不是任何
模型的专用 tokenizer，云端隐藏提示、自动压缩和图片切片都不可见，数值可能偏高或偏低。

## 额度与签到

`auth.usage` 展示套餐、授权剩余天数、日/月额度和积分余额，全部只读，互不影响。

**套餐与授权**：`/api/key/type/{license}` 与 `/api/key/expiring/detail/{license}`。授权接口只有剩余天数，
所以不推算到期时间或续费状态；`usedDailyCost`/`maxDailyCost` 这类 `cost` 字段没有明确单位，只显示原始计数
和百分比。

**个人版积分**：`/api/openapi/v3/agent/daily_cost` 对个人版固定返回 `status: "OK"` 与 `data: null`，这是
真实结果，不是解析错误。个人版的记账单位是积分，只存在于网页账号接口
`GET /api/user/agent/balance`，而它只认百度 passport Cookie。插件因此按下面的顺序补余额：

1. 只读地解密本机**百度搭子（DuMate）桌面端**的 `<用户数据目录>/auth.json` 与同目录 `.cookie-key`
   （激活账号的 `encryptedCookies`，AES-256-GCM）。Comate 与搭子共用一个百度账号和一个积分池。目录按平台
   定位：macOS `~/Library/Application Support/qianfan-desktop-app`、Windows
   `%APPDATA%\qianfan-desktop-app`、Linux `$XDG_CONFIG_HOME/qianfan-desktop-app`，`DUMATE_USER_DATA_DIR`
   可覆盖。
2. 先请求 `GET /api/user`，其 `license` 必须与当前账号完全一致。
3. 再用 `/api/user/agent/balance` 的 `seatPoints`、`addonPoints`、`giftPoints`、`standalonePackPoints`
   求和：余额取 `availablePoints` 之和，用量窗口取 `usedPoints` 与 `totalPoints` 之和。

不写文件、不落盘、不上传；Cookie 只作为请求头发给 `comate.baidu.com`，也不会进日志或错误信息。没有安装
或没有登录搭子、Cookie 过期、账号不一致（本机搭子登的是另一个百度账号）、应答异常，都只是没有积分，
仍显示「积分暂不可用」，不影响套餐和登录结论。日/月额度窗口存在时优先显示官方窗口，积分不与它叠加。

**每日签到**：在 **设置 → 用量 → 插件** 里打开该供应商的签到后，Magpie 每个北京日对每个账号调用一次，
「立即签到」可以马上执行。插件调用 Comate 桌面客户端领取「搭子充能计划」积分的同一个幂等接口
`GET /api/generate/activity/checkIn?license={license}&device=&uuid=`：

| 云端应答 | 结果 |
| --- | --- |
| `data` 为真 | `claimed`，接口明确返回数字时附带积分数 |
| `data: false` | `done`，今天已经领过 |
| 401、服务端拒绝或非 JSON 应答 | `failed`，附原因 |
| 5xx | 先按 2 秒、4 秒重试两次，仍然失败才 `failed` |
| 完全没有响应 | 抛错，交给 Magpie 的离线退避立即重试 |

插件不伪造设备号：`device` 留空即可，也不读取、不上报 Comate 的设备标识。正午前的 `done` 只是临时结论，
Magpie 30 分钟后会再问一次，积分是否到账以 Comate 客户端为准。

## 并发与取消

插件只声明 `maxConcurrency: 8`，其余交给 Magpie。同一会话还在生成时的后续请求排队等待，**不返回 4xx**——
4xx 会被 Magpie 当成厂商回答，触发账号或模型切换。失败、断流和取消都会废弃受影响的会话状态，待回传的
工具结果必须完整匹配 ID，否则明确报错。

推理内容可以返回，但不转发推理档位、`temperature`、`max_tokens` 等生成控制。工具参数必须是 JSON 对象；
校验只覆盖声明 schema 里的类型、必填、枚举、常量、数量边界和 `anyOf`/`oneOf`，不是完整 JSON Schema——
不填默认值、不猜类型、不修复字符串，但声明的类型是数组或对象时会先把 JSON 字符串解码再校验。拒绝
`strict: true`。

## 平台

| 平台 | 状态 |
| --- | --- |
| macOS | 云端传输、续聊、工具、用量、额度、积分与签到都在本机真实账号上复核过；签到「新的一天领到积分」尚未实测 |
| Windows / Linux | 路径与凭据解析有单元测试，本版本未做原机验收 |

`local-transport.fixture.mjs` 只保留旧本地传输的回归用例，不进入生产入口和 npm 载荷；针对它的
`models.test.mjs`、`protocol-transport.test.mjs`、`integration.test.mjs` 不能作为新云端传输的验收依据。

## 开发

```sh
npm test                                                   # node --test
MAGPIE_HOST=/absolute/path/to/host.js \
MAGPIE_BUN=/absolute/path/to/bun npm test                  # 加上宿主集成测试
```

| 模块 | 职责 |
| --- | --- |
| `index.mjs` | 插件入口：登录方式、供应商声明、OpenAI 兼容的流式/非流式编码 |
| `cloud.mjs` | `fetch` 钩子：会话、原生工具、图片、用量尾部、额度与签到挂载 |
| `protocol.mjs` | Comate SSE 解析、工具调用文本解析与状态机 |
| `cloud-session.mjs` | 会话键、历史哈希、工具目录哈希、续聊与工具结果回传 |
| `tool-adapter.mjs` | 能力阶梯、参数改名、补丁桥接、shell 兜底 |
| `tool-profiles.mjs` / `tool-schema.mjs` / `tool-search.mjs` | 能力描述、schema 校验、搜索模式 |
| `images.mjs` | 图片解析、上限与规范化 |
| `usage.mjs` / `quota.mjs` / `points.mjs` / `checkin.mjs` | 用量估算、套餐额度、积分、签到 |
| `discovery.mjs` | 本机 Comate 设置与 license 读取（含 JSONC 解析） |

共 376 个用例，覆盖云端传输、宿主集成、用量、签到、积分与工具适配矩阵。搜索相关用例需要 PATH 上有
`ripgrep`，缺失时会跳过或失败；宿主集成测试需要显式给出 `MAGPIE_HOST` 和 `MAGPIE_BUN`，否则跳过，
测试不会自行搜索邻近仓库。测试不读本机真实凭据，也不访问真实模型。

新增一个客户端，通常只需要在 `tool-profiles.mjs` 加一条能力描述，或在 `tool-adapter.mjs` 加一个策略，
再在对应测试里补回归用例。

## 构建与发布

```sh
npm run build
# dist/magpie-comate-auth/                 可直接安装的载荷目录
# dist/magpie-comate-auth-<版本>.zip    确定性 ZIP（UTF-8 路径、固定文件模式）
# dist/sherlockgougou-magpie-comate-auth-<版本>.tgz
# dist/BUILD-INFO.json  dist/SHA256SUMS
```

npm 载荷是 `package.json`、`LICENSE`、`README.md` 与运行模块（`index.mjs`、`cloud.mjs`、
`cloud-session.mjs`、`usage.mjs`、`quota.mjs`、`points.mjs`、`checkin.mjs`、`tool-adapter.mjs`、
`tool-profiles.mjs`、`tool-schema.mjs`、`tool-search.mjs`、`images.mjs`、`protocol.mjs`、`discovery.mjs`、
`icon.png`），没有安装器、二进制或生命周期脚本。

`.github/workflows/build-release.yml` 在面向 main 的 PR、main 更新和手动触发时运行测试、构建并校验源码、
ZIP、TGZ、`BUILD-INFO.json` 与 `SHA256SUMS`，产物保留 30 天。PR 作业只有读权限；main 的构建通过后，
发布作业才拿到 Release 写权限：新版本号自动建 `vX.Y.Z` Release，先暂存草稿、核对远端附件 SHA-256 再
公开；同版本号已发布时只生成本次构建产物，不覆盖旧 Release，要更新下载包就在 PR 里递增版本号。
GitHub runner 没有本机 Magpie 宿主，宿主集成测试按现有规则跳过。

## 常见问题

**没有模型？** 先看 `magpie plugin list` 里登录状态。`comate` 已登录但模型为空，多是云端目录接口失败，
重载插件再试；本机没有登录 Comate 时，用粘贴 license 的方式。

**模型列表会变吗？** 会。目录来自账号的云端实时列表，插件不内置种子模型，账号升级或下线模型后直接反映。

**工具没被调用，或者报「未声明的函数」？** 说明本次请求没有提供能表达该能力的工具。错误信息里带了本次
可用的函数名。客户端只声明 shell 时，写文件类操作没有安全表达，会明确失败而不是合成命令。

**我的代码会发到哪里？** 只发往 `https://comate.baidu.com`。对话、系统提示、工具定义、图片和客户端工具
结果都经过这份云端；插件自己不做遥测，不写日志文件。

**为什么积分显示「暂不可用」？** 个人版官方额度接口返回空，而本机又没有可用的百度账号登录态（或那个账号
不是当前 Comate 账号）。套餐与登录结论不受影响。

**多账号怎么配？** 每个账号单独登录一次；本机账号方式读的是同一个 Comate 登录态，要多账号请用粘贴
license 的方式，或在不同的机器上各装一份。

## 版本历史

| 版本 | 变更 |
| --- | --- |
| `0.5.21` | 客户端没有声明联网搜索函数时，模型的 `web_search` 调用改成一次可纠正的拒绝，不再让整个请求以 `api_error` 结束 |
| `0.5.20` | 重写文档：按安装、登录、请求路径、工具、用量、开发分节，补常见问题；运行代码与 0.5.19 相同 |
| `0.5.19` | 文件与读取能力改成通用阶梯（同名 → 等价能力 → 补丁 → shell），补 `read_file`/`glob_path` 的 shell 兜底；补丁目标不再固定叫 `apply_patch` |
| `0.5.18` | 修复文本式原生函数调用被逐字符拆成参数键；整段参数 JSON 还原成对象后校验，Codex 可经补丁桥接使用云端文件工具 |
| `0.5.17` | 个人版 `daily_cost` 返回空时改读账号积分，先验证本机搭子登录态属于同一 license |
| `0.5.16` | 图标 URL 加版本查询，绕开 Magpie 的旧图标缓存 |
| `0.5.15` | 新增 `auth.checkin` 每日签到 |
| `0.5.14` | 精简文档，运行代码与 0.5.13 相同 |
| `0.5.13` | 读取 `TOKEN_USAGE` 上报真实用量与缓存命中；流式不再声明来源头 |
| `0.5.4` – `0.5.12` | 工具适配、纠正通道、文本工具标记、会话锁与搜索参数的一系列修复 |

真实 Codex / Claude Code 的完整网关验收和维护者重新审核仍待完成，逐版本的证据与未验证项记录在
[VALIDATION.md](./VALIDATION.md)。

## 许可证

[MIT](./LICENSE)。插件通过 Magpie 的非官方插件发现机制分发（仓库带 `magpie-plugin` topic），未经官方
市场审核；旧社区 PR [#77](https://github.com/magpie-community/plugins/pull/77) 已关闭，本项目不是它获批
或市场重新上架的声明。

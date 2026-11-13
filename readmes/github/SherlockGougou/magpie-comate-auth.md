# Magpie Comate Auth

在 Magpie 中直接使用本机 Comate 账号的独立插件：DeepSeek Harness、Codex、Claude Code 等客户端接入
Magpie 后即可选用 Comate 云端模型，无需再开一个 IDE。

当前版本 `0.5.14`，纯 JavaScript：无第三方依赖、无安装脚本、无二进制。通过 Magpie 的**非官方插件**
发现机制分发（仓库带 `magpie-plugin` topic），未经官方市场审核。

## 特点

- **直连云端**：用 HTTPS 请求 `https://comate.baidu.com` 并复用本机 Comate 登录态；不调用 Comate 本地
  服务，云端不可用时直接报错，不静默降级。
- **原生续聊**：同账号、模型和会话复用云端 conversation/task，每轮只发新增内容；缺少 session ID、
  宿主重启或缓存淘汰、历史分叉、工具目录变更时新建 task 并回放完整历史（会重传历史图片），最多保留
  64 个会话。
- **工具交给客户端**：云端原生函数调用转换为客户端 `tool_calls`，由客户端的审批与沙箱执行，结果以原始
  ID 通过 `toolUseResults` 回传；插件内不执行 shell、不伪造结果。
- **图片与长任务**：支持内联图片输入与工具结果图片；持续输出没有总时限，只限制首包与空闲等待。
- **用量与额度**：优先上报 Comate 返回的真实 token，缺失时才回落到明确标注的本地估算；可查套餐与额度。
- **并发交给 Magpie**：只声明 `maxConcurrency: 8`，同一会话的请求串行排队，不返回 4xx 触发故障切换。

## 安装

跨平台 JavaScript，不需要编译 Magpie，也不要把文件复制进 `Magpie.app`。三种方式任选一种，推荐第一种。

方式一——从 GitHub 安装（推荐）：

```sh
magpie plugin add github:SherlockGougou/magpie-comate-auth
magpie plugin login comate 1
```

也可在 Magpie → **插件 → 非官方** 中搜索 `magpie-comate-auth` 安装。GitHub 索引和 Magpie 的十分钟缓存
可能延迟显示。

方式二——使用 [最新 Release](https://github.com/SherlockGougou/magpie-comate-auth/releases/latest) 里的
`magpie-comate-auth-0.5.14.zip`（不是自动生成的 Source code.zip），解压到长期保留的目录，然后添加
**同时包含 `package.json` 和 `index.mjs` 的那一层**：

```sh
magpie plugin add ./magpie-comate-auth
magpie plugin login comate 1
```

本地安装登记的是文件夹路径，安装后不要移动或删除该文件夹。同一 Release 还提供 `.tgz`、`SHA256SUMS`
和 `BUILD-INFO.json`（记录源码提交、未提交变更标记和各运行文件哈希）。

方式三——从源码构建（Node.js 22+、npm，无第三方依赖）：

```sh
git clone https://github.com/SherlockGougou/magpie-comate-auth.git
cd magpie-comate-auth
npm run build
magpie plugin add ./dist/magpie-comate-auth
magpie plugin login comate 1
```

`dist/` 由命令生成、不提交进 Git，可下载产物发布在 Releases。

## 登录与使用

在提供方页面添加 **Comate**，选择 **Comate account (this computer)**。电脑需已有可读的 Comate 登录凭据，
不要求 Comate 本地服务运行。登录后把客户端模型切换为实时目录中的 `comate/<model ID>`；仅安装插件不会
自动改变各客户端的模型选择。用 `magpie plugin list` 确认 `comate`、登录状态和模型数量；装了多份插件时
可指定提供服务的那份：

```sh
magpie plugin use github:SherlockGougou/magpie-comate-auth comate
```

宿主会保存凭据；对话、系统提示、工具定义、图片和客户端工具结果会发往 `https://comate.baidu.com`。插件
只读 Comate 设置（macOS 默认 `~/Library/Application Support/Comate/User/settings.json`，可用绝对路径
`COMATE_SETTINGS_PATH` 覆盖）。Windows/Linux 路径有单元测试，尚未完成本版本原机验收。

## 工具适配

Magpie 的 `chat.headers` 钩子把客户端 session ID 通过插件专用头传给插件（不发给 Comate），据此复用云端
task。工具按本次请求实际提供的目录适配，不依赖应用名称：`list_dir` → `bash` 的 `ls -la`（支持 `depth`
1–64 与 `ignore_globs` 的 `*`、`?`、`**` 规则，不支持 gitignore 否定规则、花括号和 extglob）；
`run_command` → `bash`/`Bash`，保留命令本身并映射工作目录、超时和后台选项；文件工具、`glob`/`grep`、
`todo_write`/`update_plan`、`web_search` 按客户端实际 schema 映射，声明为数组/对象的 JSON 字符串会解码
后校验。

- 只选当前请求实际提供的工具，不创建能力、不加提权或审批绕过参数。
- 未声明且无等价适配的函数（如 `delete_file`，或客户端只有 `find` 时的 `glob_path`）以 `success:false`
  把真实失败和可用函数名回传原 task，只允许一次纠正；已声明工具的参数契约失败同样走这一次纠正。
  错误信息保留原函数名和失败字段，不含失败参数值，纠错后仍须通过原 schema。
- 单次客户端请求最多三次云端 execute：初始执行、一次合约纠正、一次格式重生成。重复非法调用、混合
  合法与非法调用、断流、网络错误、取消和服务端 `TOOL` 执行均明确失败，不重放用户输入、工具结果或图片。
- 搜索支持 `content`、`files_with_matches`、`count`；其他模式或额外选项交给客户端已声明的 shell 执行
  转义后的 `rg`（需客户端环境已有 ripgrep，插件不安装）。无匹配正常返回，非法正则与执行错误保留。
- 流中顶层 `error` 即失败，即使 HTTP 200 且末尾有 `[DONE]`。

会话状态按账号、模型和 session ID 隔离。同一会话生成中的后续请求排队等待，不返回 4xx（4xx 会被 Magpie
当成厂商回答并切到别的账号或模型）；整体并发由 Magpie 按 `maxConcurrency` 排队控制。失败、断流和取消
会废弃受影响状态，待回传的工具结果必须完整匹配 ID。

支持文本、流式与非流式、`auto`/`none`/`required`/指定函数。工具参数须为 JSON 对象，不保证完整 JSON
Schema 验证，拒绝 `strict: true`；推理可返回，但不转发推理档位、temperature、max_tokens 等生成控制。
目录来自当前账号的云端实时列表，图片能力按各模型的 `supportImage` 展示，没有固定模型种子。

新增客户端通常只需在 `tool-profiles.mjs` 增加能力描述或单独策略，并在 `tool-adapter.mjs` /
`tool-schema.mjs` / `tool-search.mjs` 侧补回归测试。

### 图片

支持 PNG、JPEG、WebP、GIF 的内联 base64（OpenAI `image_url`/`input_image`，Anthropic `image` +
`source.type=base64`）、纯图片与图文混合消息及工具图片结果；每次最多 5 张，每张解码后不超过 10 MiB，
经 Comate 文件上传接口和 IMAGE contexts 传输。不抓取远程图片 URL，不支持 PDF/文档/音视频；非法输入
明确报错，不丢弃图片后降级成纯文本。

### 长任务

**没有生成总时限**，持续输出的任务不会因超过五分钟而中断，用户仍可取消。独立预算：元数据请求 15 秒、
单张图片上传 30 秒、生成响应头 5 分钟、流式首字节 5 分钟、收到首字节后连续无字节 3 分钟；每次收到字节
（包括保活）重置空闲计时。云端请求拒绝重定向，创建会话/任务和执行 POST 不自动重试，避免重复提交含
副作用的工具结果。宿主、网关及调用客户端自身的限制独立存在。

### 额度与用量

插件通过 `auth.usage` 扩展显示套餐、授权剩余有效天数和服务端返回的日/月额度，仅调用 Comate 桌面客户端
已有的只读接口 `/api/key/type/{license}`、`/api/key/expiring/detail/{license}`、
`/api/openapi/v3/agent/daily_cost?username={license}`。授权接口只有剩余天数，因此不推算到期时间或续费
状态；`usedDailyCost`/`maxDailyCost` 等 `cost` 字段没有明确单位，只显示原始计数和百分比，不添加未经验证
的单位。部分账号返回 `data: null`，此时保留已查到的套餐信息并显示“积分暂不可用（官方接口未返回额度）”，
空值不会显示为零。套餐与额度请求独立处理，额度失败不影响套餐和登录。

云端 execute 流在终止 `ANSWER` 之后另发 `TOKEN_USAGE`，携带本次请求真实的 `inputTokens`、
`cachedInputTokens` 和 `outputTokens`。插件在结束回合前继续读取该事件（5 秒上限）并优先上报：
`prompt_tokens_details.cached_tokens` 是真实缓存命中数；上游未上报或尾部读取失败时回落为
`source: "estimated"`、`method: "unicode-density-v1"` 的本地估算，不影响已完成的回答。非流式响应包含
标准 `usage`，上游有计数时带 `X-Comate-Usage-Source: upstream`；流式在 `[DONE]` 前发送一次
`choices: []` 的 usage chunk（`stream_options.include_usage` 设 `false` 可关闭），因为响应头先于读取流
发出，不声明来源头。

估算按**完整可见历史**、工具定义和适配提示计算，包含历史工具调用与结果；输出含正文、推理和原生工具
调用参数，推理同时列在 `completion_tokens_details.reasoning_tokens` 且已计入总数。规则为 ASCII 每 4
字符约 1 token、其他 BMP 字符约 1 token、补充平面字符约 2 token，每张历史图片固定预留 1,024 token。
它不是各模型的专用 tokenizer，云端隐藏提示、自动压缩和图片切片均不可见，数值可能偏高或偏低；百分比
还依赖客户端配置的模型容量。旧日志中的零值不会回写，更新插件后开启的新请求才会带用量。

## 验证

```sh
npm test
MAGPIE_HOST=/absolute/path/to/host.js MAGPIE_BUN=/absolute/path/to/bun npm test
```

`cloud.test.mjs` 和 `cloud-features.test.mjs` 验证云端传输、原生续聊、图片及长任务，`cloud-host.test.mjs`
使用显式指定的生产 Magpie 宿主和假云端服务。`usage.test.mjs` 验证上游 `TOKEN_USAGE` 优先、估算兜底及
历史/工具/图片/推理估算。没有显式宿主/Bun 时宿主测试跳过，测试不会自行寻找邻近仓库。
`local-transport.fixture.mjs` 只保留旧本地传输回归，不进入生产入口和 npm 载荷，旧 `models.test.mjs`、
`protocol-transport.test.mjs`、`integration.test.mjs` 对它的测试不能作为新云端传输验收。

npm 载荷为 LICENSE、README.md 与运行模块（`index.mjs`、`cloud.mjs`、`cloud-session.mjs`、`usage.mjs`、
`quota.mjs`、`tool-adapter.mjs`、`tool-profiles.mjs`、`tool-schema.mjs`、`tool-search.mjs`、`images.mjs`、
`protocol.mjs`、`discovery.mjs`、`package.json`），无安装器、二进制或生命周期脚本。
真实 Codex/Claude Code 完整网关验收和维护者重新审核仍待完成，详见 [VALIDATION.md](./VALIDATION.md)。

## 版本历史

- `0.5.14` 精简 README（结构合并、版本历史改为单行），运行代码与 0.5.13 相同。
- `0.5.13` 读取终止 `ANSWER` 后的 `TOKEN_USAGE`，上报真实用量与缓存命中；流式不再声明来源头。
- `0.5.12` 修复调用方取消但未消费 body 时遗留会话锁，每次请求只释放自己持有的锁。
- `0.5.11` 将 0.5.4–0.5.10 汇总到 main；搜索参数语义错误接入同一有界纠正流程。
- `0.5.10` 纠正格式统一为客户端原名，完整客户端合约只在 systemReminder 保留一份。
- `0.5.9` 消除纠正回合的文本工具标记冲突；仍限三次 execute，缺少闭合工具块时整段重生成。
- `0.5.8` 纠正通道扩展到所有客户端工具合约错误，混合批次整体退回并逐条报告未执行。
- `0.5.7` 处理原生 `todo_write` 数组与客户端单条 `action` 声明不一致的情况。
- `0.5.6` 已声明工具的参数契约失败可通过同一次纠正回传。
- `0.5.5` 未声明且无等价适配的函数以真实失败回传，附可用函数名，只允许一次纠正。
- `0.5.4` 网络搜索参数适配；`ignore_globs` 支持字符串数组及 JSON 编码字符串。

## 维护与发布

本仓库自主维护，运行源码和测试以仓库根目录为准，不跟随其他仓库更新。旧社区 PR
[#77](https://github.com/magpie-community/plugins/pull/77) 已关闭，本项目不是其获批或市场重新上架的声明。

`.github/workflows/build-release.yml` 在面向 main 的 PR、main 更新和手动触发时运行测试、构建，并校验
源码、ZIP/TGZ、`BUILD-INFO.json` 和 `SHA256SUMS`，构建产物保留 30 天。PR 作业只有读取权限；main 的
测试构建通过后，发布作业才获得 Release 写入权限。版本号取自 `package.json`：新版本号自动创建
`vX.Y.Z` Release，先暂存草稿、核对远端附件 SHA-256 后才公开；相同版本号已发布时只生成本次构建产物，
不覆盖旧 Release，需要更新下载包请在 PR 中递增版本号。GitHub runner 没有本机 Magpie 宿主，宿主集成
测试按现有规则跳过，其他测试全部运行，不访问真实模型或登录态，也不会安装或重载任何本机插件。

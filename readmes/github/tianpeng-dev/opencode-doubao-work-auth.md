# 豆包工作 Magpie 供应商插件

通过本机豆包工作桌面账号，在 Magpie 中使用订阅、查看真实额度、发送对话和执行外部 Agent 的工具循环。支持 macOS；供应商标识为 `doubao-work`。

版本 1.1.6。供应商图标使用豆包工作 App 的原始图标，包含在发行包中。

## 安装

需要在本机安装并登录豆包工作，以及安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。插件自动使用 `~/.local/bin/uv`、`/opt/homebrew/bin/uv`、`/usr/local/bin/uv` 或 PATH 中的 uv；自定义位置可通过 `DOUBAO_WORK_UV` 指定。

仓库包含 `dist/index.mjs` 和全部 JavaScript 依赖，无需构建。在 Magpie 的「插件 → 添加插件」填入 `github:tianpeng-dev/opencode-doubao-work-auth`，然后点击「导入豆包工作桌面登录」。配置名称填 `auto` 即可绑定当前桌面配置。

终端操作：

```sh
magpie plugin add github:tianpeng-dev/opencode-doubao-work-auth
magpie plugin login doubao-work
magpie provider test doubao-work doubao-work-lite
magpie quota
```

首次导入时，uv 会安装 `browser-cookie3==0.20.1` 和固定提交版本的 `ccl_chromium_reader`，具体依赖由随包提供的脚本锁定文件记录。前者读取 Cookie，后者解析 Chromium Local Storage。macOS 如提示访问 `DoubaoWork Safe Storage`，需要允许当前进程读取该钥匙串项目。

## 提供的能力

| 模型标识 | 显示名称 |
| --- | --- |
| `doubao-work/doubao-work-auto` | 自动 |
| `doubao-work/doubao-work-lite` | 豆包 2.1 Lite |
| `doubao-work/doubao-work-pro` | 豆包 2.1 Pro |

模型名称、可用权限、上下文容量和推理强度来自当前账号的豆包工作模型菜单；点击「重新获取模型」会重新查询。当前三个模型分别传递菜单中的真实 `model_item_key`，推理强度独立设置为 `low`、`medium`、`high`，未指定时采用菜单默认值（当前为 `high`）。客户端使用上述完整模型标识，`reasoning_effort` 选择强度。菜单按账号缓存 60 秒。

请求使用桌面应用标识 `aid=1044603`、本机安装版本及启动接口返回的 `assistant_bot_id`。调用保留模型和推理强度配置，不附加电脑任务环境的 `general_task_param`；外部工具由调用方执行。当前菜单声明上下文容量为 256000；这不代表单条 HTTP 请求可以包含等量 token。输出容量字段 0 表示未知。插件没有声明未经确认的模型 token 价格或免费额度。

设备标识从豆包工作 `Local State` 读取；`web_id` 和 `tea_uuid` 从当前配置的客户端 Local Storage 读取。请求使用这些独立标识及桌面平台参数。需要先在豆包工作打开一次对话页面，使该配置具备客户端标识；缺少标识时会明确提示。

Magpie 可以把 Chat Completions、Responses 和 Anthropic Messages 转换到本插件。输入支持文本、system/developer 指令、完整多轮历史、工具调用和工具结果。每次请求使用独立的上游临时对话，响应结束后调用豆包的会话删除接口，并检查本次会话的删除结果。请求期间，临时对话可能短暂出现在桌面客户端。

首次请求，以及编码后的提示词超过 260000 字节的后续请求，使用客户端的 `long_text_paste` 通道，将全部消息和完整工具定义按原始内容保存为 Markdown 中的 JSON 附件，不摘要、不截断。正文保留当前问题、工具名称、工具选择和执行约束；system/developer 指令总大小不超过 32000 字节时也会在正文保留。当前问题自身超过 24000 个 JavaScript 字符时，正文显示原文首尾，完整问题保存在附件中。服务端对正文、附件解析和模型上下文仍可能设置限制。

附件采用客户端的上传授权、二进制上传、提交和资源注册流程，使用 `tenant_id=5`、`scene_id=154`，上传前记录清理 URI。Markdown 在内存中生成，插件不会把历史正文保存到本地文件。上传凭据与模型菜单并行获取。

流式请求按服务端文本块实时转发正文和可见思考。携带工具定义时，普通文字与工具 JSON 中的 `content` 字符串也逐块返回；完整工具调用在上游结束、参数校验和临时资源清理完成后提交。JSON 使用流式解析库处理，跨块中文、转义字符和表情保持完整。若后续格式、参数或清理失败，流内返回错误，不发送成功结束事件。

工具适配通过提示词约定 JSON 格式，校验工具名称、参数 Schema、tool_choice、并行数量和调用结果关联。`tool_choice=auto` 且无需调用工具时，提示模型直接生成正文；要求工具调用时必须返回有效的调用对象。工具定义与结构化输出可以同时存在：工具调用经过参数校验，最终结构化正文经过 JSON Schema 校验。真正的文件操作、命令等由调用方 Agent 执行。结构化 JSON/JSON Schema 正文和非流式请求在完整校验后返回。

工具协议在正文中保留一份，完整工具定义、历史和执行约束均保留。账号初始化中的身份验证与启动配置查询并行执行，账号验证完成后才发送聊天请求。首字时间包含账号准备、附件上传、上游模型处理和网络时间，不能保证固定耗时。

Codex 会自动附带自身指令和可用工具定义，即使问题很短，请求也可能达到数百 KB。插件保留调用方提供的完整工具定义与上下文；如果 Codex 启用了大量插件或连接器，它们的工具说明也可能被包含。实际首字时间取决于请求大小、模型、推理强度和豆包服务端状态。

服务端返回思考文本时，以 `reasoning_content` 单独传递。较高的推理强度不保证服务端提供可见的思考文本。

支持 `tool_choice=auto/none/required`、指定工具、`parallel_tool_calls`、`response_format=json_object/json_schema`。调用方直接传入图片、音频、文件、采样参数、logprobs 和 stop 序列会被拒绝；长历史附件由插件自动生成。`max_tokens`、`max_completion_tokens` 作为提示词中的回复预算传递，上游没有提供可确认的硬性 token 截断接口。请求最长 180 秒，每个 Magpie 账号默认并发为 1。

## 临时资源清理

成功、上游异常和取消请求都会执行资源清理。插件只删除本次请求登记的会话和附件；会话必须匹配完整的 `local_conversation_id`、账号和 bot，收到确认后记录服务端会话标识。清理使用独立超时，调用方取消不会取消清理请求。非流式响应和流式结束事件均在清理完成后返回。

清理记录位于 `$XDG_CACHE_HOME/doubao-work-magpie/conversations/`，默认使用 `~/.cache`。记录只包含本次请求的标识、附件 URI、时间和进程信息，文件权限为 0600。网络异常或进程中断留下的记录会在下次请求前核查并恢复清理；在收到会话确认前断线时会保留标识，便于核查延迟创建的会话。无法确认清理时保留原始错误并报告失败。

附件清理使用客户端的 `/alice/resource/delete_files`，要求服务端返回成功。**该接口成功不代表文件下载链接立即失效。真实测试中，删除后签名链接仍可读取文件；上传凭据也不具备底层 `DeleteImageUploadFiles` 权限。插件目前不能保证豆包云端文件或缓存立即、彻底删除，也不能确认其最终保留期限。**

## 账号和额度

登录时绑定具体的 `Default` 或 `Profile N` 目录以及服务端账号 UID。`auto` 只在导入时选择当前配置。每个账号独立管理 Cookie 和刷新状态，最长每 60 秒重新读取一次桌面登录并验证 UID。配置切换为其他账号时，请求会要求重新登录，不会替换当前绑定。

可以多次登录并填写不同配置名称，交给 Magpie 管理多个账号。退出插件账号使用 `magpie plugin logout doubao-work`，不影响豆包工作客户端登录。

Magpie 保存的登录记录只包含配置名称、账号标识和显示名。Cookie 由插件从本机豆包数据库读取，通过 macOS 钥匙串解密；Cookie 和客户端标识保存在进程内存，不会写入发行包或日志。Cookie 与 Local Storage 的临时副本放在独立缓存目录，自动清理。账号接口固定使用 `https://www.doubao.com`；附件正文上传至豆包返回且经过主机校验的 `*.vodupload.com`，只携带本次上传授权，不发送账号 Cookie。重定向会被拒绝。

额度来自豆包订阅概览与额度汇总接口，显示套餐名称、订阅到期、已用额度、总额度、服务端百分比及已知时间。没有返回的数值和时间保持缺失。活动额度到期使用 `runsOutAt` 表示。某个额度池耗尽且服务端确认存在可用替代额度池时，耗尽的窗口设为 `aside`，避免阻止账号继续使用。

当前解析订阅、活动赠送及企业窗口。账号如果返回额外购买的额度包，插件明确提示其字段尚未验证；不会伪造额度包数值。服务端错误保留错误码和消息；登录失效标记为需要重新登录，限流和额度不足返回 429，模型权限错误保持 403。插件不自动重试限流请求。

## 验证与边界

本机验证环境：Magpie 0.1.3029、豆包工作 2.35.15、macOS。验证记录随发行包提供。

插件使用桌面客户端的内部接口，客户端升级可能改变协议。客户端取消会终止本地读取及 HTTP 请求；尚无证据确认豆包服务端任务同步终止或退回额度。桌面接口未提供本次调用的真实 token 计数，插件省略 usage 字段；Magpie 如显示估算计数，应按其自身规则理解。

测试中的网络模拟仅用于异常、并发和协议边界验证。真实账号测试单独执行，不把模拟结果算作真实服务验证。尚未用第二个独立订阅账号、其他操作系统或额外购买额度包进行实际验证。

## 开发

```sh
npm ci
npm test
npm run build
npm run test:live
node test/model-live.mjs
```

构建需要 Bun。真实测试会使用当前桌面账号发送测试请求，并在 `DOUBAO_WORK_TEST_DIR` 指定的目录保存文件；默认目录为运行位置相对的 `../../.scratch/live`。`DOUBAO_WORK_PROFILE` 可选择测试配置。模型映射检查可通过 `DOUBAO_WORK_TEST_MODEL` 指定单个模型。不要并行运行多组真实账号测试。

Magpie 接口依据：[插件开发文档](https://usemagpie.ai/docs/zh/plugins)。

协议参考项目：[5201213/doubao-free-api](https://github.com/5201213/doubao-free-api)、[SeiShonagon520/doubao2api](https://github.com/SeiShonagon520/doubao2api)、[wangchuxiaoji-oss/doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api)。本插件依据本机豆包工作客户端协议独立实现临时会话删除、附件处理和工具适配；这些参考项目的支持范围不构成本插件的订阅或工具能力证明。

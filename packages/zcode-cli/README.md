# zcode-cli

把本机的 ZCode CLI 接成 Magpie（以及 OpenCode）里的一个模型 provider。每个请求运行一次
ZCode 官方文档里的无界面模式：

```sh
zcode --prompt "<对话>" --cwd <空的临时目录> --mode plan \
  --output-format stream-json --no-color \
  --disallowed-tools "AskUserQuestion EnterPlanMode ExitPlanMode Agent Task"
```

登录和每个请求都由 ZCode 自己的进程完成，用它自己的请求头。插件不读取 ZCode 的凭据，
自己不向 Z.ai 发任何请求，也不冒充任何客户端。ZCode 的 `stream-json` 输出被转回
Anthropic Messages 响应：正文是 text，推理是 thinking，结果行里的用量是 usage。

**[English → README.en.md](README.en.md)**

## 环境要求

- ZCode 3.x 及其 CLI：PATH 上的 `zcode`，或 ZCode 应用自带的
  `Z Code.app/Contents/Resources/glm/zcode.cjs`（用 `node` 运行，或用应用自身加
  `ELECTRON_RUN_AS_NODE` 运行）。`ZCODE_CLI` 可指定别的路径（可执行文件或 `.cjs`）。
- ZCode 已登录：在终端运行 `zcode login`，使用 GLM Coding Plan 账号（Z.ai 或智谱）或
  Coding Plan API Key。ZCode 的免费 Start Plan 不能在独立 CLI 中使用
  （zai-org/zai-coding-plugins#44：`Z.ai user information is invalid`）。

## 模型

- `zcode-default`：ZCode 当前设置的模型。
- `GLM-5.3`、`GLM-5.3-Flash`、`GLM-5-Turbo`：ZCode 没有 `--model` 参数，所以每次运行
  用一份临时的 provider 文件（`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`），里面只有
  `defaultModelSelection`。不会读写你的 `~/.zcode/v2/provider_config.json`。默认套餐是
  `account:zai-individual-coding-plan`；智谱账号设
  `ZCODE_CLI_PROVIDER=account:bigmodel-individual-coding-plan`。

## 暂不支持

- 客户端自己的工具。ZCode 用它自己的工具，只读（plan 模式，可用 `ZCODE_CLI_MODE`
  修改），在一个运行后即删除的空目录里工作。回复是文本。
- 会话。每个请求是一次独立的 ZCode 运行，提示词里带上完整对话；对话太长放不进命令行时，
  写成该目录里的一个文件，让 ZCode 去读。

## 错误

- `3012` / "unusual activity" 是 zcode.z.ai 的风控。ZCode 应用自己的请求也会收到同样的
  回答，只有 ZCode 客服能解除。
- 未登录：运行 `zcode login`。

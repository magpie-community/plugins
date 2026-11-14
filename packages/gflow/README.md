# @magpie-community/opencode-gflow-auth

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**Google Flow**——账号由 magpie 管理，Nano Banana 三个生图模型作为原生 image models，Veo 视频以 tools 提供。

插件只有一个导出函数 `GflowPlugin`，返回 `config` / `provider` / `auth` / `tool` 四个钩子；`index.mjs` 是唯一实现，`opencode.mjs` 与 `opencode2.mjs` 分别是 OpenCode 1.x 与 2.x 的入口。

## 安装

```
magpie plugin add @magpie-community/opencode-gflow-auth
```

插件自带 `gflow/` Python 源码，**不需要** `pip install`。只需要机器上有一个 Python ≥ 3.10 且能导入 `requests`、`pydantic`、`websocket`：

```
python3 -m pip install requests pydantic websocket-client
```

未配置解释器时插件按 `GFLOW_PYTHON` → `python3` → `~/.pyenv/shims/python3` → `/opt/homebrew/bin/python3` → `/usr/local/bin/python3` → `/usr/bin/python3` 顺序探测，跳过不满足条件的（macOS 自带 Xcode 的 3.9 会被跳过）。

## 登录

1. Settings → Providers → **Google Flow** → **Add account**。
2. 选 **打开 Google Flow 获取 Cookie**：插件打开该账号独立的 Chrome 窗口停在 `https://flow.google.com/`；用户自己完成 Google 登录后，插件通过 browser-level CDP 读取 Google 域 Cookie、确认 Flow 页面已加载，立即保存。邮箱 best-effort（`WIZ_global_data.oPEP7c`，读不到再 `Target.attachToTarget`），读不到也不影响登录完成。
3. 或选 **粘贴 Google Flow Cookie**：把 Flow 页面请求里的完整 `Cookie` 头粘进去，插件调 `validate` 读取邮箱与额度。额度读不到时 Cookie 仍会保存。
4. Usage 页显示剩余额度：`auth.usage` 用同一 Cookie 调 `nzlxg` batchexecute，把 Flow 账号菜单的 credits 映射为 `balance` / `windows[].balance`；读取失败时返回可识别的 `user` 与明确错误，不显示虚构数字。
5. 可添加多个账号，每个账号的 CDP/profile 状态隔离在 `~/.config/magpie/gflow/accounts/<safe-id>/`。

Cookie 是 Google 登录凭据，不要粘到聊天、issue 或日志里。自动入口只打开真实 Chrome 窗口交给用户自己登录，不代替输入密码，也不绕过登录。

## 生图模型

三个模型经 `config.provider` + `provider.models` 注册为 magpie 的 OpenAI-compatible image models。agent 走 gateway 的 `POST /images/generations`，`model` 字段选具体模型；`auth.loader.fetch` 拦截请求调 Python bridge，返回 `{data:[{b64_json:"..."}]}`。

| 模型 id | Settings 显示名 | Flow wire `imageModelName` |
| --- | --- | --- |
| `gflow/nano-banana-pro` | Google Flow · Nano Banana Pro | `GEM_PIX_2` |
| `gflow/nano-banana-2.1` | Google Flow · Nano Banana 2.1 | `BELUGA` |
| `gflow/nano-banana-2-lite` | Google Flow · Nano Banana 2 Lite | `HARBOR_SEAL` |

```bash
curl -s "$MAGPIE_GATEWAY/v1/images/generations" \
  -H "Authorization: Bearer $MAGPIE_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gflow/nano-banana-2.1","prompt":"a red fox in the snow","n":1}'
```

调用链：

```text
agent → magpie POST /images/generations
  → GflowPlugin.auth.loader.fetch（拦截该账号请求，规范化 model）
  → python3 -I -c <bootstrap> → gflow.magpie_bridge image（stdin JSON + cookie header）
  → GenerateImageRequest.model → IMAGE_MODELS[model] → FlowClient.generate_image()
  → aisandbox-pa flowMedia:batchGenerateImages（imageModelName）
  → OpenAI-style {data:[{b64_json:"..."}]}
```

未知 `model` 返回 400，不静默换模型。`size` 支持 `1024x1024` / `1024x1792` / `1792x1024` 及 `square` / `portrait` / `landscape` / `1:1` / `9:16` / `16:9` / `4:3`，缺省 landscape；`n` 为 1–8。

Flow 生图需要真实浏览器 reCAPTCHA：账号对应的 Chrome/CDP 会话必须可用，且有打开的 `https://flow.google.com/` 页面。bridge 设 `GFLOW_NONINTERACTIVE=1`，CDP 不可用时直接报错，不自动启动浏览器、不写 `~/.gflow/env`。

## 视频 tools

| Tool | 说明 |
| --- | --- |
| `gflow_generate_video` | Veo 3.1 生成，返回保存的文件路径与 operation id |
| `gflow_extend_video` | 续写上一段视频，需要上一次的 `media_id` |
| `gflow_auth_status` | 查看 magpie 账号数与 gflow CLI 登录状态，不打印 Cookie |

## 选项与环境变量

```bash
magpie plugin options opencode-gflow-auth '{"python":"/path/to/python3","stateDir":"/path/to/private/state"}'
```

`python`、`stateDir`、`cwd`、`pythonCwd`、`gflowBin`；环境变量 `GFLOW_PYTHON`、`GFLOW_CWD`、`GFLOW_BIN`、`GFLOW_MAGPIE_STATE_DIR`、`GFLOW_MAGPIE_AUTH_PATH`、`CHROME_PATH`。

Cookie 只经 stdin 与进程内 header 传给 Python bridge，不进 argv、不进日志、不进工具输出。

## 与已有条目的区别

本包接的是 **Google Flow 的图像生成**（Nano Banana 系列），不是 Gemini 对话。生图走 Flow 的 `flowMedia:batchGenerateImages`，需要浏览器 reCAPTCHA 会话；模型是三个 image-only 的原生 image models，不是 chat 模型。`opencode-antigravity-auth` 虽然也走 Google 账号，但提供的是 Gemini / Claude / GPT-OSS 对话模型，与 Flow 生图是不同通道。

## 测试

```bash
node --test index.test.mjs
```

23 个用例，覆盖四个钩子的形状、额度映射与共享 deadline、模型声明、Cookie 处理、视频 tools 与 `package.json` 元数据。测试用假 bridge 与假解释器，不登录、不发请求。

## License

MIT

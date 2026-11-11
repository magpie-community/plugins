# OpenAI Codex legacy subscription plugin

独立的 Magpie 订阅插件，使用 OpenCode 风格的 provider/auth hooks，参考
[pi 的 legacy Codex OAuth 实现](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts)。

这是 legacy ChatGPT OAuth 路径，不是 OpenAI API key，也不是新的 ChatGPT 授权路径。
Provider ID 为 `openai-codex-legacy`，不会覆盖 Magpie 内置 Codex、迁移已有账户，
也不会读取或写入 `~/.codex/auth.json`、`~/.pi`。
插件不是内置插件，以独立仓库分发。
图标与 Magpie 内置 ChatGPT subscription 相同，复用
`internal/gui/assets/icons/openai.svg`，随包保存为
`icon.svg`，通过 `auth.icon` 提供内嵌 SVG，不访问远程图片。

## 安装与登录

克隆后安装本地目录（不需要 npm install，没有运行时依赖）：

```sh
git clone git@github.com:andelf/magpie-openai-codex-legacy-auth.git
cd magpie-openai-codex-legacy-auth
magpie plugin add "$PWD"
magpie plugin login openai-codex-legacy
```

也可以通过 Settings → Plugins 添加该绝对路径，再到 Add provider → From plugins 登录。
使用前请确认账户和订阅条款允许此类接入。

登录菜单提供两种方式：

- **Browser login (paste callback URL)**：浏览器 PKCE。授权后复制地址栏中完整的
  `http://localhost:1455/auth/callback?code=...&state=...`，粘贴回来。
  插件不监听 1455 端口；浏览器显示 localhost 无法连接是预期现象。
  如果 Codex CLI 正在监听该端口，请先结束它的登录流程。
  不接受裸 code，必须验证与这次登录匹配的 state。15 分钟后需重新登录。
- **Device code login (headless)**：在 `https://auth.openai.com/codex/device`
  输入界面显示的 user code，插件自动轮询并交换 token。
  如果 OpenAI 提示，请在 ChatGPT 设置中启用 device code authorization。
  pending 会继续等待，slow_down 增加 5 秒轮询间隔，最长等待 15 分钟。
  宿主界面可能有更短的等待期限；当前插件 API 没有传入登录取消信号，
  关闭界面不保证立即停止已开始的轮询，其自身期限仍有效。

回调 URL、device code 和 token 均视为敏感信息，不要提交到仓库或公开日志。

## 请求与凭据

- 使用 legacy OAuth client `app_EMoamEEZ73f0CkXaXp7hrann`。
- 凭据由 Magpie 的插件账户存储保管；每次请求读取当前账户，附带对应的
  `Authorization` 和 `chatgpt-account-id`，不共享全局 token。
- Magpie 通过 `auth.refresh` 串行刷新并保存轮换后的 refresh token。
  `invalid_grant` 才标记登录失效；网络和服务错误不等于账户被撤销。
- 登录后从该账户的 `/backend-api/codex/models` 获取模型，不宣称固定模型一定可用。
  模型列表请求的 `client_version=0.161.1` 是协议兼容参数，后续需随服务变化验证。
- 推理只使用 `https://chatgpt.com/backend-api/codex/responses`。
  `@ai-sdk/openai` 告诉 Magpie 使用 Responses 协议，其他客户端协议由网关转换。
- 设置 `store: false`、`stream: true`，补充缺失的 instructions，并删除订阅端点
  不支持的 max_output_tokens、max_completion_tokens、temperature、top_p。
- 流式响应透传；非流式请求从终止 SSE 事件还原 Responses JSON。
  保留工具调用、reasoning、usage 和请求取消 signal。

此包为本地开发版本（`private: true`），尚未发布 npm，不在插件市场自动上架。
OpenCode 风格接口以 Magpie 宿主验证为准，尚未在独立 OpenCode 上验证完整流程。

## 验证

```sh
npm test
# 指定 Magpie 源码，运行真实宿主集成测试：
MAGPIE_REPO=/path/to/magpie npm test
```

测试全部离线，覆盖 PKCE/state、过期和重复回调、device pending/slow_down/超时、
refresh token 轮换、账户隔离、Responses 流式和非流式转换，以及真实 Bun Magpie
宿主加载本地插件并发起浏览器授权。没有 Bun 或 Magpie 源码时宿主测试会跳过；
默认寻找同级 `../magpie` 仓库，也可用 `MAGPIE_REPO` 指定源码目录、`BUN_BIN` 指定 Bun 路径。

**未验证：真实 OpenAI 账户登录、实际设备码批准、真实模型列表与推理，以及完整 Go/GUI
套件。** 离线测试不证明 OpenAI 当前仍允许此 legacy client 使用或某个订阅计划可用。

本实现参照本地 `~/Repos/pi/packages/ai/src/auth/oauth/openai-codex.ts`、
`device-code.ts` 和 `api/openai-codex-responses.ts` 的协议行为；MIT 许可见 LICENSE。

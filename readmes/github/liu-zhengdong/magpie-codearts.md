# magpie-codearts

[magpie](https://github.com/yetone/magpie) 的华为云 CodeArts 插件，两个方向：

- **接入**：在 magpie 的 Agents 页打开 CodeArts 的接入，把 CodeArts CLI 驱动到 magpie 的模型上，随时切换。
- **反代**：在 magpie 里使用 CodeArts 的模型（GLM-5.2、OpenPangu 等），登录方式与 CodeArts CLI 相同——浏览器打开 CodeArts 授权页，拿到临时 AK/SK 后自动续期，无需手动配置密钥。

## 安装

在 magpie 中执行：

```
plugin add github:liu-zhengdong/magpie-codearts
```

或安装 npm 包后重启 magpie。

## 接入 CodeArts（Agent 页）

安装后 CodeArts 出现在 magpie 的 Agents 页（CLI 里 `magpie ls` 也能看到）。打开接入后，magpie 会把 `provider.magpie` 写进 `~/.codeartsdoer/codearts_cli.json`，并把本插件注册为 CodeArts 的插件——CodeArts 每次启动都会重算 `enabled_providers` 白名单，插件的 config hook 会把 `magpie` 加回白名单，保证重启后仍然可用。

之后在 Agents 页直接选模型，或用命令行：

```
magpie codearts magpie/group/glm-5.3
```

切换后重启 CodeArts 生效。

## 登录（反代方向）

```
auth login codearts
```

浏览器会打开华为云 CodeArts 授权页，登录后自动完成。凭据保存在 magpie 的插件凭据存储中，与 CodeArts CLI 无关，不读取 CLI 的本地数据。

## 使用

登录后即可在 magpie 中选择 `codearts/…` 模型。magpie 网关（默认 `127.0.0.1:3425`，Token `magpie`）自动以 OpenAI 兼容接口暴露这些模型：

```
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model": "codearts/openpangu-2.0-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

## 工作原理

- **登录**：走 CodeArts_Tui 的 OAuth（PKCE + DPoP），本地回调服务器接收授权码，STS 端点换取临时凭据 `{access_key_id, secret_access_key, security_token}`（约 1 小时有效）。magpie 在过期前 5 分钟用 refresh token 自动续期。
- **模型列表**：调用 agent-center 的 useragents/detail 接口获取账号可用模型；失败时回退到内置表（GLM-5.2、glm-5.2-sft-harmony、openpangu-2.0-pro、openpangu-2.0-flash）。
- **对话**：POST `{inferhub}/api/v2/chat/completions`，OpenAI 兼容流式响应，请求按华为云 SDK-HMAC-SHA256 方案签名并附 x-ot-* 追踪头（与 CodeArts CLI 26.9.12 相同）。

## 许可

MIT

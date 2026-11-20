# Magpie Paseo Bridge

这个 Magpie 网关 hook 记录 Codex 每次请求实际使用的供应商、模型和回退尝试。Paseo Magpie `v0.6.0` 或更新版本可在轮次结束后，于最终回复下展开本轮已记录的请求。

## 安装

Magpie 和 Paseo 守护进程需要在同一台机器上以同一系统用户运行，并使用相同的绝对 `XDG_CONFIG_HOME` 或同一用户主目录。Codex 的 Responses 请求需已接入该 Magpie 网关。

```sh
magpie plugin add 'github:kogekiplay/magpie-paseo-bridge#v0.1.2'
magpie plugin list
```

看到插件后，启用 Paseo Magpie 的路由显示，再发起一轮新的 Codex 对话。索引从安装后的回复开始建立。停用可用 `magpie plugin off`，卸载可用 `magpie plugin rm`，插件名以 `magpie plugin list` 显示为准。

集成测试在 macOS 上使用 Magpie `0.1.4504`、Bun `1.4.4` 和 Codex CLI `0.170.0`。写入端需要 POSIX 文件权限和硬链接。Linux 尚未做端到端验证，当前不支持原生 Windows。

## 匹配与隐私

hook 处理本机 Codex 主会话成功完成的 Responses 请求，包括产生工具调用的请求，并跳过标题、子代理等辅助请求。它通过回环地址读取 Magpie trace，用会话 ID 和响应 ID 精确匹配路由，用 Codex 的原生轮次将多条请求关联起来，再以最终助手消息 ID 供 Paseo 定位。

索引位于 `$XDG_CONFIG_HOME/magpie/paseo-bridge/v1/` 或 `~/.config/magpie/paseo-bridge/v1/`。记录保存散列后的关联键、请求的排序字段、供应商、模型和尝试明细，七天后过期。索引不会写入提示词、回复正文、凭据、账号或原始错误。

## 看不到路由标签

- 确认 hook 已加载，且 Paseo 守护进程能读到同一目录下的索引。
- 确认 Magpie trace 可通过本机明文 HTTP 访问。异步 hook 可能遇到重启、超时、回复过大或 trace 已被淘汰。
- 原生 ChatGPT 登录转发在 Magpie `0.1.4504` 可能缺少 `responseId`。此类回复会省略标签。已验证经 Magpie 路由的 Responses 透传和 Chat Completions 协议翻译。

完整索引格式和本地测试命令见[英文文档](README.md)。

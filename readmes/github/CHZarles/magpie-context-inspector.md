# Context Inspector for Magpie

想知道 Agent 给模型发了哪些内容，或者某一轮的输入为什么突然变长？Context Inspector 把经过 Magpie 的模型请求按会话排成时间线。点开一条请求，就能查看它带了哪些指令、消息和工具结果，以及它比上一条多了什么、少了什么。

![上下文轨迹。左侧是会话列表，中间是请求与工具调用时间线，右侧是请求详情。](screenshots/trajectory.png)

*示例会话。右侧可以查看 Token 用量、上下文组成和相邻请求的变化。*

## 安装

安装 Magpie 桌面版后，在终端运行：

```sh
magpie plugin add github:CHZarles/magpie-context-inspector
```

也可以在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中搜索 Context Inspector。安装后，确认插件已启用。

## 查看第一条请求

1. 让 Agent 通过 Magpie 发送一条 **Chat Completions** 或 **Responses** 请求。
2. 从 Magpie 侧边栏打开 **Context Inspector**。入口页会显示最近一次采集时间、近 24 小时的请求数和当前存储模式。
3. 点击「在浏览器打开」。如果只有「复制地址」，就把地址粘贴到本机浏览器。选中会话，再点开一条请求。

![Magpie 入口页预览，显示「在浏览器打开」按钮和采集概况。](screenshots/magpie-entry.png)

*Magpie 入口页预览，使用示例数据。*

### 在检查器里看什么

- **输入为什么变长了？** 打开请求详情，看输入 Token 数和各类内容的占用量，再与上一条请求比较。没有收到实际用量时，列表会用 `≈` 标记估算值。
- **工具返回了什么？** 展开工具调用，查看参数和对应的结果。时间线上的标记可以跳到对应请求或工具记录。
- **新请求进来了吗？** 打开会话时会显示最近 50 条请求，可以继续向前加载。往上滚动时，页面会暂停跟随。点「跟随」可以回到最新请求。

## 常见问题

**打开后没有记录？** 确认 Agent 的请求经过 Magpie，且使用 `/v1/chat/completions` 或 `/v1/responses`。Anthropic Messages 和 Gemini 原生协议暂不生成详细轨迹。没有会话 ID 的请求会出现在 `unbound` 分组。

**读不到检查器地址？** 先点「重新读取」，再看数据目录里的 `service.log`。默认端口 `3478` 被占用时，插件会换到空闲端口，入口页会显示实际地址。

**看到的是供应商最终收到的请求吗？** 页面展示 Magpie 网关采集到的客户端请求。后续脱敏、协议转换或重试都可能改变发给供应商的内容。

## 数据保存在本机

插件不修改转发请求，记录只写到本机的 SQLite 数据库。默认保存结构和截断后的摘要，不保存完整请求或响应正文。结构化凭据字段会在写入前遮盖，摘要里的自由文本仍可能含有敏感信息。

需要查看原文时，在检查器的「记录设置」中开启「保存原文」，设置只对后续采集生效。关闭后，插件会清理已保存的原文字段，SQLite 文件可能仍留有旧内容。也可以在同一个菜单里清空所有记录。

数据目录默认为 `~/.config/magpie/plugins/context-inspector/`，设置了 `XDG_CONFIG_HOME` 时会放在该目录下的 `magpie/plugins/context-inspector/`。默认保留 14 天，数据库目标上限为 512 MiB。卸载插件后，记录仍保存在本机。

```sh
magpie plugin remove magpie-context-inspector
```

## 开发与许可

从本地目录安装、运行测试、配置端口，以及接入本地 API 的方法见 [开发参考](DEVELOPMENT.md)。

本项目使用 [MIT 许可证](LICENSE)。轨迹界面改编自 DeepSeek Harness，来源和许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

# 懂了鸭 Provider · Magpie 插件（非官方）

把懂了鸭（[dongleya.qq.com/create](https://dongleya.qq.com/create)）的聊天模型接入 Magpie，作为 OpenAI Chat Completions 兼容供应商使用。

## 这个插件做什么

- 从懂了鸭 `/api/models` 拉取当前账号可用模型；
- 在 Magpie 里显示为 `dongleya` 供应商；
- 把 Magpie 收到的 Chat Completions 请求转换成懂了鸭 `/api/v3/chat`；
- 把懂了鸭的 `text-delta`、`reasoning-delta`、`finish` 事件翻译成 OpenAI SSE；
- 按 Magpie 会话 ID 复用懂了鸭的服务端 `sessionId`，保留多轮上下文；
- 云端任务中途断开时，自动订阅 `/api/v3/chat/<sessionId>/subscribe` 继续等待完成；
- 任务完成后自动下载 `workspace-file` 产物，保存到当前工作区 `dongleya/<作品名>/`；
- 显示懂了鸭的 creation credits 余额。

## 安装

```powershell
magpie plugin add @magpie-community/opencode-dongleya-auth
magpie plugin login dongleya
```

登录方式有两种：

1. **浏览器自动登录（推荐）**：Magpie 会打开一个独立的 Chromium 系浏览器窗口，你扫码或短信登录后，插件自己从该窗口读取 `eureka_token` 并保存。不会读取你日常使用的浏览器配置。
2. **手动粘贴**：填入浏览器 `localStorage` 里的 `eureka_token`：

```js
localStorage.getItem("eureka_token")
```

令牌通常以 `eyJ` 开头。它不是「个人令牌」页面创建的 `dlya_at_…`；那个令牌只用于内容资产 MCP。

自动登录支持 Chrome、Edge、Brave、Vivaldi、Opera 和 Chromium。Firefox、Safari 等非 Chromium 浏览器不支持这种自动读取方式，但仍可使用手动粘贴令牌，Provider 本身照常工作。

## 使用

重新打开 Magpie 的提供商列表，选择「懂了鸭」，然后就可以在 Agent 或 Chat 里选择
`dongleya/<model-id>`。

当前模型列表：

- `auto`
- `deepseek-v4.1-flash-1017`
- `deepseek-v4-pro-0813`
- `deepseek-v4-flash`
- `hy3`
- `hy4-preview`
- `minimax-m3`
- `kimi-k3`
- `glm-5.3`

模型列表会随懂了鸭 `/api/models` 更新。

## 边界

懂了鸭 `/api/v3/chat` 是它自己的 Agent 聊天接口，不是通用 OpenAI 兼容接口。因此：

- 这是非官方插件，只应使用自己的账号，接口可能随懂了鸭更新而变化；
- 支持文本对话、图片输入、推理内容和多轮上下文；
- 不支持把客户端自定义工具（`tools` / function calling）透传给上游；
- 懂了鸭自己的绘图、课件、绘本等内部工具事件不会变成客户端工具调用；
- 需要工具调用的编码 Agent 建议使用其他 provider。

## 令牌安全

- 令牌只保存在 Magpie 的 `plugin-auth.json`；
- 插件源码不包含任何账号令牌；
- 上游请求会带 `Origin`、`Referer` 和浏览器 UA，这是懂了鸭校验客户端所必需的；
- 插件不会把令牌写进日志或返回给模型。

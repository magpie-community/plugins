# magpie-upstream-guard

magpie 网关中间件：上游端点在流式回复中途返回错误（200 流中出现 `data: {"error": ...}`，如 `connection lost mid-reply (ECONNRESET)`）时，把该错误转成一次正常收尾——替换为 `finish_reason: "stop"` 的收尾块，并把上游报错文本写进回复正文提示客户端，避免没有容错的客户端整轮中断。

- 仅作用于 agent 侧为 chat 协议（OpenAI 兼容）的流式请求；
- 流尚未向客户端放行时，网关自身的 failover 行为不受影响；全部成员都失败时错误照常上报；
- 钩子出错或超时按原样透传（fail-open），不影响正常流。

## 安装

```shell
magpie plugin add ./upstream-guard.middleware.js
```

也可在本仓库打了 `magpie-plugin` 主题后，从 magpie 的 插件 → 发现 → 非官方插件 · GitHub 里安装。

## 选项

- `notice`：写进回复正文的提示语，默认「[上游端点中断] 上游在回复中途断开，本条回复按正常结束收尾。上游报错：」，具体报错会附在提示语之后。

```shell
magpie plugin options upstream-guard '{"notice": "[上游中断] 原因："}'
```

## 已知边界

- 中间件无法自行注入 `data: [DONE]`（钩子返回值必须是对象并重新 JSON 序列化）；上游错误事件后自带的 `[DONE]` 会原样放行。客户端认 `finish_reason` 即可正常结束。
- 只处理 chat 协议；anthropic / responses 协议的 agent 需按各自事件形状另行处理。
- 「流中途卡死」「流无收尾直接断开」这两类形态没有事件可钩，属网关层问题，见 yetone/magpie#2471。

# output-strategy 设计

## 目标

做一个独立的 magpie 输出样式插件：用户在面板上自由组合 7 种样式，插件在模型调用前把对应指令注入请求。它不改写供应商响应，也不依赖 compress-core。

## 非目标

- 不做 response sanitizer、SSE 改写、LLM 摘要或 Fusion。
- 不推社区，不接 OmniRoute 数据库、设置 API 或遥测后端。
- 首版不继承 lite/full/ultra 三档；每个样式只有开关，使用上游完整规则。
- 不保存请求正文、模型回答或注入后的 prompt。

## Module 与 interface

核心 module 是 `apply.js`。caller 和 tests 只依赖：

```js
applyOutputStyles(body, options) -> {
  body, applied, skippedReason, appliedStyles, addedBytes
}
```

这个 interface 隐藏样式选择、catalog 顺序、marker 幂等、media/安全 bypass、boundary 去重和协议注入。moejs middleware 与 Bun telemetry hook 是同一 seam 的两个 adapters，保证实际改写和统计看到同一结果。

`catalog.js` 是唯一的样式元数据与 prompt 真相源；页面目录由它生成。`stats-writer.js` 只暴露 `record / flush / snapshot / statsPath`，把文件锁、进程重启合并和页面发布藏在内部。

## 样式来源

- `terse-prose`：JuliusBrussee/caveman 当前 SKILL，3.0.0 起 Apache-2.0（早期 MIT 部分保留 MIT notice）。
- `less-code`、`terse-cjk`：decolua/9router 当前 prompt，MIT。
- `ponytail`：DietrichGebert/ponytail 当前 SKILL，MIT。
- `i-have-adhd`：ayghri/i-have-adhd 当前 SKILL，MIT。
- `antislop-ui`、`antislop-copy`：9router 当前 master 已无原文件，使用 OmniRoute Desktop 3.8.52 的适配文本并记录该限制。

只去掉 skill frontmatter、斜杠命令和宿主专属状态查询，保留行为规则及安全边界。所有适配写入 PROVENANCE。

## 请求流程

1. 读取 `options.styles`；没有任何样式开启时原样返回，不读写遥测。
2. 检查 media、已有 `[Output Strategy]` marker 和可注入的消息结构。
3. 按 catalog 顺序拼接已开启样式；共享 boundaries 只注入一次。
4. 注入 Chat/Anthropic system 或 Responses instructions；无法识别的协议原样通过。
5. 返回注入结果。任何异常都 fail-open，不让请求失败。

## 面板与遥测

页面只有样式开关、保存按钮、注入/跳过次数和各样式启用次数。`magpie.options.set` 必须提交完整 options。

Bun hook 在本地请求上统计 applied/skipped、样式和注入字节；不写正文。数据存放在 magpie 配置目录的 `output-strategy/stats.json`，通过同目录页面的 `stats.js` 发布。测试使用临时目录并禁止向安装目录发布。

## 取舍

选择独立插件而非并入 compress-core：输出 steering 与请求压缩的 interface、配置和验证互不依赖。选择静态 prompt 而非响应后处理：实现小、协议风险集中在注入位置，也不需要 SSE 状态机。选择 JSON 遥测而非 SQLite：满足面板计数，避免数据库依赖和迁移。

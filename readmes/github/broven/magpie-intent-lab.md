# magpie-intent-lab · 意图回测

[magpie](https://github.com/yetone/magpie) 社区插件：用 magpie 路由过的**历史会话**回测路由组的 `intent` 规则。
同一批用户 turn 分别按「当前规则」和「草稿」交给组的分类器（Jev）判一遍，列出每个 turn 的 intent、置信度、选中的模型以及是否发生变化。调好后可以一键写回 magpie。

## 安装

```bash
magpie plugin add github:broven/magpie-intent-lab
```

装好后，magpie 窗口侧栏的 Plugins 分组里会出现「意图回测 / Intent Lab」。插件本地 service 默认监听 `127.0.0.1:3488`，端口可用 `magpie plugin options` 修改 `port`。

## 它做什么

- **样本**：从 `~/.config/magpie/routing/` 的路由日志里找出 magpie 路由过的会话，再到 agent 自己的 transcript 里取每个用户 turn 的正文。支持 Claude Code、Codex（含 `.jsonl.zst`）和 pi。
- **分类**：magpie 的文本准备与 Jev 判定逻辑从 Go 源码逐位移植，包括去掉 system-reminder 和注入内容、前 3000 + 后 1000 截断、上一轮上下文、levels 探测、`intentSure` 阈值。之后经本机 gateway `POST /v1/systemone` 调用分类器，结果按请求体哈希缓存在 `~/.config/magpie/intent-lab/`。
- **写回**：生成 `magpie group rule rm/add … at=<n>` 命令，先预览再执行，执行后读回规则。只支持修改 intent、use 以及增删规则；遇到无法原样还原成 CLI 参数的规则（`when`、`pause`、未写时区的 `time`），会拒绝写回该条。

限制：分类器只支持 System One 决策模型（Jev），只回测 intent，不回测 `effort=auto`。

## 开发

```bash
bun install
bash scripts/parity.sh   # 与 magpie Go 源码对拍（需 MAGPIE_SOURCE 指向 magpie 源码，默认 /tmp/magpie-latest）
bun scripts/e2e.ts       # 端到端：真实样本 + 真实 Jev + 沙箱写回
bun scripts/ui-shot.ts   # 截图（需要 playwright）
bun scripts/frame-check.ts  # 按 magpie 窗口的方式（sandbox iframe + 页面 CSP）加载，确认能连上 service
magpie plugin add "$PWD" # 本地安装；改完代码再 add 一次即可重载
```

设计细节见 [DESIGN.md](DESIGN.md)。

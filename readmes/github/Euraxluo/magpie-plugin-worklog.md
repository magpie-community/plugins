# magpie-plugin-worklog

magpie 页面插件：**工作上下文录制器**。把本地 coding agent（Claude Code / Codex CLI / omp）的会话与 git 提交归一成 agent 无关的事件流，随时切换 agent 工具与模型生成周报。

## 结构

```
┌─ magpie 窗口「工作日志」页
│    时间线浏览（按天/来源/关键词过滤）
│    周报生成：agent 工具（codex/claude/本地模板）× 模型 下拉切换
│
├─ 采集（lib/collector.mjs，宿主加载即自动增量）
│    claude  ~/.claude/projects/**/*.jsonl
│    codex   ~/.codex/sessions/**/rollout-*.jsonl[.zst]
│    omp     ~/.omp/agent/sessions/**/*.jsonl
│    git     ~/project(s) 仓库提交
│    → 归一事件 {source, kind, at, project, text} 去重落库
│
└─ 生成（lib/report.mjs）
     buildContext: token 预算裁剪（prompt 全保 + reply 采样 + 按天分桶）
     runners: codex exec | claude -p | 本地模板（零模型保底）
     → ~/.config/magpie-plugin-worklog/reports/weekly-*.md
```

- 事件库：`~/.config/magpie-plugin-worklog/store.jsonl`（增量，只读 agent 自己的存储）
- 服务：`127.0.0.1:3492`（Host + Origin 白名单，无 token——本机自用）
- 与 magpie-plugin-baohe 同骨架：waypoint 页 CSP 禁 fetch，自身导航到本地服务。

## 安装

```bash
# plugins.json 加: {"spec": "/path/to/magpie-plugin-worklog"}
```

或独立调试：`node serve.mjs`

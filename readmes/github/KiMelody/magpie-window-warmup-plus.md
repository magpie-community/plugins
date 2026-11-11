# 窗口预热（Window Warmup · Plus）

这是 [magpie](https://usemagpie.ai) 的一个页面插件：按计划给指定供应商、账号和模型发一条短消息，提前开启下一轮订阅额度窗口。任务与执行记录都在 magpie 侧边栏的 Window Warmup（窗口预热）标签页里管理，页面语言跟随 magpie。

本项目 fork 自社区插件 [@magpie-community/page-window-warmup](https://github.com/magpie-community/plugins/tree/main/packages/window-warmup) 0.1.4，独立维护，包名 `magpie-window-warmup-plus`。

> **风险提示**：定时发送会真实消耗所选账号的订阅额度，每条消息都会发给所选模型并计费。部分厂商（尤其 Claude 订阅）可能把定时自动请求视为异常用量。是否使用、何时使用由你自行判断并承担风险。
>
> **Note**: Scheduled sends really spend the chosen account's subscription quota and may be treated as unusual use by some vendors. Use at your own discretion.

## 安装

```sh
magpie plugin add github:KiMelody/magpie-window-warmup-plus
```

装好后在 magpie 侧边栏 Plugins 下出现 Window Warmup（窗口预热）标签页。

- 从上游社区包换装不会丢任务：数据目录固定为 `${XDG_CONFIG_HOME:-~/.config}/magpie/window-warmup/`，与包名无关。
- 本插件与上游包共用 3492 端口且单实例运行，换装前请先移除旧包，避免端口冲突。

## 功能

**三种基础触发**（沿用上游）：窗口重置后、每天定时、固定间隔。

**本 fork 的增强**：

- **按使用时刻倒推（target 触发）**：输入期望使用时刻 `T_use`、使用后多久刷新 `Δ`、窗口长度 `L`，插件按 `T_send = T_use + Δ − L` 倒推发送时刻，`T_reset = T_use + Δ` 为预期重置时刻。例：10:00 要用、2 小时后刷新、5 小时窗口 → 07:00 开窗、12:00 重置。跨天由 IANA 时区运算处理。
- **多段调度与冲突检测**：支持按星期与一天内多个时间段；保存时展开未来若干天检测段间重叠，给出最早可设时间；`Δ` 与招呼语可全局设置、每段覆盖。
- **发送后读卡验证**：读 magpie 内置额度卡（`/v1/magpie/quotas`，无外部依赖）比对发送前后的 `used` / `lastServedAt` / `resetsAt`，把结果记为 `confirmed` / `no_effect` / `reset` / `missed`，而不只是 HTTP 200 的 `ok`。发送前若窗口已开则跳过，超时用 `runKey` 幂等反查，不盲目重发。
- **招呼语自定义**：`message` / `maxTokens` / `reasoningEffort` 可在管理页设置，旧任务缺省仍为 `hi` / `16`。
- **账号选择**：沿用上游账号检测逻辑，设置时显示指定账号。

> 固定周期窗口（自然月、固定重置日、每日签到）不随首次使用提前开窗，target 触发对它们无效。

## 数据与安全

- 数据目录 `${XDG_CONFIG_HOME:-~/.config}/magpie/window-warmup/`，`state.json` 存任务、执行记录与去重标记。
- 本地服务只监听 `127.0.0.1:3492`（可在插件设置里改），接口带随机口令校验。
- 除 magpie 本地网关（发消息、读额度、读模型）外没有对外连接。

## 开发

```sh
bun install
bun run build      # 生成 dist/plugin.js 与 dist/ui/app.js
bun run typecheck  # tsc --noEmit
bun test           # 单元测试（含 dist 一致性校验）
```

`github:` 安装不会跑构建，因此 `dist/` 必须随源码一起提交；`tests/dist.test.ts` 会校验构建产物与源码一致。

## 许可

MIT

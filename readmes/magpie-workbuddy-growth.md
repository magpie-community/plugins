# magpie-workbuddy-growth

WorkBuddy 国内版成长计划与任务签到管家（magpie 插件）。

- 成长计划任务树一键点亮、任务签到领取积分
- 猫猫旅行（领养 / 派出 / 到达领奖，每日一轮）
- 连登补签、档位兑换、连登抽奖
- 每日活跃上报（点亮成长中心连登）
- 开学季活动（任务点亮 + 转盘抽奖）

## 安装（两步）

发现页搜索「成长计划 / 任务签到 / workbuddy」找到本包安装后，再安装工具实体包：

```bash
magpie plugin add npm:magpie-workbuddy-growth-core
```

> 为什么两步：magpie 对带 `pi-package` 关键词的包按 pi 扩展路径加载（只装配模型 provider，不装配工具）。
> 本包负责被发现页搜到；`magpie-workbuddy-growth-core` 提供真正的 `wb_growth` 工具。
> 也可以只装工具包：`magpie plugin add npm:magpie-workbuddy-growth-core`（不占用发现页条目）。

## 使用

安装后对 agent 说：

- 「看看我的成长计划」→ wb_growth {action:"status"}
- 「把成长任务点亮领奖」→ wb_growth {action:"tasks", mode:"full"}
- 「猫猫旅行」→ wb_growth {action:"travel"}
- 「连登补签、兑换、抽奖」→ wb_growth {action:"streak"}
- 「开学季任务」→ wb_growth {action:"school", lottery:true}
- 「只领 X 任务的奖」→ wb_growth {action:"tasks", mode:"claim", code:"..."}

账号读取 `@magpie-community/opencode-workbuddy-auth` 的登录态（需已登录 WorkBuddy 国内版）。
企业号自动跳过（成长体系仅个人账号）。

源码：https://github.com/connoryang331/magpie-workbuddy-growth

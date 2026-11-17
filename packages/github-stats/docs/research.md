# 同类检索记录

检索日期：2026-11-17。范围：公开网页、GitHub 仓库搜索、magpie-plugin topic、magpie-community/plugins 的 README 与 registry.json。未发现功能完全一致的公开插件；这不是对所有未公开项目的穷尽证明。

| 项目 | 已有能力 | 与本方案差异 |
|---|---|---|
| [Usage Glance](https://github.com/magpie-community/plugins/tree/main/packages/usage) | Magpie 页面汇总和模型排行 | 无 Profile SVG / GitHub 自动同步 |
| [Day Card](https://github.com/magpie-community/plugins/tree/main/packages/day-card) | 单日卡片、PNG 导出 | 无深浅色 SVG 文件维护与每日 GitHub 发布 |
| [Magpie GitHub Sync](https://github.com/bingqilinweimaotai/magpie-github-sync-plugin) | GitHub 加密备份、跨电脑用量同步 | 面向备份，不生成公开 Profile 卡片 |
| [magpie-dashboard](https://github.com/aqiu817/magpie-dashboard) | 本地用量面板 | 无本项目发布流程 |
| [page-usage-board](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-board) | 用量图表、额度看板 | 无 Profile SVG 自动维护 |

主要一手依据：

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [官方插件页面/本地服务契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-runtime.md)
- [官方 Usage Totals/Tokens 定义](https://github.com/yetone/magpie/blob/main/internal/usage/usage.go)
- [官方日期区间定义](https://github.com/yetone/magpie/blob/main/internal/usage/period_range.go)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28)

本机 Magpie 0.1.4355 返回的 `period/since/calls/input/output/series/models` 已实际核对；开发时只查看了汇总数字和字段结构，没有公开原始账号/会话记录。

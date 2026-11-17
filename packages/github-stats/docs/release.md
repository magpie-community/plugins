# 架构与发布

`usage.ts` → 白名单 `Stats` → 纯 `renderer.ts` → `github.ts` Contents API。`sync.ts` 负责互斥、冷却、去重、成功状态；`scheduler.ts` 安装用户级系统任务。原生 Page 启动页通过官方 bridge 导航到插件的本地服务，用户始终留在 Magpie 窗口。

`package.json` 的 `main=dist/plugin.js` 使用 OpenCode v1 `{id, server}` 契约；`magpie.page` 注册侧栏，`magpie.page.service` 声明本地端口及 Magpie Web 代理。插件只导出一个 server 对象，不注册伪供应商或模型。

## 发布检查

1. `npm ci && npm test`，检查 `dist/` 与源代码一致。
2. `npm pack --dry-run` 确认只有 dist/page/ui/README/LICENSE；不得含本地配置、真实用量、Token、node_modules。
3. GitHub 仓库提交源码、编译产物、测试、MIT、虚构示例；添加 `magpie-plugin` topic 即可进入非官方发现的索引范围。
4. `magpie plugin add github:wolfvoid/magpie-github-stats` 可直接安装。正式版本可使用 GitHub Release 标签固定代码版本。
5. npm 发布和社区精选 registry 收录是独立发布流程；不能把 GitHub 仓库可安装等同于社区审核通过。要进入精选列表，按社区当时的贡献规范准备 registry 条目和 npm 包，或提交社区命名空间下的包供维护者评审。未完成这些步骤时不声称已收录。

## 已知边界

- GitHub `<picture>` 的 media 跟随浏览器配色偏好。用户在 GitHub 手动强制与系统相反的主题时，选择可能不随 GitHub 设置改变；这是静态 picture 的边界。
- 两张 SVG 使用 Contents API 顺序写入，不具备双文件原子性；失败不会破坏任一已存在的有效 SVG。
- Windows 和 Linux 调度/凭据代码已实现，只有 macOS 原生端到端验证记录。CI 的 Windows/Linux 测试不等于真实桌面凭据服务验收。
- 调度服务在当前用户登录会话下运行；设备关闭时无云端替代执行。
- Magpie 插件移除没有供本插件使用的 OS 任务卸载 hook。请先关闭每日同步再移除插件。
- `magpie.service` 兼容路径已实现，但远端 Magpie Web 部署未进行实机端到端验证。

## v0.2.0

- Magpie 内新增 DAILY CALLS 月／周选择，设置持久保存并用于预览与 GitHub 同步。
- 活跃图单独查询本月／本周每日汇总，处理闰年、跨年、六行月份、未来日期与 320px 布局。
- 采用社区共享 proc.mjs 检测锁进程，处理 Linux 僵尸进程并通过社区仓库进程检查。

# 社区包维护与发布

此目录沿用 `@magpie-community/middleware-codex-history` 包名与 `repository.directory`。独立源码在 [unisong/magpie-codex-history-filter](https://github.com/unisong/magpie-codex-history-filter)，同步时保留社区入口 `codex-history.test.mjs`、包完整性测试、Bun 兼容适配及社区安装说明。不能只替换 package.json。

| 目录 | 职责 |
| --- | --- |
| `plugin/`、`server/` | Magpie Bun 入口、本机工作台与可选模型检测 |
| `history/` | 固定校验值的历史基准、搜索文字转换扩展及原生设置页 |
| `web/` | 独立工作台界面 |
| `test/`、`tools/` | 离线验证、公共入口构建、诊断与截图 |
| `vendor/`、`docs/` | 第三方来源与许可、使用说明和演示截图 |
| `workbench.middleware.js` | 预构建的合并请求入口，无默认规则或私密门禁 |

在社区仓库根目录，使用独立临时 HOME 运行：

```sh
HOME=$(mktemp -d) bun test packages/codex-history
bun scripts/check.mjs codex-history
```

在此包目录执行 `npm run build` 与 `npm test`；Python 浏览器检查和 `test/magpie-smoke.py` 使用临时配置及模拟上游，不使用真实供应商。宿主测试应覆盖从 `npm pack --ignore-scripts` 得到的实际社区包；参数见该脚本帮助。

社区 dist 打包禁用生命周期脚本，所以提交前必须生成公共 `workbench.middleware.js`。禁止从正在安装的插件目录复制此文件：它可能含私密探针凭据和暂停规则。不得提交运行数据、真实配置或会话。原始历史与 ModelTrace 文件保持固定来源及 SHA-256，新增搜索转换由独立测试覆盖。

根目录 `cases.json` 经社区测试入口验证实际合并钩子；`history/cases.json` 保留原算法基准，由 `test/cases.test.mjs` 验证，不能将两者的新旧搜索行为混淆。

修改后更新版本、README、更新说明和必要截图，提交 PR 并等待官方检查与维护者审核。合并后检查 publish 工作流的 **test 与 dist** 步骤，以及 `dist/index.json` 中该包的最新版本和完整性值。npm 步骤失败不一定阻断 dist 分发；不要把 GitHub 独立发行版等同于社区市场已更新。已发布版本不可覆盖。

# @magpie-community/middleware-codex-history · Codex Workbench

**一个 Magpie 插件，管理 Codex 历史过滤、可选模型指纹检测与异常暂停。** 按供应商保存过滤规则，不修改 Codex 的 `base_url`、模型或会话文件。

本目录为 **v0.2.1 社区包源码**，沿用原包名和供应商 Options。[GitHub 独立发行版](https://github.com/unisong/magpie-codex-history-filter/releases/tag/v0.2.1) · [反馈问题](https://github.com/unisong/magpie-codex-history-filter/issues) · [更新说明](docs/RELEASE-v0.2.1.md)

从 v0.1.0 纯过滤版升级时，保留已有规则；新增的原生设置页和可选模型监测无需另装插件。社区版本需审核合并并完成 dist 分发后才会提供更新，GitHub 独立发版不会自动更新市场。

## 安装与使用

需要支持 server 插件、gateway middleware 和原生插件页面的 Magpie，已在 **0.1.1265** 验证。工作台使用 Magpie 自带 Bun，无需另装 Node.js。

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

也可在 Magpie 的 **Plugins → Discover → Gateway middleware** 中安装或更新 **Codex Workbench**。需要独立 GitHub 版时，可下载 [Release ZIP](https://github.com/unisong/magpie-codex-history-filter/releases/tag/v0.2.1) 完整解压后添加本地目录；不要与市场版重复启用。

1. 在 Magpie 侧边栏打开 **Codex Workbench · 历史过滤**，选择供应商，开启需要的规则并保存。
2. **只用历史过滤，到这里即可。无需打开独立工作台，也无需登录。** 启用状态、调用数和错误在 Magpie 扩展／插件页面查看。
3. 需要模型检测时，Windows 双击 **`Open.bat`** 或桌面「Magpie 模型工作台」；也可从 **Codex Workbench · 本机控制台** 打开。宿主可能把入口放在登录方法选择器中，但这里只打开本机页面，不需要账号。

**新安装的过滤、监测和保护均默认关闭。** 不要与旧版、独立过滤服务或其他本地副本重复启用。升级前备份自己的 Options 与检测数据；具体迁移见 [使用说明](docs/USAGE.md#更新与迁移)。

## 历史过滤

| 开关 | 作用与建议 |
| --- | --- |
| 历史过滤 | 清理旧 reasoning、明确密文块及可移植历史的服务器 ID；只为出现兼容错误的供应商开启 |
| 保留新响应密文 | 保留客户端对新响应密文的请求，旧历史密文仍会清理；通常保持勾选 |

保留正文、工具参数与结果及 `call_id` 配对。不同会话按各自请求的 `供应商/模型` 前缀独立处理；不可迁移的服务器引用或加密压缩历史会明确拒绝。

v0.2.1 修复旧 `web_search_call` 缺少关联 `reasoning` 的错误：开启历史过滤后，将历史搜索调用转换为文字记录，保留已记录的查询与后续结论，避免重放依赖原资源的搜索条目。普通对话与完整明文历史的压缩总结均适用；不解密加密压缩块。[处理原理与边界](docs/USAGE.md#历史过滤)

原生设置页与独立工作台编辑同一份规则。过滤不依赖浏览器页面或检测后台，保存规则后由 Magpie 重载，无需重启 Codex。[过滤原理与路由边界](docs/USAGE.md#历史过滤)

![Magpie 原生历史过滤页面](docs/images/native-filter.png)

## 可选模型监测

页面优先展示最近实际 Codex 路由，其次采用检测记录；无记录才在本页手动选择。「调整监测」直接在当前页展开，保存与刷新不会调用模型。

| 模式 | 行为 | 建议 |
| --- | --- | --- |
| 手动检测 | 点击才取样，不自动暂停 | 首次使用推荐 |
| 定期观测 | 按间隔取样和记录，不自动暂停 | 先观察供应商表现 |
| 异常暂停 | 首次强偏离暂停该完整模型的后续请求，再独立复测 | 理解误报与暂停边界后使用 |

检测使用 [ModelTrace](https://github.com/xqy2006/ModelTrace) 的数字挑战与本机评分，通过自己的 Magpie 供应商调用，**会消耗额度**。通常 3 个请求，强偏离时追加复核。默认共享预算 60 次请求 / UTC 日；每 30 分钟全天检测一个目标至少需要 144 次，默认预算不足以覆盖全天。定期检测不会因关闭页面而停止。

检测错误、样本不足不等于确认降智；已暂停模型需明确解除或限时放行。检测记录每页 10 条，保留最近 100 轮。[取样、费用、判定与暂停规则](docs/USAGE.md#模型指纹检测)

<details>
<summary>查看模型监测、同页设置、记录与深色主题</summary>

![模型监测工作台](docs/images/monitor-light.png)
![同页调整监测](docs/images/monitor-settings.png)
![检测记录](docs/images/history.png)
![深色模型监测](docs/images/monitor-dark.png)

</details>

## 限制与诊断

- 完整工作台在本机浏览器打开，后台随 Magpie 运行；原生页面负责过滤设置。四个分区和明暗主题操作与 CC Switch 工作台一致。
- 指纹是有限参考库的统计结果，不证明模型身份或编程能力；路由组仅支持观测，fallback 或其他插件可能改变最终上游。
- 暂停只阻止后续请求，不能撤回输出或中止已开始的响应。首次未验证、网络错误不会自动阻止请求；宿主加载失败、异常或超时可能放行原请求。
- 停用整个插件会同时停用过滤和暂停保护。只想停止自动监测时，把目标改为手动或删除目标。

### 诊断与问题反馈

在「设置与诊断」导出脱敏摘要；只用过滤时，也可运行 `Diagnose.bat` 做只读配置诊断（此可选 CLI 需要 Node.js 18+ 或 Bun）。实时过滤统计仍以 Magpie 插件页为准。

数据保存在 `~/.config/magpie-model-workbench/`，过滤规则在 Magpie `plugins.json` 的本插件 Options。**不要公开整个数据目录、运行中的生成钩子或原始配置。** 诊断不调用模型，无自动上传；完整证据分享前请自行检查。[数据与诊断详情](docs/USAGE.md#本地数据与诊断)

## 文档与开发

- [使用与检测说明](docs/USAGE.md)：升级迁移、开关原理、取样预算、评分阈值、暂停与架构限制。
- [维护与发布](MAINTAINING.md)：目录职责、离线验证、GitHub 发版与社区市场更新。

```sh
bun test packages/codex-history                 # 社区仓库根目录
bun scripts/check.mjs codex-history
```

公共请求入口已预构建，社区 dist 的 `npm pack --ignore-scripts` 不依赖安装脚本。原历史基准、ModelTrace 来源与许可保留，搜索转换为单独扩展；不提交实际运行中的探针凭据或暂停规则。

## English

Codex Workbench combines opt-in Responses history filtering, native provider settings and an optional local ModelTrace monitor with per-model pause protection. **Filtering requires no console or sign-in.** Install `@magpie-community/middleware-codex-history`; existing Options remain valid and all new functionality defaults off. The console uses Magpie's bundled Bun, with no additional runtime dependencies or telemetry. Explicit model checks can spend upstream tokens; periodic targets keep running until changed to manual or deleted.

Version 0.2.1 converts historical native `web_search_call` items to labeled assistant text, preserving recorded search data and subsequent answers while removing server IDs and their reasoning dependencies. It does not decrypt compacted history. The self-contained middleware keeps filtering if the optional console cannot start; host fail-open/time limits still apply. See the usage guide for privacy, migration and statistical fingerprint limits.

## 许可与致谢

[MIT](LICENSE)。感谢 [ModelTrace](https://github.com/xqy2006/ModelTrace) 提供评分器、中文挑战与参考库，原许可和固定来源见 [vendor/modeltrace/](vendor/modeltrace/)。历史算法来自 [Codex Filter Manager](https://github.com/unisong/codex-filter-manager)，保留原始文件及 [来源校验](history/PROVENANCE.json)。接入方式参考 [magpie-intelligence-check](https://github.com/mu-zi-lee/magpie-intelligence-check)，未复制其题库、Go 后台或门禁实现。感谢 [Magpie](https://github.com/yetone/magpie) 与上述项目维护者。

友情链接：[LINUX DO](https://linux.do/)

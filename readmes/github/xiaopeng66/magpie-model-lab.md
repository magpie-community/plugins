<p align="center"><img src="page/icon.png" alt="模型实验室" width="96" height="96"></p>

# 模型实验室 · Model Lab

[![Release](https://img.shields.io/badge/release-1.0.9-2f81f7)](https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.9)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Magpie](https://img.shields.io/badge/Magpie-0.1.2905%2B-8957e5)](https://usemagpie.ai)

**在 Magpie 中对比模型的推理回答、HTML 动画和指纹匹配，并按计划跟踪表现。**

直接使用 Magpie 已配置的供应商、模型和账号，支持跨供应商、多 API Key 的同名模型对比。回答、思考、用量和历史集中查看，测试结果保存在本机。

Model Lab compares AI models in Magpie using reasoning puzzles, HTML animations and model fingerprints, with scheduled tests and local history. [English overview](#english).

[功能概览](#功能概览) · [安装与上手](#安装与上手) · [测试与对比](#测试与对比) · [结果与数据](#结果与数据) · [常见问题](#常见问题)

> **1.0.9**：新增动画 GIF 导出，完善 Windows 异常退出后的启动恢复、本地更新中断恢复、参考库更新和配置迁移。详见 [更新记录](CHANGELOG.md)。

## 功能概览

| 页面 | 用来做什么 |
| --- | --- |
| **鹈鹕动画** | 用同一提示词生成“鹈鹕骑自行车”HTML 动画，并排比较；支持自定义提示词、重播、源码查看和 GIF 导出。 |
| **模型指纹** | 每个模型采集 3 组数字样本，与参考库匹配，查看候选模型、采样进度和匹配证据。 |
| **糖果测试** | 比较原糖果推理题的回答，标准答案为 **21**；支持重复测试、逐轮判分和分组统计。 |
| **自动测试** | 为每个模型／账号分别设置糖果和动画计划，用成功率时间格和动画长廊跟踪每日表现。 |
| **历史记录** | 按批次或日期回看结果，检索备注、组合筛选、保护记录、原条件复测和导出 JSON。 |

指纹匹配只提供参考库范围内的证据，不能证明真实模型身份；糖果绿色表示最终数值匹配 21，不等同于完整推理验证或正式智商评分。

## 安装与上手

需要 **Magpie 0.1.2905+**，并在 Magpie 中配置至少一个可用供应商。插件附带所需依赖，无需额外构建前端。

### 安装插件

在 Magpie「插件 → 发现 → GitHub 非官方插件」中查找 `magpie-model-lab`，或直接运行：

```sh
magpie plugin add github:xiaopeng66/magpie-model-lab
```

命令末尾加 `#v1.0.9` 可固定安装当前正式版。发现列表受 GitHub 索引和缓存影响，暂时搜不到时可使用命令安装；当前发布渠道为 GitHub，npm 暂未上线。

也可从 [v1.0.9 Release](https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.9) 下载 `magpie-pelican-bench-1.0.9.zip`，核对同页 SHA-256 校验文件后解压到固定目录。在插件页添加**直接包含 `package.json` 的文件夹**，或在该目录运行 `magpie plugin add .`。Windows 安装脚本及渠道规则见 [发布与发现指南](docs/publishing.md)。

### 第一次测试

1. 从 Magpie 侧栏打开「模型实验室」，选择鹈鹕动画、模型指纹或糖果测试。
2. 选择供应商和模型；需要比较同名模型的不同账号时，展开模型卡片的「账号」选择。
3. 按需调整提示词与高级设置，点击顶部开始按钮，在卡片中比较结果。
4. 点击「查看详情」阅读回答、思考、参数和用量；需要持续观察时，将目标「加入自动测试」并设置计划。

**测试会使用所选供应商的额度。** 动画重播和查看已有结果读取本地文件，不重复请求模型。

### 升级已有安装

技术包名和数据目录继续使用 `magpie-pelican-bench`，沿用已有参数、计划、历史、备注、保护状态和用量。等待活动测试结束，停用插件并完整备份数据；替换本地文件后重新启用插件、重新打开页面，确认顶部版本为 **1.0.9**。历史仍按已设置的保留策略管理。

使用本地替换工具时，中断恢复在下次运行替换／恢复工具时执行，单独恢复保持插件停用。具体命令见 [本地替换与中断恢复](docs/publishing.md#本地替换与中断恢复)。

## 测试与对比

### 模型、账号与参数

- **跨供应商、多账号对比**：搜索并多选模型；同一模型可由 Magpie 自动分配账号，或同时选择多个固定账号。普通供应商的主 Key 和附加 Key 也可分别测试，计划、历史和复测保留目标身份。
- **参数记忆与方案**：动画、指纹和糖果分别记忆参数；可保存常用参数方案，统一管理提示词、思考档位、输出上限、超时和并行数。生成采用点击开始时的参数，后续编辑不改变已提交任务。
- **重复测试**：糖果原题可按设定轮次重复，结果按模型／账号分组、各轮相邻显示，并汇总命中率与耗时。重复次数不设固定轮数上限，仍受数据大小保护限制；开始前会显示结果份数与最多生成请求数，指纹每份结果包含 3 次采样请求。

| 设置 | 默认值与含义 |
| --- | --- |
| 最大输出 | **64000 Token**；**0** 表示请求中省略插件提供的输出上限 |
| 生成超时 | **600 秒**；**0** 表示不设插件侧超时，排队等待不计入 |
| 手动批次并行数 | 动画 **2**，指纹／糖果 **3**；**0** 表示不设插件并行上限 |
| 自动测试并行数 | **3**，在「管理模型」调整；**0** 表示不设插件并行上限 |

旧模型已保存的参数继续保留。供应商与网关可能另有限制，填 0 不保证无限输出或无限并发。参数、采样设置与批次规模边界见 [使用说明](docs/usage.md)。

### 自动测试

为每个模型／账号目标分别设置糖果和动画计划，支持指定时刻、固定间隔、工作日、周末、自选星期和时区。每个目标、每种测试、每计划日最多 **24 次**；自动糖果测试每个时刻执行一次原题，自动页不含指纹测试。

**新计划默认暂停，启用后只执行未来时刻。** Magpie 插件服务需要持续运行，休眠、退出或崩溃期间错过的时刻不补跑。修改计划可复用同一目标、同一测试类型、同一原定执行分钟的已有结果。时区和跨午夜规则见 [自动测试说明](docs/favorites-guide.md)。

## 结果与数据

### 详情、复测与趋势

「查看详情」保留原始回复、思考、参数和用量，并区分超时、限流、认证失败、响应中断、截断及答案不匹配等情况。生成期间显示阶段、已用时间和剩余超时；连续 120 秒无有效数据时仅提醒，不自动重发请求。

「原条件复测」沿用原模型／账号、题面和参数，指纹另保留原挑战与参考库快照，核对后创建新批次。手动批次支持多选及按失败原因选择，自动历史支持单条复测。详情还可展开最近 **20 条同账号目标、同完整条件**的历史趋势，查看结果率、耗时、用量和异常提示。

### 动画与 GIF

动画支持重播、浏览器打开、预览及源码查看。预览限制网络访问，依赖外部脚本、图片或字体的动画可能显示不完整。

在已完成动画的详情中点击「生成 GIF」，可通过 **Windows Edge** 导出 **960×600、4 秒、25 帧/秒（100 帧）**的动画，支持复制 GIF 文件到剪贴板和另存。单个 GIF 不超过 8 MiB；临时文件最多保留 5 个、总计不超过 40 MiB。未复制的文件在关闭详情时删除，复制后的文件可手动清理或在 24 小时后过期；另存文件不受临时清理影响。

### 历史、保留与导出

- **查找记录**：手动结果按提交批次查看，自动结果按日期、类型和时刻分组。详情可保存备注，历史可组合筛选备注、模型、账号、日期、结果和保护状态。
- **保留与保护**：结果默认保留 **7 天**，可在历史页设为 **1–36500 天**或永久保留；缩短前预览影响，所有清理入口跳过受保护记录。模型和计划持续保留。
- **批次留档**：支持 JSON 导出，单批预算为 **16 MiB**，超限时原始文件仍可从「保存位置」获取。批次 JSON 用于留档和分析，当前不提供历史恢复入口。

### 请求控制与每日用量

右上角「本地设置 → 请求控制」可按供应商／固定账号设置并行上限和请求启动间隔，统一协调手动批次与自动计划。HTTP 429 会暂停同一目标的新请求，其他可执行目标继续运行；失败请求不自动重试。

「每日用量」按供应商／账号展示请求数、已知 Token、输入、输出、缓存读取与命中率，接口提供时另列缓存写入。指纹每次采样分别记账，删除历史不减少用量；未返回的用量标为未知，不推算费用。结果卡片优先显示思考／输出 Token，尚未返回用量时显示流式字符数；输出可能包含思考，两项不能直接相加。

### 本地保存与配置迁移

结果、参数、备注、保护状态和用量保存在本机 Magpie 配置目录的 `magpie-pelican-bench/` 中，运行记录位于 `runs/`，可通过「保存位置」打开。测试请求经 Magpie 网关发送至所选供应商；指纹参考库默认从 `lm.ikale.io` 或 `cdn.jsdmirror.com` 下载并缓存，不向参考库服务上传测试记录。

「本地设置 → 配置迁移」使用独立配置 JSON 迁移设置、常用参数、模型目标和计划，导入时可重新绑定账号、选择保留或覆盖，并在预览后确认。配置不含宿主凭据、历史回答或用量账本，分享模式默认去除账号绑定；受影响或新计划保持暂停，核对后再启用。历史批次 JSON 则可能包含提示词、回复、账号标识和本机路径，分享前请检查。

## 常见问题

- **供应商或模型列表为空、未更新？** 先在 Magpie 中配置并启用供应商。列表每 5 分钟自动刷新，也可手动刷新；刷新失败时保留上一次的列表。
- **为什么显示「账号未核实」？** 只有网关返回可信且一致的路由证据才显示「账号已核实」。普通供应商 Key 通常不返回明确的身份信息，未核实本身不表示测试失败。
- **GIF 复制后无法粘贴？** 剪贴板中是 GIF 文件，需要在支持文件粘贴的应用中使用；清理或过期后该临时文件无法继续粘贴，需要长期保存时请使用「另存为 GIF」。
- **页面启动时提示端口占用？** 插件服务默认使用 `127.0.0.1:3489`，可在插件选项设置 `{"port":3491}` 后重新启用；它与 Magpie 网关默认端口 3425 不同。

## 文档与开发

[使用说明](docs/usage.md) · [自动测试说明](docs/favorites-guide.md) · [发布与发现指南](docs/publishing.md) · [更新记录](CHANGELOG.md)

源码使用原生 HTML/CSS/JavaScript 与 Node/Bun，无前端构建步骤。使用 **Node 22+ 或 Bun** 独立调试：

```sh
node serve.mjs --port 3489 --data-dir .local-data --gateway http://127.0.0.1:3425
```

运行回归与静态检查：

```sh
node --test tests/*.test.mjs
bun test ./tests
bun tools/check-static.mjs
```

测试使用临时目录与模拟网关。独立调试启动服务本身不发送模型请求，在页面开始测试或启用已有计划后才会使用配置的网关。

本项目采用 [MIT License](LICENSE)。指纹能力参考 [magpie-fingerprint](https://github.com/KaranocaVe/magpie-fingerprint)，使用随包附带的 `lmfpd-sdk@0.2.0`；相关来源、局部改动和 GIF 依赖见 [第三方声明](THIRD_PARTY_NOTICES.md)。Magpie 接入遵循 [官方插件文档](https://usemagpie.ai/docs/plugins)。

## English

Model Lab is a Magpie plugin for comparing models across your configured providers and accounts, including multiple API keys for the same model.

- **Compare results:** HTML animations with side-by-side previews, three-sample model fingerprints, and the original candy reasoning puzzle (answer **21**) with repeated runs.
- **Track changes:** separate candy and animation schedules per model/account, daily result grids, an animation gallery, retests under the original conditions, and recent trends.
- **Manage records:** local history, notes, filters, record protection, configurable retention, batch JSON export, parameter presets, and configuration migration.
- **Control requests:** concurrency and interval rules shared across manual and scheduled tests, plus daily token and cache usage.
- **Share animations:** export a 4-second, 960×600, 25 fps GIF using Windows Edge, then copy the file or save it permanently.

Requirements: Magpie **0.1.2905+**. Install with:

```sh
magpie plugin add github:xiaopeng66/magpie-model-lab
```

Alternatively, download the ZIP and SHA-256 checksum from [v1.0.9](https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.9). Extract it and add the folder containing `package.json` in Magpie. No frontend build is required.

Tests use your provider quota. New schedules start paused, require the plugin service to stay running, and do not catch up missed times. Results stay local and are retained for 7 days by default; protected records are skipped during cleanup. Fingerprints are reference-bank evidence, and candy scores check the final numeric answer; neither establishes model identity or a formal IQ score.

See the [usage guide](docs/usage.md), [automation guide](docs/favorites-guide.md), and [changelog](CHANGELOG.md) for details.

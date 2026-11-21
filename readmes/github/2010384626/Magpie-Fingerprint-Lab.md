<p align="center" style="text-align: center;">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" width="96" height="96" alt="Fingerprint Lab">
  </picture>
</p>

<h1 align="center" style="text-align: center;">Magpie Fingerprint Lab</h1>

<h3 align="center" style="text-align: center;">Magpie 供应商与路由组的模型指纹检测</h3>

<p align="center" style="text-align: center;">
  用三条数字样本比对模型指纹，在同一张看板上比较不同路由的结果。
  <br>
  <em>Compare model fingerprints across providers and routing groups.</em>
</p>

<p align="center" style="text-align: center;"><a href="package.json"><img src="https://img.shields.io/badge/npm-v0.1.0-8c9eff?labelColor=1f2328" alt="npm"></a> <a href="https://usemagpie.ai"><img src="https://img.shields.io/badge/magpie-%E2%89%A50.1.1340-8c9eff?labelColor=1f2328" alt="magpie"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8c9eff?labelColor=1f2328" alt="license"></a></p>

<p align="center" style="text-align: center;"><a href="#快速上手"><b>安装</b></a> · <a href="#功能">界面预览</a> · <a href="#按供应商或路由组检测">开始检测</a> · <a href="#读懂结果">读懂结果</a> · <a href="#隐私与费用">隐私与费用</a> · <a href="#english">English</a></p>

<p align="center" style="text-align: center;">
  <img src="docs/images/detect.png" width="900" alt="检测页：三条样本并行取样，数字分布实时成形">
</p>

## 适合谁用

中转站、聚合平台和多把密钥让模型变得好买，也让“背后到底是哪个模型”变得难说。Fingerprint Lab 是一款 [magpie](https://usemagpie.ai) 页面插件，基于 [lmfpd / lm-detector](https://lm.ikale.io) 的指纹方法，检测供应商实际运行的模型是否就是它声称的那一个：

- **按供应商或路由组检测**：路由组会逐个成员检测，直接定位出问题的那条线路。
- **看板一眼看全**：所有供应商和模型最近的判定汇总在一张网格上。
- **记录与趋势**：每次检测完整保存，看得出模型从什么时候开始变了。
- **定时巡检**：按间隔自动检测，带随机抖动、活动时段和每日上限。
- **覆盖规则**：为某个供应商或某类模型固定几项配置，优先于预设。

检测只交换数字，不涉及你的任何对话内容。如果你只用官方 API、从不经过中转，大多数时候用不到它。

## 快速上手

**1 · 安装。**

```sh
magpie plugin add <插件目录>
```

<sub>需要 magpie ≥ 0.1.1340。页面服务默认监听 `127.0.0.1:3497`，端口被占用时在插件选项中修改 `port`。</sub>

**2 · 打开。** 在 magpie 侧边栏的插件分组中打开“模型指纹检测”，或在供应商的右键菜单中点击“指纹检测”，直接以该供应商为目标打开。

**3 · 检测。** 选择供应商和模型，或者一个路由组，点击“开始检测”。每轮发送三条提示词，三条回复取样完成后即给出判定。

## 功能

### 按供应商或路由组检测

检测目标可以是 magpie 中的某个**供应商**和模型（供应商有多把密钥时可指定其中一把），也可以是一个**路由组**：插件把组内每个成员拆开，用它在组里指定的密钥直连检测，各自给出结论。一次可以添加多个目标批量检测。

<table>
<tr>
<td width="50%"><img src="docs/images/group.png" alt="按路由组检测：组内成员逐个列出，可勾选要测的成员"></td>
<td width="50%"><img src="docs/images/result.png" alt="检测结果：声称 gpt-6.2-sol，实测更接近 gpt-6-luna"></td>
</tr>
</table>

结果区显示判定、实测第一名、置信度和完整的候选排名。单条样本出错或数字不足时，可以单独换一条提示词重取，不必整轮重来。供应商列表与顺序跟随 magpie，也可以在插件内自定顺序。

### 看板

“供应商 × 模型”的网格，每一格是该模型最近 12 次的判定：线宽表示严重程度，颜色表示最新一次的结论。哪个模型对不上、是偶发还是持续，一眼就能看出来。路由组按成员单独成格；可以只看异常，也可以一键为某个供应商或路由组的全部模型“体检”。

<img src="docs/images/board.png" width="900" alt="看板：星河中转的 claude-opus-5.5 与 gpt-6.2-sol 近期持续不符">

### 记录与趋势

每次检测都完整保存提示词、回复、评分、请求地址与请求头名称，可按供应商、模型、路由组、判定和来源筛选，两两叠图对比，或导出 JSON。

选定一个模型（或路由组的一个成员），趋势视图按时间排出每次检测的置信度和判定，并统计各小时段的异常次数：是一直稳定、偶尔被替换，还是从某天起换成了别的模型，都能看出来。

<img src="docs/images/history.png" width="900" alt="趋势：OpenRouter 的 gpt-6.2-sol 近 48 次中 45 次一致，3 次不符">

### 定时检测

为供应商、指定模型或路由组设置周期检测。列表中显示每个任务上次的结论和下次运行的时间；定时检测在 magpie 运行时执行。

| | |
| :-- | :-- |
| **间隔与抖动** | 固定间隔加随机抖动，避免总在同一时刻发请求 |
| **活动时段** | 只在指定时段内运行，可跨夜（如 22:00–06:00） |
| **每日上限** | 限制每天的检测批次，控制额度消耗 |

<img src="docs/images/schedules.png" width="900" alt="定时检测：编辑任务的间隔、抖动、时段和每日上限">

### 覆盖规则

预设是一组检测配置（接口协议、客户端方式、推理强度、轮数、超时等），内置“标准快测”“严格复核”“编程客户端”三个，也可以自建。

覆盖规则为某个供应商或某些模型固定几项配置，优先级高于预设。比如某个中转只开放 Chat 接口，就为它固定接口协议；希望 Opus 系列多测几轮，就用 `claude-opus-*` 为这类模型固定轮数。模型名支持 `*` 通配。生效配置按以下顺序叠加，后者覆盖前者：

```
预设 → 供应商级覆盖 → 模型级覆盖 → 本次检测中手动修改的项
```

<img src="docs/images/overrides.png" width="900" alt="覆盖规则：按供应商或模型通配固定部分配置">

### 还有

- **客户端预设**：让请求带上 Claude Code 或 Codex 的请求特征，观察中转是否对不同客户端区别对待。
- **参考库更新**：参考库与检测器 SDK 自动检查更新（可关闭），新库验证通过后才替换旧库。
- **界面**：中文与英文，浅色、深色或跟随系统。

## 读懂结果

| 判定 | 含义 |
| :-- | :-- |
| **一致** | 实测第一名就是声称的模型，三条样本有效，置信度达到 75% |
| **置信度不足** | 第一名与声称一致，但置信度低于 75%，或有效样本不足三条 |
| **同家族不同型号** | 更像同一型号线的另一个快照或修订版本 |
| **不符** | 第一名与声称的模型不属于同一型号线 |
| **不在参考库** | 声称的模型不在参考库中，只能列出最接近的候选 |
| **检测失败** | 请求失败、协议不受支持，或没有可评分的样本 |

多轮检测时，第一名取各轮第一名的多数，置信度取各轮平均值。

结论是参考库范围内的相对排名。库外模型、微调或量化后的模型、加了系统提示词或改写请求的中转，都可能影响排名；遇到“不符”时，换个时段多测几轮，结合趋势判断。

## 配置与数据

| 项目 | 说明 |
| :-- | :-- |
| **端口** | 插件选项 `port`，默认 `3497` |
| **代理** | 优先使用 `HTTPS_PROXY` / `HTTP_PROXY`，`NO_PROXY` 中的目标和本机回环地址直连；没有环境代理时，Windows 使用系统代理。支持 HTTP 与 HTTPS 代理 |
| **超时** | 默认 120 秒，从建连算到收到首个流式字节（非流式为完整回复），可在预设或覆盖规则中调整 |
| **记录保留** | 默认保留最近 2000 条，在“设置 › 运行与存储”中修改 |

所有数据保存在本机的 `<magpie 配置目录>/fingerprint-lab/` 下（magpie 配置目录通常为 `~/.config/magpie`），卸载插件不会删除，不再需要时手动删除即可：

| 路径 | 内容 |
| :-- | :-- |
| `state.json` | 设置、供应商列表（不含密钥）、预设、覆盖规则、定时任务、客户端预设 |
| `secrets.json` | 仅包含在本插件中手动添加的供应商的密钥和敏感请求头 |
| `runs/<id>.json` | 每次检测的完整记录 |
| `runs-index.json` | 记录摘要，供看板、列表和趋势读取 |
| `bank/` | 参考库 |
| `sdk/` | 下载的较新版检测器 SDK（没有时使用内置的 `vendor/lmfpd-sdk`） |
| `service.lock` | 当前持有该目录的服务实例（进程号、端口、启动时间） |

同一数据目录同一时刻只有一个服务实例写入，magpie 命令行或 `magpie web` 另外启动的实例会自动转到正在运行的那一个。

## 隐私与费用

服务只监听 `127.0.0.1`，校验 `Host` 与 `Origin`，接口需要携带每次启动随机生成的口令。界面只能看到密钥的掩码（如 `sk-…a1b2`），接口响应、日志、检测记录和导出文件中都不含密钥明文，上游报错中回显的密钥会先被抹去。magpie 中的供应商不复制密钥，每次请求时从 magpie 读取；订阅类、插件类供应商经 magpie 本机网关发出请求。

插件只访问被检测供应商的 API 地址（或 magpie 本机网关）、参考库地址（`lm.ikale.io` / `cdn.jsdmirror.com`）和 npm 源（`registry.npmjs.org` / `registry.npmmirror.com`，用于 SDK 更新，下载后按 sha512 校验），没有遥测；后两项可在设置中关闭。

| | |
| :-- | :-- |
| **每轮用量** | 3 个请求，每个请求输出约 300 个数字；推理模型消耗更多 |
| **批量与定时** | 体检和定时检测会成倍增加用量，请合理设置间隔和每日上限 |
| **客户端预设** | 经 magpie 网关的请求由网关改写请求头，预设对这类目标不生效；使用前请自行确认是否符合供应商的使用条款 |

## 本地开发

不经过 magpie 也可以直接启动页面服务（Node ≥ 22，使用代理需 22.21+ 或 24.5+）：

```sh
node serve.mjs [--port 3497] [--config <magpie 配置目录>] [--data <数据目录>]
```

## 许可

[MIT](LICENSE)

检测算法、参考库和 SDK 来自 [lmfpd / lm-detector](https://github.com/Ikaleio/lm-detector)（`lmfpd-sdk`，MIT），第三方组件详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

Fingerprint Lab is a [magpie](https://usemagpie.ai) page plugin that checks whether a provider really serves the model it claims. Each round asks the model for about 300 numbers in three replies and compares their distribution with a reference bank of known models (the [lmfpd](https://lm.ikale.io) method), giving an in-bank ranking, a confidence and a verdict.

**Install**

```sh
magpie plugin add <plugin folder>
```

Requires magpie ≥ 0.1.1340. Open "Fingerprint Lab" from magpie's sidebar, or "Fingerprint" in a provider's menu. The page service listens on `127.0.0.1:3497`; change the `port` option if it is taken.

**Features**

| | |
| :-- | :-- |
| **Providers and routing groups** | A routing group is tested member by member, each with the key the group assigns it, so you can tell which route is off |
| **Board** | A provider × model grid of the last 12 verdicts per model, with a one-click checkup |
| **History and trends** | Full records with filters, comparison and JSON export; the trend view shows how a model's verdicts change over time |
| **Schedules** | Periodic checks with random jitter, active hours (overnight allowed) and a daily cap |
| **Overrides** | Pin settings for a provider or for models matching a `*` pattern; they take precedence over presets |

**Privacy** — data stays in `<magpie config dir>/fingerprint-lab/`. The service binds to loopback and requires a per-start key; no response, log, record or export contains an API key. Network access is limited to the providers you test, the reference bank hosts and the npm registry for SDK updates. No telemetry.

A result is a ranking within the reference bank; repeat a mismatch at different times before drawing conclusions. MIT licensed; detection method, reference data and SDK by [lmfpd / lm-detector](https://github.com/Ikaleio/lm-detector).

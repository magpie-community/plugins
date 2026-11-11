# magpie-hcnsec-probe

给 [magpie](https://github.com/magpie-community) / OpenCode 用的**模型检测器**供应商插件：
域名写死在 `config.mjs`，登录时粘贴站点的 `sk-…`，然后把站点声称的每一个模型逐个打一枪，
**只有真正答对的才进 magpie 的模型列表**。

一个文件夹只管一个站点。模型列表是按 provider 隔离的，多个站点塞进同一个插件会串台，
所以要接 `api.iamhc.cn` 就复制整个文件夹、改 `config.mjs` 里的 `provider.id` 和 `baseURL`。

## 为什么要这一步

中转站的 `/v1/models` 只是"站点声称有哪些模型"。以 hcnsec.cn 实测（17 个）为例：

| 情况 | 数量 | 例子 |
|---|---|---|
| 真的正常 | 6 | `glm-5.3`、`sensenova-6.8-flash`、`longcat-2.5` |
| **列表里有，实际 404 / 无渠道** | 5 | `sensenova-u1.5-lite`、`stepaudio-2.5-asr`、`stepaudio-2.5-tts` |
| 慢到没有实用价值 | 3 | `DeepSeek-V4.1-Flash` 157s、`MiniMax-M3.1-Flash` 160s |
| 答错题（蠢但活着） | 1 | `stepaudio-2.5-chat` 把 `37×89+47` 算成 `3330` |
| 非对话模型混在列表里 | 4 | `Qwen3-Embedding-8B` |

不筛的话，agent 随机挑一个就可能挑到 404。

## 探针怎么判

一道答案唯一的题，输出要求单个 JSON 对象（用 `|` 分隔会有空格差异）：

```
只输出一个 JSON 对象，不要解释、不要代码块、不要任何多余文字。
键固定为 a、b、c，值一律写成字符串。
a：37×89+47 的结果。                    → 3340
b：把 q7f3 里的字符按 ASCII 码升序排列。 → 37fq
c：2024 的十六进制，小写，不带 0x。      → 7e8
三项必须全部给出，不确定也要给出答案。
```

三重防呆：确定性运算（不依赖知识库版本）、字符级操作（难碰巧蒙对）、进制转换（猜中率 ~1/1000）。
三项同时蒙对约 1e-9。

**双路校验**：既解析 JSON 三键，也检查原始文本是否含三个期望串——
模型答对了但没守 JSON 格式仍算通过（`答案全对但未守JSON格式`）；反过来只写对一半算 `dumb`。

| 结论 | 含义 | 是否列出 |
|---|---|---|
| `ok` | 三项全对 | 列出 |
| `dumb` | 有正文但答错/答不全 | `includeDumb` 决定，默认不列 |
| `fake` | 无脑广告文案 / 超长跑题 | 不列 |
| `dead` | 超时、HTTP 错、空回复、只有推理没正文 | 不列 |

命中的题面本身不含答案，模型无法照抄。

## 安装

```bash
magpie plugin add /path/to/magpie-hcnsec-probe   # 文件夹就地加载
magpie plugin login hcnsec                       # 粘贴 sk-…
magpie plugin                                    # 看到筛选后的模型数
```

GUI：插件 → 添加插件 → 填文件夹路径 → 在供应商那一行登录。

## 配置（`config.mjs`）

| 项 | 默认 | 说明 |
|---|---|---|
| `provider.id` | `hcnsec` | magpie 里的供应商 id，别用 models.dev 收录的名字 |
| `provider.baseURL` | `https://api.hcnsec.cn/v1` | 站点根地址 |
| `probe.timeoutMs` | `20000` | 单模型单次超时 |
| `probe.concurrency` | `3` | 并发数，开太大反而让上游排队 |
| `probe.maxTokens` | `2048` | 推理模型先吃 reasoning token，实测同题波动 169–596；给 256/512 会 `finish=length` 无正文被误判 |
| `probe.budgetMs` | `90000` | 一轮总预算（含补测），超出的下次接着测 |
| `probe.retryOnce` | `true` | 超时/5xx 补测一次；404/400 不补 |
| `probe.repeat` | `1` | 每个模型默认测几遍 |
| `probe.repeatModels` | `{ auto: 3 }` | 指定模型的多测次数 |
| `probe.anyFakeFails` | `true` | 多测里任意一次撞上假货，整条判死 |
| `probe.includeDumb` | `false` | 蠢模型是否也列出来 |
| `cache.ttlMs` | 6h | ok/dumb/fake 结论有效期 |
| `cache.deadTtlMs` | 30min | 超时/5xx 类 dead 的有效期（给它复活机会） |
| `pinnedModels` | `[]` | 无结论也强制列入 |
| `excludedModels` | `[]` | 无论如何都排除 |

## 耗时是站点的锅，不是模型的

同一个 `glm-5.3` 两次实测分别是 **2.4s 和 53s**，`kimi-k3` 是 9.1s 和 19.6s。
这个站的排队抖动极大，所以：

- 20s 超时**一定会有随机误杀**，`retryOnce` 就是为了把它捞回来；
- 想让 `glm-5.3-flash`(35–57s) 也进来，把 `timeoutMs` 调到 `60000`；
- 首次探测 17 个模型要 60–90s，**结论会边测边落盘**，第二次列模型是 0 请求、秒回；
- 一轮没测完时，下一次调用先返回已有结论，剩余的在后台补测。

缓存位置 `~/.magpie/probe/<provider id>.json`，按 baseURL + key 指纹隔离，**不存明文 key**。

## 路由组（auto）要测几遍

`auto` 不是模型，是站点的路由组：每次请求可能落到不同后端，里面混着
404 渠道、答错的模型，还有**秒回一段广告文案的假货**。只测一遍必然漏。

所以 `repeatModels: { auto: 3 }` —— 连打 3 次，**任意一次判 fake 就整条判死**
（`anyFakeFails: true`）；没有假货时取多数票，平票取更差的那个。
撞到假货后立刻停止，不会把 3 次都打完。

实测这个 auto 很不稳：同一个 key 一次是 3 次全对，半小时后 8 次全是
`HTTP 503 No available channel for model 8 under group auto`（站点侧的渠道挂了）。
所以 auto 能不能留在列表里，取决于你测的那几分钟。

针对路由组的调试：

```bash
HCN_PROBE_KEY=sk-... node scripts/auto-repeat.mjs auto 8
```

## 蠢模型要不要留

默认不留（`includeDumb: false`），理由不是"它答错一次"：

1. **算术错的模型在 bot 里会错得很难看**——算钱、数条数、拼 ID 都会翻车；
2. `stepaudio-2.5-chat` 的 `prompt_tokens` 是 1482，其他模型只有 99–215，
   说明站点在它前面塞了一大段系统提示**改写了它的行为**。这种被套壳的模型，即使某次答对也不可信；
3. 它的输出还不稳定：同一道题两次分别是 `答对2/3` 和 `答对1/3`。

结论：**闲聊/意图分类能凑合，任何要工具调用或数字的任务都别用**。
真要放进来，把 `includeDumb` 改成 `true`。

## 调试

```bash
HCN_PROBE_KEY=sk-... node scripts/try.mjs   # 跑一遍 provider.models，打印每个模型死因
node --test test/probe.test.mjs              # 判分逻辑单测
```

强制重测：删掉 `~/.magpie/probe/<provider id>.json`。

## 结构

```
config.mjs    域名、超时、并发、缓存、筛选开关（换站点只改这里）
probe.mjs     题目、双路判分、并发探测（不依赖 magpie，可单测）
index.mjs     magpie 钩子：config / auth / provider.models
scripts/try.mjs  本地对着真实站点跑一遍
test/         判分与筛选单测
```

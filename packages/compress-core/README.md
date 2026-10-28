# compress-core

给 magpie 网关用的上下文压缩中间件。它在请求离开本机之前改写 `messages`，把重复的、噪声的、格式化的部分去掉，然后照原样交给上游。引擎本身不做任何网络调用、不起任何子进程。

这是 OmniRoute 压缩策略的移植：策略 id、名字、优先级、有损标记都跟那边一致。这一版只带三个策略——`lite`、`headroom`、`session-dedup`；其余的移植（`ccr`、`rtk`、`codex-responses`、`caveman`、`relevance`、`read-lifecycle`、`aggressive`、`ultra`、`ionizer`、`llm`）与网关钩子、页面一起在后续提交里进。

## 装

```bash
magpie plugin add @magpie-community/middleware-compress-core  # 从 registry 装
magpie plugin add <本目录>                                    # 本地目录
magpie plugin add github:magpie-community/plugins             # 从仓库装（packages/compress-core）
```

装完 `magpie plugin list` 里应该能看到这个插件声明了 `middleware`。

## 策略

按 `stackPriority` 升序执行，每个都可以单独开关、单独调参。

| id | 名字 | 优先级 | 有损 | 做什么 |
| --- | --- | --- | --- | --- |
| `session-dedup` | Session Dedup | 3 | 否 | 本会话早前发过的文本换成 `[dedup:ref sha=…]`，原文可用映射还原。 |
| `lite` | Lite Cleanup | 5 | 否 | 只处理空白、重复行与格式，不动措辞。最快，永远安全。 |
| `headroom` | Headroom (GCF) | 15 | 否 | 表格化 JSON 转列式，长行折成 `[N rows]`，靠围栏里的 GCF 数据还原。 |

三个都是无损：被折叠的内容都能按原文还原，模型不需要额外工具就能读到。

## 预设

| 档 | 含义 |
| --- | --- |
| 关闭 | 全关。 |
| 稳妥 | 无损策略全开，也就是上面这三个。 |
| 自定义 | 你自己逐个点出来的结果。手动改任何开关，档位自动落到这一档。 |
| 全开 | 所有可用策略全开。这一版与"稳妥"相同，后续策略进来后会分开。 |

"自定义"是结果态，不是按钮——点它没意义，所以它是灰的。

## 缓存与前缀

提供方按**请求前缀**命中 prompt cache：前缀里有一个字节变了，后面整段都按未命中计费。

lite 默认**全量改写、严格前缀稳定**：每条消息从第一轮起就走同一套确定性变换（折叠空白本身幂等），一条消息一旦发出去，此后每个字节都是同一个结果，前缀不再变化，缓存一次都不失配。代价是正在发送的这一轮也会被折叠空白与去重——用户刚打的字同样会被压缩。

把 `preserveCurrentTurn` 设成 `true` 换回保守模式：最后一条 assistant 之后的消息（没有 assistant 时整段）原样送出，只在它从「当前轮」变成「历史」的那一轮被改写一次，那一次前缀失配，之后重新稳定。代价是这条消息被改写了一次，缓存那次 miss。

`session-dedup` 认同一个开关：默认也把正在发送的这一轮照常处理，显式 `preserveCurrentTurn: true` 才保护它。理由是同一个——只保护当前轮，等于让那条消息在下一轮里被改写一次，前缀跟着变。

`test/prefix-stability.test.mjs` 就是这条验收：逐轮追加原文，每一轮发出的前缀必须与上一轮逐字节相同，默认档、稳妥档与每个无损引擎各测一遍。

`preserve.lastTurns` 默认 `0`（不额外保护任何轮次）。设成 N 会把最近 N 轮排除在所有改写之外；那一轮滑出窗口时同样被改写一次，这是窗口本身带来的，不是 lite 的。

`preserve.system` 默认 `false`。开着它会把 system 段整段占位保护、跑完再还原，代价是依赖 system 内容的那一步（例如「同一段 system 写了两遍只留一份」）整段失效——上一版把它默认成 `true`，等于把那一步变成死配置。要绝对不动 system 的人显式写 `true`。

## 参数

`budgetMs` 默认 `0`，即不按时间跳过任何策略。给它一个正值，pipeline 会在超时后停掉剩下的策略——但同一个请求在负载下可能压出两种结果，而变过的 body 是缓存永远复用不了的 body，所以默认不给时间预算。引擎自己也不带 deadline（`session-dedup` 的 `timeBudgetMs` 同样默认 `0`）。

`maxBytes` 默认 `8000000`：**超过这个尺寸的 body 一个引擎都不跑，原样发出去**。钩子只有 250 ms，而 20 MB 的 body 光 `JSON.stringify` 就要 70 ms 上下，任何引擎还没看它一眼——那种尺寸在任何机器上都压不进预算。按尺寸而不是按时钟跳过，是因为尺寸是确定的：同一份 body 每次都得到同一个判断，它贡献给上游提示词缓存的前缀就不动。判断本身不算精确字节数：先数文本长度（O(n)、不分配、永远是真实字节数的下界），下界已经过线就直接下结论，离门限还远就直接放行，只有卡在中间那一小段才付一次精确计数。

本机实测（本包的 `lite` + `headroom`，5 次取中位）：2 MB 16 ms、4 MB 25 ms、8 MB 43 ms、12 MB 55 ms、20 MB 94 ms、40 MB 122 ms——后三个都在门限以上，只做判断。

## 钩子写了什么

这个包装的不止 `middleware`：它还有一条 `hooks`（`observability.hooks.js`），中间件压 body，钩子记录这次压缩做了什么。钩子只认本地来源的请求，别的来源不会导出任何由请求派生的数据。

累计统计写进插件配置目录的 `stats.json`，和下面那些遥测文件放在一起，**不碰 magpie 自己的 `plugins.json`**——那个文件 magpie 盯着 mtime，一改就重启钩子宿主，等于每压一次请求就重启一次，代价远超收益。

写文件很保守：先写 `.tmp` 再 rename，失败静默；最快 30 秒一次（首个请求立即写）；读回来超过 4MB 就不解析，免得被坏文件拖住；`COMPRESS_CORE_NO_STATS=1` 时完全不碰磁盘（测试用）。压缩本身不依赖这些数字：文件写不进去，压缩照跑。

## 隐私

落盘只发生在插件自己的目录（`MAGPIE_CONFIG_DIR` 优先，其次 `XDG_CONFIG_HOME/magpie`，默认 `~/.config/magpie` 下的 `compress-core/`；`COMPRESS_CORE_DATA_DIR` 可整体改掉）：

- `requests.jsonl`：每个请求一行统计（原始/压缩后字节、命中哪个策略、模型、客户端），**不含正文**。它默认开着，但是有界的：写满 8MB 就改名成 `requests.jsonl.1` 从头再来，所以最多占两代的空间，不会一声不响长到把磁盘吃掉。`telemetry.samples` 打开后才额外存最多 8 对问答，每段 1600 字符，存前先过下面这套打码。
- `captures/`：只在 `capture` 打开时才有，是完整请求正文，单条上限 2MB（超了整条不落盘，索引里标 `too_large`），只保留最新 50 条，索引在 `captures-index.json`。
- `options-override.json`：本地覆盖，不含正文。

打码在 `telemetry-store.js` 的 `SECRET_RULES`，快照与样本共用一套：私钥块整段、`ghp_`/`github_pat_`/`AKIA`/`AIza`/`sk-`/`xox?-` 形态的令牌、`eyJ…` 的 JWT、`Bearer …`、URL 里的密码、Cookie 头（包括 JSON body 里的 `"cookie"`）、`npm_` 与 `hf_` 令牌，以及 `authorization`、`api_key`、`password`、`client_secret` 这类字段的值，全部换成 `[redacted:…]`。邮箱和 `C:\Users\…` 这类路径只在样本里替换——快照要能看清代码原文。字段名保留、值丢掉，所以仍然看得出这条请求带了什么凭据。

两个开关都不碰代码本身，它们要回答的是「压缩对这段文本做了什么」。一段对话里如果有不能落盘的东西，就别打开 `capture` 和 `telemetry.samples`。

## 实验室

页面把一段试压请求交给钩子，钩子在 Node 侧用同一套引擎跑一遍，把逐段结果写回 options；页面只负责显示。输入是操作者自己贴的文本，落盘前往同样过一遍打码，单条上限 2MB。

`capture` 这一段：清空快照会删掉 `captures/`、`stats.json` 里的记录并清索引，`requests.jsonl` 直接删文件，下一次请求会重建。

## 页面

页面有三个入口：主页面（`page/index.html`）、设置面板（`page/settings.html`）、用量面板（`page/usage.html`）。它跑在 magpie 的沙箱里，那个沙箱 `connect-src 'none'`、没有文件系统，而且只吃普通 `<script>`，不支持 ES module——所以页面代码是 classic script，试压台要用的引擎源模块打成一个 IIFE 才能进浏览器。

两份产物来源不同，这是有意的：

- `page/engines.js`：由 `scripts/gen-page-catalog.mjs` 从 `catalog.js` 与各引擎的 `configSchema` 生成。**提交进仓库**：它小、能逐字节重建，`test/page-catalog.test.mjs` 会在它和真相源不一致时让测试红。改了 `catalog.js` 或某个 `configSchema` 之后跑 `npm run build:catalog`。
- `page/lab-engine.bundle.js`：约 480 KB，**不进仓库**。900 KB 级别的生成代码没法 review，也没法保证和源码对齐。它由 CI 在测试 job（没有写权限、按 `package.json` pin 的 esbuild 精确版本）里构建，再交给发布 job 打包。本地要构建就 `npm install --no-save esbuild@0.25.0` 然后 `npm run build:page`——没有装就直接失败，不去 `npx` 现下。

页面读不到 `stats.json` 和 `captures/`（沙箱没有文件系统，`magpie.options` 是它唯一能读的东西），所以压缩尺旁边只写数字在哪个文件里，会话列表也不再自己长出来。页面每 5 秒读一次 `magpie.options`，有变化就重绘，不需要手动刷新。

## 许可与来源

MIT（`LICENSE`，保留 OmniRoute 的版权行）。每个引擎都是 OmniRoute `open-sse/services/compression` 的移植；来源仓库、对应文件与移植副本的 sha256 在 `PROVENANCE.json`。

经由 OmniRoute 触达、本身是 Apache-2.0 的上游：`headroom`（github.com/headroomlabs-ai/headroom，含 `engines/gcf/` 里的 GCF 列式编解码）与 `gcf-typescript`（github.com/blackwell-systems/gcf-typescript，列式编解码本身的作者，headroom 也是经由它的副本）。两者的许可全文在 `LICENSES/Apache-2.0.txt`，Apache-2.0 §4(d) 要求的署名文本在 `NOTICE`。

## 开发

```bash
node test/run.mjs                 # 全部测试（7 套）
node test/run.mjs lite            # 只跑一套
bun test                          # CI 跑的就是它
```

`catalog.js` 是策略元数据的单一真相源：id、名字、优先级、有损标记、参数 schema 都在那里，`engines/index.js` 把元数据与 `engines/*.js` 的实现合并成 `REGISTRY`。

`test/lite-spec.md` 和 `test/session-dedup-spec.md` 是这两个策略的行为契约，改引擎之前先看。

`cases.json` 是对外契约：23 条用例里，21 条与 magpie-community/plugins 里被合并的 history-trim (#423) 同源，另外 2 条是这一包自己的默认档行为（正在发送的这一轮同样被改写、表格化的工具结果转成 `gcf-generic` 块）。那 21 条里凡是要看截断行为的，都显式 pin 了 `compressToolResults: true`——默认档不再截断之后（见下），用例仍逐字复现 #423 的行为。

**默认档只截断与剥图之外的东西**：lite 默认不改写工具结果的长度（`compressToolResults` 默认 `false`），也不把附件里的图换成 `[image: png]`（`supportsVision` 默认按「模型看得见图」处理）。两件事以前默认开着，代价是长工具输出被腰斩、用户截的图根本没到模型面前；要旧行为就显式打开 `compressToolResults: true` 或写 `supportsVision: false`。它回答一个具体问题——同一份输入经过这个中间件之后，body 是否与那份实现留下的完全一致；不一致就是语义分叉，要么这里改，要么去那边论证。那 21 条显式写成保守模式（`preserveCurrentTurn: true`），因为 history-trim 的语义就是「正在发送的这一轮原样送出」，而这里默认是全量改写。magpie 仓库跑它用 `bun scripts/check.mjs`，这边等价的入口是 `node test/run.mjs gateway`。

## 卸载

```bash
magpie plugin rm compress-core
```
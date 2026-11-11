<div align="center">

<img src="brand/assets/banner.svg" alt="fovea — keep the recent window sharp" width="820"/>

# fovea

**magpie 网关中间件：最近窗口看得清，之前的旧历史只带轮廓。**

[![License: MIT](https://img.shields.io/badge/License-MIT-2f63a2.svg?style=for-the-badge)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.2.6-2f63a2.svg?style=for-the-badge)](https://github.com/webkubor/fovea/releases)
[![Tests](https://img.shields.io/badge/tests-74%2F74-brightgreen?style=for-the-badge)](#证据三层各管什么)
[![Platform](https://img.shields.io/badge/magpie-middleware-8a6bbf?style=for-the-badge)](https://usemagpie.ai)
[![magpie community](https://img.shields.io/badge/magpie%20community-listed-8a6bbf?style=for-the-badge)](https://github.com/magpie-community/plugins/tree/main/packages/fovea)
[![Runtime](https://img.shields.io/badge/runtime-moejs%20%C2%B7%20zero%20deps-4a5568?style=for-the-badge)](fovea.middleware.js)

</div>

<details open>
<summary><b>English TL;DR</b></summary>

A [magpie](https://usemagpie.ai) gateway middleware for coding agents. Old tool output is the bulk of an agent's history and gets re-billed on every request; fovea keeps the recent window byte-for-byte and thins older tool output and long text to head and tail. Message count, order, ids, tool pairing, thinking signatures and encrypted reasoning are never touched.

The catch with trimming history: **trim a little every turn and the prompt cache misses every turn — the bill goes up.** fovea moves its cut boundary in blocks (`cut_step`, default 24 messages), so the trimmed prefix stays byte-identical and the cache keeps hitting.

| Session (shipped defaults) | Request size | Input cost, cache counted | Cache breaks | A trim that slides every turn |
|---|---:|---:|---:|---:|
| Claude Code · Anthropic Messages · 115 turns | −55% | −26% | 9 | +58% cost · 110 breaks |
| Codex · OpenAI Responses · 65 turns | −49% | −14% | 7 | +81% cost · 59 breaks |
| Chat Completions · 65 turns | −61% | −21% | 5 | +90% cost · 57 breaks |

49,032 ids, signatures, thinking blocks, encrypted reasoning items and cache breakpoints compared byte for byte over 248 requests: 0 changed. Cost is modelled from request chars with each vendor's cache multipliers, not a bill; your bill is `magpie usage --csv`.

```sh
magpie plugin add fovea                                 # the reviewed magpie-community package
git clone https://github.com/webkubor/fovea && cd fovea
bun test && bun scripts/metrics.mjs                     # offline, no key: reproduces every number above
```

<p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/fovea-cache-en.png" alt="Cumulative input cost over one Claude Code session: fovea, no middleware, and a trim that slides every turn; request size, cost and cache-break counts on the right" width="820"/></p>

</details>

---

一个会读文件、跑命令的 coding agent，历史很快堆到几十万 token——其中大头是很多轮之前的工具输出。**这些内容每发一次请求都要重新计费一次，而它们是整段历史里寿命最短的部分。** fovea 在网关上把它裁薄：最近窗口原样保留，旧工具输出和长文本只留头尾，几轮前的图换成一行注记。

## 🏆 为什么是 fovea

| | 整段历史重发 | agent 自带 `/compact` | [history-trim](https://github.com/magpie-community/plugins/tree/main/packages/history-trim) | **fovea** |
|---|:---:|:---:|:---:|:---:|
| 旧工具输出留头尾、中间省略 | ❌ | ❌ 交给摘要 | ❌ 只折空白/去重 | ✅ |
| 换话题时不携带旧上下文（saccade） | ❌ | 部分，打断式 | ❌ | ✅ |
| 缓存友好的裁剪边界（cut_step 分块） | — | ❌ 摘要必失配 | ❌ | ✅ |
| 工具调用配对永远完整（三种请求形状） | ✅ | ⚠️ 摘要丢失 | ✅ | ✅ |
| Provider 无关，agent 零改造 | ✅ | ❌ 每个 agent 各自实现 | ✅ | ✅ |
| 自带证据页：前后对照 / 缓存稳定性 / A/B | ❌ | ❌ | ❌ | ✅ |

## 🔥 四件事

- 👁️ **中央凹视觉模型** —— 最近 `keep_recent` 条消息逐字不动；更早的内容像周边视野，只剩轮廓（头+尾+省略标记）。消息条数、顺序、id、工具配对一个不少。
- 📦 **saccade：换话题就不带旧的** —— 最新问题与首条任务几乎无共同词时，旧上下文折叠成一行注记。「继续」这类短跟进不会误触发。
- 🧊 **cut_step：为 prompt cache 而生** —— 裁剪边界只按块移动，块内已裁前缀逐字节稳定，缓存能连续命中；跨块才失效一次（这是对上游评审 §1 的正面回答，有两轮回归测试锁死）。
- 🧾 **state_marker：你的结构化状态取代原始任务消息** —— agent 自己维护的任务/约束/决策 JSON 块永不被裁，同时原始任务原文不再享受豁免，按普通旧内容裁掉。

<p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/fovea-cache-zh.png" alt="同一个 Claude Code 会话的累计输入成本：fovea、不装中间件、每轮滑动裁剪三条曲线，右侧是请求体、成本与缓存打断次数" width="820"/></p>

<sub>图上每个数字都来自 `bun scripts/metrics.mjs`（离线、可复现），见下方「证据三层」。</sub>

## ⚡ 30 秒上手

```sh
magpie plugin add fovea
magpie plugin options fovea '{"state_marker":"<!-- fovea:state -->"}'
```

装的是 [magpie-community](https://github.com/magpie-community/plugins/tree/main/packages/fovea) 里评审后合并的 `@magpie-community/middleware-fovea`，会出现在 magpie 的 Plugins 页，`magpie plugin update` 随版本更新。想跟本仓最新提交，改用 `magpie plugin add github:webkubor/fovea`。

默认 `saccade: "off"`，适合带 prompt cache 的长工具循环（coding agent 的常态）。话题经常切换、又不在乎缓存的对话，可以设成 `"auto"`：换话题时旧上下文整段不带，代价是每次判定为换题都会打断一次缓存前缀。

装完在 magpie 窗口 **Plugins › Fovea evidence** 打开证据页：粘贴你自己的请求 JSON，浏览器里现算前后差异（不联网、不保存正文）。想先看代码再装：

```sh
git clone https://github.com/webkubor/fovea && cd fovea && bun test   # 74/74，无需任何依赖
```

---

## 它怎么工作

`onRequest` 收到请求后：请求小于 `threshold` 原样放行；否则窗口（按条数与 token 预算取宽者）之前的旧消息逐条裁剪。Chat（`role:"tool"`）、Anthropic（`tool_result` 块）、Responses API（`function_call_output`）三种形状各自处理；无法识别的形状原样通过。已经带 `[fovea: …]` 标记的内容不再二次裁剪。失败即放行（fail open）。

| 选项 | 默认 | 含义 |
|---|---|---|
| `threshold` | `96000` | 请求字符数超过才动手（约 24k token；`0` 总是动手） |
| `keep_recent` / `keep_recent_tokens` | `12` / `16000` | 最近窗口，按条数与 token 预算取更宽者；`0` 关闭预算 |
| `cut_step` | `24` | 裁剪边界按块移动，块内前缀逐字稳定；不足一块不动（省缓存），要随裁随减设 `1` |
| `tool_head` / `tool_tail` | `600` / `300` | 旧工具输出保留的头尾 |
| `text_head` / `text_tail` | `1200` / `400` | 旧文本保留的头尾 |
| `drop_old_images` | `true` | 窗口外的旧图换成 `[fovea: old image omitted]` |
| `protect` | `[]` | 命中即整段保全的正则（两种模式都生效），如 `["^diff --git ", "BEGIN .*PRIVATE KEY"]` |
| `saccade` | `"off"` | `off` 留头尾；`auto` 词面判定换话题后折叠旧内容；`always` 总是折叠 |
| `state_marker` | `""` | 你的结构化状态块的标记；带标记的消息永不裁，且任务原文随之可裁 |

裁剪长这样：

```
…600 chars…
[fovea: 48213 chars of old tool output omitted]
…300 chars…
```

## 证据三层，各管什么

1. **规则正确性** —— `bun test`：74 个确定性用例（离线、零依赖）。覆盖三种形状的工具配对、protect 在两种模式下生效、代理对不劈开、document 块不动、标记幂等、连续两轮已裁前缀逐字节相同；另有 Claude Code / Codex / Chat 三种形状的整段会话探针，逐轮断言 id、签名、加密推理和缓存断点不变，缓存前缀按块断开，算上缓存比不装更便宜。`bun scripts/mutate.mjs` 把 26 处契约保护逐一改坏，每一处都必须让测试变红（CI 里跑）。
2. **同一请求确实变小** —— `bun benchmark.mjs [request.json] [options]`，或直接在证据页粘贴你的请求。合成样例：47,777 → 14,148 字符，已裁的 27 条消息逐字稳定。整段会话的量化指标（三种协议的请求体、计入缓存的成本、`cut_step` 扫描）：`bun scripts/metrics.mjs` 写出 [`promo/metrics.json`](promo/metrics.json)，推广图 [`promo/`](promo/) 的每个数字都读自这里。

   <details open>
   <summary><b>▶ 本版实拍：证据页「粘贴复算」全流程（页内直接播放）</b></summary>

   下面这段视频是 0.2.6 这一版真机录的：真页面、真粘贴、真点按钮。粘贴 22 条消息的请求（110,486 字符），页面当场算出 78,239 字符（71%），裁掉 3 条。

   <video src="https://github.com/user-attachments/assets/4d8171f1-4862-45aa-ae68-9b8100b802be" controls width="820"></video>

   （视频加载不出来？[直接打开视频](https://github.com/user-attachments/assets/4d8171f1-4862-45aa-ae68-9b8100b802be)）

   <p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/evidence-page-light.webp" alt="fovea 证据页浅色主题：原始请求 47,777 字符，经过 fovea 14,148 字符，消息带显示旧消息被裁成头尾、最近窗口逐字保留" width="820"/></p>

   <p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/evidence-page-dark.webp" alt="fovea 证据页深色主题：同一组对照数字，深色下霓虹 F 图标与紫色最近窗口清晰可见" width="820"/></p>

   </details>

3. **真实 token / 缓存 / 费用** —— `FOVEA_GATEWAY_KEY=<临时key> bun live-benchmark.mjs`：同模型、同请求、ABBA 四连发，记录供应商返回的 input / cache_read / output token 与耗时，只看暖缓存的第二次。0.1.0 时代的一次实测：163,143 → 42,358 prompt tokens，中位延迟 7.1s → 2.5s（因历史形状与供应商缓存而异）。**账单以 `magpie usage --csv` 的 `cost_usd` 为准；字符百分比不是美元。**

<p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/fovea-knob-zh.png" alt="cut_step 从 1 到 96 的扫描：输入成本与平均请求体随步长的变化，默认值 24 高亮；右侧是三种协议在默认参数下的结果" width="820"/></p>

## 结构化状态优于压缩

最便宜的历史是根本不用发的历史。`state_marker` 是两边之间的契约：状态块永不被裁，任务原文不再豁免。[`state-block.example.json`](state-block.example.json) 给了固定维度的形状（目标/验收/约束/决策/带出处的事实/未决问题）。两条让它便宜的规则：

- **分两层**：少变的字段（目标、约束、决策）进块、放请求前部；每轮变的（当前步、最近命令结果）放最后一条消息——每轮重写整个块会把它之后的缓存全部打掉。
- **每条事实带出处**：替换能去掉旧值，但去不掉错值——新不等于对。带出处的错能被便宜地重读发现。

## 什么时候不该用

窗口按条数+预算共同划定，最近窗口里的巨型消息仍然原样保留。裁剪是机械的：它不知道哪条旧细节重要，只知道头尾在哪——如果 agent 的工作依赖逐字重读旧输出，调大 `tool_head`/`tool_tail` 或暂时关掉。`saccade: auto` 是词面判定不是语义理解：改述会被误判、同词异题会漏判，长缓存循环建议 `off`。放在 system/developer 或最近窗口里的压缩摘要不归 fovea 管——那要在生成请求之前决定。缩短历史是否影响答案质量，请在你自己的负载上以开/关对照验证。

## 发布物

- [CHANGELOG.md](CHANGELOG.md) · [LICENSE](LICENSE)（MIT）· [brand/](brand/)（logo 双色 / banner / 品牌审查页）
- 品牌色 `#2f63a2` 取自「中央凹」隐喻的焦点色；墨色采样自 magpie 既有图标，属实测非官方色板。
- 致谢：yetone 对早期 context-slim 草稿的评审直接塑造了缓存边界、document、代理对等设计。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

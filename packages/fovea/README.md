<div align="center">

<img src="https://raw.githubusercontent.com/webkubor/fovea/main/brand/assets/banner.svg" alt="fovea — keep the recent window sharp" width="820"/>

# @magpie-community/middleware-fovea

**magpie 网关中间件：最近窗口看得清，之前的旧历史只带轮廓。**

[![License: MIT](https://img.shields.io/badge/License-MIT-2f63a2.svg?style=for-the-badge)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-57%2F57-brightgreen?style=for-the-badge)](#证据三层各管什么)
[![Platform](https://img.shields.io/badge/magpie-middleware-8a6bbf?style=for-the-badge)](https://usemagpie.ai)
[![Runtime](https://img.shields.io/badge/runtime-moejs%20%C2%B7%20zero%20deps-4a5568?style=for-the-badge)](fovea.middleware.js)

</div>

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

## ⚡ 30 秒上手

```sh
magpie plugin add @magpie-community/middleware-fovea
magpie plugin options fovea '{"state_marker":"<!-- fovea:state -->"}'
```

默认 `saccade: "off"`，适合带 prompt cache 的长工具循环（coding agent 的常态）。话题经常切换、又不在乎缓存的对话，可以设成 `"auto"`：换话题时旧上下文整段不带，代价是每次判定为换题都会打断一次缓存前缀。

装完在 magpie 窗口 **Plugins › Fovea evidence** 打开证据页：粘贴你自己的请求 JSON，浏览器里现算前后差异（不联网、不保存正文）。想先看代码再装：

```sh
git clone https://github.com/magpie-community/plugins && bun test packages/fovea   # 31/31
```

---

## 它怎么工作

`onRequest` 收到请求后：请求小于 `threshold` 原样放行；否则窗口（按条数与 token 预算取宽者）之前的旧消息逐条裁剪。Chat（`role:"tool"`）、Anthropic（`tool_result` 块）、Responses API（`function_call_output`）三种形状各自处理；无法识别的形状原样通过。已裁内容短于长度闸门（`head + tail + 80`），不会二次裁剪；正文里出现 `[fovea:` 字样不构成豁免。失败即放行（fail open）。

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
| `state_marker` | `""` | 你的结构化状态块的标记；只认 assistant 消息里以它开头的文本，这样的消息永不裁，且任务原文随之可裁。用户文本、工具结果里出现同样字样不算 |

裁剪长这样：

```
…600 chars…
[fovea: 48213 chars of old tool output omitted]
…300 chars…
```

## 证据三层，各管什么

1. **规则正确性** —— `bun test`：57 个确定性用例（离线、零依赖）。覆盖三种形状的工具配对、protect 在两种模式下生效、代理对不劈开、document 块不动、标记幂等、连续两轮已裁前缀逐字节相同。
2. **同一请求确实变小** —— `bun benchmark.mjs [request.json] [options]`，或直接在证据页粘贴你的请求。合成样例：47,777 → 14,148 字符，已裁的 27 条消息逐字稳定。
3. **真实 token / 缓存 / 费用** —— `FOVEA_GATEWAY_KEY=<临时key> bun live-benchmark.mjs`：同模型、同请求、ABBA 四连发，记录供应商返回的 input / cache_read / output token 与耗时，只看暖缓存的第二次。0.1.0 时代的一次实测：163,143 → 42,358 prompt tokens，中位延迟 7.1s → 2.5s（因历史形状与供应商缓存而异）。**账单以 `magpie usage --csv` 的 `cost_usd` 为准；字符百分比不是美元。**

## 结构化状态优于压缩

最便宜的历史是根本不用发的历史。`state_marker` 是两边之间的契约：状态块永不被裁，任务原文不再豁免。[`state-block.example.json`](state-block.example.json) 给了固定维度的形状（目标/验收/约束/决策/带出处的事实/未决问题）。两条让它便宜的规则：

- **分两层**：少变的字段（目标、约束、决策）进块、放请求前部；每轮变的（当前步、最近命令结果）放最后一条消息——每轮重写整个块会把它之后的缓存全部打掉。
- **每条事实带出处**：替换能去掉旧值，但去不掉错值——新不等于对。带出处的错能被便宜地重读发现。

## 什么时候不该用

窗口按条数+预算共同划定，最近窗口里的巨型消息仍然原样保留。裁剪是机械的：它不知道哪条旧细节重要，只知道头尾在哪——如果 agent 的工作依赖逐字重读旧输出，调大 `tool_head`/`tool_tail` 或暂时关掉。`saccade: auto` 是词面判定不是语义理解：改述会被误判、同词异题会漏判，长缓存循环建议 `off`。放在 system/developer 或最近窗口里的压缩摘要不归 fovea 管——那要在生成请求之前决定。缩短历史是否影响答案质量，请在你自己的负载上以开/关对照验证。

## 发布物

- [CHANGELOG.md](CHANGELOG.md) · [LICENSE](LICENSE)（MIT）· banner 与品牌资产在[独立开发仓](https://github.com/webkubor/fovea/tree/main/brand)，包内只带页面图标
- 致谢：yetone 对早期草稿与本次 PR 的评审直接塑造了缓存边界、document、代理对、cache_control 与前导任务保护

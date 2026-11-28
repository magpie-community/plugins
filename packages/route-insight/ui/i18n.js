// 双语文案表。键是中文原文，值是英文；查不到就退回中文，所以可以一屏一屏地补。
// 为什么用中文当键：代码里读起来还是人话，改文案只改一处，grep 得到。
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var raw = String(params.get("lang") || document.documentElement.getAttribute("lang") || "zh").toLowerCase();
  var LANG = raw.indexOf("zh") === 0 || raw.indexOf("cn") === 0 ? "zh" : "en";

  var EN = {
    /* ---------- 顶栏与筛选 ---------- */
    "路由洞察": "Route insight",
    "读取 usage.jsonl…": "Reading usage.jsonl…",
    "暂停": "Pause",
    "继续": "Resume",
    "刷新": "Refresh",
    "看板": "Board",
    "供应商状态": "Providers",
    "指纹": "Fingerprint",
    "清空": "Clear",
    "收起指标": "Hide KPIs",
    "展开指标": "Show KPIs",
    "收起": "Collapse",
    "展开": "Expand",
    "点击收起/展开这张卡片": "Collapse or expand this card",
    "点击收起/展开检测历史": "Collapse or expand the history",
    "搜索 供应商 / 模型 / Agent / 停止原因 / 规则": "Search provider / model / agent / stop reason / rule",
    "搜索 供应商 / 模型 / Agent / 停止原因": "Search provider / model / agent / stop reason",
    "1 小时": "1 hour",
    "6 小时": "6 hours",
    "今天": "Today",
    "24 小时": "24 hours",
    "7 天": "7 days",
    "全部": "All",
    "失败": "Failed",
    "成功": "OK",
    "重试": "Retried",
    "运行中": "Running",
    "已停止": "Stopped",
    "停止": "Stop",
    "缓存": "Cache",

    /* ---------- KPI ---------- */
    "⇄ 请求 / 尝试": "⇄ Requests / attempts",
    "✓ 成功率": "✓ Success rate",
    "⚡ 首字 P50": "⚡ TTFT P50",
    "⚡ 首字 P90": "⚡ TTFT P90",
    "⏱ 总时长 P90": "⏱ Total time P90",
    " 缓存命中": " Cache hit",
    "⇅ 入 → 出": "⇅ In → out",
    "◎ 积分合计": "◎ Credits total",
    " 次 · 重试 ": " calls · retried ",
    "失败 ": "failed ",
    "均 ": "avg ",
    " · 慢 ": " · max ",
    "思考 ": "think ",
    "读 ": "read ",
    " · 写 ": " · write ",
    " tok/s · 推理 ": " tok/s · reasoning ",
    "余额 ": "balance ",
    " 次 · 额度 ": " calls · quota ",
    " 次": " calls",
    "次": "calls",

    /* ---------- 图表 ---------- */
    "⇄ 请求 ": "⇄ Requests ",
    "⚠ 失败 ": "⚠ Failed ",
    "⚡ 首字均值 ": "⚡ TTFT avg ",
    "⇢ 输出 tokens ": "⇢ Output tokens ",

    /* ---------- 请求明细 ---------- */
    "请求明细": "Requests",
    "时间": "Time",
    "供应商": "Provider",
    "模型": "Model",
    "强度": "Effort",
    "状态": "Status",
    "⇅ tokens": "⇅ tokens",
    "⚡ 首字": "⚡ TTFT",
    "⚡ tok/s": "⚡ tok/s",
    "⏱ 总时": "⏱ Total",
    "◎ 计费": "◎ Billing",
    "网关有记录就是官方 effort 档位（实线）；没记录就按本窗口思考 token 的分位派生 低/中/高/极高（虚线，后缀是思考 token 数）": "Solid = the effort level the gateway logged. Dashed = derived from thinking tokens in this window (suffix shows the token count).",
    "下行输入 ↑ 上行输出 / 缓存读取（命中率）": "↓ input ↑ output / cache reads (hit rate)",
    "首字耗时": "Time to first token",
    "输出速度（≥60 绿 / 25–60 黄 / <25 红）": "Output speed (≥60 green / 25–60 amber / <25 red)",
    "总耗时（≤8s 绿 / 8–22s 黄 / >22s 红）": "Total time (≤8s green / 8–22s amber / >22s red)",

    /* ---------- 折叠与供应商卡片 ---------- */
    "展开": "Show",
    "展开指标": "Show KPIs",
    "点击展开这张卡片": "Click to show this card",
    "点击收起这张卡片": "Click to hide this card",
    "已停用": "Disabled",
    "没流量": "No traffic",
    "错误": "Failing",
    "告警": "Degraded",
    "正常": "Healthy",
    "刚刚": "just now",
    " 分钟前": " min ago",
    " 小时前": " h ago",
    " 天前": " d ago",
    "（近 7 天没跑过）": "(not used in 7 days)",
    "本地/未填地址": "local / no endpoint",
    "首字 P50 ": "TTFT P50 ",
    "上次成功": "Last success",
    "可用性 · 7 天": "Availability · 7 days",
    "近 ": "Last ",
    " 次 · 失败 ": " calls · failed ",
    "均速 ": "Avg speed ",
    "积分 ": "Credits ",
    "主要模型 ": "Top models ",
    "读取供应商失败：": "Cannot read providers: ",
    "近 7 天没有任何请求，先发几条消息再看": "No requests in the last 7 days. Send a few messages first.",
    "近 7 天 · ": "Last 7 days · ",
    " 家在用 / 共 ": " in use / ",
    " 家": " total",

    /* ---------- 检测项 ---------- */
    "6 次「数 300 个随机数」（两回合）→ 参考库落到具体型号":
      "6× 「300 random numbers」(two rounds) → the reference bank names the exact model",
    "7 次协议探针：回声 / usage / 函数调用 / JSON / 流式":
      "7 protocol probes: echo / usage / tool calls / JSON / streaming",
    "完整 HTML：会动的鹈鹕骑车（提示词可改）":
      "Full HTML: an animated pelican on a bicycle (prompt is editable)",
    "计费方式": "How it was billed",
    "入": "in",
    "出": "out",
    "缓存读": "cache",
    "—": "—",

    /* ---------- 分组统计 ---------- */
    "分组统计": "Grouped",
    "名称": "Name",
    "次数": "Calls",
    "命中": "Hit",
    "积分": "Credits",
    "推理强度": "Reasoning effort",
    "Agent": "Agent",
    "分组": "Group",
    "没有数据": "No data",
    "额度": "Quota",
    "余额": "Balance",

    /* ---------- 计费与额度 ---------- */
    "计费与额度": "Billing and quota",
    "余额（$）": "Balance ($)",
    "供应商按余额扣费，余额来自它们自己的接口": "Charged against the provider's own balance, read from its own API",
    "额度（窗口）": "Quota (window)",
    "订阅额度，按窗口剩余": "Subscription quota, remaining per window",
    "积分（credits）": "Credits",
    "没有余额或额度的供应商，按网关积分算": "Providers with neither balance nor quota, billed in gateway credits",
    "近窗口没有这类请求": "No such requests in this window",
    "近窗口无请求": "No requests in this window",
    " 把 key": " keys",
    " 前读取": " ago",
    "快照 ": "Snapshot ",
    " 行日志 · 读于 ": " log lines · read at ",
    " · 路由 ": " · routing ",
    "更新于 ": "Updated ",
    "读取供应商…": "Reading providers…",

    /* ---------- 检测页 ---------- */
    "指纹与智商检测": "Fingerprint and IQ checks",
    "选一个模型，勾上要跑的项就能一起测；每项各花各的请求": "Pick a model, tick the checks to run them together; each one spends its own requests",
    "选一个模型，勾上要跑的项就能一起测": "Pick a model, tick the checks to run them together",
    "开始检测": "Run checks",
    "检测中…": "Running…",
    "读取模型…": "Reading models…",
    "搜索模型或供应商": "Search model or provider",
    "↑↓ 选 · ↵ 定 · Esc 关": "↑↓ pick · ↵ choose · Esc close",
    "文本强度": "Text effort",
    "画图强度": "Drawing effort",
    "数值指纹和协议审计都用这一档": "Used by both the numeric fingerprint and the protocol audit",
    "画图提示词": "Drawing prompt",
    "恢复默认": "Reset",
    "留空就用默认那句": "Leave empty to use the default prompt",
    "还没有检测结果": "No results yet",
    "检测历史": "History",
    "还没有记录": "No records yet",
    "怎么读这张卡": "How to read this card",
    "数值指纹": "Numeric fingerprint",
    "协议审计": "Protocol audit",
    "HTML 动画": "HTML animation",
    "参考库未下载 · ": "Reference data not downloaded · ",
    "参考库版本不符 · ": "Reference data version mismatch · ",
    "重新下载": "Download again",
    "下载 ": "Download ",
    "数值指纹参考库：检查中…": "Reference bank: checking…",
    "参考库状态读不到": "Cannot read reference bank status",
    "正在下载参考库…": "Downloading reference bank…",
    "参考库版本不符，需重下": "Reference bank version mismatch, needs a re-download",
    "下载失败：": "Download failed: ",
    "预计 ": "About ",
    " 次请求 · 是否扣积分看结果卡": " requests · the result card says whether it was billed",
    "一次最多 ": "up to ",
    " 次请求": " requests per run",
    "今日已花 ": "spent today ",
    " / ": " / ",
    " 积分": " credits",
    "支持 ": "supports ",
    "没声明强度档，只能走默认": "declares no effort levels, only the default",
    "默认档": "Default",
    "取不到这个型号的强度档": "This model declares no effort levels",

    /* ---------- 通用 ---------- */
    "请求": "Requests",
    "重试次数": "Retries",
    "读取日志失败": "Cannot read the log",
    "正在读取…": "Reading…",
    "页面已过期（插件重启过），关掉这一页重新打开就好。": "This page is out of date (the plugin restarted). Close it and open it again.",

    /* ---------- 单位与强度档 ---------- */
    "无": "None",
    "极低": "Minimal",
    "低": "Low",
    "中": "Medium",
    "高": "High",
    "很高": "Very high",
    "最大": "Max",
    "极高": "Ultra",
    "思考": "think",
    "无思考": "No thinking",
    "首字": "TTFT",
    "首字 ": "TTFT ",
    "首字 P50": "TTFT P50",
    "缓存命中率": "Cache hit rate",
    "输出速度": "Output speed",
    "积分合计": "Credits total",
    " 缓存读取 ": " cache reads ",
    "没有匹配项": "No matches",
    "搜索…": "Search…",
    "全选": "All",
    "网关记录的推理强度：": "Effort level logged by the gateway: ",
    "网关没记 effort，这里按思考 token 的排名派生：{n} tokens（本窗口 P50 {p50} / P75 {p75} / P90 {p90}）→ 低 < 中 < 高 < 极高，是相对值不是官方档位":
      "No effort logged; derived from this window's thinking-token rank: {n} tokens (P50 {p50} / P75 {p75} / P90 {p90}) → low < medium < high < ultra. Relative, not an official level.",
    "网关没记 effort，本次请求也没有思考 token": "No effort logged, and this request spent no thinking tokens",
    "输出速度（≥60 绿 / 25–60 黄 / <25 红）": "Output speed (≥60 green / 25–60 amber / <25 red)",
    "总耗时（≤8s 绿 / 8–22s 黄 / >22s 红）": "Total time (≤8s green / 8–22s amber / >22s red)",
    /* ---------- 怎么读这张卡（长文，允许 HTML） ---------- */
    "help:p1": "<b>Numeric fingerprint</b>: the model answers six times with “300 random numbers (1–355)”, in two rounds of three (probabilities merged per model). The digit statistics are compared against the <a href=\"https://github.com/Ikaleio/lm-detector\" target=\"_blank\" rel=\"noreferrer\">lm-detector</a> reference bank and land on an <b>exact model</b> with a probability; it also reports the gap to the runner-up — the wider the gap, the more the result deserves trust. <b>What it cannot see</b>: how the model names itself, or what its system prompt says — neither changes how it counts. The reference bank is about 3.6 MB and is downloaded once (afterwards it is cached locally).",
    "help:p2": "<b>Protocol audit</b> (checks follow <a href=\"https://github.com/canarybyte/veridrop\" target=\"_blank\" rel=\"noreferrer\">Veridrop</a>, reimplemented in JS from its published method): seven probes test whether this route <b>actually speaks the OpenAI protocol</b> — the same prompt three times to see if <code>model</code> and <code>completion_tokens</code> stay stable, whether <code>usage</code> carries Anthropic accounting fields, a forced <code>tool_choice</code> to inspect <code>tool_calls</code> id prefixes and enums, whether strict <code>json_schema</code> is honoured, and whether streaming and non-streaming hit the same backend. <b>The model cannot fake these</b>; only a real backend swap changes them. The score is a weighted sum of these details, not a probability.",
    "help:p3": "<b>HTML animation</b>: it asks for a complete HTML document starting at <code>&lt;!DOCTYPE&gt;</code>, drawing an animated pelican riding a bike with CSS keyframes; scripts and external links are stripped out, then the page really runs inside an iframe. <b>You can edit the prompt</b> — leave it empty to use the default sentence. The output is scaled to fit the viewport, with no scrollbars.",
    "help:p4": "Candidate ranking is normalised across the candidates only: it is a score, not statistical confidence, and models outside the bank can still come out close to a listed one.",
    "help:p5": "A test spends real credits, so check “about N requests” in the top right first. Only the latest six full results are kept; click a history row to reopen one.",

    "↑↓ 选 · ↵ 定 · Esc 关": "↑↓ select · ↵ confirm · Esc close",
    "数值指纹和协议审计都用这一档": "Used by both the numeric fingerprint and the protocol audit",

    /* ---------- 服务端回来的分析文案（lib/*.mjs 生成） ---------- */
    "协议规范":
      "Conforms",
    "有疑点":
      "Suspicious",
    "明显不像官方接口":
      "Not an official endpoint",
    /* 0.15.1 起结论只描述「与 OpenAI 格式的接近程度」，不再下篡改判断 */
    "符合 OpenAI 格式":
      "Matches the OpenAI format",
    "与 OpenAI 格式有出入":
      "Differs slightly from the OpenAI format",
    "与 OpenAI 格式差别较大":
      "Differs substantially from the OpenAI format",
    "干净":
      "Clean",
    "在":
      "present",
    "缺":
      "missing",
    "缺 id":
      "no id",
    "缺（OpenAI 协议必有）":
      "missing (mandatory under the OpenAI protocol)",
    "等式成立":
      "holds",
    "对不上":
      "does not match",
    "字段不全，算不了":
      "fields incomplete, cannot check",
    "一致":
      "identical",
    "不一致":
      "different",
    "带":
      "yes",
    "没带":
      "no",
    "是":
      "yes",
    "空":
      "empty",
    "空回答":
      "empty reply",
    "是代码块，不是纯 JSON":
      "a code fence, not bare JSON",
    "稳定":
      "stable",
    "轻微抖动":
      "slight jitter",
    "抖得反常":
      "abnormal jitter",
    "未记录":
      "not recorded",
    "无 usage":
      "no usage",
    "全失败":
      "all failed",
    "无":
      "none",
    "有（思考另算）":
      "yes (reasoning billed separately)",
    "没有（不代表假，很多网关不细分）":
      "no (not proof of forgery; many gateways do not break it out)",
    "只有 input_tokens / output_tokens：这是 Anthropic 的形状":
      "only input_tokens / output_tokens: that is the Anthropic shape",
    "usage 里出现了 claude / anthropic 字样":
      "usage mentions claude / anthropic",
    "整批响应都没有 usage（几乎只有伪造接口才会这样）":
      "no usage in the whole batch (almost only fake endpoints do this)",
    "强制 tool_choice 之后仍然只回文字、没有 tool_calls：这条链路并不真的支持函数调用。":
      "Even with a forced tool_choice it returned text and no tool_calls: this route does not really support function calling.",
    "流式响应里没有 usage（即使带了 stream_options.include_usage）：多是中间层自己拼的 SSE，而不是官方实现。":
      "The streaming response carries no usage (even with stream_options.include_usage): usually a middle layer assembling SSE itself, not an official implementation.",
    "检测维度参考 Veridrop（AGPL-3.0）的公开方法，用 JS 重写：回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性。分数是这些协议细节的加权，不是概率。":
      "Checks follow the published method of Veridrop (AGPL-3.0), reimplemented in JS: echo consistency / usage accounting / tool calls / structured output / streaming consistency. The score is a weighted sum of these protocol details, not a probability.",
    "不像模型回答":
      "not a model answer",
    "样本不够":
      "not enough samples",
    "未知":
      "unknown",
    "样本全是空的，这次没得分":
      "every sample came back empty; no score this time",
    "回答不像模型在数数":
      "the reply does not look like a model counting",
    "样本不够判不了":
      "not enough samples to decide",
    "参考库校验失败":
      "reference bank failed validation",
    "为什么没交回 HTML":
      "Why no HTML came back",
    "额度被思考吃光":
      "budget spent on reasoning",
    "等太久被中断":
      "interrupted for taking too long",
    "回答里没有 HTML":
      "the reply contains no HTML",
    "HTML 动画最吃时间：换一条快的线，或把画图强度调低":
      "HTML animation is the slowest item: use a faster route, or lower the drawing effort",
    "是否完整 HTML":
      "Complete HTML",
    "回答写完了没":
      "Reply finished",
    "画面空不空":
      "Is there a picture",
    "有没有动起来":
      "Does it move",
    "颜色":
      "Colours",
    "耗时":
      "Elapsed",
    "写完了":
      "finished",
    "一处动画都没有":
      "no animation at all",
    "要的是会动的画面，静态图等于没做":
      "an animated picture was requested; a still image does not count",
    "图元偏少，画面会比较素":
      "few elements, so the picture is sparse",
    "几乎没画东西：要么它偷懒，要么这一趟断了（先看上一行）":
      "almost nothing drawn: either it was lazy or this run was cut off (see the row above)",
    "分层细，通常是强模型的画法":
      "finely layered, typical of a strong model",
    "格式":
      "Format",
    "带了代码块围栏":
      "wrapped in a code fence",
    "要求只输出 SVG":
      "it was told to output SVG only",
    "未声明":
      "not declared",
    "要求 0 0 400 400":
      "0 0 400 400 was requested",
    "靠文字解释画面，通常画得敷衍":
      "explains the picture in words, usually a lazy drawing",
    "整份文档收到了，下面的图元/动画数字才是它的真实水平":
      "the whole document arrived; the element/animation numbers below reflect its real level",
    "断掉的那份只显示出前半截（常见的就是只有天空、只有一个车轮），这种不能算它画得差，重测一次或者换条线":
      "a cut-off document only shows its first half (often just sky, or a single wheel); that does not mean it draws badly — re-run it or switch route",
    "两趟都没写出正文：模型把输出额度全花在思考上了（网关原话 the whole output spent on reasoning）。把「画图强度」调低，或者换一条不那么爱思考的线再试。":
      "Both passes produced no body text: the model spent its whole output budget on reasoning (gateway wording: the whole output spent on reasoning). Lower the drawing effort, or pick a route that thinks less.",
    "收了完整文档但这些细节还是没对上":
      "the document arrived but these details still do not line up",

    /* ---------- 检测页细项（0.15.0 补） ---------- */
    " · 检测中": " · testing",
    " · 清单取自 {at}": " · catalog from {at}",
    " · 这项最慢，最长等 {n} 秒": " · slowest item, waits up to {n}s",
    " 个型号": " models",
    " 个图元": " elements",
    " 种颜色": " colours",
    " 处 · 关键帧 ": " anims · keyframes ",
    " 支持 ": " supports ",
    " 是同一型号，只是名字落到了另一条线路": " is the same model under a different route name",
    " 没声明强度档，只能走默认": " declares no effort levels, default only",
    "3 个样本": "3 samples",
    "6 个样本（两回合）": "6 samples (two rounds)",
    "6 次「数数」挑战（两回合） · 看数字串的统计纹理，不看它怎么自称": "6 counting challenges (two rounds) · reads the statistics of the digit strings, not what it claims to be",
    "CSS 关键帧 + SVG · 脚本和外部资源已剥掉": "CSS keyframes + SVG · scripts and external assets stripped",
    "usage 字段：": "usage fields: ",
    "{n} 个供应商": "{n} providers",
    "{n} 次 · {tail}": "{n} calls · {tail}",
    "{x} 积分": "{x} credits",
    "。": ".",
    "。接口本身像真的，但这次没测出模型身份。": ". The endpoint looks real, but this run could not establish model identity.",
    "一个都没给": "none at all",
    "一键画鹈鹕": "Run the pelican test",
    "上面是它画出来的鹈鹕，下面是它对不上号的指纹": "Top: the pelican it drew. Bottom: the fingerprint that does not match.",
    "下载 {size} MB": "Download {size} MB",
    "与第二名差 {n} 个百分点": "{n} points ahead of the runner-up",
    "与请求的 ": "against the requested ",
    "与请求的型号一致": "matches the requested model",
    "两条证据一致": "Both lines of evidence agree",
    "候选排名 · 具体型号": "Candidates · exact model",
    "先选一个模型": "Pick a model first",
    "免费": "free",
    "入算": " counted",
    "其他": "Other",
    "出图": "drew",
    "动画": "animation",
    "动起来": "Animated",
    " · 从 {host} 取（固定版本，下完校验 sha256）":
      " · fetched from {host} (pinned version, sha256 verified)",
    "协议审计 {score}/100（{label}）": "Protocol audit {score}/100 ({label})",
    "协议审计 {score}/100：回声、usage 记账、函数调用、结构化输出、流式一致性": "Protocol audit {score}/100: echo, usage accounting, tool calls, structured output, streaming consistency",
    "原始回答": "Raw reply",
    "参考库 ": "Reference ",
    "参考库 {date} · {size} MB": "Reference {date} · {size} MB",
    "参考库排名 · 具体型号": "Reference ranking · exact model",
    "参考库没读到（网关 /v1/models 不通），只能按家族粗略排": "Reference bank unavailable (gateway /v1/models unreachable); ranking by family only",
    "参考库：网关清单里 {c} 个具体型号 · {p} 个供应商 · 归到 {f} 个家族": "Reference: {c} exact models in the gateway catalog · {p} providers · {f} families",
    "只有协议层证据": "Protocol-level evidence only",
    "只重测这一项": "Re-run this item only",
    "合计 ": "Total ",
    "回合": "Round",
    "回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性 · 7 次探针": "Echo consistency / usage accounting / tool calls / structured output / streaming consistency · 7 probes",
    "回答被截断了（finish_reason={why}），只画了前半截，不算数": "Reply was cut off (finish_reason={why}); only the first half was drawn, so it does not count",
    "图元": "Elements",
    "失败 {n} 次": "{n} failed",
    "完整度": "Size",
    "审计 ": "Audit ",
    "对不上": "Mismatch",
    "已渲染": "Rendered",
    "指纹信息": "Fingerprint",
    "按余额计费": "billed from balance",
    "收下": "used",
    "放大": "Enlarge",
    "数值指纹不够确定": "Numeric fingerprint inconclusive",
    "数值没得分": "No numeric score",
    "数数纹理像 ": "count statistics lean ",
    "断掉的那份只供排查": "the trimmed copy is for debugging only",
    "新版本已就绪，正在刷新…": "New version ready, reloading…",
    "新窗口": "New window",
    "显示最近 {n} 条 / 匹配 {m} 次尝试": "Showing the latest {n} rows / {m} attempts matched",
    "智商检测": "IQ test",
    "最近 {n} 次 · 花不花积分看最后一列": "Latest {n} runs · the last column says whether it was billed",
    "服务没有响应：": "No response from the service: ",
    "未知错误": "Unknown error",
    "本次 {n} 次请求": "{n} requests this run",
    "本次检测": "this run",
    "检测": "Test",
    "检测失败": "Test failed",
    "概率": "Probability",
    "模型交回来的 HTML 动画": "HTML animation returned by the model",
    "模型画出来的鹈鹕": "The pelican the model drew",
    "正在请求网关": "Asking the gateway",
    "没出图": "no image",
    "没动画": "no animation",
    "没拿到": "not received",
    "没拿到完整 HTML": "no complete HTML",
    "没有匹配的模型": "No matching models",
    "没有可用模型": "No models available",
    "没有拿到 <svg>：": "No <svg> received: ",
    "没有结果": "No results",
    "没用": "dropped",
    "点开看这次的完整结果": "Click to see this run's full result",
    "用时": "Time",
    "画没画完": "incomplete",
    "留空 = 用默认提示词": "Leave empty to use the default prompt",
    "看断口": "See where it broke",
    "结果": "Result",
    "网关分组": "Gateway groups",
    "耗时": "Elapsed",
    "自定义 · {n} 字": "Custom · {n} chars",
    "自定义提示词": "Custom prompt",
    "自述型指纹（不做数，只看路由）": "Self-reported fingerprint (indicative only, routing hint)",
    "至少选一项": "Pick at least one",
    "至少选一项检测": "Pick at least one test",
    "花费 {x} 积分": "{x} credits spent",
    "要的数": "Asked",
    "解析到": "Parsed",
    "计入额度窗口，不扣积分": "counts against the quota window, spends no credits",
    "请求 ": "Request ",
    "请求 {asked} → 实际 {served}": "Requested {asked} → served {served}",
    "请求失败：": "Request failed: ",
    "请求的是 ": "Requested ",
    "请求的是 {want}，数值指纹认出的是 {got}（{p}）——这条路由大概率不是你要的型号": "You asked for {want}; the numeric fingerprint says {got} ({p}) — this route is probably not the model you picked",
    "读取失败：": "Read failed: ",
    "超时": "Timed out",
    "路由": "Route",
    "身份对不上": "Identity mismatch",
    "身份对得上，链路有疑点": "Identity matches, the route looks off",
    "输出速度 {v}（≥60 绿 / 25–60 黄 / <25 红）": "Output speed {v} (≥60 green / 25–60 amber / <25 red)",
    "还原": "Shrink",
    "还没有检测记录": "No test history yet",
    "这一批没发现疑点。": "Nothing suspicious in this batch.",
    "这个筛选组合下没有请求": "No requests match these filters",
    "这份没画完": "This one was cut off",
    "这条路由大概率不是你在页面上选的那个型号": "This route is probably not the model you picked on the page",
    "这次没扣积分": "no credits spent this time",
    "这次用的提示词": "The prompt used this time",
    "这次用的是你写的提示词": "This run used your own prompt",
    "这次的结果没留在本地（只保留最近 6 次）": "This result was not kept locally (only the latest 6 are)",
    "选一个模型…": "Pick a model…",
    "重测失败": "Re-test failed",
    "重测失败：": "Re-test failed: ",
    "重试过一次": "retried once",
    "重连中… ": "reconnecting… ",
    "颜色": "Colours",
    "默认 · 留空就用这句": "Default · leave empty to use this",
    "，{n} 处疑点见下面的清单。这次没测出模型身份。": ", {n} findings below. Model identity could not be established.",
    "，但概率只有 ": ", but only ",
    "，别当定论": ", do not treat it as settled",
    "，数数更像 ": ", the count statistics look more like ",
    "，数数纹理却更像 ": ", yet the count statistics look like ",
    "；": "; "
  };

  // 带变量的长句：正则抓出变量再拼英文。第二参数 L 是递归用的本地化函数，
  // 因为有些句子的片段自己也带中文（例如「可见输出 tokens … （CV 6%，稳定）」）。
  function splitSeg(text, L) {
    return String(text)
      .split(" · ")
      .map(function (part) {
        return L(part);
      })
      .join(" · ");
  }

  var RULES = [
    {
      re: /^有排名（(\d+) 回合合并）$/,
      en: function (m) {
        return "ranked (" + m[1] + " rounds merged)";
      }
    },
    {
      re: /^等了 (\d+) 秒还没返回完，请求已被中断（不是报错，是这一趟太长没跑完）$/,
      en: function (m) {
        return (
          "Waited " +
          m[1] +
          "s and the answer never finished, so the request was interrupted (not an error — this run simply took too long)."
        );
      }
    },
    {
      re: /^这次检测的请求次数到上限了（最多 (\d+) 次），后面的没再发出去$/,
      en: function (m) {
        return (
          "This run hit its request ceiling (" +
          m[1] +
          " at most), so the remaining requests were never sent."
        );
      }
    },
    {
      re: /^同题三次（temperature 0）：(.*)$/,
      en: function (m, L) {
        return "Same prompt, three times (temperature 0): " + splitSeg(m[1], L);
      }
    },
    {
      re: /^(\d)\/3 有回包$/,
      en: function (m) {
        return m[1] + "/3 replied";
      }
    },
    {
      re: /^model 字段 (.*)$/,
      en: function (m) {
        return "model field " + m[1];
      }
    },
    {
      re: /^可见输出 tokens (.*?)（CV (\d+)%，(.*)）$/,
      en: function (m, L) {
        return "visible output tokens " + m[1] + " (CV " + m[2] + "%, " + L(m[3]) + ")";
      }
    },
    {
      re: /^有 (\d+) 次正文是空的（预算烧在思考上，这一项只能算参考）$/,
      en: function (m) {
        return m[1] + " replied with an empty body (budget burned on reasoning; treat this item as indicative only)";
      }
    },
    {
      re: /^收到的 usage 字段：(.*)$/,
      en: function (m) {
        return "usage fields received: " + m[1].split("、").join(", ");
      }
    },
    {
      re: /^tools \+ 强制 tool_choice，检查 (\d+) 项协议细节里的 (\d+) 项$/,
      en: function (m) {
        return "tools + forced tool_choice; " + m[2] + " of " + m[1] + " protocol details checked";
      }
    },
    {
      re: /^response_format=json_schema\(strict\)，要求 ok=true 且 nonce 与请求一致 · finish_reason=(.*)$/,
      en: function (m) {
        return (
          "response_format=json_schema(strict); expects ok=true and a matching nonce · finish_reason=" + m[1]
        );
      }
    },
    {
      re: /^response_format=json_schema\(strict\)，要求 ok=true 且 nonce=(.*?) · finish_reason=(.*)$/,
      en: function (m) {
        return (
          "response_format=json_schema(strict); expects ok=true and nonce=" + m[1] + " · finish_reason=" + m[2]
        );
      }
    },
    {
      re: /^同一句「(.*)」分别走非流式与流式，比文本、finish_reason 与 usage · 收到 (\d+) 个 SSE 分片$/,
      en: function (m) {
        return (
          "The same sentence “" +
          m[1] +
          "” sent both non-streaming and streaming; text, finish_reason and usage compared · " +
          m[2] +
          " SSE chunks received"
        );
      }
    },
    {
      re: /^请求的是 (.*)，网关回包里的 model 却是 (.*)，两者对不上。$/,
      en: function (m) {
        return "Requested " + m[1] + ", but the gateway replied with model " + m[2] + " — they do not match.";
      }
    },
    {
      re: /^同一题连问三次，回包的 model 字段在变（(.*)），说明背后不止一个后端在轮转。$/,
      en: function (m) {
        return (
          "The same prompt three times and the model field keeps changing (" +
          m[1] +
          "): more than one backend is rotating behind this route."
        );
      }
    },
    {
      re: /^三次同样温度的短回答，completion_tokens 抖到 (\d+)%（(.*)），正常模型重复回答这类小问题会很稳。$/,
      en: function (m) {
        return (
          "Three short answers at the same temperature and completion_tokens swings " +
          m[1] +
          "% (" +
          m[2] +
          "); a real model is stable on questions like this."
        );
      }
    },
    {
      re: /^三次回包的 model 字段不一样：(.*)$/,
      en: function (m) {
        return "The model field differs across the three replies: " + m[1];
      }
    },
    {
      re: /^请求 (.*)，回包说自己是 (.*)$/,
      en: function (m) {
        return "Requested " + m[1] + ", the reply claims to be " + m[2];
      }
    },
    {
      re: /^usage 是 Anthropic 的记账形状（(.*)）：说明这条「OpenAI 兼容」链路背后其实是 Claude。$/,
      en: function (m) {
        return (
          "usage is shaped like Anthropic accounting (" +
          m[1] +
          "): behind this “OpenAI-compatible” route there is actually Claude."
        );
      }
    },
    {
      re: /^usage 里有 (\d+) 个非官方字段（(.*)）：网关做了改写，价格与缓存统计可能不是模型自己给的。$/,
      en: function (m) {
        return (
          "usage carries " +
          m[1] +
          " non-official fields (" +
          m[2] +
          "): the gateway rewrote them, so pricing and cache numbers may not come from the model."
        );
      }
    },
    {
      re: /^(\d+) 个（(.*?)）：网关自己加的统计，不算造假$/,
      en: function (m) {
        return m[1] + " extras (" + m[2] + "): gateway-added statistics, not forgery";
      }
    },
    {
      re: /^tool_calls 的 id 不是 call_ 开头（(.*)）：官方 OpenAI 一定是这个前缀，别的后端抄不全。$/,
      en: function (m) {
        return (
          "tool_calls ids do not start with call_ (" +
          m[1] +
          "): official OpenAI always uses that prefix; other backends copy it incompletely."
        );
      }
    },
    {
      re: /^要求严格 JSON 之后交回来的不是 JSON(（而是 markdown 代码块）)?：(.*)$/,
      en: function (m, L) {
        return (
          "Asked for strict JSON and got something that is not JSON" +
          (m[1] ? " (a markdown code fence)" : "") +
          ": " +
          m[2]
        );
      }
    },
    {
      re: /^JSON 能解析，但字段不符合 schema（ok=(.*)，nonce=(.*)）：说明 response_format 只是被「看起来像」地执行了。$/,
      en: function (m) {
        return (
          "JSON parses but the fields do not match the schema (ok=" +
          m[1] +
          ", nonce=" +
          m[2] +
          "): response_format was only made to look enforced."
        );
      }
    },
    {
      re: /^流式请求没有收到任何内容（status (\d+)）：这条链路要么不支持 stream，要么把它当非流式吞了。$/,
      en: function (m) {
        return (
          "The streaming request returned nothing (status " +
          m[1] +
          "): this route either does not support stream, or swallowed it as non-streaming."
        );
      }
    },
    {
      re: /^同一句话，非流式回的是「(.*)」，流式拼出来的是「(.*)」：两条路不是一个后端。$/,
      en: function (m) {
        return (
          "Same sentence: non-streaming returned “" +
          m[1] +
          "”, the stream assembled “" +
          m[2] +
          "” — those are not the same backend."
        );
      }
    },
    {
      re: /^没有，只回了文字：(.*)$/,
      en: function (m) {
        return "none, only text: " + m[1];
      }
    },
    {
      re: /^解析不了：(.*)$/,
      en: function (m) {
        return "cannot parse: " + m[1];
      }
    },
    {
      re: /^(\d+) 个$/,
      en: function (m) {
        return m[1] + " calls";
      }
    },
    {
      re: /^写完了（finish_reason=(.*)）$/,
      en: function (m) {
        return "finished (finish_reason=" + m[1] + ")";
      }
    },
    {
      re: /^没写完：(.*) KB 就断了（(.*)）$/,
      en: function (m, L) {
        return "cut off after " + m[1] + " KB (" + L(m[2]) + ")";
      }
    },
    {
      re: /^CSS 关键帧 (\d+) · SMIL (\d+) · 过渡 (\d+)$/,
      en: function (m) {
        return "CSS keyframes " + m[1] + " · SMIL " + m[2] + " · transitions " + m[3];
      }
    },
    {
      re: /^(\d+) 个图元（g (\d+) · 渐变 (\d+)）$/,
      en: function (m) {
        return m[1] + " elements (g " + m[2] + " · gradients " + m[3] + ")";
      }
    },
    {
      re: /^(\d+) 个图元（path (\d+) \/ circle (\d+) \/ rect (\d+)）$/,
      en: function (m) {
        return m[1] + " elements (path " + m[2] + " / circle " + m[3] + " / rect " + m[4] + ")";
      }
    },
    {
      re: /^(\d+) 种颜色(、含渐变)?(、含滤镜)?$/,
      en: function (m) {
        return m[1] + " colours" + (m[2] ? ", with gradients" : "") + (m[3] ? ", with filters" : "");
      }
    },
    {
      re: /^(\d+) 个 <text>$/,
      en: function (m) {
        return m[1] + " <text> nodes";
      }
    },
    {
      re: /^有（(\d+) 字节）$/,
      en: function (m) {
        return "yes (" + m[1] + " bytes)";
      }
    },
    {
      re: /^模型 (\d+) 秒没把 HTML 写完，请求被中断了。HTML 动画是最吃时间的一项：把「画图强度」调到 medium 或 default，或者换一条快的线（deepseek 这类）再试一次。$/,
      en: function (m) {
        return (
          "The model did not finish the HTML within " +
          m[1] +
          "s and the request was interrupted. HTML animation is the slowest item: set the drawing effort to medium or default, or try a faster route (deepseek and similar)."
        );
      }
    },
    {
      re: /^这一趟回答被截断了（(.*?)）：只收到 (.*?) KB 就断了，断口停在标签\/属性中间，所以画面上只有前面那一小截（比如只有天空、只有一个车轮）。这不是它画得差，是没画完——重测一次，或者换一条不那么爱思考、输出更稳的线。$/,
      en: function (m, L) {
        return (
          "The reply was cut off (" +
          L(m[1]) +
          "): only " +
          m[2] +
          " KB arrived and the break sits inside a tag or attribute, so the picture shows only the first fragment (say, just sky, or a single wheel). It is unfinished rather than badly drawn — re-run it, or pick a route that thinks less and streams more steadily."
        );
      }
    },
    {
      re: /^收到了完整文档，但里面只有 (\d+) 个图元，画面基本是空的：这一趟它确实没好好画。$/,
      en: function (m) {
        return (
          "The full document arrived but holds only " +
          m[1] +
          " elements — the picture is essentially empty: this run really did not try."
        );
      }
    },
    {
      re: /^参考库没下下来：(.*)$/,
      en: function (m) {
        return "Could not download the reference bank: " + m[1];
      }
    },
    {
      re: /^本地参考库读不了：(.*)$/,
      en: function (m) {
        return "Cannot read the local reference bank: " + m[1];
      }
    },
    {
      re: /^（(\d+) 回合合并）$/,
      en: function (m) {
        return " (" + m[1] + " rounds merged)";
      }
    },
    {
      re: /^参考库来自 lm-detector（MIT）· 固定版本 (.*?)(（[^（）]*）)?· 约 (.*?) MB · 第一次用到时才下载$/,
      en: function (m) {
        return (
          "Reference bank from lm-detector (MIT) · pinned revision " +
          m[1] +
          (m[2] || "") +
          " · about " +
          m[3] +
          " MB · downloaded on first use"
        );
      }
    },
    {
      re: /^自述与路由一致：更像 (.*)$/,
      en: function (m) {
        return "Self-report and route agree: looks like " + m[1];
      }
    },
    {
      re: /^自述不足以定性（不确定）→ 以路由为准：(.*)$/,
      en: function (m) {
        return "Self-report inconclusive → going by the route: " + m[1];
      }
    }
  ];

  function localizeText(value) {
    if (LANG !== "en" || typeof value !== "string" || !value) return value;
    if (Object.prototype.hasOwnProperty.call(ZH2EN, value)) return ZH2EN[value];
    if (Object.prototype.hasOwnProperty.call(EN, value)) return EN[value];
    for (var i = 0; i < RULES.length; i += 1) {
      var hit = RULES[i].re.exec(value);
      if (hit) return RULES[i].en(hit, localizeText);
    }
    return value;
  }

  // 深度本地化：接口回来的 JSON 里凡是命中文案表的字符串都换掉，其余（型号名、供应商名）原样留着。
  function localize(value) {
    if (LANG !== "en" || value === null || value === undefined) return value;
    if (typeof value === "string") return localizeText(value);
    if (Array.isArray(value)) return value.map(localize);
    if (typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (key) {
        out[key] = localize(value[key]);
      });
      return out;
    }
    return value;
  }

  // 服务端（lib/*.mjs）返回的分析文字：整句精确匹配的放这里，带变量的在下面 RULES 里。
  var ZH2EN = {
    "缺": "missing",
    "无": "none",
    "没有": "no",
    "在": "present",
    "空": "empty",
    "是": "yes",
    "带": "included",
    "没带": "not included",
    "余额": "Balance",
    "额度": "Quota",
    "积分": "Credits",
    "未知": "unknown",
    "稳定": "stable",
    "干净": "clean",
    "一致": "match",
    "不一致": "mismatch",
    "有排名": "ranked",
    "请求": "requests",
    "全失败": "all failed",
    "未记录": "unrecorded",
    "对不上": "mismatch",
    "空回答": "empty answer",
    "有疑点": "suspicious",
    "(无)": "none",
    "(未标注)": "(unlabelled)",
    "数值指纹": "Numeric fingerprint",
    "协议审计": "Protocol audit",
    "协议规范": "Protocol spec",
    "样本不够": "not enough samples",
    "样本不够判不了": "not enough samples to judge",
    "样本全是空的，这次没得分": "every sample was empty, so no score this time",
    "缺 id": "no id",
    "轻微抖动": "slight jitter",
    "抖得反常": "abnormal jitter",
    "等式成立": "equation holds",
    "函数调用": "Function calling",
    "回声一致性": "Echo consistency",
    "结构化输出": "Structured output",
    "流式一致性": "Stream consistency",
    "流式有内容": "stream has content",
    "非流式有内容": "non-streaming has content",
    "两边文本一致": "both paths returned the same text",
    "不像模型回答": "does not look like a model answer",
    "函数名对得上": "function name matches",
    "网关扩展字段": "Gateway extension fields",
    "HTML 动画": "HTML animation",
    "参考库校验失败": "reference bank check failed",
    "无 usage": "no usage",
    "有（思考另算）": "yes (reasoning counted separately)",
    "字段不全，算不了": "fields incomplete, cannot compute",
    "usage 记账": "usage accounting",
    "明显不像官方接口": "clearly not an official endpoint",
    "回答不像模型在数数": "does not read like a model counting",
    "能解析成 JSON": "parses as JSON",
    "流式带 usage": "stream carries usage",
    "id 前缀 call_": "id prefix call_",
    "枚举值合规（unit）": "enum values valid (unit)",
    "字段符合 schema": "fields match the schema",
    "返回了 tool_calls": "returned tool_calls",
    "缺（OpenAI 协议必有）": "missing (the OpenAI protocol always has it)",
    "没有（不代表假，很多网关不细分）": "no (not evidence of fakery; many gateways do not break it down)",
    "finish_reason 一致": "finish_reason matches",
    "没有 Anthropic 原始记账": "no Anthropic-original accounting",
    "ok=true / nonce 对": "ok=true and the nonce matches",
    "arguments 是合法 JSON": "arguments is valid JSON",
    "claude/anthropic 字样": "claude/anthropic wording",
    "finish_reason ∈ {stop, 空}": "finish_reason ∈ {stop, empty}",
    "整批响应都没有 usage（几乎只有伪造接口才会这样）": "No usage anywhere in the batch (almost only faked endpoints do this)",
    "usage 里出现了 claude / anthropic 字样": "usage mentions claude / anthropic",
    "只有 input_tokens / output_tokens：这是 Anthropic 的形状": "Only input_tokens / output_tokens: that is the Anthropic shape",
    "流式响应里没有 usage（即使带了 stream_options.include_usage）：多是中间层自己拼的 SSE，而不是官方实现。": "The stream carried no usage (even with stream_options.include_usage): that is usually an SSE layer assembled by a middleman, not an official implementation.",
    "强制 tool_choice 之后仍然只回文字、没有 tool_calls：这条链路并不真的支持函数调用。": "Forced tool_choice still returned plain text and no tool_calls: this route does not really support function calling.",
    "思考·低": "reasoning·low",
    "思考·中": "reasoning·medium",
    "思考·高": "reasoning·high",
    "思考·极高": "reasoning·ultra",
    "字节 / 豆包": "ByteDance / Doubao",
    "腾讯 / 混元": "Tencent / Hunyuan",
    "智谱 / GLM": "Zhipu / GLM",
    "阿里 / Qwen": "Alibaba / Qwen",
    "月之暗面 / Kimi": "Moonshot / Kimi",
    "6 次「数 300 个随机数」（两回合）→ 参考库直接落到具体型号（看统计纹理，不看自述）": "6 rounds of “count 300 random numbers” (two rounds merged) → the reference bank lands on a concrete model (it reads statistical texture, not self-reports)",
    "检测维度参考 Veridrop（AGPL-3.0）的公开方法，用 JS 重写：回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性。分数是这些协议细节的加权，不是概率。": "Checks follow Veridrop's (AGPL-3.0) published method, rewritten in JS: echo consistency / usage accounting / function calling / structured output / stream consistency. The score weights those protocol details; it is not a probability.",
    "7 次协议探针：回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性（检测维度参考 Veridrop）": "7 protocol probes: echo consistency / usage accounting / function calling / structured output / stream consistency (checks after Veridrop)",
    "6 次「数 300 个随机数」（两回合合并），参考库落到具体型号": "6 rounds of “count 300 random numbers” (two rounds merged); the reference bank lands on a concrete model"
  };

  var BACK = null;

  function t(zh, vars) {
    var out = LANG === "en" && Object.prototype.hasOwnProperty.call(EN, zh) ? EN[zh] : zh;
    if (vars) {
      Object.keys(vars).forEach(function (key) {
        out = out.split("{" + key + "}").join(String(vars[key]));
      });
    }
    return out;
  }

  // 数字 + 单位的组合（"3 次" / "3 calls"）：单位单独进表，数字照旧格式化。
  function tn(value, zhUnit) {
    return String(value) + t(zhUnit);
  }

  // 把 index.html 里标了 data-i18n 的地方填上：文本、title、placeholder 三种。
  function apply(root) {
    var scope = root || document;
    var each = function (selector, attribute, target) {
      Array.prototype.forEach.call(scope.querySelectorAll(selector), function (node) {
        node[target] = t(node.getAttribute(attribute));
      });
    };
    each("[data-i18n]", "data-i18n", "textContent");
    each("[data-i18n-title]", "data-i18n-title", "title");
    each("[data-i18n-ph]", "data-i18n-ph", "placeholder");
  }

  document.documentElement.setAttribute("lang", LANG === "zh" ? "zh-CN" : "en");

  window.RI18N = { LANG: LANG, t: t, tn: tn, apply: apply, dict: EN, back: BACK, localize: localize, serverDict: ZH2EN };
})();

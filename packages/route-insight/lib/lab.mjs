import fs from "node:fs";
import path from "node:path";
import { configFile } from "./store.mjs";

// 智商检测（数值指纹 + 协议审计 + HTML 动画）：一次检测就是一次真实请求，会花积分。
import { GATEWAY, AUTH, ask, openBudget, closeBudget, RUN_REQUEST_LIMIT } from "./gateway.mjs";
import { runNumeric } from "./numeric.mjs";
import { runRelay } from "./relay.mjs";
const FENCE = String.fromCharCode(96, 96, 96);

export const TESTS = [
  { id: "numfp", name: "数值指纹", hint: "6 次「数 300 个随机数」（两回合）→ 参考库直接落到具体型号（看统计纹理，不看自述）" },
  { id: "relay", name: "协议审计", hint: "7 次协议探针：回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性（检测维度参考 Veridrop）" },
  { id: "anim", name: "HTML 动画", hint: "要一份完整 HTML：SVG 会动的鹈鹕骑车（提示词可自己改）" }
];

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* -------- 家族关键词：把自述/风格落到具体家族 -------- */
const FAMILIES = [
  { id: "openai", name: "OpenAI / GPT", re: /\bgpt\b|openai|chatgpt/i },
  { id: "anthropic", name: "Anthropic / Claude", re: /claude|anthropic/i },
  { id: "google", name: "Google / Gemini", re: /gemini|google|bard|deepmind/i },
  { id: "deepseek", name: "DeepSeek", re: /deepseek|深度求索/i },
  { id: "qwen", name: "阿里 / Qwen", re: /qwen|千问|通义|alibaba|aliyun|dashscope/i },
  { id: "zhipu", name: "智谱 / GLM", re: /glm|智谱|chatglm|zhipu/i },
  { id: "moonshot", name: "月之暗面 / Kimi", re: /kimi|moonshot|月之暗面/i },
  { id: "minimax", name: "MiniMax", re: /minimax|abab|海螺/i },
  { id: "bytedance", name: "字节 / 豆包", re: /doubao|豆包|bytedance|字节|seed-?oss/i },
  { id: "hunyuan", name: "腾讯 / 混元", re: /hunyuan|混元|hy3/i },
  { id: "meta", name: "Meta / Llama", re: /llama|meta ai/i },
  { id: "xai", name: "xAI / Grok", re: /grok|xai/i },
  { id: "mistral", name: "Mistral", re: /mistral|mixtral/i }
];

export function familyOf(name) {
  const text = String(name || "");
  for (const item of FAMILIES) {
    if (item.re.test(text)) return item;
  }
  return null;
}

const PELICAN_PROMPT = [
  "用一条 SVG 画出「一只骑着自行车的鹈鹕」。",
  "只输出 <svg ...>...</svg> 代码本身，不要代码块、不要任何解释文字。",
  "viewBox 用 0 0 400 400，线条清晰可辨，不要用外部图片或字体。"
].join("\n");

const PELICAN_RETRY_PROMPT = [
  "上一轮没有拿到完整的 SVG。现在请直接给出结果，不要写思考过程、不要解释、不要代码块：",
  "第一行必须就是 <svg viewBox=\"0 0 400 400\" xmlns=\"http://www.w3.org/2000/svg\">，最后一行必须是 </svg>。",
  "内容：一只骑着自行车的鹈鹕，至少 12 个图形元素，用 fill 上色。"
].join("\n");

// HTML 动画的默认提示词：就是用户自己那句话（他拿去比模型的那一版）。
// 界面上可以改，改完只对这一次检测生效；重试在它后面追加硬要求，不换题。
export const ANIM_PROMPT =
  "写一个单文件 HTML：用内联 SVG 画一只骑着自行车的鹈鹕，做成 2D 循环动画。只要这一个文件，不要脚本、外链和外部图片；画面自己构图，不用解释也不用自测，直接给成品。";

// 上一次已经很接近了，只是没写完：别重画，接着把剩下的写完。
const ANIM_CLOSE_SUFFIX = [
  "补充要求（上一轮有开头没结尾，缺 </body></html>）：",
  "从 <!DOCTYPE html> 开始，输出一份完整的单文件 HTML，篇幅压到 3000 字符以内，务必以 </html> 结束；",
  "不许有脚本、外链、解释文字。"
].join("\n");
const ANIM_RETRY_SUFFIX = [
  "补充要求（上一轮没有交回完整的 HTML 文档）：",
  "第一行就是 <!DOCTYPE html>，最后一行就是 </html>，中间是画面本身；",
  "不许有脚本、不许有外链、不许有解释文字或代码块围栏。"
].join("\n");
// 上一轮的额度全被思考吃掉（网关原话 the whole output spent on reasoning），正文是空的：
// 这一趟不设上限，并且明确要求少想、直接写代码。
const ANIM_LEAN_SUFFIX = [
  "补充要求（上一轮你的思考把输出额度全占了，正文一个字都没写出来）：",
  "这次不要长篇推理，直接从 <!DOCTYPE html> 开始写文档，中间是画面本身，以 </html> 结束；",
  "不许有解释文字、不许用 Markdown 代码块围栏。"
].join("\n");

// 上一轮写了一半就断了（拿到几 KB 就没了，多半停在属性中间）：
// 这次不是让它重画，而是明确要求压篇幅、收得回来。
const ANIM_SHORT_SUFFIX = [
  "补充要求（上一轮写了一半就断了）：",
  "这次把篇幅压到 5000 字符以内，图元别超过 60 个，只保留画面本身；",
  "从 <!DOCTYPE html> 开始，务必以 </html> 收尾，不许有解释文字、代码块围栏、脚本或外链。"
].join("\n");

// 模型给的东西一律当不可信输入：抽文档 → 剥脚本/外链 → 交给浏览器渲染。
export function extractHtml(text) {
  const raw = String(text || "");
  const full = raw.match(/<!doctype[\s\S]*?<\/html>/i) || raw.match(/<html[\s\S]*?<\/html>/i);
  if (full) return full[0];
  // 有开头没结尾（多半是被 max_tokens 截断）：从开头取到末尾，自己补上收尾，
  // 否则下面会误走「片段」分支，把整份文档塞进 body，变成嵌套的 HTML。
  const open = raw.search(/<!doctype|<html/i);
  if (open >= 0) {
    const tail = raw.slice(open);
    const head = /^<!doctype/i.test(tail) ? tail : "<!DOCTYPE html>\n" + tail;
    return head + (/<\/body>/i.test(head) ? "</html>" : "</body></html>");
  }
  const svg = raw.match(/<svg[\s\S]*?<\/svg>/i);
  const shell =
    "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>SVG</title>" +
    "<style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}" +
    "svg{max-width:100%;max-height:100vh}</style></head><body>";
  if (svg) return shell + svg[0] + "</body></html>";
  // 只有片段（<style> + 几个 <div>）也照样包一层，至少能看出它想做什么。
  if (/<style|@keyframes|<div/i.test(raw)) return shell + raw + "</body></html>";
  return "";
}

// 回答写完没有 —— 这是「画得差」和「没画完」的分界线。
// 只看 extractHtml 的产物没用：它会替截断的文档补收尾，补完就看不出断口了。
// 所以这里拿原始文本 + 网关的 finish_reason 一起判。
export function docState(text, finish) {
  const raw = String(text || "");
  const f = String(finish || "").toLowerCase();
  if (!raw.trim()) return { code: f === "length" ? "length" : "empty", complete: false };
  if (/<\/html>/i.test(raw)) return { code: "ok", complete: true };
  if (f === "length") return { code: "length", complete: false };
  // 停在属性/标签中间的特征：rx=" / stroke / <path d="M0 …
  const tail = raw.slice(-120);
  if (/=\s*"[^"]*$/.test(raw) || /=[^\s>]*$/.test(tail) || /<[a-zA-Z\/][^<>]*$/.test(tail) || /["']\s*$/.test(raw)) {
    return { code: "cut-tag", complete: false };
  }
  return { code: "no-close", complete: false };
}

export function docStateLabel(code) {
  if (code === "ok") return "写完了";
  if (code === "length") return "额度用尽被截断（finish_reason=length）";
  if (code === "cut-tag") return "停在属性中间，线路把回答截断了";
  if (code === "no-close") return "没写 </html>，回答没结束";
  return "回答是空的";
}

export function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<(iframe|object|embed|link|base|form|meta|noscript)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s(href|src|xlink:href|srcset|poster|action)\s*=\s*"(?!#|data:)[^"]*"/gi, "")
    .replace(/\s(href|src|xlink:href)\s*=\s*'(?!#|data:)[^']*'/gi, "")
    .replace(/@import[^;]+;/gi, "")
    .replace(/url\(\s*['"]?(?!#|data:)[^)]*\)/gi, "none")
    .replace(/javascript:/gi, "");
}

function htmlFeatures(html) {
  const doc = String(html || "");
  const keyframes = (doc.match(/@keyframes/gi) || []).length;
  const smil = countTags(doc, "animate") + countTags(doc, "animateTransform") + countTags(doc, "animateMotion");
  const transitions = (doc.match(/transition\s*:/gi) || []).length;
  const elements =
    countTags(doc, "path") +
    countTags(doc, "circle") +
    countTags(doc, "ellipse") +
    countTags(doc, "rect") +
    countTags(doc, "line") +
    countTags(doc, "polygon") +
    countTags(doc, "polyline");
  const colours = (doc.match(/#[0-9a-f]{3,8}\b/gi) || []).map(function (c) {
    return c.toLowerCase();
  });
  const uniq = Array.from(new Set(colours));
  return {
    bytes: doc.length,
    elements,
    keyframes,
    smil,
    transitions,
    animations: keyframes + smil + (transitions ? 1 : 0),
    groups: countTags(doc, "g"),
    gradients: countTags(doc, "linearGradient") + countTags(doc, "radialGradient"),
    uniqColours: uniq.length,
    colours: uniq.slice(0, 8),
    viewBox: (doc.match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1] || "",
    texts: countTags(doc, "text")
  };
}

function parseJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/,\s*}/g, "}"));
    } catch {
      return null;
    }
  }
}

function countTags(svg, tag) {
  const re = new RegExp("<" + tag + "\\b", "gi");
  return (svg.match(re) || []).length;
}

export function pelicanFeatures(raw) {
  const text = String(raw || "");
  const match = text.match(/<svg[\s\S]*?<\/svg>/i);
  const svg = match ? match[0] : "";
  const colours = (svg.match(/#[0-9a-f]{3,8}\b/gi) || []).map(function (c) {
    return c.toLowerCase();
  });
  const uniqColours = Array.from(new Set(colours));
  const viewBox = (svg.match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1] || "";
  const elements =
    countTags(svg, "path") +
    countTags(svg, "circle") +
    countTags(svg, "ellipse") +
    countTags(svg, "rect") +
    countTags(svg, "line") +
    countTags(svg, "polygon") +
    countTags(svg, "polyline");
  return {
    hasSvg: !!svg,
    svg,
    bytes: svg.length,
    elements,
    paths: countTags(svg, "path"),
    circles: countTags(svg, "circle"),
    rects: countTags(svg, "rect"),
    texts: countTags(svg, "text"),
    groups: countTags(svg, "g"),
    gradients: countTags(svg, "linearGradient") + countTags(svg, "radialGradient"),
    filters: countTags(svg, "filter"),
    uniqColours: uniqColours.length,
    colours: uniqColours.slice(0, 8),
    viewBox,
    markdown: text.trim().indexOf(FENCE) === 0 || text.toLowerCase().indexOf(FENCE + "svg") >= 0
  };
}

// 浏览器里直接 innerHTML 渲染，先剔掉能执行的东西。
export function sanitizeSvg(svg) {
  return String(svg || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, "")
    .replace(/javascript:/gi, "");
}

function pelicanSignals(feature, call, totalMs) {
  const signals = [];
  signals.push({
    name: "是否给到 SVG",
    value: feature.hasSvg ? "有（" + feature.bytes + " 字节）" : "没有",
    tone: feature.hasSvg ? "good" : "bad",
    note: feature.hasSvg ? "" : clip(call.text, 120)
  });
  if (!feature.hasSvg) return signals;
  signals.push({
    name: "结构密度",
    value: feature.elements + " 个图元（path " + feature.paths + " / circle " + feature.circles + " / rect " + feature.rects + "）",
    tone: feature.elements >= 12 ? "good" : feature.elements >= 5 ? "warn" : "bad",
    note: feature.elements >= 12 ? "分层画得细，通常是强模型的画法" : "图元少，画得比较糊"
  });
  signals.push({
    name: "颜色与渐变",
    value: feature.uniqColours + " 种颜色" + (feature.gradients ? "、含渐变" : "") + (feature.filters ? "、含滤镜" : ""),
    tone: feature.uniqColours >= 3 ? "good" : feature.uniqColours >= 2 ? "warn" : "bad",
    note: feature.colours.join(" ")
  });
  signals.push({
    name: "标注文字",
    value: feature.texts ? feature.texts + " 个 <text>" : "没有 <text>",
    tone: feature.texts ? "warn" : "good",
    note: feature.texts ? "靠文字解释画面，通常画得比较敷衍" : "纯图形表达"
  });
  signals.push({
    name: "viewBox",
    value: feature.viewBox || "未声明",
    tone: /^0 0 400 400$/.test(feature.viewBox) ? "good" : "warn",
    note: "要求 0 0 400 400"
  });
  const spent = totalMs || call.ms;
  signals.push({ name: "耗时", value: spent + " ms", tone: spent < 60000 ? "good" : "warn", note: "" });
  if (feature.markdown) {
    signals.push({ name: "格式", value: "带了代码块围栏", tone: "warn", note: "要求只输出 SVG" });
  }
  return signals;
}

export async function runPelican(model, opts) {
  const o = opts || {};
  const started = Date.now();
  let call = await ask(model, PELICAN_PROMPT, {
    maxTokens: 8000,
    temperature: 0.7,
    effort: o.effort,
    timeoutMs: PELICAN_TIMEOUT
  });
  let feature = pelicanFeatures(call.text);
  let retried = false;
  if (!feature.hasSvg) {
    // 空答常见原因：思考把长度预算吃光，或者只画了半张图。换一句更硬的指令再要一次。
    retried = true;
    call = await ask(model, PELICAN_RETRY_PROMPT, {
    maxTokens: 8000,
    temperature: 0.7,
    effort: o.effort,
    timeoutMs: PELICAN_TIMEOUT
  });
    feature = pelicanFeatures(call.text);
  }
  return {
    id: "pelican",
    ok: call.ok,
    ms: Date.now() - started,
    served: call.served,
    svg: sanitizeSvg(feature.svg),
    features: {
      bytes: feature.bytes,
      elements: feature.elements,
      paths: feature.paths,
      circles: feature.circles,
      rects: feature.rects,
      texts: feature.texts,
      groups: feature.groups,
      gradients: feature.gradients,
      filters: feature.filters,
      uniqColours: feature.uniqColours,
      colours: feature.colours,
      viewBox: feature.viewBox
    },
    signals: pelicanSignals(feature, call, Date.now() - started),
    retried,
    raw: clip(call.text, 1200),
    error: call.error
  };
}

// 要「完整 HTML」的版本：模型交一份文档，我们剥干净后单独存成一个页面，
// 前端用 iframe 打开它（页面 CSP 是 default-src 'none'，只能靠 frame-src 'self' + 独立 CSP 渲染）。
export // 画一整份 HTML 文档跟「回一句话」不是一个量级：思考型模型光想就能想两三分钟，
// 再吐十几 KB 的 SVG，180 秒的上限（ask 的默认值）经常把它当失败掐掉，
// 界面上就成了「没拿到完整 HTML: The operation was aborted.」。
const ANIM_MAX_TOKENS = 32000;     // 推理型模型的思考也算在里面，给少了就是「正文空白」
const ANIM_TIMEOUT = 480000;      // 第一次给 8 分钟
const ANIM_RETRY_TIMEOUT = 300000; // 补交那一次给 5 分钟
const PELICAN_TIMEOUT = 300000;    // 一份 SVG，5 分钟够

async function runAnimation(model, opts) {
  const o = opts || {};
  const started = Date.now();
  // 提示词可以由界面传进来；没传就用默认那句。重试在同一句后面追加要求，不换题。
  const base = String(o.prompt || "").trim() || ANIM_PROMPT;
  let call = await ask(model, base, {
    maxTokens: ANIM_MAX_TOKENS,
    temperature: 0.6,
    effort: o.effort,
    timeoutMs: ANIM_TIMEOUT
  });
  let html = extractHtml(call.text);
  let retried = false;
  let state = docState(call.text, call.finish);
  // 网关的「空回答」有两种：一种是模型真的什么都没写，一种是推理把它自己的输出额度吃光了
  // （原话 the whole output spent on reasoning）。后者要给更大的 max_tokens，重试才有意义。
  function tooMuchThinking(c) {
    return !String(c.text || "").trim() && /spent on reasoning/i.test(String(c.error || ""));
  }
  // 「没写完」≠「画得差」：写了一半的文档里，只有前半截会显示出来
  // （实测两份：1802 字节只有天空，4949 字节只有一个车轮），看起来就像模型不会画画。
  let truncated = !!html && !state.complete;
  const eaten = tooMuchThinking(call);
  // 超时了就别再补第二遍：同一个模型、同一句提示词，再等 5 分钟大概率还是超时，
  // 只会让等待时间翻倍。想重试可以自己再点一次，或者把提示词改短。
  if ((!html || truncated || eaten) && !call.timeout) {
    retried = true;
    const suffix = eaten ? ANIM_LEAN_SUFFIX : truncated ? ANIM_SHORT_SUFFIX : ANIM_RETRY_SUFFIX;
    call = await ask(model, base + "\n\n" + suffix, {
      // 思考吃光额度的这种，第二趟干脆不设上限（跟数数挑战一个道理）
      maxTokens: ANIM_MAX_TOKENS, // 第二趟也封顶：以前这里传 0（不限），是最贵的一条路径
      temperature: 0.6,
      effort: eaten ? "" : o.effort,
      timeoutMs: ANIM_RETRY_TIMEOUT
    });
    html = extractHtml(call.text);
    state = docState(call.text, call.finish);
    truncated = !!html && !state.complete;
  }
  const clean = sanitizeHtml(html);
  const feature = htmlFeatures(clean);
  const signals = [];
  signals.push({
    name: "回答写完了没",
    value: clean
      ? truncated
        ? "没写完：" + (feature.bytes / 1024).toFixed(1) + " KB 就断了（" + docStateLabel(state.code) + "）"
        : "写完了（finish_reason=" + (call.finish || "stop") + "）"
      : "没有",
    tone: !clean ? "bad" : truncated ? "bad" : "good",
    note: !clean
      ? clip(call.text, 120)
      : truncated
        ? "断掉的那份只显示出前半截（常见的就是只有天空、只有一个车轮），这种不能算它画得差，重测一次或者换条线"
        : "整份文档收到了，下面的图元/动画数字才是它的真实水平"
  });
  if (clean) {
    signals.push({
      name: "画面空不空",
      value: feature.elements + " 个图元（g " + feature.groups + " · 渐变 " + feature.gradients + "）",
      tone: feature.elements >= 20 ? "good" : feature.elements >= 8 ? "warn" : "bad",
      note:
        feature.elements >= 20
          ? "分层细，通常是强模型的画法"
          : feature.elements >= 8
            ? "图元偏少，画面会比较素"
            : "几乎没画东西：要么它偷懒，要么这一趟断了（先看上一行）"
    });
    signals.push({
      name: "有没有动起来",
      value:
        feature.animations
          ? "CSS 关键帧 " + feature.keyframes + " · SMIL " + feature.smil + " · 过渡 " + feature.transitions
          : "一处动画都没有",
      tone: feature.animations >= 2 ? "good" : feature.animations ? "warn" : "bad",
      note: feature.animations ? "" : "要的是会动的画面，静态图等于没做"
    });
    signals.push({
      name: "颜色",
      value: feature.uniqColours + " 种",
      tone: feature.uniqColours >= 3 ? "good" : feature.uniqColours >= 2 ? "warn" : "bad",
      note: feature.colours.join(" ")
    });
    if (feature.texts) {
      signals.push({ name: "标注文字", value: feature.texts + " 个 <text>", tone: "warn", note: "靠文字解释画面，通常画得敷衍" });
    }
  } else {
    signals.push({
      name: "为什么没交回 HTML",
      value: tooMuchThinking(call) ? "额度被思考吃光" : call.timeout ? "等太久被中断" : "回答里没有 HTML",
      tone: "bad",
      note: tooMuchThinking(call)
        ? "网关原话 the whole output spent on reasoning：这类推理模型把思考算进输出额度，第二趟已经改成不设上限"
        : call.timeout
          ? "HTML 动画最吃时间：换一条快的线，或把画图强度调低"
          : clip(call.text, 120)
    });
  }
  signals.push({ name: "耗时", value: call.ms + " ms", tone: call.ms < 90000 ? "good" : "warn", note: "" });
  // 只有「整份文档 + 有画面」才算这一项过关；半份文档一律不算，
  // 否则界面上就会出现一张残缺的画配着「已渲染」，用户只能得出「模型智商差」的结论。
  const ok = !!clean && !truncated && feature.elements >= 8;
  return {
    id: "anim",
    ok,
    ms: Date.now() - started,
    served: call.served,
    html: clean,
    features: feature,
    signals,
    prompt: base,
    custom: base !== ANIM_PROMPT,
    retried,
    truncated,
    cut: truncated ? state.code : "",
    finish: call.finish || "",
    timeout: !!call.timeout,
    timeoutMs: call.timeoutMs || ANIM_TIMEOUT,
    raw: clip(call.text, 1200),
    // 超时是这一趟没跑完，不是「模型坏了」：文案要说清怎么补救，
    // 否则用户只能看到一句 "The operation was aborted."。
    error: !clean
      ? tooMuchThinking(call)
        ? "两趟都没写出正文：模型把输出额度全花在思考上了（网关原话 the whole output spent on reasoning）。" +
          "把「画图强度」调低，或者换一条不那么爱思考的线再试。"
        : call.timeout
          ? "模型 " + Math.round((call.timeoutMs || ANIM_TIMEOUT) / 1000) + " 秒没把 HTML 写完，请求被中断了。" +
            "HTML 动画是最吃时间的一项：把「画图强度」调到 medium 或 default，或者换一条快的线（deepseek 这类）再试一次。"
          : call.error
      : truncated
        ? "这一趟回答被截断了（" + docStateLabel(state.code) + "）：只收到 " + (feature.bytes / 1024).toFixed(1) +
          " KB 就断了，断口停在标签/属性中间，所以画面上只有前面那一小截（比如只有天空、只有一个车轮）。" +
          "这不是它画得差，是没画完——重测一次，或者换一条不那么爱思考、输出更稳的线。"
        : feature.elements < 8
          ? "收到了完整文档，但里面只有 " + feature.elements + " 个图元，画面基本是空的：这一趟它确实没好好画。"
          : ""
  };
}

export async function runTests(model, tests, opts) {
  const o = opts || {};
  const effort = o.effort || {};
  const wanted = Array.isArray(tests) && tests.length ? tests : ["numfp", "relay", "anim"];
  // 这次检测共用一份请求预算：任何一项把次数用光，后面的请求会被 ask() 直接拒绝，
  // 结果里带上 budgeted 标记，界面就能说清「是到上限了」而不是「模型不回话」。
  openBudget(RUN_REQUEST_LIMIT);
  let results;
  try {
    results = await Promise.all(
      wanted.map(function (id) {
        const sub = Object.assign({}, o, { effort: effort[id] || "" });
        if (id === "numfp") return runNumeric(model, sub);
        if (id === "relay") return runRelay(model, sub);
        if (id === "anim") return runAnimation(model, sub);
        return runPelican(model, sub); // 界面已撤掉这项，老历史还能重开
      })
    );
  } finally {
    closeBudget();
  }
  const out = {};
  results.forEach(function (item) {
    out[item.id] = item;
  });
  return { ok: results.some((item) => item.ok), model, at: new Date().toISOString(), results: out, limit: RUN_REQUEST_LIMIT };
}

// 参考库：网关自己报的模型清单（/v1/models），10 分钟缓存。
// 它才是「具体模型」的候选池 —— 家族只定档位，排名落到真实型号上；
// 顺带把每个型号支持的推理强度也带出来，界面的强度下拉才有依据。
let catalogCache = { at: 0, list: [], meta: null };

export async function fetchCatalog(force) {
  const now = Date.now();
  if (!force && catalogCache.list.length && now - catalogCache.at < 10 * 60 * 1000) return catalogCache;
  const res = await fetch(GATEWAY + "/v1/models", { headers: AUTH });
  if (!res.ok) throw new Error("models " + res.status);
  const doc = await res.json();
  const rows = Array.isArray(doc && doc.data) ? doc.data : [];
  const list = [];
  rows.forEach(function (row) {
    const id = String((row && row.id) || "");
    if (!id) return;
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : "gateway";
    const model = slash > 0 ? id.slice(slash + 1) : id;
    const family = familyOf(model) || familyOf(id);
    const levels = Array.isArray(row.reasoning_levels)
      ? row.reasoning_levels
          .map(function (x) {
            return String(x);
          })
          .filter(function (x) {
            return x && x !== "none" && x !== "unsupported";
          })
      : [];
    list.push({
      id,
      provider,
      model,
      // 分组是路由，不是具体型号：留在清单里好让强度下拉也有它的档位，但不进候选排名。
      group: id.indexOf("group/") === 0,
      family: family ? family.id : "",
      familyName: family ? family.name : "",
      levels,
      reasoning: !!row.reasoning
    });
  });
  const concrete = list.filter(function (m) {
    return !m.group;
  });
  const providers = new Set(
    concrete.map(function (m) {
      return m.provider;
    })
  );
  const families = new Set(
    concrete.map(function (m) {
      return m.family;
    })
  );
  catalogCache = {
    at: now,
    list,
    meta: {
      at: new Date(now).toISOString(),
      count: concrete.length,
      groups: list.length - concrete.length,
      providers: providers.size,
      families: families.size,
      source: "/v1/models"
    }
  };
  return catalogCache;
}

import { randomBytes } from "node:crypto";
import { GATEWAY, AUTH } from "./gateway.mjs";

// 中转审计：看这条链路交回来的「协议层证据」像不像官方 OpenAI 接口。
// 检测维度参考 Veridrop（github.com/canarybyte/veridrop，AGPL-3.0），此处按其公开方法用 JS 重写，
// 未复制其代码；它面向「自带 base_url + api_key」的直连场景，我们这边是 magpie 网关，所以判据换成
// 「同一网关下不同渠道之间应该长什么样」。
//
// 为什么这几项能抓假货：数值指纹看的是「数数的统计纹理」，而这里看的是「服务端的记账方式」——
// 模型自己没法改 usage 的字段名、tool_calls 的 id 前缀、finish_reason 的取值，只有真的换了后端才会变。

const FENCE = String.fromCharCode(96, 96, 96);

// 各项权重（合计 100）。导出来给回归测试盯着，别让总分悄悄变成 95 或 105。
export const RELAY_WEIGHTS = { echo: 15, usage: 20, tools: 20, json: 20, stream: 25 };

// 每项内部按百分比算（0–100，好写也好读），对外统一折算成「占自己权重多少分」——
// 这样五项加起来才是 100 分。第一版忘了折，总分蹦到 395/100。
function points(pct, weight) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round((v * weight) / 10) / 10;
}

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function post(model, body, opts) {
  const o = opts || {};
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, o.timeoutMs || 90000);
  try {
    const res = await fetch(GATEWAY + "/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, AUTH),
      body: JSON.stringify(Object.assign({ model }, body)),
      signal: controller.signal
    });
    const raw = await res.text();
    let doc = null;
    try {
      doc = JSON.parse(raw);
    } catch {
      doc = null;
    }
    return { ok: res.ok, status: res.status, doc, raw, ms: Date.now() - started, error: res.ok ? "" : clip(raw, 300) };
  } catch (error) {
    return { ok: false, status: 0, doc: null, raw: "", ms: Date.now() - started, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(call) {
  const choices = (call.doc && call.doc.choices) || [];
  const first = choices[0] || {};
  return { message: first.message || null, finish: first.finish_reason || "", served: (call.doc && call.doc.model) || "" };
}

// 流式：把 SSE 读完，拼回文本，顺手把最后一个 usage 与 finish_reason 取出来。
async function streamOnce(model, body, opts) {
  const o = opts || {};
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, o.timeoutMs || 90000);
  try {
    const res = await fetch(GATEWAY + "/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json", accept: "text/event-stream" }, AUTH),
      body: JSON.stringify(Object.assign({ model, stream: true }, body)),
      signal: controller.signal
    });
    const raw = await res.text();
    let text = "";
    let finish = "";
    let usage = null;
    let chunks = 0;
    raw.split(/\r?\n/).forEach(function (line) {
      const trimmed = line.trim();
      if (trimmed.indexOf("data:") !== 0) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let doc = null;
      try {
        doc = JSON.parse(payload);
      } catch {
        return;
      }
      chunks += 1;
      if (doc && doc.usage) usage = doc.usage;
      const choice = doc && doc.choices && doc.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === "string") text += delta.content;
    });
    return { ok: res.ok, status: res.status, text, finish, usage, chunks, ms: Date.now() - started, error: res.ok ? "" : clip(raw, 300) };
  } catch (error) {
    return { ok: false, status: 0, text: "", finish: "", usage: null, chunks: 0, ms: Date.now() - started, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function keysOf(usage) {
  const out = [];
  const walk = function (value, prefix, depth) {
    if (!value || typeof value !== "object" || depth > 2) return;
    Object.keys(value).forEach(function (key) {
      const path = prefix ? prefix + "." + key : key;
      out.push(path);
      walk(value[key], path, depth + 1);
    });
  };
  walk(usage, "", 0);
  return out;
}

// Anthropic 那边的记账字段名。OpenAI 协议里不该出现，出现就等于「后端其实是 Claude」。
const OFFICIAL_USAGE = ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"];

// 曾经拿来当「Claude 铁证」的那组字段。现在只用来在说明里点名，不再直接判 critical
// （magpie 网关对所有渠道都会加缓存统计，见 usage 那段的注释）。
const FOREIGN_USAGE = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation.ephemeral_5m_input_tokens", "cache_creation.ephemeral_1h_input_tokens"];
const CLAUDE_HINT = /claude|anthropic/i;

function toolCallRows(call, expectedName) {
  const got = messageOf(call);
  const message = got.message || {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = calls[0] || {};
  const fn = first.function || {};
  let args = null;
  try {
    args = JSON.parse(String(fn.arguments || ""));
  } catch {
    args = null;
  }
  const unit = args && args.unit;
  const rows = [
    { label: "返回了 tool_calls", ok: calls.length > 0, text: calls.length ? calls.length + " 个" : "没有，只回了文字：" + clip(message.content, 60) },
    { label: "id 前缀 call_", ok: /^call_/.test(String(first.id || "")), text: first.id ? String(first.id) : "缺 id" },
    { label: "type = function", ok: first.type === "function", text: String(first.type || "缺") },
    { label: "函数名对得上", ok: fn.name === expectedName, text: String(fn.name || "缺") },
    {
      label: "arguments 是合法 JSON",
      ok: !!args && typeof args.city === "string" && !!args.city.length,
      text: args ? clip(fn.arguments, 90) : "解析不了：" + clip(fn.arguments, 70)
    },
    { label: "枚举值合规（unit）", ok: unit === "celsius" || unit === "fahrenheit", text: String(unit === undefined ? "缺" : unit) }
  ];
  return { rows, got };
}

export async function runRelay(model, opts) {
  const o = opts || {};
  const started = Date.now();
  const effort = o.effort && o.effort !== "default" ? o.effort : "";
  const common = {};
  if (effort) common.reasoning_effort = effort;
  const checks = [];
  const findings = [];
  const note = function (level, text) {
    findings.push({ level, text });
  };

  // ① 回声一致性：同题三次 temperature=0，看 model 字段与 completion_tokens 抖不抖。
  const ECHO_PROMPT = "In one sentence, explain HTTP status 418.";
  const echoBodies = [0, 1, 2].map(function () {
    return post(model, Object.assign({ messages: [{ role: "user", content: ECHO_PROMPT }], temperature: 0, max_completion_tokens: 200 }, common));
  });

  // ② 工具调用 & ③ 结构化输出 & ⑤ 流式：一起发，省时间。
  const TOOL = {
    type: "function",
    function: {
      name: "get_current_weather",
      description: "Get the current weather in a given city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] }
        },
        required: ["city", "unit"],
        additionalProperties: false
      }
    }
  };
  const toolPromise = post(
    model,
    Object.assign(
      {
        messages: [{ role: "user", content: "What is the weather in Paris? Use the provided function." }],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: "get_current_weather" } },
        temperature: 0,
        max_completion_tokens: 200
      },
      common
    )
  );

  // nonce 每跑一次现生成。写死成固定字符串的话，转发层只要认出那个词，
  // 就能在完全不理解 json_schema 的情况下「照抄」出一个合规响应。
  const NONCE = randomBytes(6).toString("hex");
  const SCHEMA = {
    type: "json_schema",
    json_schema: {
      name: "result",
      strict: true,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, nonce: { type: "string" } },
        required: ["ok", "nonce"],
        additionalProperties: false
      }
    }
  };
  const JSON_PROMPT =
    'Return JSON matching the schema with ok=true and nonce="' + NONCE + '". No other text, no markdown fence.';
  const jsonPromise = post(
    model,
    Object.assign(
      { messages: [{ role: "user", content: JSON_PROMPT }], response_format: SCHEMA, temperature: 0, max_completion_tokens: 200 },
      common
    )
  );

  const PING = "Reply with exactly: stream check ok";
  const plainPromise = post(model, Object.assign({ messages: [{ role: "user", content: PING }], temperature: 0, max_completion_tokens: 64 }, common));
  const streamPromise = streamOnce(
    model,
    Object.assign(
      { messages: [{ role: "user", content: PING }], temperature: 0, max_completion_tokens: 64, stream_options: { include_usage: true } },
      common
    )
  );

  const echoCalls = await Promise.all(echoBodies);
  const toolCall = await toolPromise;
  const jsonCall = await jsonPromise;
  const plainCall = await plainPromise;
  const streamCall = await streamPromise;

  /* ---------- ① 回声一致性（15 分） ---------- */
  const echoRows = echoCalls.map(function (call, index) {
    const got = messageOf(call);
    const usage = (call.doc && call.doc.usage) || {};
    const details = usage.completion_tokens_details || {};
    const reasoning = typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null;
    const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
    return {
      index: index + 1,
      ok: !!call.ok,
      status: call.status,
      served: got.served,
      finish: got.finish,
      completion,
      // 思考型模型的 completion_tokens 里混着 reasoning，那一部分本来就每次都不一样，
      // 拿它算 CV 会把正常模型判成「抖得反常」。所以能拆开就只比可见输出。
      reasoning,
      visible: completion === null ? null : completion - (reasoning || 0),
      text: clip(got.message && got.message.content, 90),
      error: call.error
    };
  });
  const goodEcho = echoRows.filter(function (row) {
    return row.ok;
  });
  const servedSet = new Set(
    goodEcho
      .map(function (row) {
        return row.served;
      })
      .filter(Boolean)
  );
  const counts = goodEcho
    .map(function (row) {
      return row.visible;
    })
    .filter(function (n) {
      return typeof n === "number" && n > 0;
    });
  const mean = counts.length ? counts.reduce(function (a, b) { return a + b; }, 0) / counts.length : 0;
  const variance = counts.length > 1 ? counts.reduce(function (sum, n) { return sum + (n - mean) * (n - mean); }, 0) / (counts.length - 1) : 0;
  const cv = mean ? Math.sqrt(variance) / mean : 0;
  // 阈值比 Veridrop 宽松（他们比的是短回答的 token 数）：这里比的是可见输出，同一句话换个说法
  // 差个二三十%很正常；真正换了后端才会出现几倍的落差。
  const shape = !counts.length ? 0 : cv < 0.2 ? 40 : cv < 0.45 ? 20 : 0;
  const stable = { level: cv < 0.2 ? "good" : cv < 0.45 ? "warn" : "bad", text: cv < 0.2 ? "稳定" : cv < 0.45 ? "轻微抖动" : "抖得反常" };
  function gotEcho(rows) {
    return rows.some(function (row) { return row.ok; });
  }
  // 分开算「有回包」和「回包里有正文」：思考型模型在预算太小时会把 token 全烧在思考上，
  // content 空着、completion_tokens 三次都是同一个上限——那种「稳定」是假的，不该拿满分。
  const withText = goodEcho.filter(function (row) { return row.text; });
  let echoScore = (gotEcho(echoRows) ? 30 : 0) + (withText.length === 3 ? 30 : 0);
  echoScore += shape;
  const echoHit = [];
  if (servedSet.size > 1) {
    echoHit.push("三次回包的 model 字段不一样：" + Array.from(servedSet).join(" / "));
    note("major", "同一题连问三次，回包的 model 字段在变（" + Array.from(servedSet).join(" / ") + "），说明背后不止一个后端在轮转。");
  }
  const requested = String(model || "");
  const servedFirst = Array.from(servedSet)[0] || "";
  if (servedFirst && servedFirst !== requested && requested.indexOf("/") < 0) {
    echoHit.push("请求 " + requested + "，回包说自己是 " + servedFirst);
    note("major", "请求的是 " + requested + "，网关回包里的 model 却是 " + servedFirst + "，两者对不上。");
  }
  if (counts.length >= 2 && cv >= 0.3) {
    note("major", "三次同样温度的短回答，completion_tokens 抖到 " + (cv * 100).toFixed(0) + "%（" + counts.join(" / ") + "），正常模型重复回答这类小问题会很稳。");
  }
  checks.push({
    id: "echo",
    name: "回声一致性",
    weight: RELAY_WEIGHTS.echo,
    score: points(echoScore, RELAY_WEIGHTS.echo),
    pass: echoScore >= 70,
    detail:
      "同题三次（temperature 0）：" +
      (goodEcho.length ? goodEcho.length + "/3 有回包" : "全失败") +
      " · model 字段 " + (servedSet.size ? Array.from(servedSet).join(" / ") : "无") +
      " · 可见输出 tokens " + (counts.length ? counts.join(" / ") + "（CV " + (cv * 100).toFixed(0) + "%，" + stable.text + "）" : "未记录") +
      (goodEcho.length && withText.length < 3 ? " · 有 " + (3 - withText.length) + " 次正文是空的（预算烧在思考上，这一项只能算参考）" : ""),
    rows: echoRows.map(function (row) {
      return { label: "#" + row.index + " " + (row.served || "-"), ok: row.ok, text: row.completion === null ? "无 usage" : row.completion + " tok" };
    })
  });

  /* ---------- ② usage 记账方式（20 分） ---------- */
  const usages = echoCalls
    .concat([toolCall, jsonCall, plainCall])
    .map(function (call) {
      return (call.doc && call.doc.usage) || null;
    })
    .filter(Boolean);
  const keySet = new Set();
  usages.forEach(function (usage) {
    keysOf(usage).forEach(function (key) { keySet.add(key); });
  });
  const usageKeys = Array.from(keySet).sort();
  const joinedKeys = usageKeys.join(" ");
  const hasBasic = usageKeys.indexOf("prompt_tokens") >= 0 && usageKeys.indexOf("completion_tokens") >= 0;
  const hasTotal = usageKeys.indexOf("total_tokens") >= 0;
  // 什么才算「异源」：Anthropic 的**原始**记账形状（只有 input_tokens / output_tokens，
  // 没有 prompt_tokens 那一套），以及 usage 里直接出现 claude / anthropic 字样。
  // 注意 cache_read_input_tokens / cache_creation_input_tokens 这些**不算**：magpie 网关
  // 会给所有渠道加这组缓存统计（deepseek 实测就有），拿它当铁证会冤枉人。
  const rawAnthropic =
    usageKeys.indexOf("input_tokens") >= 0 && usageKeys.indexOf("output_tokens") >= 0 && !hasBasic;
  const claudeSmell = CLAUDE_HINT.test(joinedKeys) || rawAnthropic;
  const extras = usageKeys.filter(function (key) {
    return OFFICIAL_USAGE.indexOf(key.split(".")[0]) < 0;
  });
  const usageRows = [];
  let usageScore = 0;
  if (hasBasic) usageScore += 40;
  usageRows.push({ label: "prompt_tokens / completion_tokens", ok: hasBasic, text: hasBasic ? "在" : "缺（OpenAI 协议必有）" });
  if (hasTotal) usageScore += 15;
  usageRows.push({ label: "total_tokens", ok: hasTotal, text: hasTotal ? "在" : "缺" });
  const sums = usages.filter(function (usage) {
    return typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number" && typeof usage.total_tokens === "number";
  });
  const sumOk = sums.length ? sums.every(function (usage) {
    return usage.total_tokens === usage.prompt_tokens + usage.completion_tokens;
  }) : false;
  if (sumOk) usageScore += 20;
  usageRows.push({ label: "total = prompt + completion", ok: sumOk, text: sums.length ? (sumOk ? "等式成立" : "对不上") : "字段不全，算不了" });
  const usageClean = !claudeSmell;
  if (usageClean) usageScore += 25;
  usageRows.push({
    label: "没有 Anthropic 原始记账",
    ok: usageClean,
    text: rawAnthropic
      ? "只有 input_tokens / output_tokens：这是 Anthropic 的形状"
      : claudeSmell
        ? "usage 里出现了 claude / anthropic 字样"
        : "干净"
  });
  if (extras.length) {
    usageRows.push({
      label: "网关扩展字段",
      ok: true,
      text: extras.length + " 个（" + extras.slice(0, 6).join(" / ") + (extras.length > 6 ? " …" : "") + "）：网关自己加的统计，不算造假"
    });
  }
  if (rawAnthropic || CLAUDE_HINT.test(joinedKeys)) {
    // magpie 会把 Claude / Gemini / DeepSeek 的记账翻成 OpenAI 形状，翻不干净时留下来的是原厂字段。
    // 所以这只说明「上游是谁」，不说明「有人冒充 OpenAI」——按 major 提示，不给篡改结论。
    note(
      "major",
      "usage 是 Anthropic 的记账形状（" + (usageKeys.indexOf("input_tokens") >= 0 && usageKeys.indexOf("output_tokens") >= 0 ? "input_tokens / output_tokens" : "claude/anthropic 字样") + "）：这条链路的上游其实是 Claude（magpie 转发时没把这些记账字段翻干净）。这是转发层的正常现象，不是造假证据。"
    );
  } else if (extras.length) {
    note("major", "usage 里有 " + extras.length + " 个非官方字段（" + extras.slice(0, 6).join(" / ") + "）：网关做了改写，价格与缓存统计可能不是模型自己给的。");
  }
  const reasoning = usages.some(function (usage) {
    const details = usage.completion_tokens_details || {};
    return typeof details.reasoning_tokens === "number" && details.reasoning_tokens > 0;
  });
  usageRows.push({
    label: "completion_tokens_details.reasoning_tokens",
    ok: reasoning,
    text: reasoning ? "有（思考另算）" : "没有（不代表假，很多网关不细分）"
  });
  checks.push({
    id: "usage",
    name: "usage 记账",
    weight: RELAY_WEIGHTS.usage,
    score: points(usageScore, RELAY_WEIGHTS.usage),
    pass: usageScore >= 70 && usageClean,
    detail: usageKeys.length ? "收到的 usage 字段：" + usageKeys.join("、") : "整批响应都没有 usage（不少转发层就不回 usage，只能算一项差异，不能单独当证据）",
    rows: usageRows
  });

  /* ---------- ③ 工具调用（20 分） ---------- */
  const toolDetail = toolCallRows(toolCall, "get_current_weather");
  const toolPass = toolDetail.rows.filter(function (row) { return row.ok; }).length;
  // 注意：这里和别的项一样给**百分比**（0–100），由 points() 折算成权重分。
  // 第一版直接乘了 20，结果 6/6 全对只拿到 4/20。
  const toolScore = Math.round((toolPass / toolDetail.rows.length) * 100);
  if (!toolDetail.rows[0].ok) {
    note("major", "强制 tool_choice 之后仍然只回文字、没有 tool_calls：这条链路并不真的支持函数调用。");
  } else if (!toolDetail.rows[1].ok) {
    note(
      "minor",
      "tool_calls 的 id 不是 call_ 开头（" + toolDetail.rows[1].text + "）：与 OpenAI 官方格式不同（官方用 call_ 前缀）。兼容层普遍自己生成 id，这本身不说明任何问题。"
    );
  }
  checks.push({
    id: "tools",
    name: "函数调用",
    weight: RELAY_WEIGHTS.tools,
    score: points(toolScore, RELAY_WEIGHTS.tools),
    pass: toolScore >= 70,
    detail: "tools + 强制 tool_choice，检查 " + toolDetail.rows.length + " 项协议细节里的 " + toolPass + " 项",
    rows: toolDetail.rows
  });

  /* ---------- ④ 结构化输出（20 分） ---------- */
  const jsonGot = messageOf(jsonCall);
  const jsonText = String((jsonGot.message && jsonGot.message.content) || "");
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(jsonText.trim());
  } catch {
    parsedJson = null;
  }
  const fenced = jsonText.indexOf(FENCE) >= 0;
  const fieldsOk = !!parsedJson && parsedJson.ok === true && parsedJson.nonce === NONCE;
  const finishOk = jsonGot.finish === "stop" || jsonGot.finish === "";
  const jsonScore = (parsedJson ? 40 : 0) + (fieldsOk ? 50 : 0) + (finishOk ? 10 : 0);
  if (!parsedJson) {
    note("major", "要求严格 JSON 之后交回来的不是 JSON" + (fenced ? "（而是 markdown 代码块）" : "") + "：" + clip(jsonText, 80));
  } else if (!fieldsOk) {
    note("major", "JSON 能解析，但字段不符合 schema（ok=" + String(parsedJson.ok) + "，nonce=" + String(parsedJson.nonce) + "）：说明 response_format 只是被「看起来像」地执行了。");
  }
  checks.push({
    id: "json",
    name: "结构化输出",
    weight: RELAY_WEIGHTS.json,
    score: points(jsonScore, RELAY_WEIGHTS.json),
    pass: jsonScore >= 80,
    detail: "response_format=json_schema(strict)，要求 ok=true 且 nonce 与请求一致 · finish_reason=" + (jsonGot.finish || "空"),
    rows: [
      { label: "能解析成 JSON", ok: !!parsedJson, text: parsedJson ? "是" : fenced ? "是代码块，不是纯 JSON" : clip(jsonText, 80) || "空回答" },
      { label: "字段符合 schema", ok: fieldsOk, text: fieldsOk ? "ok=true / nonce 对" : clip(jsonText, 90) },
      { label: "finish_reason ∈ {stop, 空}", ok: finishOk, text: jsonGot.finish || "空" }
    ]
  });

  /* ---------- ⑤ 流式一致性（25 分） ---------- */
  const plainText = (messageOf(plainCall).message && messageOf(plainCall).message.content) || "";
  const plainFinish = messageOf(plainCall).finish;
  const streamTextOk = !!streamCall.text.trim();
  const textMatch = !!plainText.trim() && normalize(plainText) === normalize(streamCall.text);
  const finishMatch = plainFinish === streamCall.finish;
  const streamUsage = !!streamCall.usage;
  const plainUsage = !!((plainCall.doc && plainCall.doc.usage) || null);
  const usageMatch = streamUsage && plainUsage;
  const streamScore =
    (plainText.trim() ? 15 : 0) + (streamTextOk ? 20 : 0) + (textMatch ? 30 : 0) + (finishMatch ? 15 : 0) + (streamUsage ? 10 : 0) + (usageMatch ? 10 : 0);
  if (!streamTextOk) {
    note("major", "流式请求没有收到任何内容（status " + streamCall.status + "）：这条链路要么不支持 stream，要么把它当非流式吞了。");
  } else if (!textMatch) {
    note("major", "同一句话，非流式回的是「" + clip(plainText, 40) + "」，流式拼出来的是「" + clip(streamCall.text, 40) + "」：两条路不是一个后端。");
  }
  if (!streamUsage) {
    note("major", "流式响应里没有 usage（即使带了 stream_options.include_usage）：多是中间层自己拼的 SSE，而不是官方实现。");
  }
  checks.push({
    id: "stream",
    name: "流式一致性",
    weight: RELAY_WEIGHTS.stream,
    score: points(streamScore, RELAY_WEIGHTS.stream),
    pass: streamScore >= 70,
    detail: "同一句「" + PING + "」分别走非流式与流式，比文本、finish_reason 与 usage · 收到 " + streamCall.chunks + " 个 SSE 分片",
    rows: [
      { label: "非流式有内容", ok: !!plainText.trim(), text: clip(plainText, 70) || "空" },
      { label: "流式有内容", ok: streamTextOk, text: clip(streamCall.text, 70) || "空" },
      { label: "两边文本一致", ok: textMatch, text: textMatch ? "一致" : "不一致" },
      { label: "finish_reason 一致", ok: finishMatch, text: (plainFinish || "空") + " vs " + (streamCall.finish || "空") },
      { label: "流式带 usage", ok: streamUsage, text: streamUsage ? "带" : "没带" }
    ]
  });

  const score = Math.round(checks.reduce(function (sum, check) {
    return sum + check.score;
  }, 0));
  // 结论只说「与 OpenAI 官方格式的接近程度」，不说「谁在造假」：
  // magpie 本身就把 Claude / Gemini / DeepSeek / 插件供应商翻成 OpenAI 形状，
  // 用「不是逐字节 OpenAI」去判篡改，会把用户自己合法的订阅判成假货。
  const critical = findings.filter(function (item) { return item.level === "critical"; }).length;
  const verdict = critical ? "differs" : score >= 80 ? "clean" : score >= 55 ? "suspicious" : "differs";
  const verdictLabel =
    verdict === "clean" ? "符合 OpenAI 格式" : verdict === "suspicious" ? "与 OpenAI 格式有出入" : "与 OpenAI 格式差别较大";
  const signals = checks.map(function (check) {
    return {
      name: check.name,
      value: check.score + " / " + check.weight,
      tone: check.pass ? "good" : check.score >= check.weight * 0.5 ? "warn" : "bad",
      note: check.detail
    };
  });
  return {
    id: "relay",
    ok: checks.some(function (check) { return check.score > 0; }),
    model,
    ms: Date.now() - started,
    score,
    verdict,
    verdictLabel,
    checks,
    findings,
    usageKeys,
    samples: { echo: echoRows, plain: clip(plainText, 200), stream: clip(streamCall.text, 200), json: clip(jsonText, 200) },
    error: [].concat(echoCalls, [toolCall, jsonCall, plainCall, streamCall]).map(function (call) { return call.error; }).filter(Boolean).join(" | "),
    footnote:
      "检测维度参考 Veridrop（AGPL-3.0）的公开方法，用 JS 重写：回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性。" +
      "分数是「与 OpenAI 官方格式的接近程度」的加权，不是概率，也不是「有没有作弊」的判定：" +
      "magpie 本身会把 Claude / Gemini / DeepSeek / 插件供应商翻译成 OpenAI 形状，格式差异是转发层的常态。"
  };
}

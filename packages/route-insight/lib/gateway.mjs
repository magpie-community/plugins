import fs from "node:fs";
import path from "node:path";

// 检测都直接打 magpie 网关：一次检测就是一次真实请求，会花积分。
// 单独放一个文件，是因为「数值指纹」也要用同一套请求方式，而 lab.mjs 又要反过来 import 它。
export const GATEWAY = process.env.MAGPIE_ROUTE_INSIGHT_GATEWAY || "http://127.0.0.1:3425";
export const AUTH = { authorization: "Bearer magpie", "x-openai-actor-authorization": "magpie" };

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 一次检测最多发多少次请求。数值指纹 ≤24 次、协议审计 7 次、动画 1–2 次，
// 三项一起跑最坏三十几次；给 40 次硬顶，超了就不再发出去——一次点击不该能把额度刷穿。
export const RUN_REQUEST_LIMIT = 40;
let runBudget = null;
export function openBudget(limit) {
  runBudget = { limit: Number(limit) > 0 ? Number(limit) : RUN_REQUEST_LIMIT, used: 0 };
  return runBudget;
}
export function closeBudget() {
  const spent = runBudget ? runBudget.used : 0;
  runBudget = null;
  return spent;
}

// maxTokens 传 0 表示「不设上限」——数数挑战（要 300 多个数字）必须这样：
// 一带上限，花在思考里的 token 把预算吃光，content 就是空的，网关还会报 502。
export async function ask(model, prompt, options) {
  const opts = options || {};
  const maxTokens = opts.maxTokens === 0 ? 0 : opts.maxTokens || 1200;
  const timeoutMs = opts.timeoutMs || 180000;
  const started = Date.now();
  if (runBudget) {
    if (runBudget.used >= runBudget.limit) {
      return {
        ok: false,
        status: 0,
        ms: 0,
        timeout: false,
        timeoutMs,
        finish: "",
        text: "",
        usage: null,
        served: model,
        budgeted: true,
        error: "这次检测的请求次数到上限了（最多 " + runBudget.limit + " 次），后面的没再发出去"
      };
    }
    runBudget.used += 1;
  }
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  try {
    const payload = {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false
    };
    if (maxTokens) payload.max_tokens = maxTokens;
    if (typeof opts.temperature === "number") payload.temperature = opts.temperature;
    // 推理强度：网关按 OpenAI 的 reasoning_effort 收（实测 high / xhigh 都吃），
    // 传空就等于「用这条线的默认档」。
    if (opts.effort && opts.effort !== "default") payload.reasoning_effort = String(opts.effort);
    const res = await fetch(GATEWAY + "/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, AUTH),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const raw = await res.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const choice = (body && body.choices && body.choices[0]) || null;
    const message = choice && choice.message;
    return {
      ok: !!res.ok && !!message,
      status: res.status,
      ms: Date.now() - started,
      timeout: false,
      timeoutMs,
      // finish_reason 是判断「这份回答写完没有」的关键：length 就是被 max_tokens 截断，
      // 没有它只能靠数正文猜，猜错就会把半张画当成模型画得差。
      finish: (choice && choice.finish_reason) || "",
      text: (message && message.content) || "",
      usage: (body && body.usage) || null,
      served: (body && body.model) || model,
      error: res.ok ? "" : clip(raw, 300)
    };
  } catch (error) {
    // AbortController 掐断时 fetch 只会抛一句 "This operation was aborted"，
    // 用户看到的就是「The operation was aborted.」——既不知道是自己网络还是等太久。
    // 这里把「等了多久」写进错误里，界面直接就能显示，不再靠猜。
    const aborted = controller.signal.aborted;
    const seconds = Math.round(timeoutMs / 1000);
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      text: "",
      usage: null,
      finish: "",
      served: model,
      timeout: aborted,
      timeoutMs,
      error: aborted
        ? "等了 " + seconds + " 秒还没返回完，请求已被中断（不是报错，是这一趟太长没跑完）"
        : String((error && error.message) || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

// QianwenSession —— 纯 HTTP 接入千问 App (com.alibaba.tongyi) 网页端。
// 逆向 Baxia 签名：register 换 token 池 → 本地 HMAC-SHA256 签名 → 直接 POST /api/v2/chat。
// 不启动任何浏览器，不依赖网页 DOM，首次注册后缓存 token 池复用。
import { randomUUID, createHmac, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execute = promisify(execFile);

export const SITE = "https://www.qianwen.com/";
const REGISTER = "https://sec.qianwen.com/security/external/access/register";
const CHAT = "https://chat2.qianwen.com/api/v2/chat";
const MODEL_LIST = "https://chat2-api.qianwen.com/api/v1/model/list";
// App/会员实际使用的模型面板接口：返回带会员模型（Qwen4-Max 等）的完整清单
const MODEL_PANEL = "https://qwen-agent-api.qianwen.com/api/v1/agent/model/panel";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 签名参数顺序（逆向自网页 pre.js；服务端按此拼装验签）
const QUERY_PARAM_KEYS = "biz_id,chat_client,device,fe_version,fr,la,nonce,pr,timestamp,tz,ut,ve,wv";
const SIGN_VERSION = "2.9.3"; // eo-clt-acs-ve 前端签名版本

function randomString(n = 11) {
  const cs = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += cs[Math.floor(Math.random() * cs.length)];
  return s;
}
function hmacB64(key, msg) {
  return createHmac("sha256", key).update(msg, "utf8").digest("base64");
}

function uvPath() {
  return process.env.QIANWEN_UV || `${homedir()}/.local/bin/uv`;
}

async function importDesktop() {
  const helper = fileURLToPath(new URL("./scripts/desktop_session.py", import.meta.url));
  const bin = uvPath();
  let result;
  try {
    result = await execute(bin, ["run", "--no-project", "--script", helper], {
      timeout: 90000, maxBuffer: 4 * 1024 * 1024, env: process.env,
    });
  } catch (error) {
    throw new Error(`读取千问桌面登录失败：${error.stderr || error.message}`);
  }
  return JSON.parse(result.stdout);
}

function stateFile(profile) {
  const dir = join(homedir(), ".config", "magpie", "qianwen");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, `baxia-${profile}.json`);
}

export class QianwenSession {
  constructor(binding = {}, options = {}) {
    this.binding = binding;
    this.options = options;
    this.profile = binding.profile || "Default";
    this.cookies = null;
    this.kp = "";
    this.xsrf = "";
    this.deviceId = "";
    this.actkn = "";
    this.snver = "";
    this.sacsftPool = [];
    this.initialized = false;
    this.busy = false;
    this.pending = null;
    // 多轮会话：sessionKey -> { sessionId, topicId, lastReqId }
    // 服务端靠 parent_req_id 链维护上下文，lastReqId 是上一轮的 req_id
    this.conversations = new Map();
    this._state = stateFile(this.profile);
  }

  async ready(signal) {
    signal?.throwIfAborted();
    if (this.initialized) return;
    this.pending ??= this.initialize().finally(() => { this.pending = undefined; });
    await this.pending;
    signal?.throwIfAborted();
  }

  _loadState() {
    try {
      const s = JSON.parse(readFileSync(this._state, "utf8"));
      if (s.deviceId && s.actkn && Array.isArray(s.sacsftPool) && s.sacsftPool.length) {
        this.deviceId = s.deviceId;
        this.actkn = s.actkn;
        this.snver = s.snver || "lv";
        this.sacsftPool = s.sacsftPool;
        this.initialized = true;
      }
    } catch {}
  }

  _saveState() {
    try {
      writeFileSync(this._state, JSON.stringify({
        deviceId: this.deviceId, actkn: this.actkn, snver: this.snver,
        sacsftPool: this.sacsftPool, savedAt: Date.now(),
      }), { mode: 0o600 });
    } catch {}
  }

  async initialize() {
    // 1. 读桌面登录态
    const local = await importDesktop();
    const seen = new Map();
    for (const c of local.cookies) {
      if (c.value && !seen.has(c.name)) seen.set(c.name, c.value);
    }
    this.cookies = [...seen].map(([k, v]) => `${k}=${v}`).join("; ");
    this.kp = seen.get("tongyi_sso_ticket_hash") || "";
    this.xsrf = seen.get("XSRF-TOKEN") || "";
    this.clientVersion = local.clientVersion;
    if (!this.kp) throw new Error("千问登录态缺少 tongyi_sso_ticket_hash，请重新登录客户端");

    // 2. 尝试恢复缓存的注册态
    this._loadState();
    if (this.initialized) return;
    await this.register();
  }

  async register() {
    const chid = randomString(11);
    const fingerprint = createHash("md5").update(`${Math.random()}${Date.now()}`).digest("hex");
    const body = {
      screenResolution: "1920x1080", cookieEnabled: true, localStorageEnabled: true,
      timezoneOffset: -480, fontList: [], pluginList: [], language: ["zh-CN"],
      unifyRelateGenerate: [], fingerprint, businessScene: "qwen_web", chid,
    };
    const headers = {
      "Content-Type": "application/json", "User-Agent": UA,
      "Origin": "https://www.qianwen.com", "Referer": "https://www.qianwen.com/",
      "Cookie": this.cookies, "bx-umidtoken": "", "eo-clt-sftcnt": "100",
      "clt-acs-caer": "vrad", "eo-clt-acs-bx-intss": "2",
    };
    const resp = await fetch(`${REGISTER}?chid=${chid}`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Baxia 注册 HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.status !== 0) throw new Error(`Baxia 注册失败：${data.msg || data.code || "unknown"}`);

    const root = data.data || {};
    const rel = Array.isArray(root.unifyRelate) ? root.unifyRelate : [];
    const pool = rel.find((r) => r.businessScene === "qwen_chat")
      || rel.find((r) => r.businessScene === "qwen_web_capsule")
      || rel[0] || root;
    this.deviceId = root["eo-clt-dvidn"] || pool["eo-clt-dvidn"] || "";
    this.actkn = pool["eo-clt-actkn"] || root["eo-clt-actkn"] || "";
    this.snver = pool["eo-clt-snver"] || root["eo-clt-snver"] || "lv";
    this.sacsftPool = pool["eo-clt-bacsft"] || pool["eo-clt-sacsft"] || root["eo-clt-bacsft"] || [];
    if (!this.deviceId || !this.actkn || !this.sacsftPool.length) {
      throw new Error("Baxia 注册返回缺少设备标识或 token 池");
    }
    this.initialized = true;
    this._saveState();
  }

  _sessionFor(messages) {
    // 用第一条消息做稳定锚点：同一对话链无论追加多少轮，首条消息恒定，key 不变
    const first = messages[0] || { role: "user", content: "" };
    const key = `${first.role}:${String(first.content || "").slice(0, 160)}`;
    let s = this.conversations.get(key);
    if (!s) {
      s = { sessionId: randomUUID().replaceAll("-", ""), topicId: randomUUID().replaceAll("-", "").slice(0, 32), lastReqId: "0" };
      this.conversations.set(key, s);
      if (this.conversations.size > 200) this.conversations.delete(this.conversations.keys().next().value);
    }
    return s;
  }

  _sign(bodyStr) {
    if (!this.sacsftPool.length) throw new Error("Baxia token 池已耗尽，请重新初始化");
    const timestamp = String(Date.now());
    const sacsft = this.sacsftPool.shift();
    const bodyKey = `${sacsft}:${timestamp}`;
    const bodyHmac = hmacB64(bodyKey, bodyStr);
    const signText = `${this.deviceId}${SIGN_VERSION}${this.kp}${QUERY_PARAM_KEYS}${bodyHmac}`;
    const sign = hmacB64(bodyKey, signText);
    if (this.sacsftPool.length < 5) this.register().catch(() => {});
    return { timestamp, sacsft, sign };
  }

  // 模型列表：优先用 App/会员实际使用的 panel 接口（含 Qwen4-Max 等会员模型），
  // 失败时回退到旧的 H5 model/list 接口。纯 HTTP，无需浏览器。
  async models(signal) {
    signal?.throwIfAborted();
    await this.ready(signal);
    const p = new URLSearchParams({
      biz_id: "ai_qwen", chat_client: "h5", device: "pc", fr: "pc", pr: "qwen",
      ut: this.deviceId, la: "zh-CN", tz: "Asia/Shanghai", wv: "4.14.8", tq: "SD", ve: "4.14.8",
    });
    const headers = {
      "X-XSRF-TOKEN": this.xsrf, "Accept": "application/json",
      "Cookie": this.cookies, "User-Agent": UA,
      "Origin": "https://www.qianwen.com", "Referer": "https://www.qianwen.com/",
    };
    const fetchJson = async (url) => {
      const resp = await fetch(`${url}?${p.toString()}`, {
        headers, signal: signal || AbortSignal.timeout(20000),
      });
      if (!resp.ok) return null;
      try { return await resp.json(); } catch { return null; }
    };

    // 主接口：agent model panel。返回 data.models[]，字段 model/name/show/defaultModel。
    try {
      const data = await fetchJson(MODEL_PANEL);
      const list = data?.data?.models;
      if (data?.success && Array.isArray(list) && list.length) {
        const out = list.filter((m) => m.show !== false).map((m) => ({
          id: m.model,
          name: (m.name || m.model || "").trim(),
          default: !!m.defaultModel,
        })).filter((m) => m.id);
        if (out.length) return out;
      }
    } catch { /* 落到旧接口 */ }

    // 回退：旧 H5 model/list。字段 modelCode/legacyModelCode、displayModelName。
    const data = await fetchJson(MODEL_LIST);
    if (data?.success && Array.isArray(data.data)) {
      return data.data.filter((m) => m.show !== false).map((m) => ({
        id: m.modelCode || m.legacyModelCode,
        name: (m.displayModelName || m.modelCode || "").trim(),
        default: !!m.defaultModel,
      })).filter((m) => m.id);
    }
    throw new Error(`模型列表失败：${data?.msg || data?.errorMsg || "未知错误"}`);
  }

  // 发送对话，返回 AI 回复文本
  async sendMessage(text, { messages = [], model = "Qwen" } = {}, signal) {
    signal?.throwIfAborted();
    await this.ready(signal);
    if (this.busy) throw new Error("千问上一条对话尚未结束，请稍后重试");
    this.busy = true;
    try {
      const pairs = messages.length
        ? messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }))
        : [{ role: "user", content: text }];
      const sess = this._sessionFor(pairs);
      const reqId = randomUUID().replaceAll("-", "").slice(0, 32);
      const parentReqId = sess.lastReqId;
      // 服务端靠 parent_req_id 链维护上下文；每轮只发当前用户消息，避免重复传历史。
      const qwenMessages = [{
        mime_type: "text/plain", content: text,
        meta_data: { ori_query: text }, status: "complete",
      }];
      const body = {
        req_id: reqId, parent_req_id: parentReqId,
        relate_req_id: randomUUID().replaceAll("-", ""),
        messages: qwenMessages, scene: "chat", sub_scene: "", scene_param: "",
        operation_type: "send", session_id: sess.sessionId, biz_id: "ai_qwen",
        topic_id: sess.topicId, model, from: "default", protocol_version: "v2",
        messages_merge: false, chat_client: "h5", deep_search: "0", ai_tool_scene: "",
      };
      const bodyStr = JSON.stringify(body);
      const { timestamp, sacsft, sign } = this._sign(bodyStr);
      const nonce = randomString(11);
      const urlParams = `biz_id=ai_qwen&chat_client=h5&device=pc&fe_version=1.0.0&fr=h5&la=zh-CN&nonce=${nonce}&pr=qwen&timestamp=${timestamp}&tz=Asia%2FShanghai&ut=${this.deviceId}&ve=${SIGN_VERSION}&wv=${SIGN_VERSION}`;
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream, text/plain, */*",
        "User-Agent": UA, "Origin": "https://www.qianwen.com",
        "Referer": `https://www.qianwen.com/chat/${sess.sessionId}`,
        "Cookie": this.cookies,
        "x-device-id": this.deviceId, "x-chat-id": reqId, "x-platform": "pc_tongyi",
        "x-csrf-token": this.xsrf,
        "clt-acs-sign": sign, "clt-acs-reqt": timestamp,
        "clt-acs-request-params": QUERY_PARAM_KEYS,
        "eo-clt-dvidn": this.deviceId, "eo-clt-sacsft": sacsft,
        "eo-clt-snver": this.snver, "eo-clt-actkn": this.actkn,
        "eo-clt-acs-ve": SIGN_VERSION, "clt-acs-caer": "vrad", "eo-clt-acs-kp": this.kp,
      };
      const resp = await fetch(`${CHAT}?${urlParams}`, {
        method: "POST", headers, body: bodyStr,
        signal: signal || AbortSignal.timeout(120000),
      });
      const out = await resp.text();
      // 风控拦截（验证码/限流）：识别后给出明确提示，由上层决定是否退避重试
      if (out.includes("FAIL_SYS_USER_VALIDATE") || out.includes("RGV587_ERROR") || out.includes("_____tmd_____")) {
        const err = new Error("千问触发风控验证（请求过于频繁），请稍后再试；在千问网页完成一次验证可立即解除。");
        err.rateLimited = true;
        throw err;
      }
      if (!resp.ok) {
        let detail = out.slice(0, 300);
        try { const j = JSON.parse(out); detail = j.msg || j.message || detail; } catch {}
        throw new Error(`千问对话 HTTP ${resp.status}：${detail}`);
      }
      let reply = "";
      for (const line of out.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const s = line.slice(5).trim();
        if (!s || s === "true" || s === "[DONE]") continue;
        try {
          const j = JSON.parse(s);
          if (j?.error_msg && j.error_msg !== "ok" && j.error_msg !== "") {
            throw new Error(`千问返回错误：${j.error_msg}`);
          }
          const msgs = j?.data?.messages || j?.messages || [];
          for (const m of msgs) {
            if (m.content && m.mime_type !== "signal/post") reply = m.content;
          }
        } catch (e) {
          if (e.message.startsWith("千问返回错误")) throw e;
        }
      }
      if (!reply) throw new Error("千问未返回有效回复");
      sess.lastReqId = reqId; // 供下一轮作为 parent_req_id 串联上下文
      return reply;
    } finally {
      this.busy = false;
    }
  }

  async close() {
    // 纯 HTTP 模式无浏览器进程可关闭；token 池已落盘，下次直接复用。
  }
}

// 兼容旧调用点（保留导出，避免 index.mjs 报错）
export function browserBin() {
  return ""; // 新方案不使用浏览器内核
}

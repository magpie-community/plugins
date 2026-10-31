// 豆包生图协议核心。
//
// 两条通道（协议真值来源见 README 的“参考实现”一节，均为 2026 年抓包结论）：
//   web: POST /chat/completion  chat_ability 新协议（aid=497858，免签名），
//        模型/比例精确选择；SSE 事件 SSE_ACK / STREAM_CHUNK / SSE_REPLY_END，
//        图片在 block_type=2074 creation_block 里。
//   pc : POST /samantha/chat/completion  旧 agent 通道（aid=582478，pc_client），
//        content_type=2009 + skill_type=3，响应 content_type=2010。
//        图生图（参考图）只走此通道。
// channel=auto 时先 web 后 pc（风控除外）；参考图存在时只走 pc。
import { randomUUID } from "node:crypto";
import {
  BASE_URL,
  baseHeaders,
  SSE_HEADERS,
  DoubaoError,
  DoubaoAuthError,
  DoubaoRiskError,
  RISK_CODES,
  AUTH_CODES,
  riskHint,
  FP,
  CHROMIUM_VERSION,
} from "./http.mjs";
import { uploadRefImages } from "./upload.mjs";

export const EXTENSION_BOT_ID = "7338286299411103781"; // 多模态扩展 bot（doubao2api 真值）
export const FREE_MODELS = ["Seedream 5.0 Flash", "Seedream 4.5", "Seedream 4.0"];
export const DEFAULT_MODEL = "Seedream 5.0 Flash";
export const RATIOS = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"];

// —— 各端点共用的 query 参数（抓包真值；多为埋点字段，服务端主要看 cookie/aid/头） ——
export function securityParams(profile) {
  const common = {
    device_id: "714003710229497",
    tea_uuid: "714003710229497",
    web_id: "7604137868021548590",
    device_platform: "web",
    language: "zh",
    region: "CN",
    sys_region: "CN",
    pkg_type: "release_version",
    runtime: "web",
    runtime_version: "3.5.4",
    samantha_web: "1",
    "use-olympus-account": "1",
    fp: FP,
    web_tab_id: randomUUID(),
  };
  const byProfile =
    profile === "web"
      ? {
          aid: "497858",
          real_aid: "497858",
          doubao_pc_version: "3.41.4",
          pc_version: "3.41.4",
          version_code: "341400",
          client_platform: "web",
        }
      : {
          aid: "582478",
          real_aid: "582478",
          version_code: "20800",
          pc_version: "2.1.7",
          chromium_version: CHROMIUM_VERSION,
          client_platform: "pc_client",
        };
  return { ...common, ...byProfile };
}

export function normalizeRatio(ratio, fallback = "1:1") {
  const r = String(ratio || "").trim();
  return RATIOS.includes(r) ? r : fallback;
}

// —————————————————————————— SSE 解析 ——————————————————————————

/** 把原始 SSE 文本切成 {event, data, json} 块（兼容多行 data:）。 */
export function parseSseBlocks(raw) {
  const blocks = [];
  for (const block of String(raw).split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines = [];
    for (const line of block.replace(/\r/g, "").split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) continue;
    const data = dataLines.join("\n");
    let json = null;
    try {
      json = JSON.parse(data);
    } catch {
      try {
        json = JSON.parse(dataLines[dataLines.length - 1]);
      } catch {
        /* 非 JSON 数据块，忽略 */
      }
    }
    blocks.push({ event, data, json });
  }
  return blocks;
}

/** 响应若是 JSON 错误体（非 SSE），按错误码分类抛出。 */
function assertNotJsonError(raw) {
  const trimmed = String(raw || "").trimStart();
  if (!trimmed.startsWith("{")) return;
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!obj || typeof obj !== "object" || !("code" in obj)) return;
  throwCodeError(Number(obj.code) || 0, String(obj.msg || obj.message || ""));
}

function throwCodeError(code, msg) {
  const short = msg.slice(0, 300);
  if (RISK_CODES.has(code)) throw new DoubaoRiskError(`豆包风控拦截 (code=${code}) ${short}`, riskHint());
  if (AUTH_CODES.has(code)) throw new DoubaoAuthError(`豆包登录态失效 (code=${code}) ${short}`);
  if (code) throw new DoubaoError(`豆包接口错误 (code=${code}) ${short}`);
  throw new DoubaoError(`豆包接口错误 ${short}`);
}

function throwGatewayError(json) {
  const code = Number(json?.code) || 0;
  const msg = String(json?.message ?? json?.msg ?? "").slice(0, 300);
  if (AUTH_CODES.has(code) || /登录|过期|invalid user/i.test(msg)) {
    throw new DoubaoAuthError(`豆包登录态失效 (gateway-error code=${code}) ${msg}`);
  }
  if (RISK_CODES.has(code)) throw new DoubaoRiskError(`豆包风控拦截 (code=${code})`, riskHint());
  throw new DoubaoError(`豆包网关错误 (gateway-error code=${code}) ${msg}`);
}

const PC_IMAGE_ORDER = ["image_ori", "image_raw", "image_thumb"]; // pc 通道 ori 为最高清下载档
const WEB_IMAGE_ORDER = ["image_raw", "image_ori", "image_thumb"]; // web 通道 image_raw 为无水印档

/** 从一个图片资源对象里挑出最优 URL（按通道优先级）。 */
function pickImageVariants(item, order) {
  if (!item || typeof item !== "object") return null;
  const cands = [];
  const push = (o) => {
    if (o && typeof o === "object" && typeof o.url === "string" && o.url.startsWith("http")) cands.push(o);
  };
  for (const key of order) push(item[key]);
  for (const key of ["ori_url", "raw_url", "thumb_url", "url"]) {
    if (typeof item[key] === "string" && item[key].startsWith("http")) cands.push({ url: item[key], width: item.width, height: item.height, format: item.format });
  }
  const best = cands[0];
  if (!best) return null;
  return {
    url: best.url,
    width: Number(best.width || 0) || 0,
    height: Number(best.height || 0) || 0,
    format: best.format || item.format || "",
    key: item.key || "",
  };
}

/** 深度兜底：全树找 block_type=2074 的 creation 块。 */
function deepFindCreations(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) deepFindCreations(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.block_type === 2074 && Array.isArray(node.content?.creation_block?.creations)) {
    out.push(...node.content.creation_block.creations);
    return;
  }
  for (const v of Object.values(node)) deepFindCreations(v, out);
}

function noImagesMessage(texts) {
  const joined = texts.join(" ").replace(/\s+/g, " ").trim();
  if (/订阅|专属|标准套餐/.test(joined)) {
    return `所选模型需要豆包订阅，当前账号不可用。${joined.slice(0, 200)}`;
  }
  if (joined) return `豆包未返回图片。${joined.slice(0, 300)}`;
  return "豆包未返回图片。";
}

// —————————————————————————— pc 通道（samantha-2009，抓包真值） ——————————————————————————

export function parsePcImages(raw) {
  assertNotJsonError(raw);
  const images = [];
  const texts = [];
  for (const { event, json } of parseSseBlocks(raw)) {
    if (event === "gateway-error") throwGatewayError(json);
    if (!json || typeof json !== "object") continue;
    const eventType = json.event_type;
    if (eventType === 2005) {
      const detail = String(json.event_data ?? "").slice(0, 300);
      if (RISK_CODES.has(Number(json.code) || 0)) throw new DoubaoRiskError(`豆包风控拦截 ${detail}`, riskHint());
      throw new DoubaoError(`豆包生图失败: ${detail}`);
    }
    if (eventType !== 2001) continue;
    let ed = json.event_data;
    if (typeof ed === "string") {
      try {
        ed = JSON.parse(ed);
      } catch {
        continue;
      }
    }
    const msg = ed?.message || {};
    let content = msg.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        continue;
      }
    }
    if (msg.content_type === 2010 && Array.isArray(content?.data)) {
      for (const item of content.data) {
        const img = pickImageVariants(item, PC_IMAGE_ORDER);
        if (img) images.push(img);
      }
    } else if (content?.text) {
      texts.push(String(content.text));
    }
  }
  if (!images.length) throw new DoubaoError(noImagesMessage(texts));
  return { images, text: texts.join("") };
}

export async function generateViaPc(cfg, account, { prompt, ratio }, refs = []) {
  const content = { text: prompt };
  if (ratio && ratio !== "auto") content.ratio = ratio;
  const message = {
    content: JSON.stringify(content),
    content_type: 2009, // SamanthaImageInput
    attachments: refs.map((r) => ({ type: "image", key: r.uri, extra: { refer_types: "overall" } })),
    references: [],
    skill: { skill_type: 3, skill_type_no_default: 3, skill_id: "3", skill_id_no_default: "3" },
  };
  const body = {
    messages: [message],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      is_ai_playground: false,
      memory_type: 2,
      message_from: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      action_bar_skill_id: 3,
    },
    evaluate_option: { web_ab_params: "" },
    local_conversation_id: randomUUID(),
    local_message_id: randomUUID(),
  };
  const url = `${BASE_URL}/samantha/chat/completion?${new URLSearchParams(securityParams("pc"))}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: baseHeaders(account, SSE_HEADERS),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((cfg.timeoutSeconds || 180) * 1000),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    assertNotJsonError(raw);
    throw new DoubaoError(`samantha 接口请求失败 (${resp.status}): ${raw.slice(0, 200)}`);
  }
  const parsed = parsePcImages(raw);
  return { channel: "pc", ...parsed };
}

// —————————————————————————— web 通道（chat_ability，免签名） ——————————————————————————

export function parseWebImages(raw) {
  assertNotJsonError(raw);
  const images = [];
  const texts = [];
  let conversationId = "";
  const scanCreations = (creations) => {
    for (const c of creations || []) {
      if (!c || typeof c !== "object") continue;
      const img = pickImageVariants(c.image || c, WEB_IMAGE_ORDER);
      if (img) images.push(img);
    }
  };
  for (const { event, json } of parseSseBlocks(raw)) {
    if (event === "gateway-error") throwGatewayError(json);
    if (!json || typeof json !== "object") continue;

    if (event === "SSE_ACK") {
      const cid = String(json.ack_client_meta?.conversation_id ?? "");
      if (cid && cid !== "0") conversationId = cid;
      continue;
    }
    if (event === "STREAM_ERROR" || ("error_code" in json && Number(json.error_code) !== 0)) {
      throwCodeError(Number(json.error_code) || 0, String(json.error_msg ?? json.message ?? ""));
    }
    if (typeof json.text === "string" && json.text && !("error_code" in json)) {
      texts.push(json.text); // CHUNK_DELTA
    }

    const blocks = [];
    for (const patch of json.patch_op || []) {
      const pv = patch?.patch_value;
      if (pv && typeof pv === "object") {
        if (Array.isArray(pv.content_block)) blocks.push(...pv.content_block);
        if (typeof pv.content === "string") {
          try {
            const c = JSON.parse(pv.content);
            if (c?.text) texts.push(String(c.text));
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (json.content && typeof json.content === "object" && Array.isArray(json.content.content_block)) {
      blocks.push(...json.content.content_block);
    }
    for (const cb of blocks) {
      if (!cb || typeof cb !== "object") continue;
      if (cb.block_type === 10000) {
        const t = cb.content?.text_block?.text;
        if (t) texts.push(String(t));
      } else if (cb.block_type === 2074) {
        scanCreations(cb.content?.creation_block?.creations);
      }
    }
    if (event === "SSE_REPLY_END") break;
  }

  if (!images.length) {
    // 已知块结构没命中时，整棵 SSE 事件树兜底扫一遍 2074 creation 块
    const creations = [];
    deepFindCreations(parseSseBlocks(raw).map((b) => b.json), creations);
    scanCreations(creations);
  }
  if (!images.length) throw new DoubaoError(noImagesMessage(texts));
  return { images, text: texts.join(""), conversationId };
}

export async function generateViaWeb(cfg, account, { prompt, ratio, model }) {
  const r = normalizeRatio(ratio, "auto");
  let text = `生成图片：${prompt}`;
  if (cfg.ratioHint !== false && r !== "auto") text += `（画幅比例 ${r}）`;
  const abilityParam = JSON.stringify({
    ability_param: {
      model: model || cfg.model || DEFAULT_MODEL,
      ratio: r,
      input_box_content: { user_input_content: prompt, reply_message_format: "生成图片：%s" },
    },
    ability_type: 1,
  });
  const body = {
    client_meta: {
      local_conversation_id: `local_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      conversation_id: "",
      bot_id: EXTENSION_BOT_ID,
      last_section_id: "",
      last_message_index: 0,
    },
    messages: [
      {
        local_message_id: randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: { text_block: { text, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
            block_id: randomUUID(),
            parent_id: "",
            meta_info: [],
            append_fields: [],
            is_finish: true,
            patch_type: 2,
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: 0,
      collect_id: "",
      is_audio: false,
      answer_with_suggest: true,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      disable_sse_cache: false,
      select_text_action: "",
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_mode: 1,
      message_storage_type: 0,
      memory_type: 0,
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      action_bar_skill_id: 0,
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
    },
    chat_ability: { ability_type: 3, ability_param: abilityParam },
    ext: {
      use_deep_think: "0",
      fp: FP,
      use_submit_pipeline: "1",
      commerce_credit_config_enable: "0",
      sub_conv_firstmet_type: "1",
    },
  };
  const url = `${BASE_URL}/chat/completion?${new URLSearchParams(securityParams("web"))}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: baseHeaders(account, SSE_HEADERS),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((cfg.timeoutSeconds || 180) * 1000),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    assertNotJsonError(raw);
    throw new DoubaoError(`chat/completion 接口请求失败 (${resp.status}): ${raw.slice(0, 200)}`);
  }
  const parsed = parseWebImages(raw);
  return { channel: "web", ...parsed };
}

// —————————————————————————— 顶层编排：账号轮换 + 通道回退 ——————————————————————————

const PAID_WALL_RE = /订阅|专属|标准套餐/;

/**
 * 生成图片。opts: { prompt, ratio?, model?, refImages?, account? }
 * 返回 { images:[{url,width,height,format}], text, channel, account, conversationId, notes[] }
 */
export async function generate(cfg, opts) {
  const prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new DoubaoError("prompt 不能为空。");
  const ratio = normalizeRatio(opts.ratio, normalizeRatio(cfg.ratio, "1:1"));
  const model = (opts.model || cfg.model || DEFAULT_MODEL).trim();
  const channels = cfg.channel === "auto" ? ["web", "pc"] : [cfg.channel];
  const effectiveChannels = opts.refImages?.length ? ["pc"] : channels; // 图生图只走 pc 通道
  const errors = [];

  const { accountOrder } = await import("./accounts.mjs");
  const order = accountOrder(cfg.accounts, opts.account);

  for (const account of order) {
    try {
      // 参考图要用当前账号的 cookie 上传
      const accountRefs = opts.refImages?.length ? await uploadRefImages(cfg, account, opts.refImages) : [];
      let lastErr = null;
      for (const channel of effectiveChannels) {
        try {
          const run = (m) =>
            channel === "web"
              ? generateViaWeb(cfg, account, { prompt, ratio, model: m })
              : generateViaPc(cfg, account, { prompt, ratio }, accountRefs);
          let result;
          try {
            result = await run(model);
          } catch (err) {
            // 付费墙 + 用户点名了非默认模型 → 自动回退默认（免费档）模型再试一次
            if (
              err instanceof DoubaoError &&
              PAID_WALL_RE.test(err.message) &&
              model !== (cfg.model || DEFAULT_MODEL) &&
              model !== DEFAULT_MODEL
            ) {
              result = await run(cfg.model || DEFAULT_MODEL);
              result.text = `[模型回退] 所选 ${model} 需要订阅，已改用 ${cfg.model || DEFAULT_MODEL}。${result.text}`;
            } else {
              throw err;
            }
          }
          return { ...result, account: account.name || "(未命名)", notes: [] };
        } catch (err) {
          lastErr = err;
          if (err instanceof DoubaoRiskError) throw err; // IP 级风控，换通道无意义
          errors.push(`${channel}: ${err.message}`);
        }
      }
      if (lastErr) throw lastErr;
    } catch (err) {
      if (err instanceof DoubaoRiskError) throw err;
      if (err instanceof DoubaoAuthError) {
        errors.push(`${account.name || "(未命名)"}: ${err.message}`);
        continue; // 换下一个账号
      }
      throw err;
    }
  }
  throw new DoubaoError(
    `所有账号均不可用。${errors.join("；")}`,
    "运行 check_login 查看各账号登录态；sessionid 过期后请到 doubao.com 重新复制。",
  );
}

/** 登录态自检（供 check_login 工具与测试脚本使用）。 */
export async function checkLogin(cfg) {
  const { checkAllAccounts } = await import("./accounts.mjs");
  return checkAllAccounts(cfg.accounts);
}

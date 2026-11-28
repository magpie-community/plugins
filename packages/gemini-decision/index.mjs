/**
 * magpie plugin —— TypeSafe Jev 决策模型 provider。
 *
 * 设计要点（详见 README.md）：
 *  1. provider id 固定为 `typesafe-jev`，带 `decide: true`；jev-* 模型带 `decides: true`，
 *     于是 magpie 会把决策请求以 `POST {baseURL}/systemone` 经 loader 的 fetch 发出来。
 *  2. loader 的 fetch 只做三件事：统一鉴权、按路径分流、把上游 status/headers/body 原样回传
 *     （绝不改写上游 body 其它字段，绝不打印请求体 / state）。
 *
 * 本文件零第三方依赖，唯一入口，导出只有 `default`（插件主函数）与 `_internal`（对象，非函数）。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** provider id：刻意不用 `typesafe`，避免撞上 谷歌 AI Studio / 内置预设导致 `??=` 不生效、`decide` 落不下去。 */
const PROVIDER_ID = 'gemini-decision';
const PROVIDER_NAME = 'Gemini Decision';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** chat 兼容层请求里拿不到 jev 模型名时使用的兜底决策模型。 */
const DEFAULT_JEV_MODEL = 'gemini-decision-1';
/** 静态登记的 jev 决策模型。 */
const JEV_MODEL_IDS = Object.freeze(['gemini-decision-1']);
/** 每请求 64k / 每问题 32k；这里按单问题上限保守登记。 */
const MODEL_LIMIT = Object.freeze({ context: 32768, output: 2048 });
/** $42 / Btok 输入，输出免费 —— 谷歌 AI Studio 口径是「每百万 token」。 */
const MODEL_COST = Object.freeze({ input: 0.042, output: 0 });
const MODEL_MODALITIES = Object.freeze({ input: Object.freeze(['text']), output: Object.freeze(['text']) });
/** 由我们自己重建 body / 重算长度的请求头，转发时必须摘掉。 */
const REBUILT_BODY_HEADERS = Object.freeze([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'host',
]);

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 共享的 UTF-8 解码器（`TextDecoder` 实例化有成本，复用同一个即可）。 */
const utf8Decoder = new TextDecoder('utf-8');
/** 共享的 UTF-8 编码器（仅在需要改写字节 body 时使用）。 */
const utf8Encoder = new TextEncoder();

/**
 * 判断是否为普通对象（非 null / 非数组）。
 *
 * @param {unknown} value 待判断值。
 * @returns {boolean} 是普通对象则为 true。
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 去掉结尾的斜杠，保证 baseURL 拼接安全。
 *
 * @param {string} value 原始字符串。
 * @returns {string} 去掉结尾斜杠后的字符串。
 */
function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * 把各种可能的 body 表示统一成字符串。
 *
 * @param {unknown} body init.body 的原始值。
 * @returns {string} UTF-8 字符串（无法识别时返回空串）。
 */
function readBodyString(body) {
  if (typeof body === 'string') return body;
  if (body === null || body === undefined) return '';
  if (body instanceof Uint8Array) return utf8Decoder.decode(body);
  if (typeof body === 'object' && typeof body.toString === 'function') {
    const text = body.toString();
    // 普通对象 / 流对象无法直接当 JSON 文本用，一律视为空体。
    return text === '[object Object]' ? '' : text;
  }
  return String(body);
}

/**
 * 把 body 的文本形态解出来：字符串直接用；字节形态（`Uint8Array` / `ArrayBuffer` /
 * 任意 `ArrayBufferView`）按 UTF-8 解码。无法当文本处理时返回 null。
 *
 * @param {unknown} body init.body 的原始值。
 * @returns {string|null} 文本，或 null（表示该形态不支持文本化）。
 */
function decodeBodyText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return utf8Decoder.decode(body);
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
    return utf8Decoder.decode(new Uint8Array(body));
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
    // DataView / 非 Uint8Array 的 TypedArray：按底层字节视图解码。
    return utf8Decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return null;
}

/**
 * 把文本按 body 原本的形态回填：原来是字符串就返回字符串，原来是字节就重新编码成 `Uint8Array`。
 *
 * @param {string} text 处理后的文本。
 * @param {unknown} originalBody 原始 body（只用来判断原形态）。
 * @returns {string|Uint8Array} 回填后的 body。
 */
function encodeBodyText(text, originalBody) {
  return typeof originalBody === 'string' ? text : utf8Encoder.encode(text);
}

/* ------------------------------------------------------------------ *
 * 模型表
 * ------------------------------------------------------------------ */

/**
 * 构造一个「非决策」模型条目（不带 `decides`）：供上游 /models 返回的非 `jev-` 模型使用。
 *
 * @param {string} id 模型 id。
 * @param {string} name 展示名。
 * @returns {Record<string, unknown>} 模型配置。
 */
function plainModel(id, name) {
  return {
    id,
    name,
    reasoning: false,
    tool_call: false,
    modalities: { input: [...MODEL_MODALITIES.input], output: [...MODEL_MODALITIES.output] },
    limit: { ...MODEL_LIMIT },
    cost: { ...MODEL_COST },
  };
}

/**
 * 构造一个 jev 决策模型条目。
 *
 * @param {string} id 模型 id。
 * @param {string} name 展示名。
 * @returns {Record<string, unknown>} 模型配置。
 */
function baseJevModel(id, name) {
  return { ...plainModel(id, name), decides: true };
}

/**
 * 静态模型表（record，key = 模型 id）。
 *
 * @param {string} api provider 的 api base。
 * @returns {Record<string, Record<string, unknown>>} 静态模型表。
 */
function staticModels(api) {
  const models = {};
  models['gemini-decision-1'] = baseJevModel('gemini-decision-1', 'Gemini Decision 1');
  return models;
}

/**
 * 把模型配置（record 或数组）规范成 record，并补齐 `id`。
 *
 * @param {unknown} value 原始 models 值。
 * @returns {Record<string, Record<string, unknown>>} 规范化后的模型表。
 */
function normalizeModels(value) {
  const out = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isPlainObject(entry)) continue;
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
      if (!id) continue;
      out[id] = { ...entry, id };
    }
    return out;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!isPlainObject(entry)) continue;
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : key;
      out[key] = { ...entry, id };
    }
  }
  return out;
}

/**
 * 强制 gemini-decision 模型带 `decides: true`。
 *
 * @param {Record<string, Record<string, unknown>>} models 模型表（原地修改）。
 * @returns {Record<string, Record<string, unknown>>} 同一个模型表。
 */
function forceDecides(models) {
  for (const [key, entry] of Object.entries(models)) {
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : key;
    if (id.startsWith('gemini-decision') || JEV_MODEL_IDS.includes(id)) {
      entry.decides = true;
    }
  }
  return models;
}

/* ------------------------------------------------------------------ *
 * 配置解析
 * ------------------------------------------------------------------ */

/**
 * 解析 baseURL，优先级：插件 options.baseURL → input.magpie.option.baseURL → 环境变量 → 默认值。
 *
 * @param {Record<string, unknown>} input magpie 传给插件主函数的 input。
 * @param {Record<string, unknown>} options plugins.json 中该条目的 options。
 * @returns {string} 规范化后的 baseURL（无结尾斜杠）。
 */
function resolveBaseURL(input, options) {
  const magpieOption = isPlainObject(input) && isPlainObject(input.magpie) && isPlainObject(input.magpie.option)
    ? input.magpie.option
    : {};
  const envValue = typeof process !== 'undefined' && process && process.env ? process.env.GEMINI_DECISION_BASE_URL : undefined;
  const candidates = [
    isPlainObject(options) ? options.baseURL : undefined,
    magpieOption.baseURL,
    envValue,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return trimTrailingSlash(candidate.trim());
  }
  return DEFAULT_BASE_URL;
}

/**
 * 从 magpie 的 auth 对象里取出 API key。
 *
 * @param {unknown} getAuth 可能是函数（异步取 auth），也可能是 auth 对象 / 字符串。
 * @returns {Promise<string>} API key，取不到时返回空串。
 */
async function resolveApiKey(getAuth) {
  let auth = getAuth;
  if (typeof getAuth === 'function') {
    try {
      auth = await getAuth();
    } catch {
      return '';
    }
  }
  if (typeof auth === 'string') return auth.trim();
  if (!isPlainObject(auth)) return '';
  const candidates = [auth.key, auth.apiKey, auth.api_key, auth.token, auth.access, auth.secret];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 请求规范化 / 路径分流
 * ------------------------------------------------------------------ */

/**
 * 把 magpie 传进来的 (input, init) 规范化成可转发的最小描述。
 *
 * @param {unknown} input 可能是完整 URL 字符串 / URL / Request。
 * @param {unknown} init fetch init。
 * @returns {Promise<{url: string, method: string, headers: Headers, body: unknown, signal: unknown}>} 规范化结果。
 */
async function normalizeRequest(input, init) {
  const safeInit = isPlainObject(init) ? init : {};
  let url = '';
  let method = typeof safeInit.method === 'string' && safeInit.method ? safeInit.method.toUpperCase() : '';
  let headers = new Headers(safeInit.headers === undefined ? undefined : safeInit.headers);
  let body = safeInit.body === undefined ? undefined : safeInit.body;
  let signal = safeInit.signal === undefined ? undefined : safeInit.signal;

  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (isPlainObject(input) && typeof input.url === 'string') {
    // Request 形状（duck typing，避免依赖全局 Request 的具体实现）。
    url = input.url;
    if (!method) method = String(input.method || 'GET').toUpperCase();
    if (safeInit.headers === undefined && input.headers) headers = new Headers(input.headers);
    if (body === undefined && method !== 'GET' && method !== 'HEAD' && input.body !== null && input.body !== undefined
      && typeof input.text === 'function') {
      try {
        body = await input.text();
      } catch {
        body = undefined;
      }
    }
    if (!signal && input.signal) signal = input.signal;
  }

  if (!method) method = body === undefined ? 'GET' : 'POST';
  return { url, method, headers, body, signal };
}

/**
 * 按路径分流。只识别 `/systemone`、`/models`，其余一律 404（绝不猜路径）。
 *
 * @param {string} rawUrl magpie 传来的完整 URL。
 * @returns {{kind: string, pathname: string}} 分流结果。
 */
function classifyTarget(rawUrl) {
  let pathname = '';
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = '';
  }
  if (pathname.endsWith('/systemone')) return { kind: 'systemone', pathname };
  if (pathname.endsWith('/models')) return { kind: 'models', pathname };
  return { kind: 'unknown', pathname };
}

/**
 * 直通前对决策请求体做最小规范化：仅当 `model` 形如 `<providerId>/<model>` 时剥掉 provider 前缀。
 *
 * magpie 侧的模型 id 是 `<provider>/<model>`，而 TypeSafe 只认裸 `jev-*`。
 *
 * 入参的 body 形态一律先归一成字符串再判断（`Uint8Array` / `ArrayBuffer` / `ArrayBufferView`
 * 用 `TextDecoder` 解码），剥完前缀后再按**原形态**回填（原来字节就 `TextEncoder().encode()` 回去）。
 * 没有前缀时**原样返回同一个 body 对象**（字节路径也不重新编码、不重新序列化），
 * 因此 `changed === false` 时上游收到的字节与调用方发出的完全一致；幂等：裸 `jev-latest` 不会被二次处理。
 *
 * @param {unknown} rawBody 原始请求体（字符串或字节形态）。
 * @returns {{body: unknown, changed: boolean}} 处理后的 body 与是否发生变化。
 */
/* ------------------------------------------------------------------ *
 * OpenRouter System One part -> 谷歌 content block 转换
 * ------------------------------------------------------------------ */

/**
 * 解析 data URL，返回 {mime, data}；非 data URL 返回 null。
 *
 * @param {string} url 待解析的 URL。
 * @returns {{mime: string, data: string}|null} 解析结果。
 */
function parseDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const semi = meta.indexOf(';');
  const mime = semi >= 0 ? meta.slice(0, semi) : meta;
  if (!/^[-\w.]+\/[-\w.+]+$/.test(mime)) return null;
  return { mime, data: url.slice(comma + 1) };
}

/**
 * 音频 format -> mime 映射（OpenRouter input_audio.format 枚举）。
 */
const AUDIO_FORMAT_MIME = Object.freeze({
  wav: 'audio/wav', mp3: 'audio/mp3', mpeg: 'audio/mpeg', m4a: 'audio/m4a',
  mp4: 'audio/mp4', aac: 'audio/aac', aiff: 'audio/aiff', aif: 'audio/aiff',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', webm: 'audio/webm',
});

/**
 * 把 OpenRouter System One 的 state part 转换成谷歌 content block。
 * 字符串 -> text 块；image_url/input_audio/video_url/input_file -> 对应媒体块；
 * 已是谷歌块形状的直接透传；无法识别的对象序列化成文本。
 *
 * @param {unknown} item state 数组的一个元素。
 * @returns {Record<string, unknown>|null} 谷歌 content block，或 null（忽略）。
 */
function convertStatePart(item, assetBlocks) {
  if (typeof item === 'string') {
    if (assetBlocks && assetBlocks[item]) return assetBlocks[item];
    return { type: 'text', text: item };
  }
  if (!isPlainObject(item)) return { type: 'text', text: JSON.stringify(item) };

  const type = typeof item.type === 'string' ? item.type : '';

  // 已是谷歌块形状（text/image/audio/video/document），原样透传
  if (['text', 'image', 'audio', 'video', 'document'].includes(type)) return item;

  if (type === 'asset' || type === 'asset_ref') {
    const key = typeof item.asset === 'string' ? item.asset : typeof item.key === 'string' ? item.key : '';
    if (assetBlocks && assetBlocks[key]) return assetBlocks[key];
    return null;
  }

  if (type === 'image_url') {
    const url = isPlainObject(item.image_url) ? item.image_url.url : undefined;
    if (typeof url !== 'string') return null;
    const parsed = parseDataUrl(url);
    if (parsed) {
      const block = { type: 'image', data: parsed.data, mime_type: parsed.mime };
      // detail low/high/auto -> resolution
      const detail = isPlainObject(item.image_url) ? item.image_url.detail : undefined;
      if (detail === 'low' || detail === 'high') block.resolution = detail === 'high' ? 'high' : 'low';
      return block;
    }
    if (/^https?:\/\//.test(url)) return { type: 'image', uri: url, mime_type: 'image/jpeg' };
    return null;
  }

  if (type === 'input_audio') {
    const audio = isPlainObject(item.input_audio) ? item.input_audio : {};
    const mime = AUDIO_FORMAT_MIME[audio.format] || 'audio/mpeg';
    if (typeof audio.data === 'string') {
      if (/^https?:\/\//.test(audio.data)) return { type: 'audio', uri: audio.data, mime_type: mime };
      const parsed = parseDataUrl(audio.data);
      if (parsed) return { type: 'audio', data: parsed.data, mime_type: parsed.mime };
      return { type: 'audio', data: audio.data, mime_type: mime };
    }
    return null;
  }

  if (type === 'video_url') {
    const url = isPlainObject(item.video_url) ? item.video_url.url : undefined;
    if (typeof url !== 'string') return null;
    const parsed = parseDataUrl(url);
    if (parsed) return { type: 'video', data: parsed.data, mime_type: parsed.mime };
    if (/^https?:\/\//.test(url)) return { type: 'video', uri: url, mime_type: 'video/mp4' };
    return null;
  }

  if (type === 'input_file' || type === 'file') {
    const file = isPlainObject(item.input_file) ? item.input_file : item;
    const fileData = file.file_data;
    if (typeof fileData !== 'string') return null;
    const parsed = parseDataUrl(fileData);
    if (parsed) return { type: 'document', data: parsed.data, mime_type: parsed.mime };
    if (/^https?:\/\//.test(fileData)) {
      // 从扩展名猜 mime
      const ext = (fileData.split('?')[0].split('.').pop() || '').toLowerCase();
      const mimes = { pdf: 'application/pdf', csv: 'text/csv' };
      return { type: 'document', uri: fileData, mime_type: mimes[ext] || 'application/pdf' };
    }
    return null;
  }

  // 未知对象：序列化成文本
  return { type: 'text', text: JSON.stringify(item) };
}


/**
 * 解析 OpenRouter assets 表为谷歌 content block 映射。
 */
function parseAssets(assets) {
  const out = {};
  if (!isPlainObject(assets)) return out;
  for (const [key, asset] of Object.entries(assets)) {
    if (!isPlainObject(asset)) continue;
    const data = typeof asset.data === 'string' ? asset.data
      : typeof asset.content === 'string' ? asset.content
      : typeof asset.base64 === 'string' ? asset.base64 : null;
    const mime = typeof asset.mime_type === 'string' ? asset.mime_type
      : typeof asset.mime === 'string' ? asset.mime
      : typeof asset.format === 'string' && asset.format.includes('/') ? asset.format
      : null;
    if (!data) continue;
    const parsed = parseDataUrl(data);
    const finalMime = parsed ? parsed.mime : (mime || 'image/png');
    const rawData = parsed ? parsed.data : data;
    const kind = finalMime.startsWith('image/') ? 'image'
      : finalMime.startsWith('audio/') ? 'audio'
      : finalMime.startsWith('video/') ? 'video'
      : 'document';
    out[key] = { type: kind, data: rawData, mime_type: finalMime };
  }
  return out;
}

function normalizeDecisionBody(rawBody) {
  const empty = { body: rawBody, changed: false, idMap: null };
  const text = decodeBodyText(rawBody);
  if (text === null || !text.trim()) return empty;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!isPlainObject(parsed)) return empty;

  // Gemini Decisions API 协议改写（JEV System One → Gemini）：
  //   1. state          -> input（字符串原样；对象/数组序列化为 text 块）
  //   2. model 剥 provider 前缀后强制为 gemini-decision-1（谷歌目前只有这一个决策模型）
  //   3. noul criteria 键名映射：Jev 的 {true,false} -> 谷歌的 {true_description,false_description}
  const out = { ...parsed };

  // model：剥掉 `<providerId>/` 前缀；无论剥完是什么都归一到 gemini-decision-1
  const model = typeof out.model === 'string' ? out.model.trim() : '';
  const prefix = `${PROVIDER_ID}/`;
  const bare = model.startsWith(prefix) ? model.slice(prefix.length).trim() : model;
  out.model = bare.startsWith('gemini-decision') ? bare : DEFAULT_JEV_MODEL;

  // assets：解析成 block 表并从顶层删除（谷歌没有这个字段）
  const assetBlocks = parseAssets(out.assets);
  if ('assets' in out) delete out.assets;

  // state -> input
  if ('state' in out) {
    const state = out.state;
    delete out.state;
    if (typeof state === 'string') {
      out.input = state;
    } else if (state === null || state === undefined) {
      out.input = '';
    } else if (Array.isArray(state)) {
      out.input = state.map((item) => convertStatePart(item, assetBlocks)).filter((x) => x !== null);
      if (out.input.length === 0) out.input = '';
    } else {
      out.input = [{ type: 'text', text: JSON.stringify(state) }];
    }
  }

  // noul criteria 键名映射：Jev 用 {true, false}，谷歌用 {true_description, false_description}
  if (isPlainObject(out.questions)) {
    for (const q of Object.values(out.questions)) {
      if (!isPlainObject(q) || !isPlainObject(q.criteria)) continue;
      // noul 的 criteria 是 {true, false} 形状才映射；choice/score 的 criteria 本来就兼容，不动
      // null/undefined 描述转空串（OpenRouter 标准里 null = 自解释；谷歌接受空串不接受 null）
      for (const [k, v] of Object.entries(q.criteria)) {
        if (v === null || v === undefined) q.criteria[k] = '';
      }
      if (q.type !== 'noul') continue;
      const c = q.criteria;
      const mapped = {};
      let hit = false;
      for (const [k, v] of Object.entries(c)) {
        if (k === 'true') { mapped.true_description = v; hit = true; }
        else if (k === 'false') { mapped.false_description = v; hit = true; }
        else { mapped[k] = v; }
      }
      if (hit) q.criteria = mapped;
    }
  }

  // question id 清洗：谷歌只允许 [A-Za-z0-9_-]{1,64}，Jev 风格的 tool:Agent 会被 400。
  // 非法字符替换为 _，记录映射表以便响应侧还原。
  let idMap = null;
  if (isPlainObject(out.questions)) {
    const cleaned = {};
    const map = {};
    let anyHit = false;
    const seen = new Set();
    for (const [qid, q] of Object.entries(out.questions)) {
      let nid = qid.replace(/[^A-Za-z0-9_-]/g, '_');
      if (nid.length > 64) nid = nid.slice(0, 64);
      if (nid === '') nid = 'q';
      // 防撞车：如果清洗后撞名，追加序号
      let unique = nid, n = 2;
      while (seen.has(unique)) { unique = `${nid}_${n++}`; }
      seen.add(unique);
      cleaned[unique] = q;
      if (unique !== qid) { map[unique] = qid; anyHit = true; }
    }
    if (anyHit) {
      out.questions = cleaned;
      idMap = map;
    }
  }

  return { body: encodeBodyText(JSON.stringify(out), rawBody), changed: true, idMap };
}

/* ------------------------------------------------------------------ *
 * 响应工具
 * ------------------------------------------------------------------ */

/**
 * 还原 answers 里的 question id（清洗时改名的键换回原名）。
 *
 * @param {string} text 上游响应体文本。
 * @param {Record<string, string>|null} idMap 清洗后 id -> 原始 id。
 * @returns {string} 还原后的文本（无映射或解析失败原样返回）。
 */
function restoreAnswerIds(text, idMap) {
  if (!idMap) return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) return text;
  const restored = {};
  for (const [key, val] of Object.entries(parsed.answers)) {
    restored[idMap[key] || key] = val;
  }
  parsed.answers = restored;
  return JSON.stringify(parsed);
}



/**
 * 构造 JSON 响应。
 *
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 可 JSON 序列化的响应体。
 * @returns {Response} 响应对象。
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 构造 OpenAI 风格错误体。
 *
 * @param {number} status HTTP 状态码。
 * @param {string} message 面向调用方的说明。
 * @param {string} code 机器可读错误码。
 * @returns {Response} 响应对象。
 */
function openAiError(status, message, code) {
  const type = status >= 500 ? 'api_error' : status === 401 ? 'authentication_error' : 'invalid_request_error';
  return jsonResponse(status, {
    error: {
      message,
      type,
      param: null,
      code: code || (status >= 500 ? 'upstream_error' : 'invalid_request'),
    },
  });
}

/**
 * 复制上游响应头，摘掉 hop-by-hop / 会被重算的字段。
 *
 * @param {Headers} upstreamHeaders 上游响应头。
 * @returns {Headers} 可安全回传给 magpie 的响应头。
 */
function copyUpstreamHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (REBUILT_BODY_HEADERS.includes(lower)) continue;
    headers.set(key, value);
  }
  return headers;
}

/**
 * 把上游响应原样回传（status / headers / body 流），401 额外打上 magpie 的 re-login 标记。
 *
 * @param {Response} upstream 上游响应。
 * @returns {Response} 回传给 magpie 的响应。
 */
function toPassthroughResponse(upstream) {
  const headers = copyUpstreamHeaders(upstream.headers);
  if (upstream.status === 401) headers.set('X-Magpie-Sign-In', 'expired');
  const nullBodyStatus = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(nullBodyStatus ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */

/**
 * 向上游发一个请求。
 *
 * @param {string} targetUrl 目标完整 URL。
 * @param {{method: string, headers: Headers, body: unknown, signal: unknown}} request 请求描述。
 * @param {string} apiKey TypeSafe API key。
 * @returns {Promise<Response>} 上游响应。
 */
async function callUpstream(targetUrl, request, apiKey) {
  const headers = new Headers(request.headers);
  for (const key of ['x-api-key', 'x-magpie-sign-in', 'authorization', ...REBUILT_BODY_HEADERS]) headers.delete(key);
  // 谷歌 Gemini Developer API 走 x-goog-api-key，不是 Bearer
  if (apiKey) headers.set('x-goog-api-key', apiKey);
  else headers.delete('x-goog-api-key');
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.body !== undefined && request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }
  if (request.signal) init.signal = request.signal;

  // 网络异常直接抛出，交给 magpie 判定为传输失败。
  return fetch(targetUrl, init);
}

/* ------------------------------------------------------------------ *
 * loader.fetch（核心）
 * ------------------------------------------------------------------ */

/**
 * 构造交给 magpie 的 `fetch`。
 *
 * @param {{baseURL: string, apiKey: string}} config 配置。
 * @returns {(input: unknown, init?: unknown) => Promise<Response>} fetch 实现。
 */
function createGatewayFetch(config) {
  return async function magpieFetch(input, init) {
    const request = await normalizeRequest(input, init);
    const target = classifyTarget(request.url);

    if (target.kind === 'systemone') {
      const normalized = normalizeDecisionBody(request.body);
      const forwarded = { ...request, method: 'POST', body: normalized.body };
      const upstream = await callUpstream(`${config.baseURL}/decisions`, forwarded, config.apiKey);
      // 无 id 清洗时原样透传（零拷贝）；有清洗时读全量、还原 answers 键名再回传
      if (!normalized.idMap || !upstream.body) return toPassthroughResponse(upstream);
      const text = await upstream.text();
      const headers = copyUpstreamHeaders(upstream.headers);
      if (upstream.status === 401) headers.set('X-Magpie-Sign-In', 'expired');
      headers.delete('content-length');
      return new Response(restoreAnswerIds(text, normalized.idMap), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    if (target.kind === 'models') {
      const forwarded = { ...request, method: 'GET', body: undefined };
      const upstream = await callUpstream(`${config.baseURL}/models`, forwarded, config.apiKey);
      return toPassthroughResponse(upstream);
    }


    return openAiError(
      404,
      `magpie typesafe-jev: endpoint "${target.pathname || request.url}" is not implemented. `
        + 'Only /systemone and /models are served; upstream paths are never guessed.',
      'unsupported_endpoint',
    );
  };
}

/* ------------------------------------------------------------------ *
 * hooks
 * ------------------------------------------------------------------ */

/**
 * `config` hook：登记 provider 与模型，无条件写 `decide: true`。
 *
 * @param {Record<string, unknown>} cfg magpie 的配置对象（原地修改）。
 * @param {{baseURL: string}} shared 插件级共享配置。
 * @returns {Record<string, unknown>} 写好的 provider 条目。
 */
function configHook(cfg, shared) {
  if (!isPlainObject(cfg)) return cfg;
  cfg.provider ??= {};
  if (!isPlainObject(cfg.provider)) cfg.provider = {};

  const existing = isPlainObject(cfg.provider[PROVIDER_ID]) ? cfg.provider[PROVIDER_ID] : {};
  const api = typeof existing.api === 'string' && existing.api.trim() ? existing.api : shared.baseURL;

  const models = normalizeModels(staticModels(api));
  Object.assign(models, normalizeModels(existing.models));
  forceDecides(models);

  cfg.provider[PROVIDER_ID] = {
    ...existing,
    name: typeof existing.name === 'string' && existing.name.trim() ? existing.name : PROVIDER_NAME,
    npm: typeof existing.npm === 'string' && existing.npm.trim() ? existing.npm : '@ai-sdk/openai-compatible',
    api,
    // 无条件写入：即使预设里已经有同名 provider，也要保证决策语义成立。
    decide: true,
    models,
  };
  return cfg.provider[PROVIDER_ID];
}

/**
 * `auth.loader`：每账号跑一次，返回 baseURL / apiKey / fetch。
 *
 * @param {unknown} getAuth 取 auth 的函数或 auth 对象。
 * @param {unknown} provider provider 配置（未使用，保留签名）。
 * @param {{baseURL: string}} shared 插件级共享配置。
 * @returns {Promise<{baseURL: string, apiKey?: string, fetch: Function}>} loader 结果。
 */
async function loaderHook(getAuth, provider, shared) {
  const apiKey = await resolveApiKey(getAuth);
  const result = { baseURL: shared.baseURL, fetch: createGatewayFetch({ baseURL: shared.baseURL, apiKey }) };
  if (apiKey) result.apiKey = apiKey;
  return result;
}

/**
 * `provider.models`：每账号调一次，带 key 拉 `GET {BASE}/models` 并并入静态表；失败原样返回旧列表。
 *
 * @param {Record<string, unknown>} provider provider 配置。
 * @param {unknown} ctx 上下文（含 auth）。
 * @param {{baseURL: string}} shared 插件级共享配置。
 * @returns {Promise<unknown>} 模型表（record）或原样的 `provider.models`。
 */
async function modelsHook(provider, ctx, shared) {
  const current = isPlainObject(provider) ? provider : {};
  const fallback = current.models;
  const context = isPlainObject(ctx) ? ctx : {};
  const apiKey = await resolveApiKey(context.auth);
  if (!apiKey) return fallback;

  let payload = null;
  try {
    const response = await fetch(`${shared.baseURL}/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey, accept: 'application/json' },
    });
    if (!response.ok) return fallback;
    payload = await response.json();
  } catch {
    return fallback;
  }

  const rows = isPlainObject(payload) && Array.isArray(payload.models) ? payload.models : [];
  if (rows.length === 0) return fallback;

  const merged = normalizeModels(staticModels(shared.baseURL));
  Object.assign(merged, normalizeModels(fallback));

  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const id = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '';
    if (!id) continue;
    // 只有 id 以 `jev-` 开头才算决策模型；其它上游模型保持原样（不写 decides）。
    const isDecisionModel = id.startsWith('gemini-decision');
    const base = isPlainObject(merged[id])
      ? merged[id]
      : (isDecisionModel ? baseJevModel(id, id) : plainModel(id, id));
    const entry = { ...base, id };
    if (typeof row.description === 'string' && row.description.trim()) entry.description = row.description.trim();
    if (typeof row.release_date === 'string' && row.release_date.trim()) entry.release_date = row.release_date.trim();
    if (isDecisionModel) entry.decides = true;
    merged[id] = entry;
  }

  forceDecides(merged);
  return merged;
}

/* ------------------------------------------------------------------ *
 * 插件主函数
 * ------------------------------------------------------------------ */

/**
 * magpie 插件入口（OpenCode v1 plugin 形状）。
 *
 * @param {Record<string, unknown>} input `{client, project, directory, worktree, serverUrl, $, magpie}`。
 * @param {Record<string, unknown>} options plugins.json 中该条目的 options。
 * @returns {Promise<Record<string, unknown>>} hooks。
 */
export default async function geminiDecisionPlugin(input, options) {
  const shared = { baseURL: resolveBaseURL(input, options) };

  return {
    config: (cfg) => configHook(cfg, shared),
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: 'api',
          label: 'Google AI Studio API key',
          // TypeSafe 文档未规定 key 前缀，这里只给中性提示，不臆造 `ts_...` 之类格式。
          placeholder: '粘贴 AI Studio 的 API key（免费层即可）',
        },
      ],
      loader: (getAuth, provider) => loaderHook(getAuth, provider, shared),
    },
    provider: {
      models: (provider, ctx) => modelsHook(provider, ctx, shared),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 仅供测试使用的内部实现（对象，不是函数，不会被当成插件调用）
 * ------------------------------------------------------------------ */

export const _internal = {
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_JEV_MODEL,
  JEV_MODEL_IDS,
  MODEL_LIMIT,
  MODEL_COST,
  isPlainObject,
  trimTrailingSlash,
  readBodyString,
  decodeBodyText,
  encodeBodyText,
  plainModel,
  baseJevModel,
  staticModels,
  normalizeModels,
  forceDecides,
  resolveBaseURL,
  resolveApiKey,
  normalizeRequest,
  classifyTarget,
  normalizeDecisionBody,
  restoreAnswerIds,
  parseDataUrl,
  convertStatePart,
  parseAssets,
  jsonResponse,
  openAiError,
  copyUpstreamHeaders,
  toPassthroughResponse,
  callUpstream,
  createGatewayFetch,
  configHook,
  loaderHook,
  modelsHook,
};

// Named alias for the community OpenCode layout (opencode.mjs re-exports it);
// the default export stays for magpie path installs.
export const GeminiDecisionPlugin = geminiDecisionPlugin;

// Context token counting / estimation helper (Anthropic count_tokens DTO).
// Pure conversion OpenAI-chat -> Anthropic count DTO + a single gateway POST.
// Never claims exactness: the gateway may answer with a rough estimate.

const UNAVAILABLE = 'context_count_unavailable';
const COUNT_PATH = '/messages/count_tokens';
const MAX_BODY_BYTES = 8192;
const DEFAULT_USER_AGENT = 'Desktop Kimi Work';
// Root already lowercases the incoming request headers; only these are forwarded.
const FORWARD_HEADERS = ['user-agent', 'x-msh-version', 'r-timezone', 'x-session-id', 'session_id'];

function unavailable() {
  const error = new Error(UNAVAILABLE);
  error.code = UNAVAILABLE;
  return error;
}

function fail() {
  throw unavailable();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textBlocks(text) {
  if (text.length === 0) return [];
  return [{ type: 'text', text }];
}

function imageBlockFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) fail();
  const dataMatch = /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (dataMatch) {
    const data = dataMatch[2].replace(/\s+/g, '');
    if (data.length === 0) fail();
    return {
      type: 'image',
      source: { type: 'base64', media_type: `image/${dataMatch[1].toLowerCase()}`, data },
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail();
  return { type: 'image', source: { type: 'url', url } };
}

function contentPartToBlocks(part) {
  if (typeof part === 'string') return textBlocks(part);
  if (!isPlainObject(part)) fail();
  if (part.type === 'text') {
    if (typeof part.text !== 'string') fail();
    return textBlocks(part.text);
  }
  if (part.type === 'image_url') {
    const raw = part.image_url;
    const url = typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.url : undefined;
    return [imageBlockFromUrl(url)];
  }
  // audio/video/file/input_audio/... are unsupported: refuse, never skip.
  return fail();
}

function normalizeContent(content) {
  if (typeof content === 'string') return textBlocks(content);
  if (!Array.isArray(content)) fail();
  const blocks = [];
  for (const part of content) blocks.push(...contentPartToBlocks(part));
  return blocks;
}

function systemTextBlocks(content) {
  if (typeof content === 'string') return textBlocks(content);
  if (!Array.isArray(content)) fail();
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push(...textBlocks(part));
      continue;
    }
    // Anthropic system supports text only: images and other blocks are refused.
    if (!isPlainObject(part) || part.type !== 'text' || typeof part.text !== 'string') fail();
    blocks.push(...textBlocks(part.text));
  }
  return blocks;
}

function parseToolArguments(raw) {
  // Missing/null/empty arguments are a malformed tool call; legal no-arg calls use "{}".
  if (typeof raw !== 'string' || raw.length === 0) fail();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!isPlainObject(parsed)) fail();
  return parsed;
}

function toolCallToBlock(call) {
  if (!isPlainObject(call)) fail();
  if (call.type !== undefined && call.type !== 'function') fail();
  const fn = call.function;
  if (!isPlainObject(fn)) fail();
  if (typeof fn.name !== 'string' || fn.name.length === 0) fail();
  if (typeof call.id !== 'string' || call.id.length === 0) fail();
  return {
    type: 'tool_use',
    id: call.id,
    name: fn.name,
    input: parseToolArguments(fn.arguments),
  };
}

function toolDefToAnthropic(tool) {
  if (!isPlainObject(tool)) fail();
  if (tool.type !== 'function') fail();
  const fn = tool.function;
  if (!isPlainObject(fn)) fail();
  if (typeof fn.name !== 'string' || fn.name.length === 0) fail();
  const schema = fn.parameters;
  let inputSchema;
  if (schema === undefined) {
    inputSchema = { type: 'object', properties: {} }; // legal no-arg tool
  } else if (isPlainObject(schema)) {
    inputSchema = schema; // keep original value/reference
  } else {
    fail(); // explicit null or non-object schema is malformed
  }
  const out = { name: fn.name, input_schema: inputSchema };
  if (fn.description !== undefined) {
    if (typeof fn.description !== 'string') fail();
    out.description = fn.description;
  }
  return out;
}

export function buildCountRequest(chatPayload) {
  if (!isPlainObject(chatPayload)) fail();
  if (typeof chatPayload.model !== 'string' || chatPayload.model.length === 0) fail();
  if (!Array.isArray(chatPayload.messages)) fail();

  const systemBlocks = [];
  const messages = [];

  for (const message of chatPayload.messages) {
    if (!isPlainObject(message)) fail();
    const role = message.role;
    // Legacy function_call and tool_calls outside assistant cannot be preserved: refuse.
    if (message.function_call != null) fail();
    if (role !== 'assistant' && message.tool_calls != null) fail();

    if (role === 'system' || role === 'developer') {
      systemBlocks.push(...systemTextBlocks(message.content));
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: normalizeContent(message.content) });
      continue;
    }

    if (role === 'assistant') {
      const blocks = [];
      if (message.content !== undefined && message.content !== null) {
        blocks.push(...normalizeContent(message.content));
      }
      if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
        if (typeof message.reasoning_content !== 'string') fail();
        blocks.push(...textBlocks(message.reasoning_content));
      }
      if (message.tool_calls != null) {
        if (!Array.isArray(message.tool_calls)) fail();
        for (const call of message.tool_calls) blocks.push(toolCallToBlock(call));
      }
      if (blocks.length === 0) fail();
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id.length === 0) fail();
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: normalizeContent(message.content),
          },
        ],
      });
      continue;
    }

    fail();
  }

  if (messages.length === 0) fail();

  const dto = { model: chatPayload.model };
  if (systemBlocks.length > 0) dto.system = systemBlocks;
  dto.messages = messages;

  if (chatPayload.tools !== undefined) {
    if (!Array.isArray(chatPayload.tools)) fail();
    dto.tools = chatPayload.tools.map(toolDefToAnthropic);
  }

  return dto;
}

async function readBoundedJson(response) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') fail();
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      fail();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decoder and JSON errors fall through to the single outer catch.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function buildHeaders(gatewayKey, requestHeaders) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${gatewayKey}`,
    'user-agent': DEFAULT_USER_AGENT,
  };
  const source = requestHeaders ?? {};
  for (const name of FORWARD_HEADERS) {
    const value = source[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

export async function countContextTokens(chatPayload, options = {}) {
  try {
    const { gatewayURL, gatewayKey, fetchImpl = fetch, signal, requestHeaders = {} } = options ?? {};
    if (typeof gatewayURL !== 'string' || gatewayURL.length === 0) fail();
    if (typeof gatewayKey !== 'string' || gatewayKey.length === 0) fail();
    if (typeof fetchImpl !== 'function') fail();

    const dto = buildCountRequest(chatPayload);
    const url = `${gatewayURL.replace(/\/+$/, '')}${COUNT_PATH}`;
    const headers = buildHeaders(gatewayKey, requestHeaders);
    const timeout = AbortSignal.timeout(6000);

    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      proxy: '',
      headers,
      body: JSON.stringify(dto),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response || response.ok !== true) {
      await response?.body?.cancel();
      fail();
    }

    const payload = await readBoundedJson(response);
    if (!isPlainObject(payload)) fail();
    const tokens = payload.input_tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) fail();
    return tokens;
  } catch {
    // Single fixed failure: never surface provider body, error text, or secrets.
    throw unavailable();
  }
}

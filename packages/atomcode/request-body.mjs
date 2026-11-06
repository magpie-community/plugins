/**
 * Request body normalization for signed gateway traffic.
 *
 * Signing needs the exact bytes that will be sent, so bodies must be replayable.
 * Web streams, FormData and URLSearchParams have no stable byte representation
 * here; rejecting them is safer than signing one representation and sending
 * another. The cap prevents a Request clone from consuming unbounded memory.
 *
 * @module magpie-atomcode/request-body
 */

export const MAX_SIGNED_BODY_BYTES = 64 * 1024 * 1024;

function tooLarge(maxBytes) {
  return new Error(`request body exceeds ${maxBytes} bytes`);
}

async function readStream(stream, maxBytes) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new Error("unsupported request body");
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk =
        value instanceof Uint8Array
          ? value
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancel() may have released it already */
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Convert a supported BodyInit into replayable bytes or a string.
 *
 * @param {unknown} body - `init.body`, when present.
 * @param {{request?: Request, fromRequest?: boolean, maxBytes?: number}} [opts]
 * @returns {Promise<{body: string|Uint8Array|undefined, contentType?: string, signBody: string|Uint8Array}>}
 */
export async function normalizeRequestBody(
  body,
  { request, fromRequest = false, maxBytes = MAX_SIGNED_BODY_BYTES } = {},
) {
  if (fromRequest) {
    if (!request?.body) return { body: undefined, signBody: "" };
    const bytes = await readStream(request.clone().body, maxBytes);
    return { body: bytes, signBody: bytes };
  }
  if (body === undefined || body === null) return { body: undefined, signBody: "" };
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw tooLarge(maxBytes);
    return { body, signBody: body };
  }
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes) throw tooLarge(maxBytes);
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes, signBody: bytes };
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) throw tooLarge(maxBytes);
    const bytes = new Uint8Array(body);
    return { body: bytes, signBody: bytes };
  }
  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > maxBytes) throw tooLarge(maxBytes);
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes, signBody: bytes };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBytes) throw tooLarge(maxBytes);
    const bytes = new Uint8Array(await body.arrayBuffer());
    return {
      body: bytes,
      signBody: bytes,
      ...(body.type ? { contentType: body.type } : {}),
    };
  }
  throw new Error("unsupported request body");
}

/**
 * Ask OpenAI-compatible streaming Chat Completions for final usage.
 *
 * An explicit `include_usage` value is never overridden.
 *
 * @param {string|Uint8Array} body
 * @param {{pathname?: string, contentType?: string}} [opts]
 * @returns {{body: string|Uint8Array, changed: boolean}}
 */
export function includeStreamUsage(body, { pathname = "", contentType = "" } = {}) {
  if (!pathname.endsWith("/chat/completions")) return { body, changed: false };
  if (contentType && !/^application\/(?:[^;]+\+)?json\b/i.test(contentType)) {
    return { body, changed: false };
  }
  let text;
  try {
    text = typeof body === "string" ? body : new TextDecoder().decode(body);
  } catch {
    return { body, changed: false };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { body, changed: false };
  }
  if (!value || typeof value !== "object" || value.stream !== true) {
    return { body, changed: false };
  }
  if (
    Object.hasOwn(value, "stream_options") &&
    (!value.stream_options ||
      typeof value.stream_options !== "object" ||
      Array.isArray(value.stream_options))
  ) {
    return { body, changed: false };
  }
  const options = value.stream_options ?? {};
  if (Object.hasOwn(options, "include_usage")) return { body, changed: false };
  value.stream_options = { ...options, include_usage: true };
  return { body: JSON.stringify(value), changed: true };
}

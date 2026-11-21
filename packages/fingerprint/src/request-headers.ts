const protectedNames = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'content-type',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'origin',
  'referer',
  'x-api-key',
]);

/** Only inference requests receive these headers; credentials and routing stay with Magpie. */
export function requestHeaders(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Request headers must be an object of header names and text values.');
  const entries = Object.entries(input);
  if (entries.length > 24) throw new Error('Use at most 24 request headers.');
  const normalized: Record<string, string> = Object.create(null);
  let size = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(name))
      throw new Error('Invalid request header name.');
    if (protectedNames.has(name) || /^(content-|sec-|proxy-|x-magpie-)/.test(name))
      throw new Error(`Request header ${name} is managed by Magpie and cannot be overridden.`);
    if (typeof rawValue !== 'string' || !/^[\x20-\x7e]*$/.test(rawValue))
      throw new Error(`Request header ${name} must contain printable ASCII text on one line.`);
    if (Object.hasOwn(normalized, name)) throw new Error(`Duplicate request header: ${name}.`);
    const value = rawValue.trim();
    size += name.length + value.length;
    if (value.length > 2048) throw new Error('Use at most 2048 characters per header value.');
    if (size > 8192) throw new Error('Request headers exceed 8 KiB.');
    normalized[name] = value;
  }
  return normalized;
}

export function parseRequestHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('Enter one request header per line: Name: value.');
    const name = line.slice(0, colon).trim().toLowerCase();
    if (Object.hasOwn(headers, name)) throw new Error(`Duplicate request header: ${name}.`);
    headers[name] = line.slice(colon + 1).trim();
  }
  return requestHeaders(headers);
}

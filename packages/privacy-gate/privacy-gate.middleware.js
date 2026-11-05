// gate.middleware.js — magpie gateway middleware: the structural privacy gate.
//
// WHY THIS FILE EXISTS
// magpie's built-in Privacy masking (Settings -> Privacy, the built-in `redact`
// plugin) masks TEXT on the way out. Its documentation is explicit about what it
// cannot do: "Images and file data are sent as they are. Text inside a screenshot
// is not masked." This middleware runs inside magpie's gateway and closes exactly
// that structural gap. It never tries to mask text — that is magpie's job and this
// hook runs BEFORE magpie's redaction on the way out, so second-guessing it here
// would be wrong. What it owns is structure:
//
//   1. a content part the masker cannot mask (image / file / document / audio /
//      video, in any of the four agent APIs) is turned away with 403 for every
//      model that is not explicitly allowlisted as LOCAL;
//   2. an encoded blob (base64 / base64url / hex / data URI / PDF or ZIP magic)
//      smuggled through a TEXT field is turned away with 403;
//   3. a model allowlist (globs) turns away everything else, naming the model and
//      the policy, never the content;
//   4. a request this gate cannot fully inspect (unknown protocol, unreadable
//      body, over the inspection budget) is turned away — failing closed;
//   5. onUsage keeps bounded counters for the audit trail.
//
// RUNTIME
// moejs, inside magpie's own gateway process — NOT Bun. Standard JavaScript and
// console.log only. No timers, no network access, no Node APIs, and nothing is
// imported: the whole gate is this single file. Each request gets a runtime of its
// own, so module state is per request and the hooks share nothing but ctx.state.
// A hook has 250 ms per request. Crucially, magpie IGNORES a hook that throws or
// runs out of time and sends the request as it was, so every hook below catches
// its own errors and rejects instead of throwing: fail closed, never fail open.
//
// The code is written in defensive ES5 style (var / function declarations, no
// optional chaining, no template literals) because the engine is not Node's V8.
//
// OPTIONS (ctx.options, set with `magpie plugin options <name> '<json>'`)
//   allowModels: string[]        globs; [] (default) allows every model. Anything
//                                else is rejected with 403 naming the model.
//   localModels: string[]        globs; models that may RECEIVE binary/document
//                                parts, because the endpoint is on this machine or
//                                the local network (Ollama, LM Studio, ...). []
//                                (default) means every binary part is blocked.
//                                Encoded blobs in text are blocked even here.
//   allowUnknownProtocol: bool   false (default). When false, a request whose
//                                ctx.protocol is not chat/responses/anthropic/
//                                gemini is rejected (the gate cannot classify it).
//   blobBase64Chars: number      400. Longest tolerated base64 run in a text.
//   blobHexChars: number         400. Longest tolerated hex run in a text.
//   scanChars: number            200000. Total chars of text inspected per request
//                                (edges of long fields). Long bodies are not rejected;
//                                the middle of a very long text is not blob-scanned (the
//                                DSH Gate 1 sees each tool result separately and does).
//   localProviders: string[]     globs; provider ids that may receive binary parts even
//                                when the model id is not in localModels. Checked in
//                                onProvider, where the provider is actually known.
//   maxNodes: number             40000. JSON nodes inspected per request.
//   maxDepth: number             40. Nesting depth inspected per request.
//   logMaxLines: number          40. console.log lines this module may emit
//                                (magpie caps middleware output at 60 a minute).
//   logEveryRows: number         50. Emit one usage line every N usage rows.
//
// The hooks below return the body unchanged when they allow it, and otherwise
// return the value of ctx.reject(403, message). No message ever contains request
// content: only a part TYPE, a model id, a protocol name and counters.

// ---------------------------------------------------------------------------
// Constants: what is binary, and what is not ours to walk
// ---------------------------------------------------------------------------

// The four APIs an agent can speak to the gateway. Bodies and events reach the
// middleware in the agent's own API (ctx.protocol), not the provider's.
var KNOWN_PROTOCOL = { chat: 1, responses: 1, anthropic: 1, gemini: 1 };

// Part `type` values that carry bytes (or a reference to bytes) rather than text.
// Deliberately broad and dialect-tolerant: the same gate sees all four APIs, and
// different clients spell the same idea differently.
var BINARY_TYPE = {
  image_url: 1, input_image: 1, image: 1,
  file: 1, input_file: 1, document: 1,
  audio: 1, input_audio: 1, video: 1, input_video: 1
};

// Object keys that can only mean "binary payload here", wherever they appear
// (Gemini uses inlineData / fileData; OpenAI uses image_url / input_file; ...).
var STRONG_KEY = {
  image_url: 1, input_image: 1, input_file: 1, input_audio: 1,
  inlineData: 1, inline_data: 1, fileData: 1, file_data: 1
};

// Keys that mean binary only when they sit on an element of a content/parts
// array, which keeps ordinary tool arguments such as {"file": "report.txt"} out.
var WEAK_KEY = { image: 1, file: 1, document: 1, audio: 1, video: 1 };

// Declarations, not conversation: walking these costs time and would read JSON
// Schema property names as content. Everything else in the body is walked.
var SKIP_KEY = {
  tools: 1, toolConfig: 1, tool_config: 1,
  functions: 1, tool_choice: 1, toolChoice: 1,
  response_format: 1, responseFormat: 1,
  json_schema: 1, input_schema: 1, parameters: 1,
  responseSchema: 1, generationConfig: 1, generation_config: 1
};

// Array-valued keys whose elements are content parts.
var PART_ARRAY_KEY = { content: 1, parts: 1, output: 1, input: 1 };

var DEFAULTS = {
  allowModels: [],
  localModels: [],
  localProviders: [],
  allowUnknownProtocol: false,
  // A one-page invoice PDF is ~1-3 KB: ~1.4-4 k base64 chars, ~2-6 k hex chars. The
  // threshold is deliberately below that, because a smaller encoded document was a real
  // measured bypass. A false positive is a 403, which fails closed.
  blobBase64Chars: 400,
  blobHexChars: 400,
  // Total chars of text inspected per request. Bodies are NOT rejected for being long:
  // a 1M-token session is normal. The bound is deterministic (no clock), so the hook
  // cannot overrun its 250 ms budget and be ignored (which would fail open).
  scanChars: 200000,
  maxNodes: 40000,
  maxDepth: 40,
  logMaxLines: 40,
  logEveryRows: 50
};

var MARKER = "[privacy-gate: content withheld locally]";

// A data: URI that decodes to ~96 bytes or more is bytes, not text.
var DATA_URI_RE = /data:[a-z][a-z0-9.+/-]*\/[a-z0-9.+_-]+;base64,[A-Za-z0-9+/=_-]{128,}/i;
// One line of wrapped base64 (a PEM/JSON-wrapped payload split at 64/76 chars).
var B64_LINE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------------------------------------------------------------------------
// Small helpers (standard JavaScript only)
// ---------------------------------------------------------------------------

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(value, max) {
  var s = value === null || value === undefined ? "" : String(value);
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (s.length > max) s = s.slice(0, max) + "...";
  return s;
}

function numOpt(opts, key, fallback, lo, hi) {
  var v = opts[key];
  if (typeof v !== "number" || !isFinite(v)) return fallback;
  v = Math.floor(v);
  if (v < lo) v = lo;
  if (hi && v > hi) v = hi;
  return v;
}

function boolOpt(opts, key, fallback) {
  var v = opts[key];
  if (typeof v === "boolean") return v;
  return fallback;
}

function strList(opts, key) {
  var v = opts[key];
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < 200; i++) {
    if (typeof v[i] === "string" && v[i].length > 0 && v[i].length < 200) out.push(v[i]);
  }
  return out;
}

// Glob -> RegExp ("*" spans anything, "?" one character). Anchored, so a rule
// says exactly which model ids it covers.
var globCache = {};
var globCacheSize = 0;

function globRegExp(pattern) {
  if (has(globCache, pattern)) return globCache[pattern];
  var source = "^";
  for (var i = 0; i < pattern.length; i++) {
    var ch = pattern.charAt(i);
    if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  var re;
  try {
    re = new RegExp(source + "$", "i");
  } catch (e) {
    re = /^$/;
  }
  if (globCacheSize > 500) {
    globCache = {};
    globCacheSize = 0;
  }
  globCache[pattern] = re;
  globCacheSize++;
  return re;
}

function matchesAny(patterns, value) {
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i] === value) return true;
    if (globRegExp(patterns[i]).test(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inspection: walk the body, classify parts, hunt blobs
// ---------------------------------------------------------------------------

// Linear run-length checks: an unanchored /{400,}/ regex backtracks badly on
// long near-threshold input and can blow the 250 ms hook budget (fail open).
function hasBase64Run(text, min) {
  var run = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47) {
      run++;
      if (run >= min) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function hasHexRun(text, min) {
  var run = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) {
      run++;
      if (run >= min) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

// A payload wrapped at a fixed width escapes the single-run test, so count
// base64-looking lines instead. A one-page invoice is ~22 wrapped lines, so the
// bar is deliberately low; a line of pure hex is left to the hex rule.
function looksWrappedBase64(text, minTotal) {
  var lines = text.split(/\r?\n/);
  if (lines.length < 5) return false;
  var hits = 0;
  var sum = 0;
  var limit = lines.length < 400 ? lines.length : 400;
  for (var i = 0; i < limit; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "");
    if (line.length >= 32 && B64_LINE_RE.test(line) && /[^0-9A-Fa-f]/.test(line)) {
      hits++;
      sum += line.length;
    }
  }
  return hits >= 5 && sum >= minTotal;
}

// `Format-Hex`, `xxd`, `od`: many even-length hex tokens per line, with letters a-f
// somewhere in the group. Decimal tables (dates, amounts) never trip this.
function looksHexDump(text, minChars) {
  var lines = text.split(/\r?\n/);
  if (lines.length < 4) return false;
  var hexChars = 0;
  var alpha = 0;
  var limit = lines.length < 400 ? lines.length : 400;
  for (var i = 0; i < limit; i++) {
    var tokens = lines[i].replace(/^\s+|\s+$/g, "").split(/\s+/);
    var even = 0;
    var lineChars = 0;
    for (var t = 0; t < tokens.length; t++) {
      var bare = tokens[t].charAt(tokens[t].length - 1) === ":" ? tokens[t].slice(0, -1) : tokens[t];
      if (bare.length >= 2 && bare.length <= 16 && bare.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(bare)) {
        even++;
        lineChars += bare.length;
        if (/[a-fA-F]/.test(bare)) alpha++;
      }
    }
    if (even >= 4 && lineChars >= 16) hexChars += lineChars;
  }
  return hexChars >= minChars && alpha >= 6;
}

// One long token with base64url characters (no padding) can hide bytes too.
function looksLikeBase64UrlToken(text) {
  var tokens = text.split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.length < 1024) continue;
    if (!/^[A-Za-z0-9+_/=-]+$/.test(t)) continue;
    if (!/[0-9]/.test(t) || !/[a-z]/.test(t) || !/[A-Z]/.test(t)) continue;
    return true;
  }
  return false;
}

function scanText(text, state, opts) {
  // Deterministic work bound (no clock): every request gets `scanChars` characters of text
  // inspection in total, and one field may take at most an eighth of it (min 1k) so a
  // single pasted log cannot starve the rest of the newest turn. The middle of a longer
  // field, and text after the total budget, is not inspected (README says so).
  var remaining = opts.scanChars - state.chars;
  if (remaining <= 0) {
    state.degraded = true;
    return;
  }
  var share = Math.max(1024, Math.floor(opts.scanChars / 8));
  if (share > remaining) share = remaining;
  var window;
  if (text.length <= share) {
    window = text;
  } else {
    var edge = Math.floor(share / 2);
    window = text.slice(0, edge) + "\n" + text.slice(text.length - edge);
  }
  state.chars += Math.min(window.length, share);

  // A document's own magic bytes inside a text field: never text, never maskable.
  if (window.length >= 5 && window.slice(0, 5) === "%PDF-") {
    state.blob = { code: "PDF_MAGIC", length: window.length };
    return;
  }
  if (window.length >= 64 && window.indexOf("PK\u0003\u0004") >= 0) {
    state.blob = { code: "ZIP_MAGIC", length: window.length };
    return;
  }
  if (window.length >= 128 && window.indexOf("data:") >= 0 && DATA_URI_RE.test(window)) {
    state.blob = { code: "DATA_URI", length: window.length };
    return;
  }

  if (window.length >= opts.blobHexChars && hasHexRun(window, opts.blobHexChars)) {
    state.blob = { code: "HEX_RUN", length: window.length };
    return;
  }
  if (window.length >= opts.blobBase64Chars && hasBase64Run(window, opts.blobBase64Chars)) {
    state.blob = { code: "BASE64_RUN", length: window.length };
    return;
  }
  if (window.length >= opts.blobBase64Chars) {
    if (window.indexOf("\n") >= 0 && looksWrappedBase64(window, opts.blobBase64Chars)) {
      state.blob = { code: "BASE64_WRAPPED", length: window.length };
      return;
    }
    if (window.indexOf("\n") >= 0 && looksHexDump(window, opts.blobHexChars)) {
      state.blob = { code: "HEX_DUMP", length: window.length };
      return;
    }
  }
  if (window.length >= opts.blobBase64Chars && looksLikeBase64UrlToken(window)) {
    state.blob = { code: "BASE64URL_RUN", length: window.length };
  }
}

// Does this object look like a content part carrying bytes?
// Direct checks avoid enumerating STRONG_KEY/WEAK_KEY on every object in moejs.
function binaryOf(node, partContext) {
  var type = node.type;
  if (typeof type === "string" && BINARY_TYPE[type]) return { kind: type, how: "type" };
  if (has(node, "image_url")) return { kind: "image_url", how: "key" };
  if (has(node, "input_image")) return { kind: "input_image", how: "key" };
  if (has(node, "input_file")) return { kind: "input_file", how: "key" };
  if (has(node, "input_audio")) return { kind: "input_audio", how: "key" };
  if (has(node, "inlineData")) return { kind: "inlineData", how: "key" };
  if (has(node, "inline_data")) return { kind: "inline_data", how: "key" };
  if (has(node, "fileData")) return { kind: "fileData", how: "key" };
  if (has(node, "file_data")) return { kind: "file_data", how: "key" };
  if (partContext) {
    if (has(node, "image")) return { kind: "image", how: "key" };
    if (has(node, "file")) return { kind: "file", how: "key" };
    if (has(node, "document")) return { kind: "document", how: "key" };
    if (has(node, "audio")) return { kind: "audio", how: "key" };
    if (has(node, "video")) return { kind: "video", how: "key" };
  }
  return null;
}

// Exempt a vendor-sealed field only at the position the protocol reserves for it.
// The walker assigns these site tags from the protocol layout; it never infers a site
// from a key name, so a tool argument or message text that imitates a vendor block is
// still scanned.
var SITE_ROOT = "root";
var SITE_MESSAGES = "messages";
var SITE_MESSAGE = "message";
var SITE_CONTENT = "content";
var SITE_ANTHROPIC_ASSISTANT = "anthropic-assistant-content";
var SITE_CHAT_ASSISTANT = "chat-assistant-content";
var SITE_RESPONSES_INPUT = "responses-input";
var SITE_RESPONSES_ITEM = "responses-item";
var SITE_GEMINI_CONTENTS = "gemini-contents";
var SITE_GEMINI_CONTENT = "gemini-content";
var SITE_GEMINI_PARTS = "gemini-parts";
var SITE_GEMINI_MODEL_PARTS = "gemini-model-parts";

function isPartSite(site) {
  return site === SITE_CONTENT || site === SITE_ANTHROPIC_ASSISTANT ||
    site === SITE_CHAT_ASSISTANT || site === SITE_GEMINI_PARTS ||
    site === SITE_GEMINI_MODEL_PARTS || site === SITE_RESPONSES_ITEM;
}

function sealedFields(value, site) {
  var type = value.type;
  if (site === SITE_ANTHROPIC_ASSISTANT) {
    // Anthropic protocol: thinking carries signature; redacted_thinking carries data.
    if (type === "thinking") return { signature: 1 };
    if (type === "redacted_thinking") return { data: 1 };
    return null;
  }
  if (site === SITE_CHAT_ASSISTANT) {
    // DSH's pi-ai chat shape uses thinkingSignature on a thinking block; tool calls
    // carry vendor ids and thought signatures. Chat text parts have none.
    if (type === "thinking") return { thinkingSignature: 1 };
    if (type === "toolCall" || type === "tool_call" || type === "function_call") {
      return { id: 1, call_id: 1, thoughtSignature: 1, textSignature: 1 };
    }
    return null;
  }
  if (site === SITE_RESPONSES_ITEM) {
    // Responses input items: only a reasoning item's encrypted_content/id and an
    // assistant message's id are vendor-sealed. A user message's id is not.
    if (type === "reasoning") return { encrypted_content: 1, id: 1 };
    if (type === "message" && value.role === "assistant") return { id: 1 };
    if (type === "function_call" || type === "custom_tool_call" || type === "tool_call") {
      return { id: 1, call_id: 1 };
    }
    return null;
  }
  if (site === SITE_GEMINI_MODEL_PARTS) {
    // Only a model-role Gemini part holds vendor signatures; a user part does not.
    if (has(value, "thoughtSignature") || has(value, "textSignature")) {
      return { thoughtSignature: 1, textSignature: 1 };
    }
  }
  return null;
}

// The only arrays that can carry a protocol site tag. Everything nested below a
// site (tool_use.input, tool_result.content, function_call.arguments, ...) falls
// back to null and is scanned as ordinary content.
function childSite(protocol, site, key, child, role) {
  if (!Array.isArray(child)) return null;
  if (site === SITE_ROOT) {
    if ((protocol === "anthropic" || protocol === "chat") && key === "messages") return SITE_MESSAGES;
    if (protocol === "responses" && key === "input") return SITE_RESPONSES_INPUT;
    if (protocol === "gemini" && key === "contents") return SITE_GEMINI_CONTENTS;
    return null;
  }
  if (site === SITE_MESSAGE && key === "content") {
    if (role === "assistant") {
      return protocol === "chat" ? SITE_CHAT_ASSISTANT : SITE_ANTHROPIC_ASSISTANT;
    }
    return SITE_CONTENT;
  }
  if (site === SITE_RESPONSES_ITEM && key === "content") return SITE_CONTENT;
  if (site === SITE_GEMINI_CONTENT && key === "parts") {
    return role === "model" ? SITE_GEMINI_MODEL_PARTS : SITE_GEMINI_PARTS;
  }
  return null;
}

// Bounded depth-first walk with an explicit protocol site.
function walkValue(value, site, depth, state, opts, protocol) {
  if (state.limited !== null || state.binary !== null || state.blob !== null) return;

  if (depth > opts.maxDepth) {
    state.limited = "depth";
    return;
  }

  // Every visited value counts toward maxNodes, including primitives and array
  // elements. This is what bounds a 3M-number array or 1.5M short strings.
  state.nodes++;
  if (state.nodes > opts.maxNodes) {
    state.limited = "nodes";
    return;
  }

  if (typeof value === "string") {
    scanText(value, state, opts);
    return;
  }
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    // A single array wider than the remaining budget is refused without
    // iterating it; otherwise every element is charged by walkValue.
    if (value.length > opts.maxNodes - state.nodes) {
      state.limited = "nodes";
      return;
    }
    var itemSite = site;
    if (site === SITE_MESSAGES) itemSite = SITE_MESSAGE;
    else if (site === SITE_RESPONSES_INPUT) itemSite = SITE_RESPONSES_ITEM;
    else if (site === SITE_GEMINI_CONTENTS) itemSite = SITE_GEMINI_CONTENT;
    var reverse = site === SITE_MESSAGES || site === SITE_RESPONSES_INPUT || site === SITE_GEMINI_CONTENTS;
    for (var i = 0; i < value.length; i++) {
      var index = reverse ? value.length - 1 - i : i;
      walkValue(value[index], itemSite, depth + 1, state, opts, protocol);
      if (state.limited !== null || state.binary !== null || state.blob !== null) return;
    }
    return;
  }

  var found = binaryOf(value, isPartSite(site));
  if (found !== null) {
    state.binary = found;
    return;
  }

  var sealed = sealedFields(value, site);
  var role = typeof value.role === "string" ? value.role : "";
  var keys = Object.keys(value);
  if (keys.length > opts.maxNodes - state.nodes) {
    state.limited = "nodes";
    return;
  }
  if (site === SITE_ROOT) {
    var contentKey = (protocol === "anthropic" || protocol === "chat") ? "messages" : protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "";
    var at = contentKey ? keys.indexOf(contentKey) : -1;
    if (at > 0) { keys.splice(at, 1); keys.unshift(contentKey); }
  }
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    if (SKIP_KEY[key]) continue;
    var child = value[key];
    if (sealed !== null && sealed[key] && typeof child === "string") continue;
    walkValue(child, childSite(protocol, site, key, child, role), depth + 1, state, opts, protocol);
    if (state.limited !== null || state.binary !== null || state.blob !== null) return;
  }
}

function modelOf(body, ctx) {
  if (ctx && typeof ctx.model === "string" && ctx.model.length > 0) return ctx.model;
  if (isObject(body) && typeof body.model === "string") return body.model;
  return "";
}

// Every hook must work with NO options saved at all (`ctx.options` undefined is
// the documented default: "a middleware runs with no options until you save
// some"). Resolving the defaults once here keeps the fail-closed behaviour of an
// unconfigured gate: no localModels means every binary part is rejected.
function resolvedOptions(raw) {
  var source = raw && typeof raw === "object" ? raw : {};
  return {
    allowModels: strList(source, "allowModels"),
    localModels: strList(source, "localModels"),
    localProviders: strList(source, "localProviders"),
    allowUnknownProtocol: boolOpt(source, "allowUnknownProtocol", DEFAULTS.allowUnknownProtocol),
    blobBase64Chars: numOpt(source, "blobBase64Chars", DEFAULTS.blobBase64Chars, 64, 1000000),
    blobHexChars: numOpt(source, "blobHexChars", DEFAULTS.blobHexChars, 64, 1000000),
    scanChars: numOpt(source, "scanChars", DEFAULTS.scanChars, 1000, 5000000),
    maxNodes: numOpt(source, "maxNodes", DEFAULTS.maxNodes, 1000, 5000000),
    maxDepth: numOpt(source, "maxDepth", DEFAULTS.maxDepth, 1, 200),
    logMaxLines: numOpt(source, "logMaxLines", DEFAULTS.logMaxLines, 0, 500),
    logEveryRows: numOpt(source, "logEveryRows", DEFAULTS.logEveryRows, 1, 100000)
  };
}

function gateOptions(ctx) {
  if (ctx && ctx.options && typeof ctx.options === "object") return resolvedOptions(ctx.options);
  return resolvedOptions(null);
}

function usageOptions(options) {
  return resolvedOptions(options);
}

function blocked(code, message) {
  return { ok: false, block: { code: code, message: message } };
}

// The whole policy decision. Returns {ok:true} or a block descriptor; it may
// throw only if the body is unreadable, and onRequest turns that into a block.
function inspect(body, ctx) {
  var opts = gateOptions(ctx);
  var model = clip(modelOf(body, ctx), 120);
  var protocol = ctx && typeof ctx.protocol === "string" ? clip(ctx.protocol, 40) : "";

  if (!isObject(body) && !Array.isArray(body)) {
    return blocked("BODY", "privacy-gate: the request body is not an object the gate can inspect; nothing was sent.");
  }

  if (!protocol || KNOWN_PROTOCOL[protocol] !== 1) {
    if (!boolOpt(opts, "allowUnknownProtocol", DEFAULTS.allowUnknownProtocol)) {
      return blocked(
        "PROTOCOL",
        "privacy-gate: request protocol \"" + (protocol || "unknown") +
          "\" cannot be classified by this gate; nothing was sent."
      );
    }
  }

  var allowModels = opts.allowModels;
  if (allowModels.length > 0 && !matchesAny(allowModels, model)) {
    return blocked(
      "MODEL",
      "privacy-gate: model \"" + model +
        "\" is not in this gate's model allowlist; nothing was sent."
    );
  }

  var local = matchesAny(opts.localModels, model);
  var state = {
    nodes: 0,
    chars: 0,
    binary: null,
    blob: null,
    limited: null,
    degraded: false
  };
  walkValue(body, SITE_ROOT, 0, state, opts, protocol);

  if (state.degraded) {
    // Not a rejection: the text scan hit its character budget. The structural decision
    // (binary parts, depth, node count) is complete, and the DSH Gate 1 covers text.
    logLine("privacy-gate: text scan hit its character budget; structural checks only", opts);
  }

  if (state.limited !== null) {
    return blocked(
      "INSPECT_LIMIT",
      "privacy-gate: the request is too large to inspect inside the middleware inspection budget (" +
        state.limited + " limit); nothing was sent."
    );
  }

  if (state.binary !== null && !local) {
    return blocked(
      "BINARY_PART",
      "privacy-gate: a content part of type \"" + clip(state.binary.kind, 40) +
        "\" cannot be masked locally; extract it to text first (Settings -> Privacy masks text only). Nothing was sent."
    );
  }

  // An encoded blob in a text field is bytes whatever the model is: even a local
  // model is not an extractor, and the contract makes this a block signal.
  if (state.blob !== null) {
    return blocked(
      "BLOB",
      "privacy-gate: a text field carries an encoded blob (" + state.blob.code +
        ") that cannot be masked locally; extract it to text first. Nothing was sent."
    );
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Last-resort body blanking (only when ctx.reject is unusable)
// ---------------------------------------------------------------------------

function sanitize(body, ctx) {
  var protocol = ctx && typeof ctx.protocol === "string" ? ctx.protocol : "";
  try {
    if (!isObject(body)) {
      return { messages: [{ role: "user", content: MARKER }] };
    }
    delete body.prompt;
    delete body.system;
    delete body.instructions;
    delete body.systemInstruction;
    delete body.system_instruction;
    // Drop every content container first, then put back the one the protocol uses,
    // so a body carrying more than one of them cannot keep bytes in the others.
    delete body.messages;
    delete body.input;
    delete body.contents;
    if (protocol === "anthropic") {
      body.messages = [{ role: "user", content: [{ type: "text", text: MARKER }] }];
    } else if (protocol === "gemini") {
      body.contents = [{ role: "user", parts: [{ text: MARKER }] }];
    } else if (protocol === "responses") {
      body.input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: MARKER }] }
      ];
    } else if (protocol === "chat") {
      body.messages = [{ role: "user", content: MARKER }];
    } else {
      // Unknown protocol: blank every content container we know of.
      body.messages = [{ role: "user", content: MARKER }];
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: MARKER }] }];
      body.contents = [{ role: "user", parts: [{ text: MARKER }] }];
    }
    return body;
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Audit counters and bounded logging
// ---------------------------------------------------------------------------

var counters = {
  requests: 0,
  rejected: 0,
  providerBlanked: 0,
  blanked: 0,
  logLines: 0
};

var usage = {
  rows: 0,
  status403: 0,
  errors: 0,
  lastModel: "",
  lastStatus: 0
};

function logLine(text, opts) {
  var cap = opts && typeof opts.logMaxLines === "number" ? opts.logMaxLines : DEFAULTS.logMaxLines;
  if (counters.logLines >= cap) return;
  counters.logLines++;
  try {
    console.log(text);
  } catch (e) {
    // Logging must never be the reason a decision is lost.
  }
}

function rejectOrBlank(body, ctx, block, opts) {
  logLine(
    "privacy-gate: blocked code=" + block.code +
      " protocol=" + clip(ctx && ctx.protocol, 40) +
      " model=" + clip(modelOf(body, ctx), 120),
    opts
  );
  try {
    if (ctx && typeof ctx.reject === "function") {
      counters.rejected++;
      // In magpie's host, ctx.reject performs the rejection and returns nothing.
      // Calling it is the rejection; do not treat "nothing returned" as a failure.
      ctx.reject(403, block.message);
      return undefined;
    }
  } catch (e) {
    // The call itself failed; fall through to a content-less body.
  }
  counters.blanked++;
  logLine("privacy-gate: ctx.reject unavailable; sent a content-less request instead", opts);
  return sanitize(body, ctx);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// Runs before routing and before magpie's text masking. Rejection is the only
// fail-closed outcome available here; returning nothing would send the body.
export function onRequest(body, ctx) {
  var opts = gateOptions(ctx);
  counters.requests++;
  var decision;
  try {
    decision = inspect(body, ctx);
  } catch (e) {
    decision = blocked(
      "INTERNAL",
      "privacy-gate: the gate failed while inspecting the request; nothing was sent."
    );
  }
  if (decision.ok === true) return body;
  return rejectOrBlank(body, ctx, decision.block, opts);
}

// Structural-only walk used by onProvider: finds a binary part without scanning text,
// so it stays cheap and independent of the text budget.
function findFirstBinary(value, partContext, depth, state, opts) {
  if (state.binary !== null || (state.limited !== undefined && state.limited !== null) || depth > opts.maxDepth) return;
  state.nodes = (state.nodes || 0) + 1;
  if (state.nodes > opts.maxNodes) {
    state.limited = "nodes";
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > opts.maxNodes - state.nodes) {
      state.limited = "nodes";
      return;
    }
    for (var i = 0; i < value.length; i++) {
      findFirstBinary(value[i], partContext, depth + 1, state, opts);
      if (state.binary !== null || state.limited !== null) return;
    }
    return;
  }
  var found = binaryOf(value, partContext);
  if (found !== null) {
    state.binary = found;
    return;
  }
  var keys = Object.keys(value);
  if (keys.length > opts.maxNodes - state.nodes) {
    state.limited = "nodes";
    return;
  }
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    if (SKIP_KEY[key]) continue;
    var child = value[key];
    findFirstBinary(child, PART_ARRAY_KEY[key] === 1 && Array.isArray(child), depth + 1, state, opts);
    if (state.binary !== null || state.limited !== null) return;
  }
}

// Runs once per provider try, after routing. It CANNOT turn the request away, so
// it does the fail-closed thing that is still available: blank the content
// containers and send a text-only request. Defense in depth only — onRequest has
// normally already rejected, but a hook ordered after this one, an earlier
// middleware's injection, or a timed-out onRequest could still put bytes here.
export function onProvider(body, ctx) {
  var opts = gateOptions(ctx);
  var decision;
  try {
    decision = inspect(body, ctx);
  } catch (e) {
    decision = blocked("INTERNAL", "privacy-gate: internal error");
  }
  if (decision.ok === true) {
    // The model id is supplied by the agent; here the provider is finally known. A binary
    // part is allowed through only if that provider is declared local too, so a
    // local-sounding model id cannot smuggle bytes to a remote endpoint.
    var providerId = "";
    try {
      if (ctx && ctx.provider && typeof ctx.provider.id === "string") providerId = ctx.provider.id;
    } catch (e3) {
      providerId = "";
    }
    var binaryState = { binary: null, limited: null, nodes: 0 };
    try {
      findFirstBinary(body, false, 0, binaryState, opts);
    } catch (e4) {
      binaryState.binary = { kind: "unknown" };
    }
    if (binaryState.limited !== null) binaryState.binary = { kind: "unknown" };
    if (binaryState.binary !== null) {
      // Only an explicitly declared local PROVIDER may receive bytes. The model id is
      // agent-supplied; the provider id is what magpie will actually call.
      var providerLocal = providerId !== "" && matchesAny(opts.localProviders, providerId);
      if (!providerLocal) {
        counters.providerBlanked++;
        logLine("privacy-gate: provider " + clip(providerId, 60) + " is not declared local; blanking binary content", opts);
        try {
          return sanitize(body, ctx);
        } catch (e5) {
          return {};
        }
      }
    }
    return body;
  }

  counters.providerBlanked++;
  logLine(
    "privacy-gate: provider try could not be rejected; blanking the body code=" +
      decision.block.code,
    opts
  );
  try {
    return sanitize(body, ctx);
  } catch (e2) {
    return {};
  }
}

// Usage rows only: no body, no prompt, no error text. Counters and one bounded
// line every logEveryRows rows; magpie writes it into its own log.
export function onUsage(row, options) {
  var opts = usageOptions(options);
  try {
    usage.rows++;
    if (row && typeof row.model === "string") usage.lastModel = clip(row.model, 120);
    var status = row && typeof row.status === "number" ? row.status : 0;
    usage.lastStatus = status;
    if (status === 403) usage.status403++;
    if (status >= 500) usage.errors++;
    else if (row && (row.errorType || row.error_type)) usage.errors++;

    var every = numOpt(opts, "logEveryRows", DEFAULTS.logEveryRows, 1, 10000);
    if (usage.rows === 1 || usage.rows % every === 0) {
      logLine(
        "privacy-gate: usage rows=" + usage.rows +
          " blocked403=" + usage.status403 +
          " errors=" + usage.errors +
          " lastModel=" + (usage.lastModel || "?") +
          " lastStatus=" + usage.lastStatus,
        opts
      );
    }
  } catch (e) {
    // An audit hook must never fail a request.
  }
}

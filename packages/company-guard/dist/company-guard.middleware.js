// vendor/hashes.js
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});
var _HMAC = class {
  constructor(hash, key) {
    __publicField(this, "oHash");
    __publicField(this, "iHash");
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", false);
    __publicField(this, "finished", false);
    __publicField(this, "destroyed", false);
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  constructor(blockLen, outputLen, padOffset, isLE) {
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", false);
    __publicField(this, "padOffset");
    __publicField(this, "isLE");
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "finished", false);
    __publicField(this, "length", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "destroyed", false);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    __publicField(this, "A", 0);
    __publicField(this, "B", 0);
    __publicField(this, "C", 0);
    __publicField(this, "D", 0);
    __publicField(this, "E", 0);
    __publicField(this, "F", 0);
    __publicField(this, "G", 0);
    __publicField(this, "H", 0);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to || (to = new this.constructor())).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// src/crypto.js
function utf8(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 56320 && lo <= 57343) {
        cp = 65536 + (cp - 55296 << 10) + lo - 56320;
        i++;
      } else cp = 65533;
    } else if (cp >= 56320 && cp <= 57343) cp = 65533;
    if (cp < 128) out.push(cp);
    else if (cp < 2048) out.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536) out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    else out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  return new Uint8Array(out);
}
function hex(bytes) {
  let out = "";
  for (const n of bytes) out += n.toString(16).padStart(2, "0");
  return out;
}
function validKey(key) {
  return typeof key === "string" && /^[0-9a-f]{64}$/.test(key);
}
function keyBytes(key) {
  if (!validKey(key)) throw new Error("guard_key_missing");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function sign(key, text) {
  return hex(hmac(sha256, keyBytes(key), utf8(text)));
}
function scopedSigner(key, prefix) {
  const base = hmac.create(sha256, keyBytes(key)).update(utf8(prefix));
  return (text) => hex(base.clone().update(utf8(text)).digest());
}
function digest(text) {
  return hex(sha256(utf8(text)));
}
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// src/policy.js
var PROOF = "__nero_company_guard";
var TASK_NAME_LIMIT = 65536;
var TOKEN_PREFIX = "[[NERO_ORG_";
function normalPrompt(s) {
  return typeof s === "string" ? s.replace(/\r\n/g, "\n").trim() : "";
}
function directive(prompt) {
  const first = normalPrompt(prompt).split("\n", 1)[0];
  if (first.length > 600) return null;
  const m = /^(本轮允许原名|本次允许原名|本轮不脱敏|本次不脱敏|允许原名|不脱敏|联网核查|互联网核查|互联核查)\s*[:：]\s*(.+)$/.exec(first);
  if (!m) return null;
  const names = m[2].replace(/[。.]$/, "").split(/[；;、]/).map((s) => s.trim());
  if (!names.length || names.length > 32 || names.some((s) => !validName(s) || /^(所有|全部|任何|all|\*)$/i.test(s) || /[\n<>?？!！]/.test(s))) return null;
  return { mode: /核查$/.test(m[1]) ? "public_lookup" : "original", names: [...new Set(names)] };
}
function identity(body) {
  const c = body && body.client_metadata;
  if (!c || typeof c !== "object") return null;
  let m = c["x-codex-turn-metadata"] || c;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  const ok = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(x);
  if (!m || !ok(m.thread_id) || !ok(m.turn_id) || m.thread_source !== "user") return null;
  return { thread: m.thread_id, turn: m.turn_id };
}
function taskSession(body, ctx) {
  if (!["local", "magpie-key"].includes(ctx?.origin) || ctx?.agent !== "codex" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(ctx?.session || "")) return null;
  const c = body?.client_metadata;
  let m = c?.["x-codex-turn-metadata"] || c;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (m && typeof m !== "object") return null;
  if (m?.thread_source && !["user", "agent_created_thread"].includes(m.thread_source)) return null;
  if (m?.thread_id && m.thread_id !== ctx.session) return null;
  return ctx.session;
}
function readProof(proof, body, key, ctx) {
  if (!proof || typeof proof.payload !== "string" || proof.payload.length > 2 * 1024 * 1024 || !same((ctx?.sign || sign)(key, proof.payload), proof.mac)) return null;
  let p;
  try {
    p = JSON.parse(proof.payload);
  } catch {
    return null;
  }
  if (p.v === 1 && proof.payload.length > 12e3) return null;
  const id = identity(body), now = Date.now();
  if (!Number.isFinite(p.expires) || p.expires <= now || p.expires > now + 15e3) return null;
  const session = taskSession(body, ctx);
  const task = p.v === 2 && p.scope === "session_task" && !!session && p.thread === session;
  if (!task && (!id || p.v !== 1 || p.thread !== id.thread || p.turn !== id.turn)) return null;
  if (!["original", "public_lookup"].includes(p.mode) || !Array.isArray(p.names) || p.names.length > (task ? TASK_NAME_LIMIT : 32) || p.names.some((n) => !validName(n))) return null;
  return p;
}
function validName(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 120 && !/^\s|\s$/.test(s) && /[A-Za-z\u00c0-\u024f\u3400-\u9fff]/.test(s) && !/[\x00-\x1f]/.test(s) && !s.includes(TOKEN_PREFIX);
}
function configuredNames(options) {
  const out = [];
  for (const c of options.companies || []) {
    if (typeof c === "string") out.push(c);
    else if (c && typeof c === "object") {
      out.push(c.name);
      if (Array.isArray(c.aliases)) out.push(...c.aliases);
    }
  }
  if (out.length > 512 || out.some((n) => !validName(n))) throw new Error("invalid_company_options");
  return [...new Set(out)];
}
function expandAllowed(names, options) {
  const out = new Set(names);
  for (const c of options.companies || []) {
    if (!c || typeof c !== "object") continue;
    const group = [c.name, ...Array.isArray(c.aliases) ? c.aliases : []];
    if (group.some((n) => out.has(n))) {
      for (const n of group) if (validName(n)) out.add(n);
    }
  }
  return out;
}
function environmentText(s) {
  const t = s.trim();
  return t.startsWith("<environment_context>") || t.startsWith("<environment_info>") || t.startsWith("# AGENTS.md instructions for ");
}
function webTool(name) {
  return ["web.run", "web__run", "functions.web__run", "mcp__codex_apps__search_service__web_search", "mcp__codex_apps__search_service__search", "mcp__codex_apps__search_service__browse"].includes(name);
}
var LEGAL_NAME = /[\u3400-\u9fffA-Za-z0-9（(][\u3400-\u9fffA-Za-z0-9（）()·&．.\-]{1,79}?(?:股份有限公司|有限责任公司|有限公司|股份公司|集团公司)/;
var ENGLISH_KIND = /(?:Co\.,?[ \t]+Ltd\.?|Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|L\.L\.C\.|PLC|GmbH)/.source.replace(/\\.|Limited|[A-Za-z]/g, (value) => value === "Limited" ? "L[Ii][Mm][Ii][Tt][Ee][Dd]" : value.length === 1 ? `[${value.toUpperCase()}${value.toLowerCase()}]` : value);
var KIND_SUFFIX = /(?:股份有限公司|有限责任公司|有限公司|股份公司|集团公司|集团|公司)$/;
var GENERIC_PARTS = /(?:非上市|拟上市|非公众|供应商|交易对手|发行人|保荐人|可比|其他|任何|所有|全部|上述|相关|目标|项目|主体|企业|真实|实际|一般|普通|外部|内部|境内|境外|国内|国外|上市|公众|有限|股份|母子|集团|关联|同控|控股|参股|全资|被投|投资|持股|合作|客户|这家|那家|本|贵|该|各|某|母|子|孙)/g;
var FIELD_DESCRIPTION = /的(?:公司|集团)$|避免|当作|当成|没有|并非|不是|是否|能否|不能|不应|不要|只对|仅对|包含|保留|保护|替换|脱敏|识别|显示|看到|查看|核实|确认|表示|说明|继续|启动|存在|属于|涉及|上传|下载|配置|插件|页面|功能|工具|规则|名称|原名|本轮|本次|字段|提示词|样本|包括|以及|而非|等非|某个|某家|一家|一个|哪些|这些|这种|这类|用于|构成|均以|通过|提供的/;
var cleanName = (name) => name.replace(/^.*(?:映射最初包含|另查到|单独归入)/, "").replace(/^(?:(?:请帮我|帮我|请|查询|核查|分析|关于|公司名为|客户为|供应商为|交易对手为|以及|来自))+/, "");
var genericName = (name) => name.replace(KIND_SUFFIX, "").replace(GENERIC_PARTS, "") === "";
function nameFieldValue(text, field = "") {
  if (typeof text !== "string") return null;
  const name = text.trim();
  if (!validName(name) || genericName(name)) return null;
  if (/^(?:unknown|none|null|n\/a|string|number|boolean|object|array)$/i.test(name)) return null;
  const full = LEGAL_NAME.exec(name);
  if (full && full[0] === name) return name;
  if (/^(?:company|customer|supplier|counterparty)$/i.test(field) && /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return null;
  return FIELD_DESCRIPTION.test(name) ? null : name;
}
function recognitionText(text, quotes = false) {
  return text.replace(/\\+(r\\+n|[nrt"])?/g, (raw, escaped) => !escaped ? raw : escaped === '"' ? quotes ? '"' : raw : "\n");
}
var LEGAL_HINT = /有限公司|有限责任公司|股份公司|集团公司/;
var ENGLISH_HINT = new RegExp("[ ,](?:" + ENGLISH_KIND + ")\\b");
var FIELD_HINT = /company|customer|supplier|counterparty|entity_name|公司名称|客户名称|供应商名称|交易对手名称/i;
function scanLegalNames(text, visit) {
  const suffixes = ["\u80A1\u4EFD\u6709\u9650\u516C\u53F8", "\u6709\u9650\u8D23\u4EFB\u516C\u53F8", "\u6709\u9650\u516C\u53F8", "\u80A1\u4EFD\u516C\u53F8", "\u96C6\u56E2\u516C\u53F8"];
  const next = suffixes.map((s) => text.indexOf(s));
  const legal = new RegExp(LEGAL_NAME.source, "g");
  let after = 0;
  for (; ; ) {
    let k = -1;
    for (let i = 0; i < next.length; i++) if (next[i] >= 0 && (k < 0 || next[i] < next[k])) k = i;
    if (k < 0) return;
    const at = next[k], end = at + suffixes[k].length;
    next[k] = text.indexOf(suffixes[k], at + 1);
    if (at < after) continue;
    const from = Math.max(after, at - 80);
    legal.lastIndex = 0;
    const m = legal.exec(text.slice(from, end));
    if (!m) continue;
    m.index += from;
    after = m.index + m[0].length;
    for (let i = 0; i < next.length; i++) if (next[i] >= 0 && next[i] < after) next[i] = text.indexOf(suffixes[i], after);
    visit(m);
  }
}
function detectNames(text) {
  const out = [];
  const add = (s) => {
    if (validName(s)) out.push(s);
  };
  const legalHint = LEGAL_HINT.test(text), englishHint = ENGLISH_HINT.test(text), fieldHint = FIELD_HINT.test(text);
  if (!legalHint && !englishHint && !fieldHint) return out;
  text = recognitionText(text);
  if (legalHint) scanLegalNames(text, (m) => {
    let name = cleanName(m[0]);
    if (name.startsWith("\u4E0E") && /(?:用户|您|你|贵方)[”"」』]?[）)]$/.test(text.slice(Math.max(0, m.index - 24), m.index).trimEnd().replace(/\\+(?=")/g, ""))) name = name.slice(1);
    if (!genericName(name)) add(name);
  });
  const en = new RegExp(/\b[A-Z][A-Za-z0-9&.'’-]*(?:[ \t]+[A-Za-z0-9&.'’-]+){0,7}[ ,]+/.source + ENGLISH_KIND + /\b\.?/.source, "g");
  for (const m of englishHint ? text.matchAll(en) : []) {
    if (!/\bBUT\s+NOT\s+LIMITED\.?$/i.test(m[0])) add(m[0]);
  }
  const fields = /(?:"(company(?:_name)?|customer(?:_name)?|supplier(?:_name)?|counterparty(?:_name)?|entity_name|公司名称|客户名称|供应商名称|交易对手名称)"\s*:\s*"((?:[^"\\]|\\.)*)"|(?:公司名称|客户名称|供应商名称|交易对手名称)[：:]\s*([^\n,，;；|\t]{2,120}))/gi;
  for (const m of fieldHint ? text.matchAll(fields) : []) {
    if (m[2] !== void 0) {
      try {
        const name = nameFieldValue(JSON.parse('"' + m[2] + '"'), m[1]);
        if (name) add(name);
      } catch {
      }
    } else {
      const name = nameFieldValue(m[3]);
      if (name) add(name);
    }
  }
  return [...new Set(out)];
}
function taskAliases(slots) {
  const relations = /* @__PURE__ */ new Map(), blocked = /* @__PURE__ */ new Set();
  const generic = /^(?:我们|我方|对方|双方|各方|甲方|乙方|丙方|用户|您|你|本平台|本服务|本产品|本项目|本系统|平台|服务|产品|游戏|项目|系统|科技|电子|信息|中国|简称|全称|co|corp|inc|ltd|llc)$/i;
  const quoted = /^[“"「『]([^”"」』]{2,40})[”"」』]/;
  for (const slot of slots) {
    if (!["user", "tool"].includes(slot.source)) continue;
    const original = slot.owner[slot.key];
    if (environmentText(original)) continue;
    const text = recognitionText(original.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, "\n"), true);
    const definitions = /[（(，,][ \t]*(?:(?:以下|下文)(?:简称|亦称|称)|简称(?:为)?)[ \t]*[：:]?[ \t]*(?=[“"「『])/g;
    for (const marker of text.matchAll(definitions)) {
      const prefix = text.slice(Math.max(0, marker.index - 180), marker.index).trimEnd();
      const full = detectNames(prefix).filter((n) => prefix.endsWith(n) && (LEGAL_NAME.test(n) || /(?:Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|L\.L\.C\.|PLC|GmbH)$/i.test(n))).sort((a, b) => b.length - a.length)[0];
      if (!full || /(?:例如|示例|举例|样例|例子|假设|虚构)/.test(prefix.slice(prefix.lastIndexOf("\n") + 1, -full.length))) continue;
      let tail = text.slice(marker.index + marker[0].length, marker.index + marker[0].length + 180);
      for (let count = 0; count < 4; count++) {
        const match = quoted.exec(tail);
        if (!match) break;
        const alias = match[1].trim();
        if (/^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9 &·.\-]{1,31}$/.test(alias) && nameFieldValue(alias) && !generic.test(alias) && alias.toLowerCase() !== full.toLowerCase()) {
          const key = alias.toLowerCase(), prior = relations.get(key);
          if (prior && prior.full.toLowerCase() !== full.toLowerCase()) blocked.add(key);
          else relations.set(key, { alias, full });
          if (relations.size > 128) return { names: [], conflicts: blocked.size, limited: true };
        }
        const rest = tail.slice(match[0].length), next = /^[ \t]*(?:或|、|及|和|\/)[ \t]*(?=[“"「『])/.exec(rest);
        if (!next) break;
        tail = rest.slice(next[0].length);
      }
    }
  }
  return { names: [...relations].filter(([key]) => !blocked.has(key)).map(([, value]) => value.alias), conflicts: blocked.size, limited: false };
}
function escapeRE(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function namePattern(names) {
  const root = /* @__PURE__ */ new Map();
  for (const name of names.slice().sort((a, b) => b.length - a.length)) {
    let node = root;
    for (const c of name) {
      const upper = c.length === 1 ? c.toUpperCase() : c;
      const key = upper.length === 1 && !(c.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : c;
      if (!node.has(key)) node.set(key, /* @__PURE__ */ new Map());
      node = node.get(key);
    }
    node.set("", null);
  }
  const render = (node) => {
    let prefix = "";
    while (node.size === 1 && !node.has("")) {
      const [c, next] = node.entries().next().value;
      prefix += escapeRE(c);
      node = next;
    }
    const branches = [];
    for (const [c, next] of node) if (c) branches.push(escapeRE(c) + render(next));
    if (node.has("")) branches.push("");
    return prefix + (branches.length > 1 ? "(?:" + branches.join("|") + ")" : branches[0] || "");
  };
  return render(root);
}

// src/protocols.js
var NAME_FIELD = /^(?:company(?:_name)?|customer(?:_name)?|supplier(?:_name)?|counterparty(?:_name)?|entity_name|公司名称|客户名称|供应商名称|交易对手名称)$/i;
var OPAQUE_FIELD = /^(?:id|type|role|tool_call_id|tool_use_id|call_id|signature|encrypted_content|data|image_url|file_data|file_id|mime_type|mimeType|media_type)$/;
function inspectRequest(body, protocol) {
  const slots = [], records = [], calls = /* @__PURE__ */ Object.create(null);
  let nodes = 0;
  const add = (owner, key, meta = {}) => {
    if (typeof owner?.[key] === "string") slots.push({ owner, key, ...meta });
  };
  const data = (value, meta, depth = 0) => {
    if (++nodes > 5e4 || depth > 48) throw new Error("input_structure_limit");
    if (!value || typeof value !== "object") return;
    for (const k of Object.keys(value)) {
      if (OPAQUE_FIELD.test(k)) continue;
      if (typeof value[k] === "string") add(value, k, { ...meta, nameField: NAME_FIELD.test(k) ? k : null });
      else data(value[k], meta, depth + 1);
    }
  };
  const blocks = (value, meta, depth = 0) => {
    if (++nodes > 5e4 || depth > 48) throw new Error("input_structure_limit");
    if (!Array.isArray(value)) {
      data(value, meta, depth + 1);
      return;
    }
    for (const p of value) {
      if (!p || typeof p !== "object") continue;
      if (["text", "input_text", "output_text", "summary_text", "reasoning_text"].includes(p.type) || !p.type && typeof p.text === "string") add(p, "text", meta);
      else if (p.type === "thinking") add(p, "thinking", { ...meta, sealed: !!p.signature });
      else if (p.type === "tool_result") {
        const m = { ...meta, source: "tool", tool: calls[p.tool_use_id] || "" };
        if (typeof p.content === "string") add(p, "content", m);
        else blocks(p.content, m, depth + 1);
      } else if (p.type === "tool_use") data(p.input, { ...meta, source: "call", tool: p.name || "" }, depth + 1);
      else if (p.type === "resource") {
        if (p.resource) add(p.resource, "text", meta);
      } else if (p.functionCall) data(p.functionCall.args, { ...meta, source: "call", tool: p.functionCall.name || "" }, depth + 1);
      else if (p.functionResponse) data(p.functionResponse.response, { ...meta, source: "tool", tool: p.functionResponse.name || "" }, depth + 1);
      else if (p.type === "input_file" || p.type === "file") add(p, "filename", meta);
    }
  };
  let list;
  if (protocol === "responses") list = Array.isArray(body.input) ? body.input : [];
  else if (protocol === "gemini") list = Array.isArray(body.contents) ? body.contents : [];
  else list = Array.isArray(body.messages) ? body.messages : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "function_call" || m.type === "custom_tool_call") calls[m.call_id] = m.name || "";
    for (const c of m.tool_calls || []) if (c) calls[c.id] = c.function?.name || "";
    for (const p of Array.isArray(m.content) ? m.content : []) if (p?.type === "tool_use") calls[p.id] = p.name || "";
  }
  if (protocol === "responses" && typeof body.input === "string") {
    add(body, "input", { source: "user", index: 0 });
    records.push({ index: 0, role: "user", text: body.input });
  }
  for (let index = 0; index < list.length; index++) {
    const m = list[index];
    if (!m || typeof m !== "object") continue;
    const source = ["system", "developer"].includes(m.role) ? "instruction" : m.role === "user" ? "user" : ["tool", "function"].includes(m.role) ? "tool" : "assistant";
    const meta = { source, index, tool: calls[m.tool_call_id] || (source === "tool" ? m.name || "" : "") };
    const before = slots.length;
    if (typeof m.content === "string") add(m, "content", meta);
    else blocks(m.content, meta);
    blocks(m.parts, meta);
    if (m.type === "function_call_output" || m.type === "custom_tool_call_output") {
      const sm = { ...meta, source: "tool", tool: calls[m.call_id] || "" };
      if (typeof m.output === "string") add(m, "output", sm);
      else data(m.output, sm);
    } else if (m.type === "function_call") add(m, "arguments", { ...meta, source: "call", tool: m.name || "", json: true });
    else if (m.type === "custom_tool_call") add(m, "input", { ...meta, source: "call", tool: m.name || "" });
    else if (m.type === "reasoning") blocks(m.summary, { ...meta, source: "assistant" });
    for (const c of m.tool_calls || []) if (c?.function) add(c.function, "arguments", { ...meta, source: "call", tool: c.function.name || "", json: true });
    if (m.function_call) add(m.function_call, "arguments", { ...meta, source: "call", tool: m.function_call.name || "", json: true });
    const own = slots.slice(before).filter((s) => s.source === "user" && s.index === index).map((s) => s.owner[s.key]).join("\n");
    records.push({ index, role: m.role || m.type || "unknown", text: own });
  }
  add(body, "instructions", { source: "instruction", index: -1 });
  if (typeof body.system === "string") add(body, "system", { source: "instruction", index: -1 });
  else blocks(body.system, { source: "instruction", index: -1 });
  if (body.systemInstruction) blocks(body.systemInstruction.parts, { source: "instruction", index: -1 });
  const schema = (v, depth = 0) => {
    if (!v || typeof v !== "object") return;
    if (++nodes > 5e4 || depth > 48) throw new Error("input_structure_limit");
    for (const k of Object.keys(v)) {
      if (["description", "title"].includes(k)) add(v, k, { source: "schema", index: -1 });
      else if (k === "enum" && Array.isArray(v[k])) for (let i = 0; i < v[k].length; i++) add(v[k], i, { source: "schema", index: -1 });
      else if (typeof v[k] === "object") schema(v[k], depth + 1);
    }
  };
  schema(body.tools);
  const user = records.filter((r) => r.role === "user" && r.text && !environmentText(r.text)).at(-1) || null;
  return { slots, records, user };
}
function publicContextSafe(view, allowed) {
  if (!view.user) return false;
  for (const r of view.records) {
    if (r.index >= view.user.index || ["system", "developer"].includes(r.role)) continue;
    if (r.role !== "user" || !environmentText(r.text)) return false;
  }
  for (const s of view.slots) {
    if ((s.source === "instruction" || s.index < view.user.index) && [...allowed].some((n) => s.owner[s.key].includes(n))) return false;
    if (["tool", "call"].includes(s.source) && !webTool(s.tool)) return false;
  }
  return true;
}
function safeInput(body, protocol) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 8e4 || depth > 64) throw new Error("input_structure_limit");
    if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("unsafe_numeric_value");
    if (!v || typeof v !== "object") return;
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(body, 0);
}

// src/session-authorization.js
var PREFIX = "nero.session.authorization.v1\0";
var validId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value);
function sessionIdentity(body, ctx) {
  if (ctx?.agent !== "codex" || ctx.origin && !["local", "magpie-key"].includes(ctx.origin)) return null;
  let meta = body?.client_metadata?.["x-codex-turn-metadata"] || body?.client_metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  if (!meta || !["user", "agent_created_thread"].includes(meta.thread_source) || !validId(meta.thread_id) || !validId(meta.turn_id)) return null;
  if (ctx.session && ctx.session !== meta.thread_id) return null;
  return { session: meta.thread_id, turn: meta.turn_id };
}
function sessionWorkspace(body, ctx) {
  if (typeof ctx?.cwd === "string" && ctx.cwd.startsWith("/")) return ctx.cwd.replace(/\/$/, "") || "/";
  let workspace = "";
  for (const item of body?.input || body?.messages || []) {
    if (!["user", "developer", "system"].includes(item?.role)) continue;
    const texts = typeof item.content === "string" ? [item.content] : (Array.isArray(item.content) ? item.content : []).filter((p) => ["text", "input_text", "output_text"].includes(p?.type)).map((p) => p.text || "");
    for (const text of texts) {
      for (const block of text.matchAll(/<environment_context>[\s\S]*?<\/environment_context>/g)) {
        const cwd = /<cwd>\s*([^<\n]+?)\s*<\/cwd>/.exec(block[0])?.[1];
        if (cwd?.startsWith("/")) workspace = cwd.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\/$/, "") || "/";
      }
    }
  }
  return workspace;
}
function readAuthorization(envelope, key, verifyContents = true) {
  if (!validKey(key) || !envelope || typeof envelope.payload !== "string" || envelope.payload.length > 2 * 1024 * 1024 || !same(sign(key, PREFIX + envelope.payload), envelope.mac)) return null;
  let record;
  try {
    record = JSON.parse(envelope.payload);
  } catch {
    return null;
  }
  record.names = envelope.names;
  record.pattern = envelope.pattern;
  if (record.v !== 1 || !validId(record.session) || record.session !== envelope.session || typeof record.workspace !== "string" || !record.workspace.startsWith("/") || !["active", "revoked"].includes(record.state) || !["all", "names"].includes(record.coverage) || !Number.isFinite(record.created) || record.created > Date.now() || !Array.isArray(record.names) || record.names.length > 32 || record.names.some((n) => typeof n !== "string" || n.length < 2 || n.length > 120) || record.coverage === "names" && record.state === "active" && !record.names.length || record.coverage === "all" && record.names.length) return null;
  if (record.nameCount !== record.names.length || typeof record.pattern !== "string") return null;
  if (verifyContents && digest(JSON.stringify({ names: record.names, pattern: record.pattern })) !== record.contentsHash) return null;
  return record;
}
function resolveAuthorization(body, ctx) {
  const id = sessionIdentity(body, ctx);
  if (!id) return { record: null, reason: "request_identity_unavailable", managed: false };
  const entries = ctx.options?.sessionAuthorizations;
  if (!Array.isArray(entries) || entries.length > 64) return { record: null, managed: false };
  const matching = entries.filter((e) => e?.session === id.session);
  if (!matching.length) return { record: null, managed: false };
  if (matching.length !== 1) return { record: null, managed: true, reason: "authorization_invalid" };
  const record = readAuthorization(matching[0], ctx.options?.authKey, false);
  if (!record) return { record: null, managed: true, reason: "authorization_invalid" };
  if (record.state !== "active") return { record: null, managed: true, reason: "session_revoked" };
  if (sessionWorkspace(body, ctx) !== record.workspace) return { record: null, managed: true, reason: "task_identity_mismatch" };
  return { record, managed: true, reason: record.coverage === "all" ? "session_all_active" : "session_names_active" };
}

// src/company-guard.js
var ESCAPED_STRING = /"[^"\\]*(?:\\.[^"\\]*)+"/g;
var TOKEN = /\[\[NERO_ORG_[a-f0-9]{24}\]\]/g;
var NOTE = "Company identifiers of the form [[NERO_ORG_\u2026]] are opaque local labels. Copy them exactly in text and tool arguments; do not infer or expand them.";
var fail = (ctx, code) => {
  ctx.reject(400, "NERO \u516C\u53F8\u540D\u4FDD\u62A4\uFF1A" + code);
};
function addNote(body, protocol) {
  var _a;
  if (protocol === "responses") body.instructions = (body.instructions ? body.instructions + "\n\n" : "") + NOTE;
  else if (protocol === "anthropic") {
    if (Array.isArray(body.system)) body.system.push({ type: "text", text: NOTE });
    else body.system = (body.system ? body.system + "\n\n" : "") + NOTE;
  } else if (protocol === "gemini") {
    body.systemInstruction || (body.systemInstruction = { parts: [] });
    (_a = body.systemInstruction).parts || (_a.parts = []);
    body.systemInstruction.parts.push({ text: NOTE });
  } else if (Array.isArray(body.messages)) body.messages.unshift({ role: "system", content: NOTE });
}
function prepareRequest(body, ctx) {
  var _a;
  const budget = () => {
    if (ctx.signal?.aborted) throw new Error("\u672C\u5730\u5904\u7406\u5DF2\u53D6\u6D88");
  };
  ctx.state.guard = { reverse: /* @__PURE__ */ Object.create(null), buffers: /* @__PURE__ */ Object.create(null), ready: false, failed: false };
  try {
    const o = ctx.options || {};
    if (!validKey(o.authKey)) {
      fail(ctx, "\u5C1A\u672A\u914D\u7F6E\u672C\u5730\u4FDD\u62A4\u5BC6\u94A5");
      return;
    }
    let proof = readProof(body[PROOF], body, o.authKey, ctx);
    delete body[PROOF];
    const managed = resolveAuthorization(body, ctx);
    if (managed.managed) proof = managed.record ? { mode: "original", scope: "session_task", coverage: managed.record.coverage, names: managed.record.names, pattern: managed.record.pattern } : null;
    if (!["responses", "chat", "anthropic", "gemini"].includes(ctx.protocol)) throw new Error("\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u534F\u8BAE");
    safeInput(body, ctx.protocol);
    const view = inspectRequest(body, ctx.protocol);
    const metrics = ctx.state.guard.metrics = { matchedNames: 0, replacedNames: 0, replacements: 0, allowedOccurrences: 0, scopes: {} };
    const matched = /* @__PURE__ */ new Set();
    const scopeOf = (s) => s.source === "user" ? s.index === view.user?.index ? "user" : "history" : { tool: "tool_results", call: "tool_arguments", schema: "tool_schema", instruction: "instructions" }[s.source] || "history";
    let currentScope;
    for (const slot of view.slots) {
      const key = scopeOf(slot);
      (_a = metrics.scopes)[key] || (_a[key] = { checkedTexts: 0, replacements: 0 });
      metrics.scopes[key].checkedTexts++;
    }
    let size = 0;
    for (const s of view.slots) {
      size += s.owner[s.key].length;
      if (size > 4 * 1024 * 1024) throw new Error("\u6587\u5B57\u8D85\u8FC7 4 MiB\uFF0C\u8BF7\u7F29\u5C0F\u672C\u6B21\u8F93\u5165");
    }
    if (proof?.coverage === "all") {
      metrics.authorization = "original";
      metrics.authorizationReason = managed.reason;
      metrics.authorizationCoverage = "all";
      ctx.state.guard.authorization = "original";
      ctx.state.guard.ready = true;
      return body;
    }
    const requested = managed.managed ? new Set(proof?.names || []) : expandAllowed(proof?.names || [], o);
    if (proof?.mode === "public_lookup" && !publicContextSafe(view, requested)) proof = null;
    const allowed = proof ? requested : /* @__PURE__ */ new Set();
    ctx.state.guard.authorization = proof ? proof.mode : "masked";
    metrics.authorization = ctx.state.guard.authorization;
    metrics.authorizationReason = managed.managed ? managed.reason : proof ? proof.scope === "session_task" ? "session_task_active" : "turn_grant_active" : ctx.grantStatus || "no_matching_grant";
    metrics.authorizationCoverage = proof ? "names" : "none";
    const names = new Set(configuredNames(o));
    const aliases = taskAliases(view.slots);
    for (const n of aliases.names) names.add(n);
    metrics.taskAliases = aliases.names.length;
    metrics.aliasConflicts = aliases.conflicts;
    metrics.aliasLimitReached = aliases.limited;
    if (!proof?.pattern) for (const n of allowed) names.add(n);
    for (const s of view.slots) {
      budget();
      const text = s.owner[s.key];
      for (const n of detectNames(text)) names.add(n);
      if (s.nameField) {
        const name = nameFieldValue(text, s.nameField);
        if (name) names.add(name);
      }
      if (s.source === "user") for (const n of directive(text)?.names || []) names.add(n);
      if (text.includes("\\u")) for (const q of text.matchAll(ESCAPED_STRING)) {
        let t;
        try {
          t = JSON.parse(q[0]);
        } catch {
          continue;
        }
        for (const n of detectNames(t)) names.add(n);
      }
    }
    const candidates = [...names].filter((n) => typeof n === "string" && n.length >= 2).sort((a, b) => b.length - a.length);
    const pattern = candidates.length ? namePattern(candidates) : "";
    const matcher = candidates.length ? new RegExp("\\[\\[NERO_ORG_[a-f0-9]{24}\\]\\]|(?:" + pattern + ")", "gi") : null;
    const prefixMatcher = candidates.length ? new RegExp(namePattern([...new Set(candidates.map((n) => n.slice(0, 2)))]), "i") : null;
    const literalMatchers = !ctx.sign ? candidates.map((n, rank) => ({ re: new RegExp(escapeRE(n), "gi"), rank })) : null;
    const opaque = new RegExp(TOKEN.source, "gi");
    const approvedMatcher = proof?.pattern ? new RegExp(proof.pattern, "gi") : null;
    const id = identity(body);
    const scope = [ctx.session, id?.thread].filter(Boolean).join(":") || "request:" + Date.now() + ":" + Math.random();
    const signName = ctx.sign ? (name) => ctx.sign(o.authKey, scope + "\0" + name) : scopedSigner(o.authKey, scope + "\0");
    const forward = /* @__PURE__ */ Object.create(null), reverse = ctx.state.guard.reverse;
    const allowedFold = new Set([...allowed].map((n) => n.toLowerCase()));
    const tokenFor = (name) => {
      if (forward[name]) return forward[name];
      const token = TOKEN_PREFIX + signName(name).slice(0, 24) + "]]";
      if (reverse[token] && reverse[token] !== name) throw new Error("\u540D\u79F0\u4EE3\u53F7\u51B2\u7A81");
      forward[name] = token;
      reverse[token] = name;
      return token;
    };
    const replaceName = (name, offset, original, allow) => {
      if (/^\[\[NERO_ORG_[a-f0-9]{24}\]\]$/.test(name)) return name;
      if (/[A-Za-z0-9_]/.test(name[0]) && offset > 0 && /[A-Za-z0-9_]/.test(original[offset - 1])) return name;
      if (/[A-Za-z0-9_]/.test(name.at(-1)) && /[A-Za-z0-9_]/.test(original[offset + name.length] || "")) return name;
      matched.add(name);
      metrics.matchedNames = matched.size;
      if (allow && allowedFold.has(name.toLowerCase())) {
        metrics.allowedOccurrences++;
        return name;
      }
      const token = tokenFor(name);
      metrics.replacements++;
      metrics.scopes[currentScope].replacements++;
      return token;
    };
    const sub = (text, allow) => {
      if (!matcher && !approvedMatcher) return text;
      if (!literalMatchers && !approvedMatcher) return text.replace(matcher, (n, i, s) => replaceName(n, i, s, allow));
      const hits = [];
      let m;
      opaque.lastIndex = 0;
      while (m = opaque.exec(text)) hits.push({ at: m.index, name: m[0], rank: -1 });
      if (approvedMatcher) {
        approvedMatcher.lastIndex = 0;
        while (m = approvedMatcher.exec(text)) hits.push({ at: m.index, name: m[0], rank: 0 });
      }
      if (!literalMatchers && matcher) {
        matcher.lastIndex = 0;
        while (m = matcher.exec(text)) hits.push({ at: m.index, name: m[0], rank: 1 });
      }
      for (const item of literalMatchers || []) {
        item.re.lastIndex = 0;
        while (m = item.re.exec(text)) {
          hits.push({ at: m.index, name: m[0], rank: item.rank });
          item.re.lastIndex = m.index + 1;
        }
      }
      hits.sort((a, b) => a.at - b.at || (approvedMatcher ? b.name.length - a.name.length : 0) || a.rank - b.rank);
      const pieces = [];
      let after = 0;
      for (const hit of hits) {
        if (hit.at < after) continue;
        pieces.push(text.slice(after, hit.at), replaceName(hit.name, hit.at, text, allow));
        after = hit.at + hit.name.length;
      }
      return after ? pieces.join("") + text.slice(after) : text;
    };
    for (const s of view.slots) {
      budget();
      currentScope = scopeOf(s);
      const allow = !!proof && (proof.mode === "original" || s.source === "user" && s.index === view.user?.index || ["tool", "call"].includes(s.source) && webTool(s.tool));
      let text = s.owner[s.key];
      if (!matcher && !approvedMatcher || !approvedMatcher && ctx.sign && !text.includes("\\u") && !prefixMatcher.test(text)) continue;
      if (text.includes("\\")) text = text.replace(ESCAPED_STRING, (raw) => {
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          return raw;
        }
        const next = sub(value, allow);
        return next === value ? raw : JSON.stringify(next);
      });
      text = sub(text, allow);
      if (s.sealed && text !== s.owner[s.key]) throw new Error("\u7B7E\u540D\u601D\u8003\u5185\u5BB9\u4E0D\u80FD\u5B89\u5168\u6539\u5199\uFF0C\u8BF7\u4F7F\u7528\u5E72\u51C0\u7684\u65B0\u4E0A\u4E0B\u6587");
      s.owner[s.key] = text;
    }
    metrics.replacedNames = Object.keys(reverse).length;
    if (metrics.replacedNames) addNote(body, ctx.protocol);
    ctx.state.guard.ready = true;
    return body;
  } catch (e) {
    fail(ctx, e instanceof Error ? e.message : "\u672C\u5730\u68C0\u67E5\u5931\u8D25");
  }
}
function restore(text, state, json = false) {
  if (typeof text !== "string") return text;
  return text.replace(TOKEN, (token) => {
    const name = state.reverse[token];
    if (name !== void 0 && state.restoredTokens) state.restoredTokens[token] = true;
    return name === void 0 ? token : json ? JSON.stringify(name).slice(1, -1) : name;
  });
}
function whole(value, state, depth = 0, data = false) {
  if (!value || typeof value !== "object" || depth > 64) return;
  for (const key of Object.keys(value)) {
    if (!data && /^(?:id|type|role|name|model|call_id|tool_call_id|tool_use_id|signature|encrypted_content)$/.test(key)) continue;
    if (typeof value[key] === "string") value[key] = restore(value[key], state, key === "arguments");
    else whole(value[key], state, depth + 1, data || key === "args" || key === "input" && value.type === "tool_use");
  }
}
function chunk(text, state, key, json = false, final = false) {
  if (typeof text !== "string") return text;
  let value = (state.buffers[key] || "") + text;
  state.buffers[key] = "";
  if (!final) {
    let cut = value.lastIndexOf(TOKEN_PREFIX);
    if (cut >= 0) {
      const tail = value.slice(cut);
      if (tail.length < TOKEN_PREFIX.length + 26 && /^\[\[NERO_ORG_[a-f0-9]*\]?$/.test(tail)) {
        state.buffers[key] = tail;
        value = value.slice(0, cut);
      }
    }
    if (!state.buffers[key]) for (let n = Math.min(value.length, TOKEN_PREFIX.length - 1); n > 0; n--) {
      if (value.endsWith(TOKEN_PREFIX.slice(0, n))) {
        state.buffers[key] = value.slice(-n);
        value = value.slice(0, -n);
        break;
      }
    }
  }
  return restore(value, state, json);
}
function clear(state, prefix) {
  for (const key of Object.keys(state.buffers)) if (key.startsWith(prefix)) delete state.buffers[key];
}
function pending(state, prefix = "") {
  return Object.keys(state.buffers).some((k) => k.startsWith(prefix) && state.buffers[k]);
}
function streamError(ctx, state) {
  state.failed = true;
  receiptEvent(state, "reply_processed", false, "restoration_incomplete");
  const message = "NERO \u516C\u53F8\u540D\u8FD8\u539F\u672A\u5B8C\u6210\uFF0C\u5DF2\u505C\u6B62\u6B64\u56DE\u590D\uFF0C\u8BF7\u91CD\u8BD5\u3002";
  if (ctx.protocol === "responses") return { type: "error", code: "nero_restore_incomplete", message, param: null };
  if (ctx.protocol === "anthropic") return { type: "error", error: { type: "api_error", message } };
  return { error: { type: "nero_restore_incomplete", message } };
}
function onEvent(ev, ctx) {
  const state = ctx.state.guard;
  if (!state?.ready) return;
  if (!Object.keys(state.reverse).length) {
    if (terminalEvent(ev, ctx.protocol)) receiptEvent(state, "reply_processed", terminalOK(ev), terminalOK(ev) ? "processed" : "upstream_incomplete", ev.type);
    return;
  }
  if (state.failed) return null;
  try {
    if (ctx.protocol === "responses") {
      const p = "r:" + (ev.output_index ?? 0) + ":";
      const key = p + (ev.content_index ?? ev.summary_index ?? 0) + ":" + (ev.type || "").replace(/\.(delta|done)$/, "");
      if (typeof ev.delta === "string" && /\.delta$/.test(ev.type)) ev.delta = chunk(ev.delta, state, key, ev.type === "response.function_call_arguments.delta");
      else {
        whole(ev, state);
        if (/\.(done)$/.test(ev.type)) {
          if (ev.type === "response.output_item.done") clear(state, p);
          else delete state.buffers[key];
        }
        if (["response.completed", "response.incomplete", "response.failed"].includes(ev.type)) {
          if (Array.isArray(ev.response?.output) && ev.response.output.length) clear(state, "r:");
          if (pending(state)) return streamError(ctx, state);
        }
      }
    } else if (ctx.protocol === "anthropic") {
      const p = "a:" + (ev.index ?? 0) + ":";
      if (ev.type === "content_block_delta") {
        for (const key of ["text", "thinking", "partial_json"]) if (typeof ev.delta?.[key] === "string") ev.delta[key] = chunk(ev.delta[key], state, p + key, key === "partial_json");
      } else {
        whole(ev, state);
        if (ev.type === "content_block_stop" && pending(state, p)) return streamError(ctx, state);
        if (ev.type === "message_stop" && pending(state)) return streamError(ctx, state);
      }
    } else if (Array.isArray(ev.choices)) {
      for (const c of ev.choices) {
        const p = "c:" + (c.index ?? 0) + ":", end = c.finish_reason != null;
        c.delta || (c.delta = {});
        for (const key of ["content", "reasoning", "reasoning_content", "refusal"]) if (typeof c.delta[key] === "string" || end && state.buffers[p + key]) c.delta[key] = chunk(c.delta[key] || "", state, p + key, false, end);
        for (const t of c.delta.tool_calls || []) if (t.function) t.function.arguments = chunk(t.function.arguments || "", state, p + "tool:" + (t.index ?? 0), true, end);
        if (c.delta.function_call) c.delta.function_call.arguments = chunk(c.delta.function_call.arguments || "", state, p + "function", true, end);
        if (end && pending(state, p)) return streamError(ctx, state);
      }
    } else if (Array.isArray(ev.candidates)) {
      for (let ci = 0; ci < ev.candidates.length; ci++) {
        const c = ev.candidates[ci], parts = c.content?.parts || [];
        for (let pi = 0; pi < parts.length; pi++) {
          const part = parts[pi], key = "g:" + (c.index ?? ci) + ":" + pi + ":" + !!part.thought;
          if (typeof part.text === "string") part.text = chunk(part.text, state, key, false, !!c.finishReason);
          if (part.functionCall) whole(part.functionCall.args, state, 0, true);
        }
        if (c.finishReason && pending(state, "g:" + (c.index ?? ci) + ":")) return streamError(ctx, state);
      }
    } else whole(ev, state);
    if (terminalEvent(ev, ctx.protocol)) receiptEvent(state, "reply_processed", terminalOK(ev) && !state.failed && !pending(state), !terminalOK(ev) ? "upstream_incomplete" : state.failed || pending(state) ? "restoration_incomplete" : "processed", ev.type);
    return ev;
  } catch {
    return streamError(ctx, state);
  }
}
function onResponse(body, ctx) {
  const state = ctx.state.guard;
  if (!state?.ready) return;
  whole(body, state);
  receiptEvent(state, "reply_processed", !state.failed && !pending(state));
  return body;
}
var PREPARED = "__nero_company_prepared";
function onRequest(body, ctx) {
  const envelope = body[PREPARED];
  delete body[PREPARED];
  delete body[PROOF];
  const key = ctx.options?.authKey;
  try {
    if (!validKey(key)) throw new Error("\u672C\u5730\u4FDD\u62A4\u5BC6\u94A5\u4E0D\u53EF\u7528");
    if (envelope === void 0 || envelope === null) {
      let metadata = body?.client_metadata?.["x-codex-turn-metadata"] || body?.client_metadata;
      if (typeof metadata === "string") {
        try {
          metadata = JSON.parse(metadata);
        } catch {
          metadata = null;
        }
      }
      const hint = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(metadata?.thread_id || "") ? metadata.thread_id : void 0;
      const result = prepareRequest(body, { ...ctx, session: ctx.session || hint });
      const state = ctx.state.guard;
      if (state?.ready) {
        state.fallback = true;
        state.fallbackIdentity = identity(body);
        state.restoredTokens = /* @__PURE__ */ Object.create(null);
        receiptEvent(state, "request_checked", true);
      }
      return result;
    }
    if (!envelope || typeof envelope.payload !== "string") throw new Error("\u672C\u5730\u8131\u654F\u5904\u7406\u672A\u5B8C\u6210\uFF1A\u7F3A\u5C11\u5904\u7406\u7ED3\u679C");
    if (!same(sign(key, envelope.payload), envelope.mac)) throw new Error("\u672C\u5730\u8131\u654F\u5904\u7406\u7ED3\u679C\u7B7E\u540D\u4E0D\u5339\u914D");
    const p = JSON.parse(envelope.payload), now = Date.now();
    if (p.v !== 1 || p.protocol !== ctx.protocol || p.expires < now || p.expires > now + 3e4 || p.thread !== (identity(body)?.thread || "")) throw new Error("\u672C\u5730\u8131\u654F\u7ED3\u679C\u5DF2\u5931\u6548");
    if (p.error) throw new Error(p.error);
    const reverse = /* @__PURE__ */ Object.create(null);
    for (const [token, name] of Object.entries(p.reverse || {})) {
      if (!/^\[\[NERO_ORG_[a-f0-9]{24}\]\]$/.test(token) || !validName(name)) throw new Error("\u540D\u79F0\u8FD8\u539F\u8BB0\u5F55\u65E0\u6548");
      reverse[token] = name;
    }
    ctx.state.guard = { reverse, buffers: /* @__PURE__ */ Object.create(null), ready: true, failed: false, receiptId: p.receiptId, restoredTokens: /* @__PURE__ */ Object.create(null) };
    if (p.schema?.length) {
      const slots = inspectRequest({ tools: body.tools }, ctx.protocol).slots;
      for (const [i, text] of p.schema) {
        if (!slots[i] || typeof text !== "string") throw new Error("\u5DE5\u5177\u8BF4\u660E\u5904\u7406\u7ED3\u679C\u65E0\u6548");
        slots[i].owner[slots[i].key] = text;
      }
    }
    receiptEvent(ctx.state.guard, "request_checked", true);
    return body;
  } catch (e) {
    fail(ctx, e.message || "\u672C\u5730\u5904\u7406\u5931\u8D25");
  }
}
function terminalOK(ev) {
  return !["error", "response.failed", "response.incomplete"].includes(ev.type);
}
function terminalEvent(ev, protocol) {
  if (protocol === "responses") return ["response.completed", "response.failed", "response.incomplete"].includes(ev.type);
  if (protocol === "anthropic") return ["message_stop", "error"].includes(ev.type);
  if (protocol === "chat") return ev.choices?.length && ev.choices.every((c) => c.finish_reason != null);
  return ev.candidates?.length && ev.candidates.every((c) => c.finishReason);
}
function receiptEvent(state, phase, ok, reason, eventType) {
  if (!state?.fallback && !/^[a-f0-9-]{36}$/.test(state?.receiptId || "")) return;
  if (phase === "reply_processed" && state.receiptDone) return;
  if (phase === "reply_processed") state.receiptDone = true;
  const replyReason = phase === "reply_processed" ? reason || (ok ? "processed" : "restoration_incomplete") : void 0;
  const terminalType = ["response.completed", "response.failed", "response.incomplete", "message_stop", "error"].includes(eventType) ? eventType : void 0;
  if (state.fallback) {
    const metrics = state.metrics || {};
    try {
      console.info("NERO_COMPANY_GUARD_FALLBACK " + JSON.stringify({ phase, ok, thread: state.fallbackIdentity?.thread || null, turn: state.fallbackIdentity?.turn || null, cause: "prepared_result_unavailable", authorization: metrics.authorization || "masked", authorizationCoverage: metrics.authorizationCoverage || "none", matchedNames: metrics.matchedNames || 0, replacements: metrics.replacements || 0, reason: replyReason, eventType: terminalType, restoredNames: Object.keys(state.restoredTokens).length }));
    } catch {
    }
    return;
  }
  try {
    console.info("NERO_COMPANY_GUARD_RECEIPT " + JSON.stringify({ id: state.receiptId, phase, ok, reason: replyReason, eventType: terminalType, restoredNames: Object.keys(state.restoredTokens || {}).length }));
  } catch {
  }
}
export {
  PREPARED,
  onEvent,
  onRequest,
  onResponse,
  prepareRequest
};

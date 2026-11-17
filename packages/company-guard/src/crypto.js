import { sha256, hmac } from "../vendor/hashes.js";

// No TextEncoder/Node dependency: this module also runs in Magpie's moejs.
export function utf8(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + lo - 0xdc00; i++; }
      else cp = 0xfffd;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

function hex(bytes) { let out = ""; for (const n of bytes) out += n.toString(16).padStart(2, "0"); return out; }
export function validKey(key) { return typeof key === "string" && /^[0-9a-f]{64}$/.test(key); }
function keyBytes(key) {
  if (!validKey(key)) throw new Error("guard_key_missing");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
export function sign(key, text) {
  return hex(hmac(sha256, keyBytes(key), utf8(text)));
}
export function scopedSigner(key, prefix) {
  const base = hmac.create(sha256, keyBytes(key)).update(utf8(prefix));
  return text => hex(base.clone().update(utf8(text)).digest());
}
export function digest(text) { return hex(sha256(utf8(text))); }
export function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

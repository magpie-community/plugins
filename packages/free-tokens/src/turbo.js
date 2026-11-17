// free-tokens.data 的 turbo-stream v2「flatten」解码器（零依赖）。
// 结构：JSON 数组，下标即引用 id；对象写成 {"_<keyId>": <valueId>}（key/value 皆为数组下标）；
// 负数内联常量（<0 → null）。本数据无 Date 对象，时间均为 ISO 字符串 / 毫秒数。
export function decodeTurboStream(text) {
  let A;
  try { A = JSON.parse(text); } catch (e) { throw new Error("free-tokens.data 不是合法 JSON: " + e.message); }
  if (!Array.isArray(A)) throw new Error("free-tokens.data 结构异常（非数组）");
  const ref = (i) => (typeof i === "number" && i < 0 ? null : (typeof i === "number" ? hydrate(A[i]) : hydrate(i)));
  function hydrate(v) {
    if (Array.isArray(v)) return v.map((x) => (typeof x === "number" ? ref(x) : hydrate(x)));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const value = typeof val === "number" ? ref(val) : hydrate(val);
        if (k.charCodeAt(0) === 95 /* _ */) out[A[Number(k.slice(1))]] = value;
        else out[k] = value;
      }
      return out;
    }
    return v;
  }
  const root = hydrate(A[0]);
  const ft = root["free-tokens"] || (root.root && root.root["free-tokens"]);
  if (!ft || !ft.data || !Array.isArray(ft.data.deals)) throw new Error("free-tokens 数据缺失（deals 未找到）");
  return ft.data; // { deals, ended, basis, serverNow, expiresAt }
}

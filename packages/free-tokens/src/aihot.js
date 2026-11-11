import { decodeTurboStream } from "./turbo.js";
const URL = "https://aihot.news/free-tokens.data";
// fetchImpl 可注入，方便离线单测
export async function fetchFreeTokens(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const signal = (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined;
  const res = await f(URL, {
    signal,
    headers: {
      "User-Agent": "magpie-free-tokens/0.1 (+local-desktop-plugin)", // 诚实 UA，不伪装浏览器
      "Accept": "text/plain",
      "Accept-Encoding": "gzip, br",
    },
  });
  if (!res.ok) throw new Error(`AIHOT ${res.status} ${res.statusText || ""}`.trim());
  return decodeTurboStream(await res.text());
}

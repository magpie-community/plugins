import { parseFreeTokensMd } from "./md.js";
// AIHOT 给程序的开放入口（https://aihot.news/agent、llms.txt）。网页自用的 free-tokens.data
// 从 2026-11 起对程序回 403 use_open_interfaces，所以读 Markdown 版。
export const SOURCE = "https://aihot.news/free-tokens.md";
// fetchImpl 可注入，方便离线单测
export async function fetchFreeTokens(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const signal = (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined;
  const res = await f(SOURCE, {
    signal,
    headers: {
      "User-Agent": "magpie-free-tokens/0.1 (+local-desktop-plugin)", // 诚实 UA，不伪装浏览器
      "Accept": "text/markdown, text/plain",
      "Accept-Encoding": "gzip, br",
    },
  });
  if (!res.ok) {
    let why = "";
    try { const j = JSON.parse(await res.text()); if (j && typeof j.error === "string") why = " " + j.error; } catch {}
    throw new Error(`AIHOT ${res.status} ${res.statusText || ""}`.trim() + why);
  }
  return parseFreeTokensMd(await res.text());
}

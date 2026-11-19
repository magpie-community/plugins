// magpie 自己的联网搜索（设置 › 模型 › 联网搜索）可以直接用知乎站内搜索。
// 返回 magpie 期望的形状：[{ title, url, text, age }]。

import { cacheKey } from "./cache.mjs";
import { DEFAULT_MAX_TEXT_LENGTH } from "./config.mjs";
import { request } from "./request.mjs";
import { clean, isoTime, stripTracking } from "./normalize.mjs";

export function createWebSearch({
  credentials,
  baseUrl,
  cache = { remember: (_key, _ttl, producer) => producer() },
  logger,
  ttl = 0,
  maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
}) {
  return async function zhihuWebSearch(input, ctx) {
    const query = typeof input?.query === "string" ? input.query.trim() : "";
    if (!query) throw new Error("query is required.");

    // 知乎站内搜索一次最多 10 条。
    const n = Math.trunc(Number(input?.count));
    const count = Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 10;

    const token = await credentials.tokenFor(ctx);
    const key = cacheKey(token, "/content/zhihu_search", { Query: query, Count: count });
    const data = await cache.remember(key, ttl, () =>
      request({
        baseUrl,
        path: "/content/zhihu_search",
        token,
        query: { Query: query, Count: count },
        signal: ctx?.abort,
        logger,
      }),
    );

    const items = Array.isArray(data?.Items) ? data.Items : [];
    return items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        title: typeof item.Title === "string" ? item.Title : "",
        url: stripTracking(typeof item.Url === "string" ? item.Url : ""),
        text: clean(typeof item.ContentText === "string" ? item.ContentText : "", maxTextLength) ?? "",
        // 优先用发布时间；老内容没有 CreateTime 时退回编辑时间。
        age: isoTime(item.CreateTime) ?? isoTime(item.EditTime) ?? "",
      }))
      .filter((result) => result.url);
  };
}
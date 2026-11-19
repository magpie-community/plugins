// 工具定义。参数用 JSON Schema 给出：magpie 会让智能体看到它，
// 并在 execute 之前按它校验。magpie 原样转发参数，所以这里再校验一次。

import { cacheKey } from "./cache.mjs";
import { DEFAULT_MAX_TEXT_LENGTH } from "./config.mjs";
import { request } from "./request.mjs";
import {
  normalizeAnswers,
  normalizeGlobalSearch,
  normalizeHotList,
  normalizeQuota,
  normalizeRecommendations,
  normalizeZhihuSearch,
} from "./normalize.mjs";

// —— 参数校验（无运行时依赖，与 @magpie-community/tools-search1api 同思路）——

export function validate(schema, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工具参数必须是一个对象。");
  }
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) throw new Error(`缺少参数 ${key}。`);
  }

  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(schema.properties, key)) {
      throw new Error(`未知参数：${key}。`);
    }
    if (raw === undefined) continue;
    const field = schema.properties[key];

    if (field.type === "string") {
      if (typeof raw !== "string") throw new Error(`${key} 必须是字符串。`);
      // 关键词两侧的空白没有意义。
      const text = key === "query" ? raw.trim() : raw;
      if (field.minLength !== undefined && text.length < field.minLength) {
        throw new Error(`${key} 至少需要 ${field.minLength} 个字符。`);
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        throw new Error(`${key} 不能超过 ${field.maxLength} 个字符。`);
      }
      if (field.enum && !field.enum.includes(text)) {
        throw new Error(`${key} 必须是以下之一：${field.enum.join("、")}。`);
      }
      if (field.format === "uri") {
        try {
          new URL(text);
        } catch {
          throw new Error(`${key} 必须是完整 URL。`);
        }
      }
      result[key] = text;
    } else if (field.type === "integer") {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new Error(`${key} 必须是整数。`);
      }
      if (field.minimum !== undefined && raw < field.minimum) {
        throw new Error(`${key} 不能小于 ${field.minimum}。`);
      }
      if (field.maximum !== undefined && raw > field.maximum) {
        throw new Error(`${key} 不能大于 ${field.maximum}。`);
      }
      result[key] = raw;
    } else if (field.type === "boolean") {
      if (typeof raw !== "boolean") throw new Error(`${key} 必须是布尔值。`);
      result[key] = raw;
    } else if (field.type === "array") {
      if (!Array.isArray(raw)) throw new Error(`${key} 必须是数组。`);
      const items = field.items ?? {};
      for (const item of raw) {
        if (items.type === "string" && typeof item !== "string") {
          throw new Error(`${key} 的每一项都必须是字符串。`);
        }
        if (items.minLength !== undefined && item.length < items.minLength) {
          throw new Error(`${key} 的每一项至少需要 ${items.minLength} 个字符。`);
        }
        if (items.enum && !items.enum.includes(item)) {
          throw new Error(`${key} 的每一项必须是以下之一：${items.enum.join("、")}。`);
        }
      }
      if (field.minItems !== undefined && raw.length < field.minItems) {
        throw new Error(`${key} 至少需要 ${field.minItems} 项。`);
      }
      if (field.maxItems !== undefined && raw.length > field.maxItems) {
        throw new Error(`${key} 不能超过 ${field.maxItems} 项。`);
      }
      result[key] = raw;
    } else {
      throw new Error(`参数 ${key} 的类型无效。`);
    }
  }
  return result;
}

function tool({ description, properties, required = [], execute }) {
  const args = { type: "object", properties, required, additionalProperties: false };
  return {
    description,
    args,
    async execute(value, ctx) {
      return execute(validate(args, value), ctx);
    },
  };
}

// —— 知乎 SortBy 语法 ——
// Field:order:(min,max)。字段为 CommentCount / VoteUpCount / EditTime / CreateTime，
// order 为 asc / desc / none；区间闭区间，留空表示不设边界；时间字段用 Unix 秒。
export const SORT_FIELDS = ["CommentCount", "VoteUpCount", "EditTime", "CreateTime"];
export const TIME_FIELDS = ["EditTime", "CreateTime"];

// 把 YYYY-MM-DD 或 ISO 时间转成 Unix 秒（不带时区时按 UTC 解析）。
export function unixSeconds(value, name = "时间") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new Error(`${name} 必须是可解析的时间，例如 2026-11-01 或 2026-11-01T00:00:00Z。`);
}

export function sortBy({ sortField, sortOrder, min, max, since, until }) {
  if (since !== undefined || until !== undefined) {
    if (sortField === undefined) {
      throw new Error("使用 since/until 时必须用 sortField 指定时间字段（EditTime 或 CreateTime）。");
    }
    if (!TIME_FIELDS.includes(sortField)) {
      throw new Error("since/until 只能配合 EditTime 或 CreateTime 使用。");
    }
    if (min !== undefined || max !== undefined) {
      throw new Error("since/until 与 min/max 不能同时使用。");
    }
    if (since !== undefined) min = unixSeconds(since, "since");
    if (until !== undefined) max = unixSeconds(until, "until");
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error("since 不能晚于 until。");
    }
  }

  if (sortField === undefined) {
    if (min !== undefined || max !== undefined) {
      throw new Error("设置 min/max 时必须同时给出 sortField。");
    }
    return undefined;
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error("min 不能大于 max。");
  }
  const order = sortOrder ?? "desc";
  if (min === undefined && max === undefined) return `${sortField}:${order}`;
  return `${sortField}:${order}:(${min ?? ""},${max ?? ""})`;
}

const queryField = (description, extra = {}) => ({
  type: "string",
  minLength: 1,
  description,
  ...extra,
});

const maxTextLengthField = (fallback) => ({
  type: "integer",
  minimum: 0,
  maximum: 20000,
  description: `每条结果的正文最多保留多少字符，默认 ${fallback}；超出部分以 … 结尾，填 0 表示不截断。`,
});

const NO_PAGING_NOTE =
  "返回 hasMore=true 表示还有更多结果，但该接口不支持翻页：请缩小关键词、减少 count，或改用 zhihu_global_search。";

export function createTools({
  credentials,
  baseUrl,
  cache = { remember: (_key, _ttl, producer) => producer() },
  logger,
  ttl = {},
  maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  maxCommentInfo = 2,
}) {
  const call = async (ctx, path, query, cacheTTL = 0) => {
    const token = await credentials.tokenFor(ctx);
    const key = cacheKey(token, path, query);
    return cache.remember(key, cacheTTL, () =>
      request({
        baseUrl,
        path,
        token,
        query,
        signal: ctx?.abort,
        logger,
      }),
    );
  };

  const options = (args) => ({
    maxTextLength: args.maxTextLength ?? maxTextLength,
    maxCommentInfo,
  });

  return {
    search: tool({
      description:
        "搜索知乎站内内容（问题、回答、文章、视频），返回标题、摘要、链接、作者和点赞/评论数。中文经验、观点、教程类问题优先用它。"
        + "可用 sortField 指定排序字段（默认 desc，即从高到低），并用 min/max 过滤区间："
        + "CommentCount / VoteUpCount 是次数，EditTime / CreateTime 是 Unix 秒时间戳。"
        + "按时间过滤更推荐 since/until：例如 sortField=CreateTime, since=2026-01-01。"
        + NO_PAGING_NOTE
        + `正文默认截断到 ${maxTextLength} 字符，需要全文时设 maxTextLength=0。`,
      properties: {
        query: queryField("搜索关键词，例如「如何学习 Go 语言」。"),
        count: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "返回条数，默认 10，最多 10。",
        },
        sortField: {
          type: "string",
          enum: SORT_FIELDS,
          description: "排序 / 过滤字段。不填则使用知乎默认相关性排序。",
        },
        sortOrder: {
          type: "string",
          enum: ["desc", "asc", "none"],
          description: "排序方向，默认 desc；只想用 min/max 过滤时可填 none。",
        },
        min: {
          type: "integer",
          minimum: 0,
          description: "区间下限（含）。次数或 Unix 秒时间戳，取决于 sortField。",
        },
        max: {
          type: "integer",
          minimum: 0,
          description: "区间上限（含）。次数或 Unix 秒时间戳，取决于 sortField。",
        },
        since: {
          type: "string",
          minLength: 1,
          description: "起始时间（含），如 2026-01-01 或 2026-01-01T00:00:00Z；需配合 EditTime / CreateTime。",
        },
        until: {
          type: "string",
          minLength: 1,
          description: "结束时间（含），格式同 since；需配合 EditTime / CreateTime。",
        },
        maxTextLength: maxTextLengthField(maxTextLength),
      },
      required: ["query"],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/content/zhihu_search",
          {
            Query: args.query,
            Count: args.count ?? 10,
            SortBy: sortBy(args),
          },
          ttl.search ?? 0,
        );
        return normalizeZhihuSearch(data, options(args));
      },
    }),

    global_search: tool({
      description:
        "搜索全网内容（知乎之外还包括新闻、博客等来源），返回标题、摘要、链接和互动数据。适合查时事、新闻和站外资料。"
        + "可用 filter 传入高级表达式，例如 host==\"example.com\"、publish_time>=1760000000，"
        + "支持 == != > >= < <=、AND / OR（大写）和括号；不支持 host==\"zhihu.com\"。"
        + "返回 hasMore=true 时同样不支持翻页，请缩小关键词或减少 count。"
        + `正文默认截断到 ${maxTextLength} 字符，需要全文时设 maxTextLength=0。`,
      properties: {
        query: queryField("搜索关键词，例如「固态电池 最新进展」。"),
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "返回条数，默认 10，最多 20。",
        },
        filter: {
          type: "string",
          description: "高级过滤表达式，例如 host==\"example.com\" AND publish_time>=1760000000。",
        },
        searchDB: {
          type: "string",
          enum: ["all", "realtime", "static"],
          description: "搜索库：all（默认）、realtime（近期内容）、static（已收录内容）。",
        },
        maxTextLength: maxTextLengthField(maxTextLength),
      },
      required: ["query"],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/content/global_search",
          {
            Query: args.query,
            Count: args.count ?? 10,
            Filter: args.filter,
            SearchDB: args.searchDB,
          },
          // 实时库不缓存，避免把“刚刚发生”的搜索结果冻住。
          0,
        );
        return normalizeGlobalSearch(data, options(args));
      },
    }),

    hot_list: tool({
      description: "获取知乎热榜，返回当前热门话题的标题、链接、缩略图和摘要。",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "返回条数，默认 30，最多 30。",
        },
      },
      required: [],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/content/hot_list",
          { Limit: args.limit ?? 30 },
          ttl.hot_list ?? 0,
        );
        return normalizeHotList(data);
      },
    }),

    question_answers: tool({
      description:
        "获取某个知乎问题下的回答列表（摘要），支持分页。questionUrl 必须是问题的完整链接，"
        + "例如 https://www.zhihu.com/question/123456789。用返回的 paging.nextOffset 翻页，paging.isEnd 为真时没有更多。",
      properties: {
        questionUrl: {
          type: "string",
          format: "uri",
          minLength: 1,
          description: "知乎问题的完整 URL。",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "偏移量，默认 0。",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "返回条数，默认 20，最多 50。",
        },
      },
      required: ["questionUrl"],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/content/question_answers",
          {
            QuestionUrl: args.questionUrl,
            Offset: args.offset ?? 0,
            Limit: args.limit ?? 20,
          },
          ttl.answers ?? 0,
        );
        return normalizeAnswers(data);
      },
    }),

    question_recommendations: tool({
      description:
        "获取知乎推荐的问题。给出 query 时按关键词推荐相关问题；不给出时按账号的浏览兴趣推荐。返回问题标题和链接。",
      properties: {
        query: queryField("关键词；留空则按账号兴趣推荐。"),
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "返回条数，默认 5，最多 20。",
        },
      },
      required: [],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/user/question_recommendations",
          {
            Query: args.query,
            Count: args.count ?? 5,
          },
          ttl.recommendations ?? 0,
        );
        return normalizeRecommendations(data);
      },
    }),

    quota: tool({
      description:
        "查询当前 Access Secret 的每日免额用量（不消耗额度）。不传 apiIds 时返回所有已配置的额度项。",
      properties: {
        apiIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "要查询的额度项 id，例如 zhihu_search、global_search、hot_list、"
            + "question_discovery、zhida_openai、tools、knowledge、user_data、creator；不填则查询全部。",
        },
      },
      required: [],
      async execute(args, ctx) {
        const data = await call(
          ctx,
          "/quota",
          {
            APIIDs: Array.isArray(args.apiIds) && args.apiIds.length
              ? args.apiIds.join(",")
              : undefined,
          },
          ttl.quota ?? 0,
        );
        return normalizeQuota(data);
      },
    }),
  };
}
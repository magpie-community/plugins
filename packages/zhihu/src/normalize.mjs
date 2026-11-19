// 把知乎返回的 PascalCase 字段整理成给智能体看的 camelCase，
// 并清理正文里的高亮标签、HTML 实体和跟踪参数。

import { DEFAULT_MAX_COMMENT_INFO } from "./config.mjs";

const text = (value) => (typeof value === "string" && value ? value : undefined);
const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value) => (typeof value === "boolean" ? value : undefined);

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith("#")
        ? Number.parseInt(lower.slice(1), 10)
        : NaN;
    if (Number.isFinite(code)) {
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

// 只去掉形如 <em>、</a>、<br/> 的标签；正文里的 “a < b” 不受影响。
const stripTags = (value) => value.replace(/<\/?[a-zA-Z][^>]*>/g, "");

// 按码点截断，避免把 emoji 之类的代理对切成半个字符。
export function truncate(value, maxLength) {
  if (typeof value !== "string") return value;
  if (!Number.isFinite(maxLength) || maxLength <= 0) return value;
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return `${chars.slice(0, maxLength).join("").trimEnd()}…`;
}

// 摘要里的高亮标签对模型没有意义，实体和截断也一并处理。
export function clean(value, maxLength) {
  if (typeof value !== "string") return value;
  const plain = decodeEntities(stripTags(value)).trim();
  return truncate(plain, maxLength);
}

// 去掉 utm_* 跟踪参数：对模型和用户都没有用，还占字符。
export function stripTracking(url) {
  if (typeof url !== "string" || !url) return url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
    }
    const search = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
  } catch {
    return url;
  }
}

// 知乎的时间字段是 Unix 秒；给模型 ISO 字符串更好读。
export const isoTime = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return undefined;
  }
};

function compact(object) {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) delete object[key];
  }
  return object;
}

// 单条搜索结果（知乎搜索与全网搜索共用大部分字段）。
export function normalizeItem(raw, options = {}) {
  if (!raw || typeof raw !== "object") return undefined;
  const maxTextLength = options.maxTextLength;
  const maxCommentInfo = options.maxCommentInfo ?? DEFAULT_MAX_COMMENT_INFO;
  const author = compact({
    name: text(raw.AuthorName),
    avatar: text(raw.AuthorAvatar),
    badge: text(raw.AuthorBadge),
    badgeText: text(raw.AuthorBadgeText),
  });
  const comments = Array.isArray(raw.CommentInfoList)
    ? raw.CommentInfoList.map((entry) => clean(text(entry?.Content)))
        .filter(Boolean)
        .slice(0, maxCommentInfo)
    : undefined;

  return compact({
    title: text(raw.Title),
    headline: text(raw.Headline),
    contentType: text(raw.ContentType),
    contentId: text(raw.ContentID),
    url: stripTracking(text(raw.Url)),
    contentText: clean(text(raw.ContentText), maxTextLength),
    commentCount: num(raw.CommentCount),
    voteUpCount: num(raw.VoteUpCount),
    author: Object.keys(author).length ? author : undefined,
    editTime: isoTime(raw.EditTime),
    createTime: isoTime(raw.CreateTime),
    authorityLevel: text(raw.AuthorityLevel),
    rankingScore: num(raw.RankingScore),
    commentInfo: comments?.length ? comments : undefined,
  });
}

const items = (data, options) =>
  Array.isArray(data?.Items)
    ? data.Items.map((entry) => normalizeItem(entry, options)).filter(Boolean)
    : [];

export function normalizeZhihuSearch(data, options) {
  return compact({
    hasMore: bool(data?.HasMore),
    searchHashId: text(data?.SearchHashId),
    emptyReason: text(data?.EmptyReason),
    items: items(data, options),
  });
}

export function normalizeGlobalSearch(data, options) {
  return compact({
    hasMore: bool(data?.HasMore),
    items: items(data, options),
  });
}

export function normalizeHotList(data) {
  const list = Array.isArray(data?.Items) ? data.Items : [];
  return compact({
    total: num(data?.Total),
    items: list
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) =>
        compact({
          title: text(entry.Title),
          url: stripTracking(text(entry.Url)),
          thumbnailUrl: text(entry.ThumbnailUrl),
          summary: clean(text(entry.Summary), 200),
        }),
      ),
  });
}

export function normalizeRecommendations(data) {
  const list = Array.isArray(data?.Items) ? data.Items : [];
  return {
    items: list
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) =>
        compact({ title: text(entry.Title), url: stripTracking(text(entry.Url)) }),
      ),
  };
}

export function normalizeAnswers(data) {
  const list = Array.isArray(data?.Items) ? data.Items : [];
  const paging = compact({
    isEnd: bool(data?.Paging?.IsEnd),
    nextOffset: num(data?.Paging?.NextOffset),
    totals: num(data?.Paging?.Totals),
  });
  return compact({
    items: list
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) =>
        compact({
          contentType: text(entry.ContentType),
          contentToken: text(entry.ContentToken),
          url: stripTracking(text(entry.Url)),
          summary: clean(text(entry.Summary), 300),
        }),
      ),
    paging: Object.keys(paging).length ? paging : undefined,
  });
}

export function normalizeQuota(data) {
  const list = Array.isArray(data) ? data : [];
  return {
    items: list
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) =>
        compact({
          apiId: text(entry.APIID),
          apiName: text(entry.APIName),
          totalQuota: num(entry.TotalQuota),
          totalUsed: num(entry.TotalUsed),
          remainingQuota: num(entry.RemainingQuota),
        }),
      ),
  };
}
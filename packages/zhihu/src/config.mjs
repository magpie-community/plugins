// 常量与地址校验。

// 供应商 id：也是 plugin-auth.json 里的键。
export const PROVIDER = "zhihu";
// 知乎数据开放平台。插件只使用 /api/v1 下的 REST 接口。
export const API_BASE = "https://developer.zhihu.com";
// 标识发往知乎的流量。
export const USER_AGENT = "tools-zhihu/0.2.0";
// 工具单次执行最多 55 秒；这里给重试留出余量。
export const REQUEST_TIMEOUT = 25_000;

// 返回给智能体的正文摘要默认截断长度（字符）。0 表示不截断。
export const DEFAULT_MAX_TEXT_LENGTH = 500;
// 单条结果最多保留几条评论摘要。
export const DEFAULT_MAX_COMMENT_INFO = 2;

// 重试只针对确定可以安全重试的失败：网络错误、HTTP 5xx、50002/90001/30003。
// 额度类（30001/30002）和鉴权类（20001）重试只会再烧一次额度。
export const RETRY = { attempts: 2, baseDelay: 300, maxDelay: 3000 };

// 各类接口的缓存时长（毫秒）。0 表示不缓存。
export const CACHE_TTL = {
  search: 120_000,
  hot_list: 60_000,
  quota: 60_000,
  answers: 120_000,
  recommendations: 60_000,
};

// 只允许 HTTPS；本地测试允许回环地址的 HTTP（与 magpie 社区插件一致）。
export function serviceURL(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("baseUrl 必须是一个地址。");
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "知乎接口地址必须使用 HTTPS（本地测试允许回环地址的 HTTP）。",
    );
  }
  return url;
}

// baseUrl 是源站（可带路径前缀），这里统一拼出 /api/v1 下的地址。
export function apiURL(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/api/v1${path}`;
}
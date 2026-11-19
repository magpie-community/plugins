// 知乎搜索插件：把知乎数据开放平台的搜索相关接口包装成 magpie 工具，
// 任何接入 magpie 的智能体都能调用（MCP 服务器 /mcp/magpie/tools）。
//
// 安装：
//   magpie plugin add @magpie-community/tools-zhihu
//   magpie plugin login zhihu
//
// 只导出插件函数：magpie / OpenCode 1.x 会把入口文件导出的每个成员都当成插件。

import {
  API_BASE,
  CACHE_TTL,
  DEFAULT_MAX_COMMENT_INFO,
  DEFAULT_MAX_TEXT_LENGTH,
  PROVIDER,
  serviceURL,
} from "./src/config.mjs";
import { Cache } from "./src/cache.mjs";
import { Credentials } from "./src/credentials.mjs";
import { createTools } from "./src/tools.mjs";
import { createWebSearch } from "./src/websearch.mjs";

// 可选：options.debug=true 或环境变量 ZHIHU_DEBUG=1 时把请求耗时/错误写进 magpie 日志。
// 只记录路径、耗时、错误码，不记录密钥和搜索词。
function createLogger(input, options) {
  const enabled = options.debug ?? process.env.ZHIHU_DEBUG === "1";
  if (!enabled) return undefined;
  return (level, message) => {
    try {
      const log = input?.client?.app?.log;
      if (typeof log === "function") {
        void Promise.resolve(
          log({ body: { service: "tools-zhihu", level, message } }),
        ).catch(() => {});
        return;
      }
    } catch {
      // magpie 的日志接口不可用时退回 stderr（magpie 会收进自己的日志）。
    }
    console.error(`[tools-zhihu] ${message}`);
  };
}

function resolveTextLength(value) {
  if (value === undefined) return DEFAULT_MAX_TEXT_LENGTH;
  if (!Number.isInteger(value) || value < 0 || value > 20000) {
    throw new Error("maxTextLength 必须是 0 到 20000 之间的整数（0 表示不截断）。");
  }
  return value;
}

function resolveTTL(value) {
  if (value === undefined) return CACHE_TTL;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("cacheTTL 必须是大于等于 0 的毫秒数（0 表示不缓存）。");
  }
  return {
    search: value,
    hot_list: value,
    quota: value,
    answers: value,
    recommendations: value,
  };
}

export const ZhihuTools = async (input, options = {}) => {
  if (options.accessSecret !== undefined && typeof options.accessSecret !== "string") {
    throw new Error("accessSecret must be a string.");
  }
  const baseUrl = serviceURL(options.baseUrl ?? API_BASE).href.replace(/\/$/, "");
  const credentials = new Credentials(input, options);
  const logger = createLogger(input, options);
  const maxTextLength = resolveTextLength(options.maxTextLength);
  const ttl = resolveTTL(options.cacheTTL);
  const cache = new Cache({ enabled: options.cache !== false });

  return {
    // 这个供应商只负责登录，不提供对话模型。
    config: async (config) => {
      config.provider ??= {};
      config.provider[PROVIDER] ??= { name: "知乎", models: {} };
    },
    auth: {
      provider: PROVIDER,
      single: true,
      methods: [
        {
          type: "api",
          label: "知乎 Access Secret",
          placeholder: "在 developer.zhihu.com/profile 生成",
        },
      ],
    },
    // magpie 的联网搜索可以选“知乎”。
    search: {
      zhihu: {
        name: "知乎",
        auth: PROVIDER,
        execute: createWebSearch({
          credentials,
          baseUrl,
          cache,
          logger,
          ttl: ttl.search,
          maxTextLength,
        }),
      },
    },
    tool: createTools({
      credentials,
      baseUrl,
      cache,
      logger,
      ttl,
      maxTextLength,
      maxCommentInfo: DEFAULT_MAX_COMMENT_INFO,
    }),
  };
};

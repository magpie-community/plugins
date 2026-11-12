import { CHANNEL_NAMES } from "./adapter.mjs";

const details = {
  grok: ["G", "模型搜索", "可选轻量、一般与深入模型", "GROK_API_KEY", "GROK_API_URL"],
  tavily: ["T", "网页搜索", "面向 Agent 的搜索与摘要", "TAVILY_API_KEY", "TAVILY_API_URL"],
  exa: ["E", "网页搜索", "网页发现与相关内容摘录", "EXA_API_KEY", "EXA_API_URL"],
  firecrawl: ["F", "网页搜索", "搜索结果与网页内容提取", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"],
  you: ["Y", "网页搜索", "网页与新闻；支持免密钥入口", "YOU_API_KEY"],
  brave: ["B", "网页搜索", "独立搜索索引", "BRAVE_API_KEY"],
  parallel: ["P", "网页搜索", "自然语言目标与网页摘录", "PARALLEL_API_KEY"],
  perplexity: ["Px", "网页搜索", "Search API，使用独立 API 额度", "PERPLEXITY_API_KEY"],
  bocha: ["博", "网页搜索", "中文网页与摘要", "BOCHA_API_KEY"],
  serper: ["S", "网页搜索", "Google 搜索结果", "SERPER_API_KEY"],
  searxng: ["Sx", "聚合搜索", "你的 SearXNG 实例", null, "SEARXNG_URL"],
  github: ["GH", "专业来源", "公开代码仓库，支持搜索限定词", "GITHUB_SEARCH_TOKEN"],
  arxiv: ["aX", "专业来源", "论文预印本与摘要"],
  crossref: ["Cr", "专业来源", "文献元数据与 DOI"],
};
export const CATALOG = Object.fromEntries(Object.keys(CHANNEL_NAMES).map(id => {
  const [mark, kind, description, keyEnv, urlEnv] = details[id];
  return [id, { id, name: CHANNEL_NAMES[id].split(" · ")[0], mark, kind, description, keyEnv, urlEnv }];
}));
export const IDS = Object.keys(CATALOG);
export const WEB = IDS.filter(id => CATALOG[id].kind !== "专业来源" && id !== "grok");
export const PROFILES = ["quick", "balanced", "deep"];
export function fault(message, code = "INVALID", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

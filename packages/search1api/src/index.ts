import { Credentials } from "./auth.ts";
import { startOAuth } from "./oauth.ts";
import { AuthenticationError, request } from "./request.ts";
import { filters, maxResults, query, searchBody, validate, type ArgumentsSchema, type Schema } from "./tools.ts";
import { API_BASE, PROVIDER, serviceURL, type Options, type PluginInput, type StoredOAuth } from "./types.ts";

export const Search1APIPlugin = async (input: PluginInput, options: Options = {}) => {
  if (options.apiKey !== undefined && typeof options.apiKey !== "string")
    throw new Error("apiKey must be a string.");
  const baseUrl = serviceURL(options.baseUrl ?? API_BASE).href.replace(/\/$/, "");
  const credentials = new Credentials(input, options);

  function tool(
    name: string,
    description: string,
    properties: Record<string, Schema>,
    required: string[],
    body: (args: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const args: ArgumentsSchema = { type: "object", properties, required, additionalProperties: false };
    return {
      description,
      args,
      async execute(value: unknown, ctx: { abort: AbortSignal }) {
        const payload = body(validate(args, value));
        const signal = ctx.abort;
        let auth = await credentials.token(signal);
        signal.throwIfAborted();
        let result: unknown;
        try {
          result = await request(baseUrl, name, auth.token, payload, signal);
        } catch (error) {
          if (!(error instanceof AuthenticationError) || !auth.oauth) throw error;
          const renewed = await credentials.renew(auth.oauth, signal);
          auth = { token: renewed.access, oauth: renewed };
          result = await request(baseUrl, name, auth.token, payload, signal);
        }
        return JSON.stringify(result, null, 2);
      },
    };
  }

  return {
    config: async (config: { provider?: Record<string, unknown> }) => {
      config.provider ??= {};
      // This entry supplies sign-in, not chat models.
      config.provider[PROVIDER] ??= { name: "Search1API", models: {} };
    },
    auth: {
      provider: PROVIDER,
      single: true,
      methods: [
        { type: "oauth" as const, label: "Sign in to Search1API", authorize: () => startOAuth(baseUrl) },
        { type: "api" as const, label: "Search1API API key" },
      ],
      refreshLead: 60_000,
      refresh: (auth: StoredOAuth) => credentials.renew(auth),
    },
    tool: {
      search: tool("search",
        "Search the live web for current facts, research, documentation, people, companies and sources. Credit Grokipedia results as Powered by xAI.",
        { query, ...filters,
          searchService: { type: "string", enum: ["google", "bing", "bingcn", "duckduckgo", "yahoo", "yandex", "x", "reddit", "github", "youtube", "arxiv", "wechat", "bilibili", "imdb", "wikipedia", "grokipedia", "baidu", "360", "quark"] },
          page: { type: "integer", minimum: 1, maximum: 100 },
        }, ["query"], (args) => searchBody(args, "google")),
      news: tool("news",
        "Search current news and optionally retrieve full article content.",
        { query, ...filters, searchService: { type: "string", enum: ["google", "bing", "duckduckgo", "yahoo", "hackernews", "reuters"] } },
        ["query"], (args) => searchBody(args, "bing")),
      ask: tool("ask",
        "Describe what to find in natural language. Search1API chooses engines and a time window and returns results ranked by relevance. Costs 5 credits; returns search results rather than a generated answer.",
        { query: { ...query, maxLength: 500 } }, ["query"], ({ query }) => ({ query })),
      crawl: tool("crawl", "Retrieve clean readable content from a public URL.",
        { url: { type: "string", format: "uri" } }, ["url"], ({ url }) => ({ url })),
      sitemap: tool("sitemap", "Discover links related to a public URL or domain.",
        { url: { type: "string", format: "uri" } }, ["url"], ({ url }) => ({ url })),
      trending: tool("trending", "Find trending repositories on GitHub or stories on Hacker News.",
        { service: { type: "string", enum: ["github", "hackernews"] }, maxResults },
        ["service"], ({ service, maxResults }) => ({ search_service: service, max_results: maxResults ?? 10 })),
    },
  };
};

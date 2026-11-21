import { join } from "node:path";
import { Credentials } from "./auth.ts";
import { CATEGORIES, DESCRIPTION, feedbackBody } from "./feedback.ts";
import { startOAuth } from "./oauth.ts";
import { Pool } from "./pool.ts";
import { request } from "./request.ts";
import { filters, maxResults, query, searchBody, validate, type ArgumentsSchema, type Schema } from "./tools.ts";
import { API_BASE, PROVIDER, serviceURL, type Options, type PluginInput, type StoredAuth, type StoredOAuth } from "./types.ts";

export const Search1APIPlugin = async (input: PluginInput, options: Options = {}) => {
  if (options.apiKey !== undefined && typeof options.apiKey !== "string")
    throw new Error("apiKey must be a string.");
  if (options.keyPick !== undefined && options.keyPick !== "order" && options.keyPick !== "rotate")
    throw new Error('keyPick must be "order" or "rotate".');
  const baseUrl = serviceURL(options.baseUrl ?? API_BASE).href.replace(/\/$/, "");
  const credentials = new Credentials(input, options);
  const pool = new Pool(credentials, options.keyPick ?? "order");

  async function send(name: string, payload: Record<string, unknown>, signal: AbortSignal) {
    return pool.send((token) => request(baseUrl, name, token, payload, signal), signal);
  }

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
        const result = await send(name, body(validate(args, value)), ctx.abort);
        return JSON.stringify(result, null, 2);
      },
    };
  }

  const feedbackArgs: ArgumentsSchema = {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1, maxLength: 4000, description: "What went wrong or what was missing, in plain language." },
      intent: { type: "string", maxLength: 2000, description: "The Search1API call you were making and what you expected from it. Not the user's request or conversation." },
      category: { type: "string", enum: CATEGORIES },
      request_id: { type: "string", maxLength: 256, description: "Request id of the call that had the problem, if known." },
      model: { type: "string", maxLength: 128, description: "Your model name, if you know it." },
    },
    required: ["message"],
    additionalProperties: false,
  };

  // magpie's web search (Settings › Models › Web search): the account magpie
  // picked, already renewed, comes from ctx.getAuth(). Errors keep their HTTP
  // status so magpie rests that account and asks the next search API.
  async function webSearch(
    { query, count }: { query?: unknown; count?: unknown },
    ctx: { abort: AbortSignal; getAuth?: () => Promise<StoredAuth | undefined> },
  ) {
    if (typeof query !== "string" || !query.trim()) throw new Error("query is required.");
    // The account magpie picked is the one sent, so a refusal rests the
    // account that was refused. The option or environment keys are used only
    // where magpie gives no account (a host without getAuth).
    let token: string | undefined;
    if (ctx.getAuth) {
      const auth = await ctx.getAuth();
      if (auth?.type === "api" && auth.key) token = auth.key;
      else if (auth?.type === "oauth" && auth.access) token = auth.access;
      else throw new Error("Not signed in to Search1API.");
    }
    const n = Math.trunc(Number(count));
    const payload = {
      query: query.trim(),
      search_service: "google",
      max_results: n >= 1 ? Math.min(n, 50) : 10,
      crawl_results: 0,
    };
    const result = (token === undefined
      ? await pool.send((bearer) => request(baseUrl, "search", bearer, payload, ctx.abort), ctx.abort)
      : await request(baseUrl, "search", token, payload, ctx.abort)) as { results?: unknown };
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return (Array.isArray(result?.results) ? result.results : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({ title: text(r.title), url: text(r.link), text: text(r.snippet), age: text(r.published_date) }))
      .filter((r) => r.url);
  }

  return {
    config: async (config: { provider?: Record<string, unknown> }) => {
      config.provider ??= {};
      // This entry supplies sign-in, not chat models.
      config.provider[PROVIDER] ??= { name: "Search1API", models: {} };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        { type: "oauth" as const, label: "Sign in to Search1API", authorize: () => startOAuth(baseUrl, undefined, join(input.directory, "search1api-oauth-client.json")) },
        { type: "api" as const, label: "Search1API API key" },
      ],
      refreshLead: 60_000,
      refresh: (auth: StoredOAuth) => credentials.renew(auth),
    },
    search: {
      search1api: { name: "Search1API", auth: PROVIDER, execute: webSearch },
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
      send_feedback: {
        description: DESCRIPTION,
        args: feedbackArgs,
        async execute(value: unknown, ctx: { abort: AbortSignal }) {
          const payload = feedbackBody(validate(feedbackArgs, value));
          // A report that cannot be sent must not fail the agent's task.
          try {
            const receipt = await send("feedback", payload, ctx.abort) as { id?: unknown };
            return `Feedback recorded (${typeof receipt?.id === "string" ? receipt.id : "ok"}). Thank you.`;
          } catch (error) {
            ctx.abort.throwIfAborted();
            const reason = error instanceof Error ? error.message : "Search1API feedback failed.";
            return `Feedback was not recorded: ${reason} Continue the task.`;
          }
        },
      },
    },
  };
};

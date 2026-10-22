// Cloudflare Workers AI Plugin for Magpie
// Supports template URL with ${CLOUDFLARE_ACCOUNT_ID} placeholder
// Auto-discovers models from models.dev API

const CF_WORKERS_AI_ID = "cloudflare-workers-ai";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CF_API_BASE_TEMPLATE = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1";
const DEFAULT_DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const CHAT_SDK = "@ai-sdk/openai-compatible";
// Models Cloudflare gates behind a Workers Paid plan / prepaid AI Gateway credits
// (developers.cloudflare.com/workers-ai/platform/pricing/)
const PAID_ONLY_MODELS = new Set([
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
]);
const FREE_ALLOCATION_NEURONS = 10000; // per day, both plans
const DAY_MS = 24 * 60 * 60 * 1000;

function checkedURL(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Expected a plain HTTP(S) base URL");
  }
  return url.href.replace(/\/+$/, "");
}

function interpolateTemplate(template, vars) {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? `\${${key}}`);
}

async function fetchModelsDev({ fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!resp.ok) {
    throw new Error(`models.dev returned HTTP ${resp.status}`);
  }
  return resp.json();
}

function buildModels(catalog, baseURL) {
  const cfSection = catalog["cloudflare-workers-ai"]?.models;
  if (!cfSection || typeof cfSection !== "object") {
    throw new Error("cloudflare-workers-ai section not found in models.dev catalog");
  }
  const result = {};
  for (const [modelId, meta] of Object.entries(cfSection)) {
    const limit = meta.limit ?? {};
    const cost = meta.cost ?? {};
    result[modelId] = {
      id: modelId,
      providerID: CF_WORKERS_AI_ID,
      name: meta.name ?? modelId,
      api: { id: modelId, url: baseURL, npm: CHAT_SDK },
      limit: {
        context: limit.context ?? 32768,
        output: limit.output ?? 4096,
      },
      capabilities: {
        temperature: true,
        reasoning: !!meta.reasoning,
        attachment: (meta.modalities?.input ?? ["text"]).some((m) => m !== "text"),
        toolcall: !!meta.tool_call,
        input: Object.fromEntries((meta.modalities?.input ?? ["text"]).map((m) => [m, true])),
        output: Object.fromEntries((meta.modalities?.output ?? ["text"]).map((m) => [m, true])),
        interleaved: meta.interleaved?.field === "reasoning_content" || false,
      },
      cost: {
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        cache: { read: cost.cache_read ?? 0, write: cost.cache_write ?? 0 },
      },
      variants: meta.reasoning_options
        ? Object.fromEntries(
            meta.reasoning_options
              .filter((o) => o.type === "effort")
              .flatMap((o) => o.values ?? [])
              .map((effort) => [effort, { reasoningEffort: effort }])
          )
        : {},
      status: "active",
      release_date: meta.release_date ?? "",
    };
  }
  return result;
}

function createDiscovery({ load, initial = {}, ttlMs = DEFAULT_DISCOVERY_TTL_MS, now = Date.now }) {
  let current = initial;
  let verifiedAt;
  let pending;

  async function refresh(force = false) {
    if (!force && verifiedAt !== undefined && now() - verifiedAt < ttlMs) return current;
    if (pending) return pending;
    pending = (async () => {
      const next = await load();
      if (!next || typeof next !== "object" || Array.isArray(next))
        throw new Error("Invalid live model catalog");
      current = next;
      verifiedAt = now();
      return current;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }

  return {
    get verifiedAt() { return verifiedAt; },
    get current() { return current; },
    refresh,
    async forDisplay() {
      try { return await refresh(); }
      catch {
        if (verifiedAt === undefined && !Object.keys(current).length)
          throw new Error("Model discovery failed with no cached list");
        const fallback = { ...current };
        fallback[Symbol.for("magpie.fellBack")] = true;
        return fallback;
      }
    },
    async requireModel(id) {
      const models = await refresh();
      if (!Object.hasOwn(models, id))
        throw new Error(`Model ${JSON.stringify(id)} is absent from the current catalog`);
      return models[id];
    },
  };
}

export async function CloudflareWorkersAIPlugin(_input, options = {}) {
  const accountId = options.accountId ?? "";
  const apiKey = options.apiKey ?? "";
  const baseTemplate = options.baseTemplate ?? CF_API_BASE_TEMPLATE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const discoveryTTL = options.discoveryTTLMs ?? DEFAULT_DISCOVERY_TTL_MS;

  // accountId is optional at init: it is provided per account at sign-in time
  // (metadata.accountId) or via plugin options. Do not fail the plugin load.
  const baseURL = accountId
    ? interpolateTemplate(baseTemplate, { CLOUDFLARE_ACCOUNT_ID: accountId })
    : baseTemplate; // placeholder left intact until sign-in provides the id
  checkedURL(baseURL);

  // Initial static snapshot (from models.dev at plugin build time, or empty)
  let initialModels = {};
  try {
    const catalog = await fetchModelsDev({ fetchImpl });
    initialModels = buildModels(catalog, baseURL);
  } catch (e) {
    console.warn("[magpie-cloudflare-workers-ai] Initial model fetch failed, will retry on demand:", e.message);
  }

  const discovery = createDiscovery({
    initial: initialModels,
    ttlMs: discoveryTTL,
    load: async () => {
      const catalog = await fetchModelsDev({ fetchImpl });
      return buildModels(catalog, baseURL);
    },
  });

  return {
    async config(cfg) {
      cfg.provider ??= {};
      let models;
      try {
        models = await discovery.forDisplay();
      } catch (e) {
        // Graceful degrade: load errors in the config hook fail the whole plugin.
        console.warn("[magpie-cloudflare-workers-ai] catalog unavailable, registering provider with empty model list; models come from provider.models per account:", e.message);
        models = {};
      }
      cfg.provider[CF_WORKERS_AI_ID] ??= {
        name: "Cloudflare Workers AI",
        npm: CHAT_SDK,
        api: baseURL,
        models: Object.fromEntries(
          Object.entries(models).map(([id, m]) => [id, {
            name: PAID_ONLY_MODELS.has(id) ? `${m.name} （Paid）` : m.name,
            meta: PAID_ONLY_MODELS.has(id) ? "需要 Workers Paid 或 AI Gateway 预充值" : undefined,
            limit: m.limit,
            reasoning: m.capabilities.reasoning,
            tool_call: m.capabilities.toolcall,
            attachment: m.capabilities.attachment,
            modalities: {
              input: Object.keys(m.capabilities.input).filter((k) => m.capabilities.input[k]),
              output: Object.keys(m.capabilities.output).filter((k) => m.capabilities.output[k]),
            },
            cost: { input: m.cost.input, output: m.cost.output },
            // magpie-only field: green "free" badge on the model card.
            // Workers served the 8 paid-only models behind Workers Paid / AI
            // Gateway credits; everything else counts only against the daily
            // Neurons allowance.
            free: !PAID_ONLY_MODELS.has(id),
            variants: m.variants,
            interleaved: m.capabilities.interleaved,
            }])
        )
      };
    },
    auth: {
      provider: CF_WORKERS_AI_ID,
      maxConcurrency: 3,
      methods: [
        {
          type: "api",
          label: "Cloudflare API Token (Workers AI:Edit 权限)",
          prompts: [
            {
              type: "password",
              key: "token",
              message: "API Token",
              placeholder: "Workers AI:Edit 权限的 API Token",
              validate: (v) => (v && v.trim() ? undefined : "需要 API Token"),
            },
            {
              type: "password",
              key: "accountId",
              message: "Account ID (可选，默认使用插件配置的)",
              placeholder: "32位十六进制 Account ID",
              validate: (v) => (!v || /^[0-9a-f]{32}$/i.test(v.trim()) ? undefined : "Account ID 必须是 32 位十六进制"),
            },
          ],
          async authorize(input, inputs) {
            // magpie passes the prompts answers object as the first argument
            // ({ token?, accountId? }); accept legacy shapes as well.
            const obj =
              input && typeof input === "object" && !Array.isArray(input)
                ? input
                : inputs && typeof inputs === "object"
                  ? inputs
                  : {};
            const token = (
              (typeof input === "string" && input.trim()) ||
              obj.token || obj.key || obj.apiKey || ""
            ).trim();
            if (!token) return { type: "failed", error: "需要 API Token" };
            const accountIdInput = (obj.accountId ?? "").trim();
            return {
              type: "success",
              key: token,
              metadata: accountIdInput ? { accountId: accountIdInput } : {},
            };
          },
        }
      ],
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (!auth) return {};

        // Account object shapes: contract api account is { type: "api", key, ... };
        // keep the legacy OpenCode multi-method shape accepted for compatibility.
        const apiKey = auth.key ?? auth.methods?.[0]?.key ?? "";
        const customAccountId = auth.metadata?.accountId || auth.methods?.[1]?.key || "";
        const effectiveAccountId = customAccountId || accountId;
        if (!/^[0-9a-f]{32}$/i.test(effectiveAccountId)) {
          throw new Error("Cloudflare Workers AI needs a 32-char hex Account ID — provide it in the sign-in prompt or the plugin's accountId option");
        }
        const effectiveBaseURL = interpolateTemplate(baseTemplate, { CLOUDFLARE_ACCOUNT_ID: effectiveAccountId });

        return {
          baseURL: effectiveBaseURL,
          apiKey,
          async fetch(input, init) {
            const req = new Request(input, init);
            const parsed = new URL(req.url);
            // The gateway may address us via a model-metadata URL that still
            // carries the ${CLOUDFLARE_ACCOUNT_ID} template. Rebuild the target
            // from the effective account's base URL, reusing only the resource
            // part after /accounts/<whatever>/ai/v1.
            let targetURL;
            const m = parsed.pathname.match(/\/accounts\/[^/]*\/ai\/v1(\/.*)?$/);
            if (m) {
              const suffix = m[1] && m[1] !== "/" ? m[1] : "";
              targetURL = effectiveBaseURL.replace(/\/+$/, "") + suffix;
            } else {
              targetURL = effectiveBaseURL.replace(/\/+$/, "") + "/" + parsed.pathname.replace(/^\/+/, "");
            }
            if (parsed.search) targetURL += parsed.search;

            const headers = new Headers({ authorization: `Bearer ${apiKey}` });
            // Pass through CF-specific headers and content-type as given
            const contentType = req.headers.get("content-type");
            if (contentType) headers.set("content-type", contentType);
            for (const h of ["cf-aig-authorization", "cf-aig-metadata"]) {
              const v = req.headers.get(h);
              if (v) headers.set(h, v);
            }

            let body = init?.body;
            if (req.method === "POST" && !body && req.body) {
              body = await req.json().catch(() => null);
              if (body) {
                body = JSON.stringify(body);
                if (!headers.get("content-type")) headers.set("content-type", "application/json");
              }
            }

            // Verify the model exists in the current catalog when a chat request names one
            if (body && typeof body === "string") {
              let parsedBody = null;
              try {
                parsedBody = JSON.parse(body);
              } catch {
                /* non-JSON body: forward as-is */
              }
              if (parsedBody && typeof parsedBody === "object" && parsedBody.model) {
                await discovery.requireModel(parsedBody.model);
              }
            }

            return fetchImpl(targetURL, {
              method: req.method,
              headers,
              body,
              signal: init?.signal ?? req.signal,
              redirect: "error",
            });
          },
        };
      },
      async usage(getAuth, _provider) {
        // Cloudflare publishes no REST for per-account Neurons (dashboard only);
        // show the repeatable free-allocation window (10,000 Neurons/day,
        // resets daily 00:00 UTC) and best-effort plan detection.
        const auth = await getAuth?.();
        const acct = auth?.metadata?.accountId || accountId;
        let plan = "Workers Free / Paid（需 Dashboard 确认）";
        try {
          const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${acct}`, {
            headers: { authorization: `Bearer ${auth?.key ?? apiKey}` },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            const info = await res.json();
            const planName = info?.result?.plan?.name ?? info?.result?.plan ?? "";
            if (/free/i.test(String(planName))) plan = "Workers Free";
            else if (String(planName)) plan = String(planName);
          }
        } catch {
          /* token scope not enough or network issue — keep unknown */
        }
        const nextUtcMidnight = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS);
        return {
          plan,
          windows: [
            {
              name: "Neurons/天（免费额度）",
              span: DAY_MS,
              resetsAt: nextUtcMidnight.toISOString(),
              amount: null,
              limit: FREE_ALLOCATION_NEURONS,
              unit: "neurons",
              display: "≤10,000 Neurons/天：精确用量仅在 Cloudflare Dashboard（API 无公开端点）",
            },
          ],
        };
      },
    },
    provider: {
      id: CF_WORKERS_AI_ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const models = await discovery.forDisplay();
        // Flag the models Cloudflare serves only behind Workers Paid / AI
        // Gateway credits, and mark the rest as free for the green badge.
        return Object.fromEntries(
          Object.entries(models).map(([id, m]) => [
            id,
            PAID_ONLY_MODELS.has(id)
              ? { ...m, name: `${m.name} （Paid）` }
              : { ...m, free: true },
          ]),
        );
      },
    },
  };
}
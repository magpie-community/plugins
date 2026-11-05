// Builds the page's provider -> account -> model tree from magpie's own
// gateway answers. The gateway has already applied magpie's accounting
// rules (handed-on tries, rejected calls, API keys, session-file rows),
// pricing and account aliases, so this file only groups and sorts them.

const PROVIDER_NAMES = {
  codex: "Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
  raccoon: "Raccoon",
  "minimax-code": "MiniMax Code",
  "minimax-code-global": "MiniMax Code",
  "trae-cn": "Trae CN",
  "trae-global": "Trae",
  "opencode-zen-free": "OpenCode Zen",
  "autoclaw-cn": "AutoClaw",
  autoclaw: "AutoClaw",
  zcode: "ZCode",
};

const PERIODS = new Set(["today", "7d", "30d", "all"]);

function text(value) {
  return value == null ? "" : String(value).trim();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function providerName(id) {
  return PROVIDER_NAMES[id] || id || "unknown";
}

function providerLabel(item) {
  const sub = text(item?.sub);
  // The gateway writes "Provider · account" in model subtitles; the
  // provider is the part before the account separator. Older answers used
  // a hyphen, so accept both spellings.
  const beforeAlias = sub.split(" · ")[0].split(" - ")[0].trim();
  return beforeAlias || text(item?.providerName) || providerName(text(item?.provider));
}

function blankStats() {
  return {
    calls: 0,
    errors: 0,
    retried: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    unpriced: 0,
    credits: 0,
    timed: 0,
    ttftMs: 0,
    decodeMs: 0,
    decodeOut: 0,
    decodeN: 0,
    lastAt: "",
  };
}

function finishStats(target) {
  target.tokens = target.input + target.output;
  target.cache = target.cacheRead + target.cacheWrite;
  target.allTokens = target.tokens + target.cache;
  return target;
}

function gatewayStats(item) {
  const stats = blankStats();
  for (const [to, from] of [
    ["calls", "calls"],
    ["errors", "errors"],
    ["retried", "retried"],
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
    ["reasoning", "reasoning"],
    ["cost", "cost"],
    ["unpriced", "unpriced"],
    ["credits", "credits"],
    ["timed", "timed"],
    ["ttftMs", "ttft_ms"],
    ["decodeMs", "decode_ms"],
    ["decodeOut", "decode_out"],
    ["decodeN", "decode_n"],
  ]) {
    stats[to] = number(item?.[from]);
  }
  stats.lastAt = text(item?.last_at || item?.lastAt || item?.last?.at);
  return finishStats(stats);
}

function addTotals(total, item) {
  for (const key of [
    "calls",
    "errors",
    "retried",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "cost",
    "unpriced",
    "credits",
    "timed",
    "ttftMs",
    "decodeMs",
    "decodeOut",
    "decodeN",
  ]) {
    total[key] += number(item[key]);
  }
  const lastAt = text(item?.lastAt);
  if (lastAt && lastAt > text(total.lastAt)) total.lastAt = lastAt;
}

function isApiKey(item) {
  const account = text(item?.account);
  const access = text(item?.access).toLowerCase();
  return account === "API key" || access === "key" || access === "api-key";
}

export function accountKey(provider, account) {
  return `${text(provider)}\u001f${text(account)}`;
}

function modelFromId(item, fallbackProvider) {
  const id = text(item?.id);
  const slash = id.indexOf("/");
  const provider = text(item?.provider) || (slash >= 0 ? id.slice(0, slash) : fallbackProvider);
  const model = text(item?.model) || (slash >= 0 ? id.slice(slash + 1) : id);
  return { id, provider, model };
}

function mergeModelRows(items, account) {
  const rows = new Map();
  const hostsByModel = new Map();

  for (const item of items) {
    const model = modelFromId(item, account.provider);
    if (!model.model || model.provider !== account.provider) continue;

    const key = `${model.provider}\u001f${model.model}`;
    let row = rows.get(key);
    const stats = gatewayStats(item);
    if (!row) {
      row = {
        id: `${account.id}\u001f${model.provider}\u001f${model.model}`,
        model: model.model,
        provider: model.provider,
        providerName: account.providerName,
        ...stats,
        hostNotes: [],
      };
      rows.set(key, row);
    } else {
      addTotals(row, stats);
    }

    const host = text(item?.host) || text(account.alias) || text(account.account);
    if (host) {
      let hosts = hostsByModel.get(key);
      if (!hosts) {
        hosts = new Map();
        hostsByModel.set(key, hosts);
      }
      hosts.set(host, (hosts.get(host) || 0) + number(item?.calls));
    }
  }

  for (const [key, row] of rows) {
    finishStats(row);
    const hosts = [...(hostsByModel.get(key) || new Map()).entries()]
      .map(([host, calls]) => ({ account: host, calls }))
      .sort((a, b) => b.calls - a.calls || a.account.localeCompare(b.account));
    row.hostNotes = hosts.length > 1 ? hosts : [];
  }
  return [...rows.values()];
}

// The usage answer already has a Models table, with the account that made
// the calls in `host`. Using it avoids one requests read per account: on a
// large 30-day ledger that was the slowest part of the first load. A model
// row without a host belongs to the provider's only account, or the
// requests read below fills the gap.
function modelRowsFromUsage(usage, account, siblings) {
  const rows = Array.isArray(usage?.models) ? usage.models : [];
  const providerRows = rows.filter((item) => text(item?.provider) === account.provider);
  const exact = providerRows.filter((item) => {
    const host = text(item?.host);
    return host && (host === account.account || host === account.alias);
  });
  const withoutHost = providerRows.filter((item) => !text(item?.host));
  const chosen = exact.length ? exact : siblings === 1 ? withoutHost : [];
  if (!chosen.length) return null;
  const total = chosen.reduce((sum, item) => sum + number(item?.calls), 0);
  // The top-level model table may be capped or may omit calls handed on to
  // another account. Use it only when it accounts for every call; otherwise
  // the requests answer carries this account's complete model table.
  if (total < account.calls) return null;
  return mergeModelRows(chosen, account);
}

function modelRows(requests, account) {
  const rows = Array.isArray(requests?.by?.modelAt) ? requests.by.modelAt : [];
  return mergeModelRows(rows, account);
}

// usage is GET /v1/magpie/usage; requestsByAccount maps the account id to
// GET /v1/magpie/usage/requests?account=...
export function aggregateGatewayUsage(usage, requestsByAccount = {}, options = {}) {
  const period = PERIODS.has(options.period) ? options.period : "today";
  const accountItems = Array.isArray(usage?.accounts) ? usage.accounts : [];
  const accounts = [];
  let apiKeyGroups = 0;
  const providerCounts = new Map();

  for (const item of accountItems) {
    const provider = text(item?.provider);
    if (provider) providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
  }

  for (const item of accountItems) {
    const provider = text(item?.provider);
    const account = text(item?.account) || text(item?.id);
    if (!provider || !account) continue;
    const apiKey = isApiKey(item);
    const accountRow = {
      id: `${provider}\u001f${account}`,
      account,
      alias: apiKey ? "" : (text(item?.name) !== account ? text(item?.name) : ""),
      provider,
      providerName: providerLabel(item),
      kind: apiKey ? "api-key" : "account",
      models: modelRowsFromUsage(usage, {
        id: accountKey(provider, account),
        account,
        alias: apiKey ? "" : (text(item?.name) !== account ? text(item?.name) : ""),
        provider,
        providerName: providerLabel(item),
        calls: number(item?.calls),
      }, providerCounts.get(provider) || 0) ?? modelRows(requestsByAccount[accountKey(provider, account)], {
        id: accountKey(provider, account),
        provider,
        providerName: providerLabel(item),
      }),
      ...gatewayStats(item),
    };
    accounts.push(accountRow);
    if (apiKey) apiKeyGroups += 1;
  }

  const summary = gatewayStats(usage);
  summary.accounts = accounts.filter((account) => account.kind !== "api-key").length;
  summary.apiKeyGroups = apiKeyGroups;
  summary.providers = 0;
  summary.models = 0;

  const maxAccountTokens = Math.max(1, ...accounts.map((account) => account.tokens));
  for (const account of accounts) {
    account.share = summary.tokens > 0 ? account.tokens / summary.tokens : 0;
    account.bar = Math.max(0.015, account.tokens / maxAccountTokens);
    account.models.sort(
      (a, b) =>
        b.tokens - a.tokens ||
        b.cost - a.cost ||
        b.calls - a.calls ||
        a.model.localeCompare(b.model),
    );
    const maxModelTokens = Math.max(1, ...account.models.map((model) => model.tokens));
    for (const model of account.models) {
      model.share = account.tokens > 0 ? model.tokens / account.tokens : 0;
      model.bar = Math.max(0.02, model.tokens / maxModelTokens);
    }
    summary.models += account.models.length;
  }

  const providerGroups = new Map();
  for (const account of accounts) {
    let provider = providerGroups.get(account.provider);
    if (!provider) {
      provider = {
        id: account.provider,
        provider: account.provider,
        providerName: account.providerName,
        accounts: [],
        ...blankStats(),
      };
      providerGroups.set(account.provider, provider);
    }
    provider.accounts.push(account);
    addTotals(provider, account);
  }
  const providers = [...providerGroups.values()];
  for (const provider of providers) {
    finishStats(provider);
    provider.accounts.sort(
      (a, b) => b.tokens - a.tokens || b.cost - a.cost || a.account.localeCompare(b.account),
    );
  }
  providers.sort(
    (a, b) => b.tokens - a.tokens || b.cost - a.cost || a.providerName.localeCompare(b.providerName),
  );
  summary.providers = providers.length;
  finishStats(summary);

  accounts.sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.cost - a.cost ||
      b.calls - a.calls ||
      a.account.localeCompare(b.account),
  );

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary,
    providers,
    accounts,
    warnings: summary.calls ? [] : [{ code: "no-usage" }],
    source: "Magpie gateway usage",
  };
}

export { PERIODS };

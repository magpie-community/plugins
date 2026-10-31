// The usage tree, grouped the way magpie groups its own usage tables
// (internal/usage/summary_fold.go, internal/stats):
//
//   - an account is a provider and the subscription account that answered:
//     the record's provider_account, else the host's account
//     (Record.Account). Magpie shows the name the user gave that account
//     (providers.json accountNames) beside it.
//   - a model is a provider and the model that was asked for
//     (the record's model), told apart by the host's account when a
//     provider went to more than one place (summaryKeying).
//
// So a child of an account is one model at one host, and the numbers add
// up to the account's own.

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

function nullableNumber(value) {
  if (value == null || text(value) === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truthy(value) {
  return value === true || text(value).toLowerCase() === "true" || text(value) === "1";
}

export function providerName(id) {
  return PROVIDER_NAMES[id] || id || "未知供应商";
}

// whoOf is the account a call went out as: the part after " as " in the
// host, else the host itself (magpie's internal/usage.who).
export function whoOf(host) {
  const value = text(host);
  const at = value.lastIndexOf(" as ");
  return at >= 0 ? value.slice(at + 4) : value;
}

// accountOf is the subscription account that answered the call.
export function accountOf(row) {
  return text(row.provider_account) || whoOf(row.host);
}

// aliasOf is the name the user gave the account, the name magpie's own
// tables show beside it.
export function aliasOf(aliases, provider, account) {
  const forProvider = aliases?.[provider];
  if (!forProvider) return "";
  return forProvider[String(account || "").toLowerCase()] || "";
}

export function parseCSV(source) {
  const out = [];
  let row = [];
  let field = "";
  let quoted = false;

  const value = String(source ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quoted) {
      if (ch === '"') {
        if (value[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      out.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error("unterminated quoted field in usage CSV");
  if (field !== "" || row.length) {
    row.push(field.replace(/\r$/, ""));
    out.push(row);
  }
  return out;
}

function blankStats() {
  return {
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    unpriced: 0,
    credits: 0,
    lastAt: "",
  };
}

function finishStats(target) {
  target.tokens = target.input + target.output;
  target.cache = target.cacheRead + target.cacheWrite;
  target.allTokens = target.tokens + target.cache;
  return target;
}

function addTo(target, row) {
  target.calls += 1;
  target.input += row.input;
  target.output += row.output;
  target.cacheRead += row.cacheRead;
  target.cacheWrite += row.cacheWrite;
  target.reasoning += row.reasoning;
  target.credits += row.credits;
  if (row.error) target.errors += 1;
  if (row.cost == null) target.unpriced += 1;
  else target.cost += row.cost;
  if (row.time) {
    const ms = Date.parse(row.time);
    if (Number.isFinite(ms) && (!target.lastAt || ms > Date.parse(target.lastAt))) {
      target.lastAt = new Date(ms).toISOString();
    }
  }
}

function addTotals(total, item) {
  total.calls += item.calls;
  total.errors += item.errors;
  total.input += item.input;
  total.output += item.output;
  total.cacheRead += item.cacheRead;
  total.cacheWrite += item.cacheWrite;
  total.reasoning += item.reasoning;
  total.cost += item.cost;
  total.unpriced += item.unpriced;
  total.credits += item.credits;
  if (item.lastAt && (!total.lastAt || Date.parse(item.lastAt) > Date.parse(total.lastAt))) {
    total.lastAt = item.lastAt;
  }
}

export function aggregateUsageCSV(csv, options = {}) {
  const period = PERIODS.has(options.period) ? options.period : "7d";
  const aliases = options.accountNames || {};

  const table = parseCSV(csv);
  if (!table.length) throw new Error("usage CSV is empty");

  const header = table[0].map((name, index) =>
    (index === 0 ? name.replace(/^\uFEFF/, "") : name).trim(),
  );
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const field = (row, name) => (index[name] == null ? "" : row[index[name]] ?? "");

  const accounts = new Map();
  let skipped = 0;
  let rejected = 0;

  for (let i = 1; i < table.length; i += 1) {
    const row = table[i];
    if (!row.length || row.every((part) => part === "")) continue;

    // A call the agent made on its own, read from its session files, is not
    // a call of an account here.
    if (text(field(row, "source")).toLowerCase() === "log") {
      skipped += 1;
      continue;
    }

    const provider = text(field(row, "provider"));
    const status = number(field(row, "status"));
    // magpie's own rule: a rejected call is in no figure.
    if (truthy(field(row, "rejected")) || (!provider && status >= 400)) {
      rejected += 1;
      continue;
    }
    if (!provider) {
      skipped += 1;
      continue;
    }

    const host = text(field(row, "host"));
    const accountLabel = accountOf({ provider_account: field(row, "provider_account"), host });
    if (!accountLabel) {
      skipped += 1;
      continue;
    }
    const hostAccount = whoOf(host);
    const modelLabel =
      text(field(row, "model")) ||
      text(field(row, "served_model")) ||
      text(field(row, "requested_model")) ||
      "未记录模型";
    const served = text(field(row, "served_model"));

    const cost = nullableNumber(field(row, "cost_usd"));
    const record = {
      provider,
      account: accountLabel,
      model: modelLabel,
      served: served && served !== modelLabel ? served : "",
      hostAccount,
      time: text(field(row, "time")),
      input: number(field(row, "input_tokens")),
      output: number(field(row, "output_tokens")),
      cacheRead: number(field(row, "cache_read_tokens")),
      cacheWrite: number(field(row, "cache_write_tokens")),
      reasoning: number(field(row, "reasoning_tokens")),
      cost,
      credits: number(field(row, "credits")),
      error: truthy(field(row, "error")) || status === 0 || status >= 400,
    };

    const accountID = `${provider}\u001f${accountLabel}`;
    let account = accounts.get(accountID);
    if (!account) {
      account = {
        id: accountID,
        account: accountLabel,
        alias: aliasOf(aliases, provider, accountLabel),
        provider,
        providerName: providerName(provider),
        models: new Map(),
        ...blankStats(),
      };
      accounts.set(accountID, account);
    }

    // One row per model inside an account. Records written before magpie
    // kept provider_account name the host alone ("chatgpt.com"), so the
    // same model can arrive with more than one host account; keep them on
    // one row and show the differing host as a note instead.
    const modelID = modelLabel;
    let model = account.models.get(modelID);
    if (!model) {
      model = {
        id: `${accountID}\u001f${modelID}`,
        model: modelLabel,
        served: record.served,
        hostAccount,
        hosts: new Map(),
        provider,
        providerName: providerName(provider),
        ...blankStats(),
      };
      account.models.set(modelID, model);
    }
    if (!model.served && record.served) model.served = record.served;
    const hostEntry = model.hosts.get(hostAccount) || { account: hostAccount, calls: 0 };
    hostEntry.calls += 1;
    model.hosts.set(hostAccount, hostEntry);

    addTo(account, record);
    addTo(model, record);
  }

  const summary = blankStats();
  summary.accounts = accounts.size;
  summary.providers = 0;
  summary.models = 0;
  summary.skipped = skipped;
  summary.rejected = rejected;

  const accountRows = [];
  for (const account of accounts.values()) {
    finishStats(account);
    const models = [];
    for (const model of account.models.values()) {
      finishStats(model);
      models.push(model);
    }
    models.sort(
      (a, b) =>
        b.tokens - a.tokens ||
        b.cost - a.cost ||
        b.calls - a.calls ||
        a.model.localeCompare(b.model),
    );
    account.models = models;
    summary.models += models.length;
    addTotals(summary, account);
    accountRows.push(account);
  }

  accountRows.sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.cost - a.cost ||
      b.calls - a.calls ||
      a.account.localeCompare(b.account),
  );

  // The tree the page shows: a provider, the accounts that answered for it,
  // and the models each account used.
  const providerGroups = new Map();
  for (const account of accountRows) {
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

  const maxAccountTokens = Math.max(1, ...accountRows.map((account) => account.tokens));
  for (const account of accountRows) {
    account.share = summary.tokens > 0 ? account.tokens / summary.tokens : 0;
    account.bar = Math.max(0.015, account.tokens / maxAccountTokens);
    const maxModelTokens = Math.max(1, ...account.models.map((model) => model.tokens));
    for (const model of account.models) {
      model.share = account.tokens > 0 ? model.tokens / account.tokens : 0;
      model.bar = Math.max(0.02, model.tokens / maxModelTokens);
      model.hostNotes = [...model.hosts.values()]
        .filter((host) => host.account && host.account !== account.account)
        .sort((a, b) => b.calls - a.calls);
      delete model.hosts;
    }
  }

  const warnings = [];
  if (skipped > 0) {
    warnings.push(`已忽略 ${skipped} 条不属于账号统计的记录（本地会话或没有账号）。`);
  }
  if (rejected > 0) {
    warnings.push(`已忽略 ${rejected} 条被拒绝的请求。`);
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary,
    providers,
    accounts: accountRows,
    warnings,
  };
}

export function mapLedgerRow(row) {
  return {
    time: text(row.t || row.time),
    source: text(row.source),
    provider: text(row.provider || row.session_provider),
    host: text(row.host),
    provider_account: text(row.providerAccount || row.provider_account || row.session_account),
    model: text(row.model),
    served_model: text(row.served || row.served_model || row.model),
    requested_model: text(row.req || row.requested_model),
    input_tokens: row.in ?? row.input_tokens ?? "",
    output_tokens: row.out ?? row.output_tokens ?? "",
    cache_read_tokens: row.cache_read ?? row.cache_read_tokens ?? "",
    cache_write_tokens: row.cache_write ?? row.cache_write_tokens ?? "",
    reasoning_tokens: row.reasoning ?? row.reasoning_tokens ?? "",
    cost_usd: row.cost_usd ?? row.cost ?? "",
    credits: row.credits ?? "",
    status: row.status ?? "",
    error: row.error ?? "",
    rejected: row.rejected ?? "",
    error_message: row.error_message ?? "",
  };
}

export function aggregateLedgerRows(rows, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const period = PERIODS.has(options.period) ? options.period : "7d";
  const since = periodStart(period, now);
  const kept = [];

  for (const row of rows) {
    const mapped = mapLedgerRow(row);
    const at = Date.parse(mapped.time);
    if (since != null && (!Number.isFinite(at) || at < since)) continue;
    kept.push(mapped);
  }

  const header = [
    "time",
    "source",
    "provider",
    "host",
    "provider_account",
    "model",
    "served_model",
    "requested_model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "cost_usd",
    "credits",
    "status",
    "error",
    "rejected",
    "error_message",
  ];
  const esc = (value) => {
    const s = String(value ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = [
    header.join(","),
    ...kept.map((row) => header.map((key) => esc(row[key])).join(",")),
  ].join("\n");
  return aggregateUsageCSV(csv, { period, accountNames: options.accountNames });
}

function periodStart(period, now) {
  if (period === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "7d") start.setDate(start.getDate() - 6);
  if (period === "30d") start.setDate(start.getDate() - 29);
  return start.getTime();
}

export { PERIODS };

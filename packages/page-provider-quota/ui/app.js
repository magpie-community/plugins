const base = new URL(".", document.currentScript.src);
const pageKey = document.querySelector('meta[name="page-key"]').content;
const elements = Object.fromEntries(
  ["refresh", "status", "accounts", "accounts-count", "empty", "api-section", "api-accounts", "api-count",
    "provider-filters", "other-section", "other-accounts", "other-count"]
    .map((id) => [id, document.getElementById(id)]),
);
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme")
  ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
let loading = false;
let selectedProvider = "";
let currentReport;

const channels = {
  codex: "Codex",
  chatgpt: "ChatGPT",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  claude: "Claude",
  kiro: "Kiro",
  copilot: "Copilot",
  "github-copilot": "GitHub Copilot",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  kimi: "Kimi",
  siliconflow: "SiliconFlow",
  zhipu: "智谱",
  glm: "智谱 GLM",
  qwen: "通义千问",
  dashscope: "阿里百炼",
  volcengine: "火山引擎",
  doubao: "豆包",
  minimax: "MiniMax",
  gemini: "Gemini",
  google: "Google",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function channelName(provider) {
  return channels[provider] ?? provider;
}

function hue(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function level(value) {
  return value === null ? "unknown" : value <= 5 ? "danger" : value <= 20 ? "warning" : "";
}

function percentage(value) {
  return value === null ? "—" : `${Number(value.toFixed(1))}%`;
}

function dateTime(value) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ago(value) {
  const minutes = Math.floor((Date.now() - value) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return dateTime(value);
}

function resetHint(resetsAt) {
  if (resetsAt === null) return "重置时间未知";
  const minutes = Math.ceil((resetsAt - Date.now()) / 60000);
  if (minutes <= 0) return "已过重置时间，待更新";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`;
  return `${dateTime(resetsAt)} 重置`;
}

function readingTitle(account) {
  if (account.error) return account.error;
  return account.readAt === null ? "更新时间未知" : `更新于 ${new Date(account.readAt).toLocaleString("zh-CN")}`;
}

function bar(value) {
  const track = node("div", `bar ${level(value)}`);
  const fill = node("i");
  fill.style.width = `${value ?? 0}%`;
  track.append(fill);
  return track;
}

function value(text, className = "") {
  const element = node("dd", `value ${className}`);
  const match = /^(.*\d)%$/.exec(text);
  if (match) element.append(match[1], node("span", "unit", "%"));
  else element.textContent = text;
  return element;
}

function cardBase(account, tags) {
  const name = account.user && account.user !== "未命名账号" ? account.user
    : account.name === account.provider ? channelName(account.provider) : account.name || account.user;
  const stale = account.error || account.readAt === null || Date.now() - account.readAt > 300000;
  const card = node("article", stale ? "card stale" : "card");
  card.style.setProperty("--channel-hue", hue(account.provider || name));

  const head = node("header", "card-head");
  const identity = node("div", "identity");
  const title = node("h3", "account-name", name);
  title.title = name;
  const tagList = node("div", "tags");
  for (const [className, text, hint] of tags) {
    if (!text) continue;
    const tag = node("span", `tag ${className}`, text);
    if (hint) tag.title = hint;
    tagList.append(tag);
  }
  identity.append(title);

  const freshness = node("span", "freshness");
  freshness.title = readingTitle(account);
  if (account.error) {
    freshness.classList.add("error");
    freshness.textContent = "读取失败";
  } else if (account.readAt === null) {
    freshness.classList.add("unknown");
    freshness.textContent = "时间未知";
  } else {
    if (stale) freshness.classList.add("stale");
    freshness.textContent = ago(account.readAt);
  }
  head.append(identity, freshness);
  card.append(head, tagList);
  return card;
}

function appendError(card, account) {
  if (!account.error) return;
  const error = node("p", "card-error", account.error);
  error.title = account.error;
  card.append(error);
}

function quotaCard(account) {
  const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "";
  const kind = account.kind === "plan" ? "密钥套餐" : account.kind === "unknown" ? "类型待确认" : "订阅";
  const tags = [
    ["channel", channelName(account.provider)], [account.kind === "unknown" ? "unclassified" : "type", kind], ["plan", plan],
  ];
  if (account.kind === "subscription" || account.kind === "plan") {
    const until = account.until === null || account.until === undefined ? null : new Date(account.until);
    tags.push([
      "expiry",
      until ? `到期 ${until.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}` : "到期 未提供",
      until ? `当前付费周期结束时间：${until.toLocaleString("zh-CN")}` : "供应商未提供订阅到期时间，额度重置时间不代表订阅到期时间",
    ]);
  }
  tags.push(["", account.from]);
  const card = cardBase(account, tags);
  const metrics = node("dl", "metrics");
  for (const window of account.windows) {
    if (/^image[\s_-]*generation$/i.test(window.name.trim())) continue;
    const remaining = window.remaining;
    const windowName = window.name.trim().toLowerCase();
    const label = ["5h", "5 hours", "5 hour", "5-hour limit"].includes(windowName) ? "5h剩余额度"
      : ["weekly", "week", "7d", "7 days"].includes(windowName) ? "周限剩余额度" : window.name || "额度";
    let display = percentage(remaining);
    if (window.unlimited) display = "不限量";
    else if (window.text) display = window.display || "暂无读数";
    else if (window.balance !== null) display = formatAmount(window.balance, window.unit);
    else if (remaining === null && window.display) display = window.display;
    else if (remaining === null && window.amount !== null) display = formatAmount(window.amount, window.unit);
    const metric = node("div", "metric");
    const heading = node("dt", "", label);
    heading.title = window.name || label;
    metric.append(heading, value(display, window.unlimited || window.text ? "text-value" : level(remaining)));
    if (remaining !== null) metric.append(bar(remaining));
    if (!window.unlimited && !window.text && window.limit > 0 && window.amount !== null) {
      metric.append(node("div", "hint", `剩余 ${formatAmount(Math.max(0, window.limit - window.amount), window.unit)} / ${formatAmount(window.limit, window.unit)}`));
    } else if (window.display && window.display !== display) {
      metric.append(node("div", "hint", window.display));
    } else if (!window.text && remaining === null && window.amount !== null && window.balance === null) {
      metric.append(node("div", "hint", "已用数量 · 总额度未知"));
    }
    if (!window.text && !window.unlimited) {
      metric.append(node("div", "hint", remaining === null && !window.display && window.balance === null && window.amount === null ? "暂无读数" : resetHint(window.resetsAt)));
    } else if (window.resetsAt !== null) {
      metric.append(node("div", "hint", resetHint(window.resetsAt)));
    }
    metric.title = [window.name, window.display, window.resetsAt === null ? "" : `重置于 ${new Date(window.resetsAt).toLocaleString("zh-CN")}`]
      .filter(Boolean).join(" · ");
    metrics.append(metric);
  }
  if (account.balance) {
    const metric = node("div", "metric");
    metric.append(node("dt", "", "剩余额度"), value(account.balance));
    metrics.append(metric);
  }
  if (metrics.childElementCount) card.append(metrics);
  else card.append(node("p", "no-reading", "暂无额度读数，请在 Magpie 中更新此账号"));
  appendError(card, account);
  return card;
}

function formatAmount(amount, unit) {
  const formatted = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(amount);
  if (unit === "USD" || unit === "$") return `$${formatted}`;
  if (unit === "CNY" || unit === "¥") return `¥${formatted}`;
  return unit ? `${formatted} ${unit}` : formatted;
}

function balanceCard(account) {
  const channel = channelName(account.provider);
  const card = cardBase(account, [
    ["channel", channel.toLowerCase() === account.name.toLowerCase() ? "" : channel],
    ["", "API"],
    ["", account.from],
  ]);
  const metrics = node("dl", "metrics balance-metrics");
  for (const balance of account.balances) {
    const metric = node("div", "metric");
    metric.append(node("dt", "", balance.name), value(balance.display));
    if (balance.remaining !== null) {
      metric.append(bar(balance.remaining), node("div", "hint", `剩余 ${percentage(balance.remaining)}`));
    }
    metrics.append(metric);
  }
  if (metrics.childElementCount) card.append(metrics);
  else card.append(node("p", "no-reading", "暂无余额读数，请在 Magpie 中更新此供应商"));
  appendError(card, account);
  return card;
}

function setStatus(text, className, title = "") {
  elements.status.textContent = text;
  elements.status.className = `status ${className}`;
  elements.status.title = title;
}

function renderAccounts() {
  const matches = (account) => !selectedProvider || account.provider === selectedProvider;
  const accounts = currentReport.accounts.filter(matches);
  const apiAccounts = (currentReport.apiAccounts ?? []).filter(matches);
  const otherAccounts = (currentReport.otherAccounts ?? []).filter(matches);
  elements.accounts.replaceChildren(...accounts.map(quotaCard));
  elements.empty.hidden = accounts.length > 0;
  elements.empty.querySelector("strong").textContent = selectedProvider ? "此渠道暂无订阅或套餐读数" : "暂无订阅或套餐读数";
  elements["accounts-count"].textContent = accounts.length || "";
  elements["api-section"].hidden = apiAccounts.length === 0;
  elements["api-accounts"].replaceChildren(...apiAccounts.map(balanceCard));
  elements["api-count"].textContent = apiAccounts.length || "";
  elements["other-section"].hidden = otherAccounts.length === 0;
  elements["other-accounts"].replaceChildren(...otherAccounts.map(quotaCard));
  elements["other-count"].textContent = otherAccounts.length || "";
}

function renderFilters(report) {
  const counts = new Map();
  const all = [...report.accounts, ...(report.apiAccounts ?? []), ...(report.otherAccounts ?? [])];
  for (const account of all) counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
  if (!counts.has(selectedProvider)) selectedProvider = "";
  const options = [["", all.length], ...[...counts].sort(([first], [second]) => channelName(first).localeCompare(channelName(second)))];
  elements["provider-filters"].replaceChildren(...options.map(([provider, count]) => {
    const button = node("button", "provider-filter", provider ? channelName(provider) : "全部渠道");
    button.type = "button";
    button.setAttribute("aria-pressed", String(provider === selectedProvider));
    button.append(node("span", "", String(count)));
    button.addEventListener("click", () => {
      selectedProvider = provider;
      renderFilters(currentReport);
      renderAccounts();
    });
    return button;
  }));
}

function render(report) {
  currentReport = report;
  renderFilters(report);
  renderAccounts();
  const time = new Date(report.generatedAt ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (report.source === "snapshot") setStatus(`本地快照 · ${time}`, "warn", report.warning || "网关不可用，显示 Magpie 保存的额度快照");
  else setStatus(`Magpie 网关 · ${time}`, "live", "每 60 秒自动读取，页面不可见时暂停");
}

async function refresh(force = false) {
  if (loading) return;
  loading = true;
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-label", "正在刷新");
  try {
    const url = new URL("api/report", base);
    if (force) url.searchParams.set("refresh", "1");
    const response = await fetch(url, {
      headers: { "x-provider-quota-key": pageKey },
      signal: AbortSignal.timeout(15000),
    });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error || `HTTP ${response.status}`);
    render(report);
  } catch (error) {
    setStatus("更新失败", "error", error.message);
  } finally {
    loading = false;
    elements.refresh.disabled = false;
    elements.refresh.setAttribute("aria-label", "刷新额度");
  }
}

elements.refresh.addEventListener("click", () => refresh(true));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 60000);
refresh();

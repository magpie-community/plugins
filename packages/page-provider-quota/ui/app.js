const base = new URL(".", document.currentScript.src);
const pageKey = document.querySelector('meta[name="page-key"]').content;
const elements = Object.fromEntries(
  ["refresh", "status", "overview", "accounts", "accounts-count", "empty", "api-section", "api-accounts", "api-count",
    "provider-filters", "other-section", "other-accounts", "other-count", "toast",
    "reset-dialog", "reset-who", "reset-text", "reset-remote", "reset-cards", "reset-which", "reset-idle",
    "reset-key", "reset-key-input", "reset-error", "reset-cancel", "reset-confirm"]
    .map((id) => [id, document.getElementById(id)]),
);
let loading = false;
let selectedProvider = "";
let currentReport;

// ---- 主题：跟随 Magpie 窗口（明暗、强调色、字体），单独运行时跟随系统 ----

const themeTokens = ["bg", "card", "fg", "fg-2", "muted", "faint", "line", "accent", "accent-soft", "accent-fg",
  "green", "red", "amber", "font", "code"];
const query = new URLSearchParams(location.search);
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let hostTheme = query.get("theme");

function applyTheme(dark, tokens) {
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  if (!tokens || typeof tokens !== "object") return;
  for (const name of themeTokens) {
    const value = String(tokens[name] ?? "").trim();
    // 令牌来自 Magpie 窗口，只接受普通的颜色与字体取值
    if (value && value.length < 300 && !/[;{}<>]|url\(/i.test(value)) root.style.setProperty(`--magpie-${name}`, value);
    else root.style.removeProperty(`--magpie-${name}`);
  }
}

function initialTokens() {
  try {
    const encoded = query.get("tokens");
    return encoded ? JSON.parse(decodeURIComponent(escape(atob(encoded)))) : null;
  } catch {
    return null;
  }
}

applyTheme(hostTheme ? hostTheme === "dark" : systemDark.matches, initialTokens());
systemDark.addEventListener?.("change", (event) => {
  if (!hostTheme) applyTheme(event.matches);
});
// 本页面由 Magpie 的插件框架导航而来，窗口仍会向此框架推送主题与可见性变化
addEventListener("message", (event) => {
  if (event.source !== parent || parent === window) return;
  const message = event.data;
  if (!message || message.magpie !== 1) return;
  if (message.event === "theme" && message.data) {
    hostTheme = message.data.dark ? "dark" : "light";
    applyTheme(Boolean(message.data.dark), message.data.tokens);
  } else if (message.event === "visibility" && message.data?.visible) {
    refresh();
  }
});

// ---- 渠道 ----

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

const icons = {
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 15h2"/>',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(key, value);
  // 图标为本文件内的常量
  svg.innerHTML = icons[name];
  return svg;
}

function channelName(provider) {
  if (channels[provider]) return channels[provider];
  const remote = /^([^/]+)\/(.+)$/.exec(provider);
  return remote ? channels[remote[2]] ?? remote[2] : provider;
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

function fullTime(value) {
  return new Date(value).toLocaleString("zh-CN");
}

function ago(value) {
  const minutes = Math.floor((Date.now() - value) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return dateTime(value);
}

function duration(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${days} 天${hours ? ` ${hours} 小时` : ""}`;
}

function resetHint(resetsAt) {
  if (resetsAt === null) return "重置时间未知";
  const minutes = Math.ceil((resetsAt - Date.now()) / 60000);
  if (minutes <= 0) return "已过重置时间，待更新";
  if (minutes < 1440) return `${duration(minutes)}后重置`;
  return `${dateTime(resetsAt)} 重置`;
}

function readingTitle(account) {
  if (account.error) return account.error;
  return account.readAt === null ? "更新时间未知" : `更新于 ${fullTime(account.readAt)}`;
}

function accountTitle(account) {
  return account.user && account.user !== "未命名账号" ? account.user
    : account.name === account.provider ? channelName(account.provider) : account.name || account.user;
}

function bar(value) {
  const track = node("div", `bar ${level(value)}`);
  track.setAttribute("role", "meter");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  if (value !== null) track.setAttribute("aria-valuenow", String(Math.round(value)));
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

function levelBadge(remaining) {
  const kind = level(remaining);
  if (kind === "danger") return node("span", "level danger", remaining <= 0 ? "已用尽" : "即将用尽");
  if (kind === "warning") return node("span", "level warning", "偏低");
  return null;
}

function cardBase(account, tags) {
  const name = accountTitle(account);
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
  identity.append(title, tagList);

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
  card.append(head);
  return card;
}

function appendError(card, account) {
  if (!account.error) return;
  const error = node("p", "card-error", account.error);
  error.title = account.error;
  card.append(error);
}

// ---- 重置卡 ----

function resetCardName(card, index) {
  if (card.window === "fiveHour") return "5 小时重置卡";
  if (card.window === "weekly") return "周限重置卡";
  return `重置卡 ${index + 1}`;
}

function resetCardWhen(card) {
  return card.until === null ? "长期有效" : `${dateTime(card.until)} 过期`;
}

function resetsTitle(resets) {
  if (resets.each.length) {
    return resets.each.map((card, index) => `${resetCardName(card, index)} · ${card.until === null ? "长期有效" : `${fullTime(card.until)} 过期`}`).join("\n");
  }
  return resets.until === null ? "" : `最早一张 ${fullTime(resets.until)} 过期`;
}

function resetsUsedText(account) {
  const last = account.resetsUsed[0];
  if (!last) return "";
  const why = last.why === "week" ? "周限用尽时自动使用" : last.why === "expiring" ? "过期前自动使用" : "手动使用";
  return `上次使用：${dateTime(last.at)} · ${why}`;
}

function resetsBlock(account) {
  const resets = account.resets;
  if (!resets?.count) return null;
  const block = node("div", account.resetTarget ? "resets" : "resets window-only");
  const iconBox = node("span", "resets-icon");
  iconBox.append(icon("reset", 15));
  const text = node("div", "resets-text");
  let count = `${resets.count} 张重置卡`;
  if (resets.byWindow) {
    count = [resets.fiveHour && `${resets.fiveHour} 张 5 小时重置`, resets.weekly && `${resets.weekly} 张周限重置`]
      .filter(Boolean).join(" · ") || count;
  }
  text.append(node("span", "resets-count", count));
  const subParts = [];
  const soon = resets.until !== null && resets.until - Date.now() < 3 * 86400000;
  if (resets.until !== null) {
    const minutes = Math.ceil((resets.until - Date.now()) / 60000);
    subParts.push(minutes > 0 && minutes < 1440 * 3 ? `最早一张 ${duration(minutes)}后过期` : `最早一张 ${dateTime(resets.until)} 过期`);
  } else if (resets.each.length) {
    subParts.push("长期有效");
  }
  if (resets.byWindow) subParts.push(resets.team ? "团队套餐，在供应商网站使用" : "在供应商网站使用");
  else if (!account.resetTarget) subParts.push("需在供应商处使用");
  const used = resetsUsedText(account);
  const sub = node("span", soon ? "resets-sub soon" : "resets-sub", subParts.join(" · ") || used || "可立即重置全部额度窗口");
  text.append(sub);
  text.title = [resetsTitle(resets), used].filter(Boolean).join("\n");
  block.append(iconBox, text);
  if (account.resetTarget) {
    const use = node("button", "button primary", "使用");
    use.type = "button";
    use.title = "立即重置此账号的额度窗口，使用前会再次确认";
    use.setAttribute("aria-label", `为 ${accountTitle(account)} 使用重置卡`);
    use.addEventListener("click", () => openResetDialog(account));
    block.append(use);
  }
  return block;
}

const resetDialog = { account: null, chosen: "" };

function openResetDialog(account) {
  const resets = account.resets;
  const name = accountTitle(account);
  resetDialog.account = account;
  resetDialog.chosen = "";
  elements["reset-who"].textContent = `${name} · ${channelName(account.provider)}`;
  elements["reset-text"].textContent = `该账号有 ${resets.count} 张重置卡。使用一张后，当前所有额度窗口会立即重新开始，如同从未使用过。此操作无法撤销。`;
  const remote = account.resetTarget.provider;
  elements["reset-remote"].hidden = !remote;
  elements["reset-remote"].textContent = remote ? `该账号登录在远端 Magpie「${account.from}」上，重置卡将由那台电脑上的 Magpie 使用。` : "";

  const cards = resets.each.length > 1 && resets.each.every((card) => card.id) ? resets.each : [];
  elements["reset-cards"].hidden = !cards.length;
  elements["reset-cards"].replaceChildren(...cards.map((card, index) => {
    const option = node("button", "reset-card");
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(index === 0));
    option.dataset.credit = index === 0 ? "" : card.id;
    option.append(node("span", "radio"), node("span", "card-name", index === 0 ? `${resetCardName(card, index)}（默认）` : resetCardName(card, index)),
      node("span", "card-when", resetCardWhen(card)));
    option.title = card.until === null ? "长期有效" : `${fullTime(card.until)} 过期`;
    option.addEventListener("click", () => {
      resetDialog.chosen = option.dataset.credit;
      for (const other of elements["reset-cards"].children) other.setAttribute("aria-checked", String(other === option));
      describeChoice(cards);
    });
    return option;
  }));
  describeChoice(cards);

  const used = account.windows.some((window) => window.remaining !== null && window.remaining < 100);
  const known = account.windows.some((window) => window.remaining !== null);
  elements["reset-idle"].hidden = !known || used;
  elements["reset-key"].hidden = Boolean(currentReport?.canReset);
  elements["reset-key-input"].value = "";
  setResetError("");
  setResetBusy(false);
  elements["reset-dialog"].showModal();
  (elements["reset-key"].hidden ? elements["reset-confirm"] : elements["reset-key-input"]).focus();
}

function describeChoice(cards) {
  const which = elements["reset-which"];
  const resets = resetDialog.account.resets;
  if (!resetDialog.chosen) {
    which.hidden = resets.until === null;
    which.textContent = resets.until === null ? "" : `默认使用最早过期的一张（${fullTime(resets.until)}）。`;
    return;
  }
  const card = cards.find((candidate) => candidate.id === resetDialog.chosen);
  const first = cards[0];
  which.hidden = false;
  which.textContent = `将使用 ${card.until === null ? "长期有效的一张" : `${fullTime(card.until)} 过期的一张`}`
    + (first.until !== null && first.until !== card.until ? `；最早的一张（${fullTime(first.until)} 过期）会保留，过期未用即作废。` : "。");
}

function setResetError(message) {
  elements["reset-error"].hidden = !message;
  elements["reset-error"].textContent = message;
}

function setResetBusy(busy) {
  elements["reset-confirm"].disabled = busy;
  elements["reset-confirm"].classList.toggle("busy", busy);
  elements["reset-confirm"].textContent = busy ? "正在使用" : "确认使用";
  elements["reset-cancel"].disabled = busy;
}

function resetOutcome(outcome) {
  switch (outcome.code) {
    case "reset": return outcome.windows ? `已重置 ${outcome.windows} 个额度窗口` : "已重置额度窗口";
    case "nothing_to_reset": return "额度窗口尚未使用，无需重置，重置卡已保留";
    case "no_credit": return "该账号已没有可用的重置卡";
    case "already_redeemed":
    case "already_used": return "这张重置卡已被使用";
    case "not_limited": return "额度窗口尚未用尽，重置卡已保留";
    case "cooldown": return "刚刚使用过重置卡，请稍后再试";
    case "ineligible": return "该账号无法使用重置卡";
    case "unavailable": return "暂时无法使用重置卡，请稍后再试";
  }
  return outcome.code || "已提交";
}

function remoteResetError(message) {
  if (/read-only on the remote magpie/.test(message)) return "该密钥在远端 Magpie 上是只读的，请为此供应商配置完全访问权限的密钥";
  if (/didn't say in time whether the reset was used/.test(message)) return "远端未及时回复是否已使用，可能已经使用，请先刷新再重试";
  if (/^remote magpie doesn't share its quotas/.test(message)) return "远端 Magpie 版本过旧，暂不支持从此处使用重置卡";
  if (/^remote magpie isn't shared/.test(message)) return "远端 Magpie 未开启局域网共享";
  if (/^couldn't reach the remote magpie/.test(message)) return "无法连接远端 Magpie，请确认其正在运行";
  if (/full access|gateway key/i.test(message)) return "需要一个已启用、完全访问权限的 Magpie 网关密钥";
  return message;
}

async function confirmReset() {
  const account = resetDialog.account;
  if (!account) return;
  const key = elements["reset-key-input"].value.trim();
  if (!elements["reset-key"].hidden && !key) {
    setResetError("请先填写 Magpie 网关密钥");
    elements["reset-key-input"].focus();
    return;
  }
  setResetError("");
  setResetBusy(true);
  try {
    const response = await fetch(new URL("api/reset", base), {
      method: "POST",
      headers: { "x-provider-quota-key": pageKey, "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, credit: resetDialog.chosen, ...(key ? { key } : {}) }),
      signal: AbortSignal.timeout(80000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.code === "needs_key" || body.code === "bad_key") {
        elements["reset-key"].hidden = false;
        if (currentReport) currentReport.canReset = false;
        elements["reset-key-input"].focus();
      }
      throw new Error(remoteResetError(body.error || `HTTP ${response.status}`));
    }
    elements["reset-dialog"].close();
    showToast(`${accountTitle(account)}：${resetOutcome(body)}`, body.code === "reset" ? "" : "error");
    if (body.report) render(body.report);
    else refresh(true);
  } catch (error) {
    setResetError(error.name === "TimeoutError" ? "等待超时，重置卡可能已被使用，请刷新后确认" : error.message);
  } finally {
    setResetBusy(false);
  }
}

elements["reset-confirm"].addEventListener("click", confirmReset);
elements["reset-cancel"].addEventListener("click", () => elements["reset-dialog"].close());
elements["reset-key-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmReset();
});
elements["reset-dialog"].addEventListener("cancel", (event) => {
  if (elements["reset-confirm"].disabled) event.preventDefault();
});
elements["reset-dialog"].addEventListener("click", (event) => {
  if (event.target === elements["reset-dialog"] && !elements["reset-confirm"].disabled) elements["reset-dialog"].close();
});

let toastTimer;
function showToast(message, className = "") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${className}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

// ---- 卡片 ----

function quotaCard(account) {
  const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "";
  const kind = account.kind === "plan" ? "密钥套餐" : account.kind === "unknown" ? "类型待确认" : "订阅";
  const tags = [
    ["channel", channelName(account.provider)], [account.kind === "unknown" ? "unclassified" : "type", kind], ["plan", plan],
  ];
  if (account.kind === "subscription" || account.kind === "plan") {
    const until = account.until === null || account.until === undefined ? null : new Date(account.until);
    const soon = until && until - Date.now() < 7 * 86400000;
    tags.push([
      soon ? "expiry soon" : "expiry",
      until ? `到期 ${until.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}` : "到期 未提供",
      until ? `当前付费周期结束时间：${until.toLocaleString("zh-CN")}` : "供应商未提供订阅到期时间，额度重置时间不代表订阅到期时间",
    ]);
  }
  tags.push(["remote", account.from, account.from ? `来自远端 Magpie：${account.from}` : ""]);
  const card = cardBase(account, tags);
  const metrics = node("dl", "metrics");
  for (const window of account.windows) {
    if (/^image[\s_-]*generation$/i.test(window.name.trim())) continue;
    const remaining = window.remaining;
    const windowName = window.name.trim().toLowerCase();
    const label = window.kind === "fiveHour" || ["5h", "5 hours", "5 hour", "5-hour limit"].includes(windowName) ? "5 小时剩余"
      : window.kind === "weekly" && ["weekly", "week", "7d", "7 days"].includes(windowName) ? "本周剩余" : window.name || "额度";
    let display = percentage(remaining);
    if (window.unlimited) display = "不限量";
    else if (window.text) display = window.display || "暂无读数";
    else if (window.balance !== null) display = formatAmount(window.balance, window.unit);
    else if (remaining === null && window.display) display = window.display;
    else if (remaining === null && window.amount !== null) display = formatAmount(window.amount, window.unit);
    const metric = node("div", "metric");
    const heading = node("dt", "", label);
    heading.title = window.name || label;
    const badge = window.unlimited || window.text ? null : levelBadge(remaining);
    if (badge) heading.append(badge);
    metric.append(heading, value(display, window.unlimited || window.text ? "text-value" : remaining === null ? "unknown" : ""));
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
    metric.title = [window.name, window.display, window.resetsAt === null ? "" : `重置于 ${fullTime(window.resetsAt)}`]
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
  const resets = resetsBlock(account);
  if (resets) card.append(resets);
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
    ["remote", account.from, account.from ? `来自远端 Magpie：${account.from}` : ""],
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

// ---- 概览 ----

function stat(iconName, label, main, unit, sub, className = "") {
  const tile = node("div", `stat ${className}`);
  const head = node("span", "stat-label");
  head.append(icon(iconName, 13), label);
  const figure = node("span", "stat-value", main);
  if (unit) figure.append(node("small", "", unit));
  tile.append(head, figure, node("span", "stat-sub", sub));
  return tile;
}

function renderOverview(report) {
  const accounts = [...report.accounts, ...(report.otherAccounts ?? [])];
  const apiAccounts = report.apiAccounts ?? [];
  if (!accounts.length && !apiAccounts.length) {
    elements.overview.replaceChildren();
    return;
  }
  const windows = accounts.flatMap((account) => account.windows.filter((window) => window.remaining !== null && !window.unlimited && !window.text));
  const low = windows.filter((window) => window.remaining <= 20);
  const empty = windows.filter((window) => window.remaining <= 5);
  const average = windows.length ? windows.reduce((sum, window) => sum + window.remaining, 0) / windows.length : null;
  const withResets = accounts.filter((account) => account.resets?.count);
  const resetCount = withResets.reduce((sum, account) => sum + account.resets.count, 0);
  const soonest = withResets.map((account) => account.resets.until).filter((until) => until !== null).sort((a, b) => a - b)[0];
  const errors = [...accounts, ...apiAccounts].filter((account) => account.error).length;

  elements.overview.replaceChildren(
    stat("accounts", "已接入账号", String(accounts.length + apiAccounts.length), "个",
      `${accounts.length} 个订阅与套餐 · ${apiAccounts.length} 个 API`, errors ? "danger" : "accent"),
    stat("gauge", "平均剩余", average === null ? "—" : String(Math.round(average)), average === null ? "" : "%",
      windows.length ? `覆盖 ${windows.length} 个额度窗口` : "暂无百分比读数", average !== null && average <= 20 ? "warning" : "good"),
    stat("alert", "额度偏低", String(low.length), "个窗口",
      low.length ? `${empty.length} 个已用尽或即将用尽` : "所有窗口余量充足", empty.length ? "danger" : low.length ? "warning" : "good"),
    stat("reset", "重置卡", String(resetCount), "张",
      resetCount ? soonest ? `最早 ${dateTime(soonest)} 过期` : `${withResets.length} 个账号持有` : "暂无可用重置卡",
      resetCount ? "accent" : ""),
  );
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
  elements.accounts.removeAttribute("aria-busy");
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
  if (counts.size < 2) {
    elements["provider-filters"].replaceChildren();
    return;
  }
  const options = [["", all.length], ...[...counts].sort(([first], [second]) => channelName(first).localeCompare(channelName(second)))];
  elements["provider-filters"].replaceChildren(...options.map(([provider, count]) => {
    const button = node("button", "provider-filter");
    button.type = "button";
    if (provider) {
      button.style.setProperty("--channel-hue", hue(provider));
      button.append(node("i"));
    }
    button.append(provider ? channelName(provider) : "全部", node("span", "", String(count)));
    button.setAttribute("aria-pressed", String(provider === selectedProvider));
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
  renderOverview(report);
  renderFilters(report);
  renderAccounts();
  const time = new Date(report.generatedAt ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (report.source === "snapshot") setStatus(`本地快照 · ${time}`, "warn", report.warning || "网关不可用，显示 Magpie 保存的额度快照");
  else setStatus(`Magpie 网关 · ${time}`, "live", "每 60 秒自动读取，页面不可见时暂停");
}

async function refresh(force = false) {
  if (loading || elements["reset-dialog"].open) return;
  loading = true;
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-label", "正在刷新");
  try {
    const url = new URL("api/report", base);
    if (force) url.searchParams.set("refresh", "1");
    const response = await fetch(url, {
      headers: { "x-provider-quota-key": pageKey },
      signal: AbortSignal.timeout(force ? 50000 : 15000),
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

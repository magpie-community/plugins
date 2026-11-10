// 页面逻辑：读 api/report，渲染按模型汇总的剩余 token。
const query = new URLSearchParams(location.search);
const theme = query.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

const KEY = document.querySelector('meta[name="magpie-quota-key"]')?.content || "";
const expanded = new Set();

const words = {
  en: {
    heading: "Model quota",
    sub: "Every quota window of every account and provider, turned into tokens and merged by model",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    connecting: "Connecting to the service…",
    total: "Tokens left",
    totalNote: (n) => `${n} models`,
    models: "Models",
    modelsNote: "with a quota window to estimate from",
    pools: "Quota windows",
    poolsNote: "counted once each",
    model: "Model",
    tokens: "Tokens left",
    share: "Share",
    daily: "Daily use",
    lasts: "Lasts",
    poolCount: "Windows",
    windows: "Quota windows",
    window: "Window",
    remaining: "Left",
    tpp: "Per 1%",
    poolTokens: "Tokens left",
    roundDrop: "Used this round",
    roundCalls: "Records",
    reset: "Resets",
    detailWindow: "Quota window",
    detailPart: "To this model",
    detailShare: "Its share",
    detailPool: "Window left",
    unassigned: "(no model split)",
    emptyModels: "No quota window can be estimated yet. Let magpie record some usage, or wait until a window has a few readings.",
    emptyPools: "No quota window can be estimated yet.",
    exhausted: (w) => `Exhausted (${w})`,
    historical: "(from past rounds)",
    hoursUnit: "h",
    daysUnit: "d",
    over: "> 1000 d",
    updated: (t) => `Updated ${t}`,
    failed: (m) => `Failed to load: ${m}`,
    note:
      "Tokens are input + output + cache reads + cache writes + reasoning. A window's tokens per 1% come from its own history: the tokens an account spent over a drop in its remaining percentage. Tokens left = remaining percentage × that, split by each model's share inside the window.",
    noteSkipped: (parts) => ` Not counted: ${parts.join("; ")}.`,
    noteFile: " Current quota came from the local snapshot; the gateway did not answer.",
    noteSource: "Source: magpie's usage.jsonl and quota-history.json; current quota from the gateway's /v1/magpie/quotas.",
    blocked: (n) => `${n} windows are exhausted, so their accounts are left out`,
    lowConfidence: (n) => `${n} windows have few records and are estimated from past rounds`,
    noHistory: (n) => `${n} windows have no readings yet`,
    noUsage: (n) => `${n} windows have no usage to line up with`,
  },
  zh: {
    heading: "模型剩余额度",
    sub: "把所有账号、所有供应商的额度窗口换算成 token，按模型合并",
    refresh: "刷新",
    refreshing: "刷新中…",
    connecting: "正在连接服务…",
    total: "合计剩余",
    totalNote: (n) => `覆盖 ${n} 个模型`,
    models: "覆盖模型",
    modelsNote: "有可估算额度窗口的模型",
    pools: "覆盖额度池",
    poolsNote: "每个窗口只计一次",
    model: "模型",
    tokens: "剩余 token",
    share: "占比",
    daily: "日均消耗",
    lasts: "预计可用",
    poolCount: "池数",
    windows: "额度窗口",
    window: "窗口",
    remaining: "剩余",
    tpp: "每 1% 约合",
    poolTokens: "剩余 token",
    roundDrop: "本轮已用",
    roundCalls: "本轮记录",
    reset: "重置",
    detailWindow: "额度窗口",
    detailPart: "摊到本模型",
    detailShare: "本模型占比",
    detailPool: "窗口剩余",
    unassigned: "（未分模型）",
    emptyModels: "还没有可估算的额度窗口。先让 magpie 记录一些用量，或等额度读数攒够几个点。",
    emptyPools: "没有可估算的额度窗口。",
    exhausted: (w) => `已用完（${w}）`,
    historical: "（按历史轮次估）",
    hoursUnit: "小时",
    daysUnit: "天",
    over: "> 1000 天",
    updated: (t) => `更新于 ${t}`,
    failed: (m) => `加载失败：${m}`,
    note:
      "口径：token = 输入 + 输出 + 缓存读 + 缓存写 + 推理。每个窗口的“每 1% 值多少 token”由它自己的历史推得：账号在剩余百分比下降期间消耗的 token 除以掉掉的百分比。剩余 token = 剩余百分比 × 该值，再按窗口内各模型的占比摊开。",
    noteSkipped: (parts) => ` 未计入：${parts.join("；")}。`,
    noteFile: " 当前额度取自本地快照，网关没有应答。",
    noteSource: "数据源：magpie 的 usage.jsonl 与 quota-history.json；当前额度来自网关的 /v1/magpie/quotas。",
    blocked: (n) => `${n} 个窗口已用完，所在账号不计入`,
    lowConfidence: (n) => `${n} 个窗口记录不足，按历史轮次估算`,
    noHistory: (n) => `${n} 个窗口还没有读数`,
    noUsage: (n) => `${n} 个窗口没有可对齐的用量记录`,
  },
};

const lang = String(query.get("lang") || navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
const t = words[lang];
const locale = lang === "zh" ? "zh-CN" : "en-US";

const $ = (id) => document.getElementById(id);

function fmtTokens(n) {
  if (!Number.isFinite(n)) return "—";
  if (lang === "zh") {
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return Math.round(n).toLocaleString(locale);
  }
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toLocaleString(locale);
}

function fmtDays(d) {
  if (d == null || !Number.isFinite(d)) return "—";
  if (d < 1) return (d * 24).toFixed(1) + " " + t.hoursUnit;
  if (d < 1000) return d.toFixed(1) + " " + t.daysUnit;
  return t.over;
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(locale, { hour12: false });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function labels() {
  $("heading").textContent = t.heading;
  $("subheading").textContent = t.sub;
  $("refresh").textContent = t.refresh;
  $("label-total").textContent = t.total;
  $("label-models").textContent = t.models;
  $("note-models").textContent = t.modelsNote;
  $("label-pools").textContent = t.pools;
  $("pool-note").textContent = t.poolsNote;
  $("th-model").textContent = t.model;
  $("th-tokens").textContent = t.tokens;
  $("th-share").textContent = t.share;
  $("th-daily").textContent = t.daily;
  $("th-days").textContent = t.lasts;
  $("th-pools").textContent = t.poolCount;
  $("pool-title").textContent = t.windows;
  $("th-window").textContent = t.window;
  $("th-remaining").textContent = t.remaining;
  $("th-tpp").textContent = t.tpp;
  $("th-pool-tokens").textContent = t.poolTokens;
  $("th-round-drop").textContent = t.roundDrop;
  $("th-round-calls").textContent = t.roundCalls;
  $("th-reset").textContent = t.reset;
  document.title = t.heading;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

function render(report) {
  $("total").textContent = fmtTokens(report.totalTokens);
  $("total-note").textContent = t.totalNote(report.models.length);
  $("modelCount").textContent = String(report.models.length);
  $("poolCount").textContent = String(report.pools.length);
  $("stamp").textContent = t.updated(new Date(report.generatedAt).toLocaleTimeString(locale, { hour12: false }));

  const tbody = $("rows");
  tbody.innerHTML = "";
  const total = report.totalTokens || 1;

  const empty = $("empty");
  empty.hidden = report.models.length > 0;
  if (!report.models.length) empty.textContent = t.emptyModels;

  for (const model of report.models) {
    const row = el("tr", "model-row");
    row.dataset.id = model.id;

    const cell = el("td", "col-model");
    const name = el("div", "model-name");
    name.appendChild(el("span", "dot"));
    name.appendChild(el("span", "nm", model.name || model.id || t.unassigned));
    cell.appendChild(name);
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = Math.max(1, Math.min(100, (model.tokens / total) * 100)) + "%";
    bar.appendChild(fill);
    cell.appendChild(bar);
    row.appendChild(cell);

    row.appendChild(el("td", "num", fmtTokens(model.tokens)));
    row.appendChild(el("td", "num", ((model.tokens / total) * 100).toFixed(1) + "%"));
    row.appendChild(el("td", "num", model.dailyTokens > 0 ? fmtTokens(model.dailyTokens) : "—"));
    const days = el("td", "num", fmtDays(model.days));
    if (model.days != null && model.days < 1) days.classList.add("warn");
    row.appendChild(days);
    row.appendChild(el("td", "num", String((model.pools || []).length)));

    row.addEventListener("click", () => {
      if (expanded.has(model.id)) expanded.delete(model.id);
      else expanded.add(model.id);
      render(report);
    });
    tbody.appendChild(row);

    if (!expanded.has(model.id)) continue;

    const detailRow = el("tr", "detail-row");
    const detailCell = el("td");
    detailCell.colSpan = 6;
    const box = el("div", "detail");
    const table = el("table");
    const head = el("thead");
    const headRow = el("tr");
    headRow.appendChild(el("th", null, t.detailWindow));
    headRow.appendChild(el("th", "num", t.detailPart));
    headRow.appendChild(el("th", "num", t.detailShare));
    headRow.appendChild(el("th", "num", t.detailPool));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    for (const pool of model.pools || []) {
      const detail = el("tr");
      detail.appendChild(el("td", null, pool.pool));
      detail.appendChild(el("td", "num", fmtTokens(pool.tokens)));
      detail.appendChild(el("td", "num", pool.share != null ? (pool.share * 100).toFixed(1) + "%" : "—"));
      detail.appendChild(el("td", "num", fmtTokens(pool.poolTokens)));
      body.appendChild(detail);
    }
    table.appendChild(body);
    box.appendChild(table);
    detailCell.appendChild(box);
    detailRow.appendChild(detailCell);
    tbody.appendChild(detailRow);
  }

  const poolBody = $("poolRows");
  poolBody.innerHTML = "";
  const pools = (report.pools || []).slice().sort((a, b) => b.tokens - a.tokens);
  const poolEmpty = $("poolEmpty");
  poolEmpty.hidden = pools.length > 0;
  if (!pools.length) poolEmpty.textContent = t.emptyPools;

  for (const pool of pools) {
    const row = el("tr");
    row.appendChild(el("td", "col-model", pool.pool));
    row.appendChild(el("td", "num", Number(pool.remaining).toFixed(1) + "%"));
    row.appendChild(el("td", "num", pool.tpp ? fmtTokens(pool.tpp) : "—"));
    const tokens = el("td", "num");
    if (pool.blocked) tokens.textContent = t.exhausted(pool.blockedBy || "");
    else if (pool.lowConfidence) tokens.textContent = fmtTokens(pool.tokens) + t.historical;
    else tokens.textContent = fmtTokens(pool.tokens);
    if (pool.blocked) tokens.classList.add("warn");
    row.appendChild(tokens);
    row.appendChild(el("td", "num", pool.roundDrop != null ? pool.roundDrop.toFixed(0) + "%" : "—"));
    row.appendChild(el("td", "num", pool.roundCalls != null ? String(pool.roundCalls) : "—"));
    row.appendChild(el("td", "num", pool.resetsAt ? fmtTime(pool.resetsAt) : "—"));
    poolBody.appendChild(row);
  }

  const skipped = report.skipped || {};
  const blocked = (report.pools || []).filter((p) => p.blocked).length;
  const lowConfidence = (report.pools || []).filter((p) => p.lowConfidence).length;
  const parts = [];
  if (blocked) parts.push(t.blocked(blocked));
  if (lowConfidence) parts.push(t.lowConfidence(lowConfidence));
  if (skipped.noHistory) parts.push(t.noHistory(skipped.noHistory));
  if (skipped.noUsage) parts.push(t.noUsage(skipped.noUsage));

  const note = $("note");
  note.textContent =
    t.note + (parts.length ? t.noteSkipped(parts) : "") + (report.source === "file" ? t.noteFile : "");
  note.appendChild(document.createElement("br"));
  note.appendChild(el("span", null, t.noteSource));
}

async function load(force, attempt = 0) {
  const button = $("refresh");
  button.disabled = true;
  button.textContent = t.refreshing;
  try {
    const suffix = force ? "?force=1" : "";
    const init = { method: force ? "POST" : "GET", headers: { "x-magpie-quota-key": KEY } };
    // 直接访问时两种写法等价；经 magpie 的 service 代理、页面挂在子路径下时，
    // 只有相对路径会带上代理前缀，所以先用相对路径，404 再退回根路径。
    let res;
    try {
      res = await fetch("api/report" + suffix, init);
      if (res.status === 404) res = await fetch("/api/report" + suffix, init);
    } catch {
      res = await fetch("/api/report" + suffix, init);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || "HTTP " + res.status);
      error.http = true;
      error.status = res.status;
      throw error;
    }
    render(await res.json());
    try {
      sessionStorage.removeItem("mq-reload");
    } catch {
      // 没有 sessionStorage 也不影响。
    }
  } catch (error) {
    // 宿主重启后旧页面手里的口令会失效：换一个地址重新载入，拿新口令。
    if (error.http && error.status === 401) {
      try {
        if (!sessionStorage.getItem("mq-reload")) {
          sessionStorage.setItem("mq-reload", "1");
          const next = new URL(location.href);
          next.searchParams.set("_r", String(Date.now()));
          location.replace(next.href);
          return;
        }
      } catch {
        // 同上。
      }
    }
    // 只有网络错误才重试；HTTP 错误直接显示，避免一直停在“正在连接”。
    if (!error.http && attempt < 20) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (attempt === 0) $("stamp").textContent = t.connecting;
      return load(force, attempt + 1);
    }
    $("stamp").textContent = t.failed(String(error.message || error));
  } finally {
    button.disabled = false;
    button.textContent = t.refresh;
  }
}

labels();
$("refresh").addEventListener("click", () => load(true));
load(false);
setInterval(() => load(false), 60000);
// 切回这个页签时立刻拉一次，避免看到切走之前的旧表。
window.addEventListener("focus", () => load(false));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load(false);
});

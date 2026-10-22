const cards = document.getElementById("cards");
const updated = document.getElementById("updated");
const refresh = document.getElementById("refresh");
const tokenNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const date = n => n ? new Date(n).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未知";
const time = n => n ? new Date(n).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "未知";

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

window.acceptQuotaSnapshot = snapshot => {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.cards)) throw new Error("快照格式不支持");
  const opened = new Set([...cards.querySelectorAll("details[open]")].map(node => node.dataset.account));
  cards.replaceChildren();
  const stale = Date.now() - snapshot.generatedAt > 3 * 60000;
  updated.textContent = stale ? "数据暂未更新" : `更新于 ${time(snapshot.generatedAt)}`;
  document.getElementById("errors").replaceChildren(...snapshot.errors.map(text => element("p", "notice", text)));
  const accounts = new Map();
  for (const card of snapshot.cards) {
    if (!accounts.has(card.title)) accounts.set(card.title, []);
    accounts.get(card.title).push(card);
  }
  for (const [title, windows] of accounts) {
    const section = element("section", "account"), heading = element("div", "account-heading");
    const name = title.includes("Codex") ? "Codex" : title.includes("Claude") ? "Claude Code" : "Remote magpie";
    const scope = title.startsWith("本机") ? "本机" : title.match(/^Remote magpie \d+/)?.[0] || "远端";
    heading.append(element("h2", "", name), element("span", "scope", scope));
    section.append(heading, element("p", "account-id", title.match(/账号 \d+$/)?.[0] || "连接未就绪"));
    const metrics = element("div", "windows"), basis = element("div", "basis");
    for (const card of windows) {
      const window = element("section", "window"), label = card.window === "周" ? "周额度" : card.window;
      const row = element("div", "window-heading");
      row.append(element("span", "", label), element("strong", "", card.used === null ? "未上报" : `已用 ${card.used}%`));
      window.append(row);
      if (card.used !== null) {
        const progress = element("progress");
        progress.max = 100; progress.value = card.used;
        progress.setAttribute("aria-label", `${name} ${scope} ${label}官方已用 ${card.used}%`);
        window.append(progress);
      } else window.append(element("div", "no-window"));
      const available = card.state === "estimated" && !stale;
      window.append(element("p", "metric-label", "用满预估"),
        element("div", `capacity${available ? "" : " unavailable"}`, available ? tokenNumber.format(card.tokens) : "—"));
      const value = element("div", `value-meta${available ? "" : " unavailable"}`);
      value.append(element("span", "unit", "Token"), element("span", "", available ? card.cost === null ? "美元待定" : `≈${money.format(card.cost)}` : "· — USD"));
      window.append(value, element("p", "status", stale ? "数据暂未更新" : available
        ? `${card.confidence}${card.partial ? " · 可能低估" : ""}` : card.reason));
      if (card.end) window.append(element("p", "reset", `重置 ${date(card.end)}`));
      metrics.append(window);
      basis.append(element("h3", "", label));
      if (card.calls) basis.append(element("p", "", `已记录 ${tokenNumber.format(card.observedTokens)} Token · ${money.format(card.observedCost)}${card.unpriced ? " + 未定价部分" : ""} · ${card.calls} 次调用`));
      if (card.nativeCalls) basis.append(element("p", "", `原生 ${card.nativeCalls} 次 · 网关 ${card.calls - card.nativeCalls} 次 · 已去重`));
      if (card.nativeNote) basis.append(element("p", "", card.nativeNote));
      basis.append(element("p", "", card.reason));
      if (card.unpriced) basis.append(element("p", "", `${card.unpriced} 次调用缺少可靠 API 价格，美元满额留空。`));
      basis.append(element("p", "", `额度采样 ${date(card.readAt)}`));
    }
    const details = element("details"), summary = element("summary");
    details.dataset.account = title; details.open = opened.has(title);
    const sampled = Math.max(...windows.map(card => card.readAt || 0));
    summary.append(element("span", "", "估算依据"), element("span", "sample", `额度更新 ${time(sampled)}`));
    details.append(summary, basis);
    section.append(metrics, details);
    cards.append(section);
  }
  if (!snapshot.cards.length) cards.append(element("p", "empty", "尚无可读取的账号"));
  cards.setAttribute("aria-busy", "false");
};

let loading = false;
function readSnapshot() {
  if (loading) return;
  loading = true; refresh.disabled = true;
  const script = document.createElement("script");
  script.src = `snapshot.js?v=${Date.now()}`;
  script.onload = () => { loading = false; refresh.disabled = false; script.remove(); };
  script.onerror = () => {
    loading = false; refresh.disabled = false; script.remove();
    updated.textContent = "暂时无法读取，请稍后刷新";
    cards.setAttribute("aria-busy", "false");
  };
  document.head.append(script);
}
refresh.addEventListener("click", readSnapshot);
readSnapshot();
setInterval(readSnapshot, 30000);

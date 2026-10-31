(() => {
  const V = globalThis.UsageView;
  // A plugin page runs in a sandboxed frame, whose origin is opaque: even
  // reading localStorage throws there. Fall back to memory so the page
  // still works, only without remembering the last filters.
  const store = (() => {
    const memory = new Map();
    return {
      get(key) {
        try {
          return localStorage.getItem(key);
        } catch {
          return memory.has(key) ? memory.get(key) : null;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch {
          memory.set(key, String(value));
        }
      },
    };
  })();

  const meta = (name) =>
    document.querySelector(`meta[name="usage-tree-${name}"]`)?.getAttribute("content") || "";
  const token = meta("token");
  const theme = meta("theme") || "light";
  const currency = meta("currency") || "cny";
  const usdCny = Number(meta("usd-cny")) || 7.2;
  const saved = {
    period: store.get("usage-tree.period") || "today",
    sort: store.get("usage-tree.sort") || "tokens",
    expanded: readSet("usage-tree.expanded"),
  };
  const validPeriods = new Set(["today", "7d", "30d", "all"]);
  const validSorts = new Set(["tokens", "cost", "calls", "name"]);

  const state = {
    period: validPeriods.has(saved.period) ? saved.period : "today",
    sort: validSorts.has(saved.sort) ? saved.sort : "tokens",
    expanded: saved.expanded,
    openProviders: readSet("usage-tree.providers"),
    query: "",
    data: null,
    loading: false,
    error: "",
    loadedAt: 0,
    previewFirst: new URLSearchParams(location.search).get("preview") === "first",
  };

  const $ = (id) => document.getElementById(id);
  const summary = $("summary");
  const accounts = $("accounts");
  const stateCard = $("state-card");
  const warning = $("warning");
  const refresh = $("refresh");
  const expandAll = $("expand-all");

  applyTheme();
  buildSummarySkeleton();
  bind();
  load();

  function readSet(key) {
    try {
      const value = JSON.parse(store.get(key) || "[]");
      return new Set(Array.isArray(value) ? value.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function saveSet() {
    store.set("usage-tree.expanded", JSON.stringify([...state.expanded]));
    store.set("usage-tree.providers", JSON.stringify([...state.openProviders]));
  }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    try {
      const tokens = JSON.parse(meta("tokens") || "{}");
      for (const [key, value] of Object.entries(tokens)) {
        if (typeof value === "string") {
          document.documentElement.style.setProperty(`--magpie-${key}`, value);
        }
      }
    } catch {
      // Theme tokens are optional.
    }
  }

  function bind() {
    $("period").addEventListener("click", (event) => {
      const value = event.target.closest("button")?.dataset.period;
      if (!value || value === state.period) return;
      state.period = value;
      state.stalePolls = 0;
      store.set("usage-tree.period", value);
      renderPeriod();
      load();
    });

    $("sort").addEventListener("change", (event) => {
      state.sort = validSorts.has(event.target.value) ? event.target.value : "tokens";
      store.set("usage-tree.sort", state.sort);
      renderAccounts();
    });

    $("search").addEventListener("input", (event) => {
      state.query = event.target.value.trim().toLowerCase();
      renderAccounts();
    });

    expandAll.addEventListener("click", () => {
      const providers = visibleProviders();
      const accounts = providers.flatMap((provider) => provider.accounts);
      const allOpen =
        providers.length > 0 &&
        providers.every((provider) => state.openProviders.has(provider.id)) &&
        accounts.every((account) => state.expanded.has(account.id));
      for (const provider of providers) {
        if (allOpen) state.openProviders.delete(provider.id);
        else state.openProviders.add(provider.id);
      }
      for (const account of accounts) {
        if (allOpen) state.expanded.delete(account.id);
        else state.expanded.add(account.id);
      }
      saveSet();
      renderAccounts();
    });

    refresh.addEventListener("click", () => {
      state.stalePolls = 0;
      load({ force: true });
    });

    window.addEventListener("focus", () => {
      if (Date.now() - state.loadedAt > 60_000) load();
    });

    setInterval(() => {
      if (!document.hidden && Date.now() - state.loadedAt > 60_000) load();
    }, 60_000);
  }

  function renderPeriod() {
    for (const button of $("period").querySelectorAll("button")) {
      button.setAttribute("aria-selected", String(button.dataset.period === state.period));
    }
    $("sort").value = state.sort;
  }

  async function load(options = {}) {
    if (state.loading && !options.force) return;
    state.loading = true;
    state.error = "";
    if (!options.quiet) {
      refresh.classList.add("busy");
      refresh.disabled = true;
    }
    warning.hidden = true;
    if (!state.data) {
      stateCard.hidden = true;
      accounts.hidden = true;
      buildSummarySkeleton();
    }

    try {
      const fresh = options.force ? "&fresh=1" : "";
      const res = await fetch(`api/tree?period=${encodeURIComponent(state.period)}${fresh}`, {
        headers: { "x-usage-tree-token": token },
        cache: "no-store",
        signal: AbortSignal.timeout(90000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const next = fingerprint(body);
      const changed = next !== state.fingerprint || !state.rendered;
      state.data = body;
      state.fingerprint = next;
      state.loadedAt = Date.now();
      // The service answers with the numbers it had and reads again behind
      // the page; ask for them again in a moment, so the page catches up
      // without the reader asking.
      if (body.stale && (state.stalePolls = (state.stalePolls || 0) + 1) <= 3) {
        clearTimeout(state.staleTimer);
        state.staleTimer = setTimeout(() => {
          if (!document.hidden) load({ quiet: true });
        }, 8000);
      }
      if (state.previewFirst && state.data.accounts?.length && !store.get("usage-tree.expanded")) {
        state.expanded.add(state.data.accounts[0].id);
      }
      if (changed) {
        state.rendered = true;
        render();
      } else {
        renderFoot();
      }
    } catch (error) {
      state.error = `${error?.name || "Error"}: ${error?.message || "无法读取用量数据"}`;
      renderError();
    } finally {
      state.loading = false;
      if (!options.quiet) {
        refresh.classList.remove("busy");
        refresh.disabled = false;
      }
    }
  }

  // What the page reads: if a read came back the same, nothing is redrawn.
  function fingerprint(data) {
    const summary = data?.summary || {};
    const parts = [data?.period, summary.calls, summary.tokens, Number(summary.cost || 0).toFixed(4)];
    for (const provider of data?.providers || []) {
      parts.push(provider.id, provider.calls, provider.tokens);
      for (const account of provider.accounts || []) {
        parts.push(account.id, account.calls, account.tokens);
        for (const model of account.models || []) parts.push(model.id, model.calls, model.tokens);
      }
    }
    return parts.join("|");
  }

  // The foot names when the numbers are from; the rows stay as they are.
  function renderFoot() {
    const data = state.data;
    if (!data) return;
    const source = data.source || "Magpie 本地用量记录";
    $("source-note").textContent = `只读聚合 · ${source}`;
    $("updated").textContent = data.generatedAt
      ? `更新于 ${new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "";
  }

  function buildSummarySkeleton() {
    summary.replaceChildren(
      ...["账号", "调用", "Token", "估算费用"].map((label) => {
        const card = el("article", "summary-card loading");
        const head = el("div", "summary-label");
        head.append(icon("dot"), document.createTextNode(label));
        card.append(
          head,
          el("div", "summary-value", "—"),
          el("span", "summary-sub", "首次读取约需数秒"),
        );
        return card;
      }),
    );
  }

  function render() {
    const data = state.data;
    if (!data) return;
    renderPeriod();
    renderSummary(data.summary || {});
    renderWarnings(data.warnings || []);
    renderAccounts();
    renderFoot();
  }

  function renderSummary(data) {
    // A read from before the three-level shape has no provider count; the
    // rows still know their providers, so count those.
    const summaryData = { ...data, providers: data.providers ?? providersOf(state.data).length };
    const items = V.tiles(summaryData, "zh", currency, usdCny).map((tile, index) => ({
      ...tile,
      icon: ["accounts", "calls", "tokens", "cost"][index],
    }));

    summary.replaceChildren(
      ...items.map((item) => {
        const card = el("article", "summary-card");
        const head = el("div", "summary-label");
        head.append(icon(item.icon), document.createTextNode(item.label));
        const value = el("div", "summary-value", item.value);
        if (item.bad) value.style.color = "var(--red)";
        card.append(head, value, el("span", "summary-sub", item.sub));
        return card;
      }),
    );
  }

  function renderWarnings(warnings) {
    if (!warnings.length) {
      warning.hidden = true;
      return;
    }
    warning.hidden = false;
    warning.textContent = warnings.join(" ");
  }

  function renderError() {
    summary.replaceChildren();
    accounts.replaceChildren();
    accounts.hidden = true;
    stateCard.hidden = false;
    stateCard.replaceChildren();
    const strong = el("strong", "", "没有读到用量数据");
    const button = el("button", "", "重新加载");
    button.type = "button";
    button.addEventListener("click", () => load({ force: true }));
    stateCard.append(strong, document.createTextNode(state.error), button);
  }

  function visibleAccounts() {
    return visibleProviders()
      .flatMap((provider) => provider.accounts)
      .filter((account) => !state.query || matches(account, state.query));
  }

  function visibleProviders() {
    const list = [...providersOf(state.data)];
    const query = state.query;
    if (query) {
      return list.filter(
        (account) =>
          account.providerName.toLowerCase().includes(query) ||
          account.provider.toLowerCase().includes(query) ||
          account.accounts.some((account) => matches(account, query)),
      );
    }
    return list.sort((a, b) => {
      if (state.sort === "name") return a.providerName.localeCompare(b.providerName);
      if (state.sort === "cost") return b.cost - a.cost || b.tokens - a.tokens;
      if (state.sort === "calls") return b.calls - a.calls || b.tokens - a.tokens;
      return b.tokens - a.tokens || b.cost - a.cost;
    });
  }

  // What the list draws: the providers the service sent. A read written
  // before the three-level shape existed has none, so its accounts are
  // grouped here rather than shown as "no usage".
  function providersOf(data) {
    if (Array.isArray(data?.providers) && data.providers.length) return data.providers;
    const accounts = data?.accounts || [];
    if (!accounts.length) return [];
    const byProvider = new Map();
    for (const account of accounts) {
      let provider = byProvider.get(account.provider);
      if (!provider) {
        provider = {
          id: account.provider,
          provider: account.provider,
          providerName: account.providerName,
          accounts: [],
          calls: 0,
          tokens: 0,
          cost: 0,
          errors: 0,
          unpriced: 0,
        };
        byProvider.set(account.provider, provider);
      }
      provider.accounts.push(account);
      provider.calls += account.calls || 0;
      provider.tokens += account.tokens || 0;
      provider.cost += account.cost || 0;
      provider.errors += account.errors || 0;
      provider.unpriced += account.unpriced || 0;
    }
    return [...byProvider.values()];
  }

  function matches(account, query) {
    return (
      account.account.toLowerCase().includes(query) ||
      account.providerName.toLowerCase().includes(query) ||
      account.provider.toLowerCase().includes(query) ||
      account.models.some((model) => model.model.toLowerCase().includes(query))
    );
  }

  function renderAccounts() {
    if (!state.data) return;
    const list = visibleProviders();
    accounts.hidden = false;
    stateCard.hidden = true;

    if (!list.length) {
      accounts.hidden = true;
      stateCard.hidden = false;
      stateCard.replaceChildren(
        el("strong", "", state.query ? "没有匹配的账号" : "这个周期还没有账号用量"),
        document.createTextNode(
          state.query
            ? "试试搜索其他账号、供应商或模型。"
            : "通过 Magpie 网关产生调用后，这里会按账号汇总。",
        ),
      );
      updateExpandLabel();
      return;
    }

    accounts.replaceChildren(...list.map((provider, index) => providerCard(provider, index)));
    updateExpandLabel();
  }

  function providerCard(provider, index) {
    const article = el("section", "provider" + (state.openProviders.has(provider.id) ? " open" : ""));
    article.dataset.id = provider.id;
    article.style.animationDelay = `${Math.min(index, 8) * 30}ms`;

    const main = el("button", "provider-main");
    main.type = "button";
    main.setAttribute("aria-expanded", String(state.openProviders.has(provider.id)));

    const identity = el("div", "identity");
    const badge = el("span", "provider-badge", shortProvider(provider.provider));
    const identityText = el("div", "identity-text");
    const name = el("div", "level-name", provider.providerName);
    identityText.append(
      name,
      el("div", "level-sub", `${provider.accounts.length} 个账号 · ${countModels(provider)} 个模型`),
    );
    identity.append(badge, identityText);

    const calls = metric("", compact(provider.calls), "", "calls-cell");
    const all = providersOf(state.data);
    const total = totalForSort(all);
    const share = shareCell(provider, total, all);

    const cost = metric(
      "",
      money(provider.cost, provider.unpriced, provider.calls),
      "",
      "cost-cell" + (provider.unpriced ? " unpriced" : ""),
    );
    const errors = metric(
      "",
      provider.errors ? `${provider.errors} 失败` : "正常",
      "",
      "errors-cell" + (provider.errors ? " bad" : ""),
    );
    const chevron = el("span", "chevron");
    chevron.append(icon("chevron"));

    main.append(identity, calls, ...share, cost, errors, chevron);
    main.addEventListener("click", () => {
      if (state.openProviders.has(provider.id)) state.openProviders.delete(provider.id);
      else state.openProviders.add(provider.id);
      saveSet();
      article.classList.toggle("open", state.openProviders.has(provider.id));
      main.setAttribute("aria-expanded", String(state.openProviders.has(provider.id)));
      updateExpandLabel();
    });

    const accountBox = el("div", "provider-accounts");
    for (const account of provider.accounts) {
      accountBox.append(accountCard(account, provider.accounts));
    }
    article.append(main, accountBox);
    return article;
  }

  function countModels(provider) {
    return provider.accounts.reduce((sum, account) => sum + account.models.length, 0);
  }

  function accountCard(account, siblings) {
    const article = el("article", "account" + (state.expanded.has(account.id) ? " open" : ""));
    article.dataset.id = account.id;

    const main = el("button", "account-main");
    main.type = "button";
    main.setAttribute("aria-expanded", String(state.expanded.has(account.id)));

    const identity = el("div", "identity");
    const badge = el("span", "provider-badge", shortProvider(account.provider));
    const identityText = el("div", "identity-text");
    const name = el("div", "level-name", account.alias || account.account);
    name.title = account.account;
    const sub = el("div", "level-sub");
    // The provider is the row above, so the account says what is its own:
    // the raw sign-in when the reader named it, how many models, when last.
    const subParts = [
      account.alias ? account.account : "",
      `${account.models.length} 个模型`,
      lastSeen(account.lastAt),
    ].filter(Boolean);
    subParts.forEach((part, index) => {
      if (index) sub.append(el("i"));
      sub.append(document.createTextNode(part));
    });
    identityText.append(name, sub);
    identity.append(badge, identityText);

    const calls = metric("", compact(account.calls), "", "calls-cell");
    const share = shareCell(account, totalForSort(siblings), siblings);

    const cost = metric(
      "",
      money(account.cost, account.unpriced, account.calls),
      account.unpriced ? `${compact(account.unpriced)} 次未定价` : "",
      "cost-cell" + (account.unpriced ? " unpriced" : ""),
    );
    const errors = metric(
      "",
      account.errors ? `${account.errors} 失败` : "正常",
      "",
      "errors-cell" + (account.errors ? " bad" : ""),
    );
    const chevron = el("span", "chevron");
    chevron.append(icon("chevron"));

    main.append(identity, calls, ...share, cost, errors, chevron);
    main.addEventListener("click", () => {
      if (state.expanded.has(account.id)) state.expanded.delete(account.id);
      else state.expanded.add(account.id);
      saveSet();
      article.classList.toggle("open", state.expanded.has(account.id));
      main.setAttribute("aria-expanded", String(state.expanded.has(account.id)));
      updateExpandLabel();
    });

    article.append(main, modelList(account));
    return article;
  }

  function modelList(account) {
    const box = el("div", "model-list");
    const head = el("div", "model-head");
    head.append(
      el("span", "", "模型"),
      el("span", "", "调用"),
      el("span", "", "Token"),
      el("span", "", ""),
      el("span", "", "费用"),
      el("span", "", "占比"),
    );
    box.append(head);

    const query = state.query;
    const models = account.models.filter(
      (model) =>
        !query ||
        account.account.toLowerCase().includes(query) ||
        account.providerName.toLowerCase().includes(query) ||
        account.provider.toLowerCase().includes(query) ||
        model.model.toLowerCase().includes(query),
    );

    models.sort((a, b) => {
      if (state.sort === "name") return a.model.localeCompare(b.model);
      return sortMetric(b) - sortMetric(a) || a.model.localeCompare(b.model);
    });

    for (const model of models) {
      const row = el("div", "model-row");
      const who = el("div");
      const name = el("div", "model-name", model.model);
      name.title = model.model;
      who.append(name, el("div", "model-provider", model.providerName));
      if (model.hostNotes?.length) {
        who.append(
          el(
            "div",
            "model-host",
            `含 ${model.hostNotes.map((h) => `${h.account} ${compact(h.calls)} 次`).join(" · ")}`,
          ),
        );
      }

      const calls = metric(
        "",
        compact(model.calls),
        model.errors ? `${model.errors} 失败` : "",
        model.errors ? "bad" : "",
      );
      const share = shareCell(model, totalForSort(account.models), account.models);
      const split = el("div", "model-split", `入 ${compact(model.input)} · 出 ${compact(model.output)} · 缓存 ${compact(model.cache)}`);
      who.append(split);

      const cost = metric(
        "",
        money(model.cost, model.unpriced, model.calls),
        "",
        "cost-cell" + (model.unpriced ? " unpriced" : ""),
      );
      row.append(who, calls, ...share, cost, el("div", "metric"));
      box.append(row);
    }
    return box;
  }

  function updateExpandLabel() {
    const providers = visibleProviders();
    const accounts = providers.flatMap((provider) => provider.accounts);
    const allOpen =
      providers.length > 0 &&
      providers.every((provider) => state.openProviders.has(provider.id)) &&
      accounts.every((account) => state.expanded.has(account.id));
    expandAll.textContent = allOpen ? "收起全部" : "展开全部";
  }

  function metric(label, value, detail = "", className = "") {
    const box = el("div", `metric ${className}`.trim());
    if (label) box.append(el("div", "metric-label", label));
    box.append(el("div", "metric-value", value));
    if (detail) box.append(el("div", "metric-detail", detail));
    return box;
  }

  // A row's share: the number of tokens, the bar of the share and the
  // percentage of it, in three columns of their own so the numbers line
  // up down the page.
  function shareCell(item, total, list) {
    const share = sharePercent(item, total);
    const tokens = el("div", "metric tokens-cell");
    tokens.append(el("div", "metric-value", compact(item.tokens)));

    const barCell = el("div", "share-cell");
    const bar = el("div", "bar");
    bar.setAttribute("aria-label", `${V.shareWord(state.sort)} ${percent(share)}`);
    const fill = el("i");
    fill.style.setProperty(
      "--bar",
      `${(Math.max(0.015, barShare(item, list)) * 100).toFixed(1)}%`,
    );
    bar.append(fill);
    barCell.append(bar);
    const labelCell = el("div", "share-label-cell", percent(share));
    labelCell.title = V.shareWord(state.sort);
    return [tokens, barCell, labelCell];
  }

  // A percentage and a bar follow the sort picked: tokens, cost or calls.
  // A name sort keeps tokens, as the list's own order is the name's.
  function sortMetric(item) {
    if (state.sort === "cost") return Number(item.cost) || 0;
    if (state.sort === "calls") return Number(item.calls) || 0;
    return Number(item.tokens) || 0;
  }

  function totalForSort(list) {
    return list.reduce((sum, item) => sum + sortMetric(item), 0);
  }

  function barShare(item, list) {
    const max = Math.max(0, ...list.map(sortMetric));
    return max > 0 ? sortMetric(item) / max : 0;
  }

  function sharePercent(item, total) {
    return total > 0 ? sortMetric(item) / total : 0;
  }

  function compact(value) {
    return V.count(value);
  }

  function money(usd, unpriced, calls) {
    return V.money(usd, unpriced, calls, currency, usdCny);
  }

  function percent(value) {
    return V.percent(value);
  }

  function lastSeen(value) {
    if (!value) return "无时间";
    const diff = Date.now() - Date.parse(value);
    if (!Number.isFinite(diff)) return "最近使用";
    if (diff < 60_000) return "刚刚使用";
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
    return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function shortProvider(id) {
    const words = String(id || "??")
      .replaceAll("_", "-")
      .split("-")
      .filter(Boolean);
    if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
    return String(id || "??").slice(0, 2).toUpperCase();
  }

  function el(tag, className = "", value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  }

  function icon(name) {
    const box = document.createElement("span");
    box.setAttribute("aria-hidden", "true");
    box.style.display = "contents";
    const paths = {
      dot: '<circle cx="12" cy="12" r="7"/>',
      accounts: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 3.5 5"/>',
      calls: '<path d="M4 18V9M10 18V5M16 18v-7M22 18V3"/>',
      tokens: '<path d="M4 7h16M4 12h10M4 17h7"/><circle cx="18" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
      cost: '<path d="M12 3v18M17 7.5c0-2-2.24-3.5-5-3.5S7 5.5 7 7.5s2.24 3.5 5 3.5 5 1.5 5 3.5-2.24 3.5-5 3.5-5-1.5-5-3.5"/>',
      chevron: '<path d="m7 10 5 5 5-5"/>',
    };
    box.innerHTML = `<svg viewBox="0 0 24 24">${paths[name] || paths.dot}</svg>`;
    return box;
  }
})();

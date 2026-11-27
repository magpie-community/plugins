(() => {
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="hindsight-token"]').content;
  const defaults = {
    hindsight_api: "http://127.0.0.1:8888", bank: "hermes", recall_max_tokens: 1024,
    injection_max_bytes: 16384, gatewayTimeoutMs: 5000, capture: false, port: 3482,
    allowRemote: false, allowInsecureHttp: false
  };
  const numeric = ["recall_max_tokens", "injection_max_bytes", "gatewayTimeoutMs", "port"];
  const checks = ["capture", "allowRemote", "allowInsecureHttp"];
  const owners = { auto: "自动", gateway: "网关处理", native: "交给原生", off: "关闭网关" };
  const optionsText = {
    connected: "可达", unavailable: "服务不可用", timeout: "请求超时", unauthorized: "访问被拒绝", "rate-limited": "服务限流",
    invalid: "响应无法识别", "invalid-options": "配置无效", "not-found": "接口不存在",
    unverified: "待验证", "not-listed": "目录中未找到", accessible: "可访问", listed: "已列出"
  };
  const explanations = {
    "native-active": "检测到原生启用", "manual-native": "已手动交给原生", "policy-off": "策略已关闭",
    "capture-off": "网关写入总开关关闭", "legacy-selected": "旧配置已选中", "legacy-excluded": "旧策略未选中",
    "native-unknown": "原生状态待确认", "native-unsupported": "暂无原生检测适配",
    "native-history-only": "有历史活动，当前接线待确认",
    "native-installed-unverified": "已安装，启用待确认",
    "native-profile-unknown": "当前配置档案待确认",
    "gateway-enabled": "由网关处理", "gateway-fallback": "已检查原生配置，由网关处理", "native-conflict": "原生与网关均启用"
  };
  const evidence = {
    disabled: "原生集成已关闭", wired: "检测到原生接入", scoped: "检测到原生接入，随项目变化",
    "other-provider": "Hermes 使用其他记忆提供方", "hermes-provider": "Hermes Hindsight 提供方",
    "no-supported-integration": "检查了已支持的配置位置",
    "custom-hook": "检测到自定义召回 Hook",
    "installed-profile": "配置档案内有 Hindsight 插件",
    "multiple-profiles": "有多套原生配置",
    "separate-profile": "有独立配置档案",
    unsupported: "可手动设置召回来源",
    observed: "仅有原生活动记录", unknown: "未核实当前接线"
  };
  const codes = {
    hit: "命中", empty: "空结果", reused: "复用本轮结果", timeout: "超时", unavailable: "服务不可用",
    "rate-limited": "限流", "not-found": "接口不存在", budget: "等待预算不足", cooldown: "故障冷却中", busy: "达到并发限制",
    cancelled: "取消", unauthorized: "鉴权失败", invalid: "响应或配置无效", continuation: "工具续接", skipped: "跳过",
    submitted: "已提交", processing: "处理中", completed: "已入库", failed: "入库失败", duplicate: "已去重",
    unconfirmed: "待确认是否提交", unidentified: "缺少稳定轮次身份", pending: "排队中", unknown: "最终状态未知",
    "bank-unverified": "目标记忆库未验证",
    ...explanations
  };
  const phases = { recall: "召回", capture: "写入", policy: "策略" };
  const failures = new Set(["timeout", "unavailable", "rate-limited", "unauthorized", "not-found", "invalid", "budget"]);
  const queryOutcomes = new Set(["hit", "empty", ...failures].filter(code => code !== "budget"));
  const date = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const number = new Intl.NumberFormat("zh-CN");
  const fmt = n => Number.isFinite(n) ? number.format(n) : "—";
  const time = n => n ? date.format(n) : "—";
  const waiting = new Map();
  let counter = 1000;
  let host, saved, dirty = false, busy = false, visible = true, stale = false;
  let snapshot = { agents: [], activity: { rows: [], recent: [] } };
  let stats = snapshot.activity;
  let hints = [];
  let draftRules = Object.create(null);
  let previewRows;
  let previewSeq = 0;
  let previewTimer;
  let activePanel = "agents";
  let bankCatalog = [];
  let pendingReconnect;

  function show(id, text, tone = "") {
    const node = $(id);
    node.textContent = text;
    node.dataset.tone = tone;
  }

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function theme(data) {
    if (typeof data?.dark === "boolean") document.documentElement.dataset.theme = data.dark ? "dark" : "light";
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error("host-timeout")); }, 8000);
      waiting.set(id, { resolve, reject, timer });
      parent.postMessage({ magpie: 1, id, method, params }, host?.origin || "*");
    });
  }

  window.addEventListener("message", event => {
    if (event.source !== parent || (host?.origin && event.origin !== host.origin)) return;
    const message = event.data;
    if (message?.magpie !== 1) return;
    if (message.event === "theme") return theme(message.data);
    if (message.event === "visibility") {
      visible = message.data?.visible !== false;
      if (visible) void refresh();
      return;
    }
    const entry = waiting.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error("host-error"));
    else entry.resolve({ data: message.result, origin: event.origin !== "null" ? event.origin : "" });
  });

  async function api(path, data) {
    const response = await fetch(new URL("./api/" + path, location.href), {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "x-hindsight-token": token, "content-type": "application/json" },
      body: JSON.stringify(data ?? {}), signal: AbortSignal.timeout(12000)
    });
    if (response.status === 403) stale = true;
    if (!response.ok) throw new Error("local-service");
    return response.json();
  }

  function panels(id) {
    activePanel = id;
    for (const button of document.querySelectorAll("[data-panel]")) {
      const selected = button.dataset.panel === id;
      $("panel-" + button.dataset.panel).hidden = !selected;
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (id === "activity") void refreshStats();
  }

  function buttons() {
    $("save").disabled = !saved || !dirty || busy;
    $("discard").disabled = !saved || !dirty || busy;
    $("check-draft").disabled = !saved || busy;
    $("agent_mode").disabled = !saved || busy;
    $("capture").disabled = !saved || busy;
    $("add-agent").disabled = !saved || busy || $("agent_mode").value === "legacy";
  }

  function fill(options) {
    for (const [id, fallback] of Object.entries(defaults)) {
      if (checks.includes(id)) $(id).checked = options[id] === true;
      else $(id).value = options[id] ?? fallback;
      $(id).removeAttribute("aria-invalid");
    }
    $("recall_tags").value = Array.isArray(options.recall_tags) ? options.recall_tags.join(", ") : "";
    $("agent_mode").value = options.agent_mode ?? (Object.hasOwn(options, "agents") ? "legacy" : "auto");
    draftRules = Object.assign(Object.create(null), options.agent_policies || {});
    $("draft-result").hidden = true;
    dirty = false;
    previewRows = undefined;
    previewSeq++;
    buttons();
    renderMode();
  }

  function values() {
    const next = {};
    for (const key of Object.keys(defaults)) {
      next[key] = checks.includes(key) ? $(key).checked
        : numeric.includes(key) ? ($(key).valueAsNumber || 0) : $(key).value.trim();
    }
    next.agent_mode = $("agent_mode").value;
    next.agent_policies = draftRules;
    next.recall_tags = $("recall_tags").value.split(/[,，]/).map(value => value.trim()).filter(Boolean);
    return next;
  }

  function renderMode() {
    const help = {
      legacy: "沿用旧选择。要调整单个 Agent 的召回、写入或记忆库，请切换到手动或自动。旧名单为空时沿用旧版排除规则。",
      auto: "检测到原生启用时交给原生，确认原生关闭时交给网关。证据不足的 Agent 标为待确认，可手动选择。",
      manual: "按下表逐项设置。新发现的 Agent 默认关闭网关处理，也可把单个动作设为自动。"
    };
    show("mode-help", help[$("agent_mode").value] || "等待从 Magpie 读取策略。");
    const timeout = Math.max(0, Math.min(8000, ($("gatewayTimeoutMs").valueAsNumber || 0) - 200));
    show("timeout-help", timeout ? "单次召回最多等待 " + timeout + " 毫秒，已预留宿主处理时间。" : "当前等待上限不足，网关跳过召回。");
  }

  function changed() {
    dirty = true;
    buttons();
    renderMode();
    show("status", "有未保存的更改。表格显示当前表单的策略预览。");
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void preview(), 160);
  }

  async function preview() {
    const seq = ++previewSeq;
    try {
      const result = await api("preview", { options: { ...saved, ...values() }, hints });
      if (seq !== previewSeq || !dirty || result.error) return;
      previewRows = result.agents;
      renderAgents();
    } catch { if (stale) show("status", "工作台服务已更新。请重新打开页面后继续。", "error"); }
  }

  function sum(rows, action, codes) {
    return rows.reduce((n, row) => n + (row.action === action && (!codes || codes.has(row.code)) ? row.n : 0), 0);
  }

  function currentRows() {
    return previewRows ?? snapshot.agents ?? [];
  }

  function renderOverview() {
    const connection = snapshot.connection;
    if (connection?.api) {
      show("api-state", optionsText[connection.api] || connection.api, connection.api === "connected" ? "good" : "error");
      show("api-detail", "数据库 " + (optionsText[connection.database] || "待校验") + " · " + fmt(connection.ms) + " ms");
      show("bank-state", connection.bank ?? $("bank").value, connection.bankStatus === "accessible" ? "good" : "warn");
      const documents = connection.stats?.documents;
      show("bank-detail", (optionsText[connection.bankStatus] || "校验结果未知") +
        (Number.isFinite(documents) ? " · " + fmt(documents) + " 篇全库文档" : "") + " · " + time(connection.checkedAt));
    } else {
      show("api-state", "等待检查");
      show("api-detail", "检查 API 与数据库");
      show("bank-state", saved?.bank ?? defaults.bank);
      show("bank-detail", "等待检查记忆库权限");
    }
    const last = snapshot.activity?.runtime;
    if (last?.revision && snapshot.revision === last.revision) {
      show("hook-state", "已在请求中生效", "good");
      show("hook-detail", "最近一次 " + time(last.last));
    } else {
      show("hook-state", snapshot.invalid ? "配置无效" : last ? "等待新配置生效" : "尚未观测到请求", "warn");
      show("hook-detail", last ? "上次请求 " + time(last.last) : "通过所选 Agent 发起请求后更新");
    }
    const rows = snapshot.activity?.rows ?? [];
    const hits = sum(rows, "recall", new Set(["hit"]));
    const attempted = sum(rows, "recall", queryOutcomes);
    show("recall-state", attempted ? fmt(hits) + " / " + fmt(attempted) : rows.length ? "未发起召回" : "—");
    show("recall-detail", attempted ? fmt(sum(rows, "recall", new Set(["reused"]))) + " 次复用 · 不计入查询量"
      : rows.length ? fmt(sum(rows, "request", new Set(["seen"]))) + " 个网关请求" : "等待网关活动");
    $("hit-meter").hidden = !attempted;
    $("hit-meter").value = attempted ? hits / attempted : 0;
  }

  function policyCell(agent, action) {
    const td = node("td");
    const decision = agent.policy?.[action];
    if ($("agent_mode").value !== "legacy" && agent.id !== "unknown") {
      const menu = node("select");
      menu.setAttribute("aria-label", agent.name + (action === "recall" ? "召回策略" : "写入策略"));
      menu.dataset.agent = agent.id;
      menu.dataset.action = action;
      const fallback = $("agent_mode").value === "auto" ? "auto" : "off";
      for (const [value, label] of Object.entries(owners)) menu.add(new Option(label, value));
      menu.value = draftRules[agent.id]?.[action] ?? fallback;
      menu.disabled = !saved || busy;
      menu.addEventListener("change", () => {
        const policy = draftRules[agent.id] ?? { recall: fallback, capture: fallback };
        draftRules[agent.id] = { ...policy, [action]: menu.value };
        changed();
      });
      td.append(menu);
    }
    if (decision) {
      const text = explanations[decision.reason] ?? "待确认";
      const detail = node("small", text);
      detail.dataset.tone = decision.reason === "native-conflict" || decision.owner === "pending" ? "warn" : decision.owner === "gateway" ? "good" : "";
      td.append(detail);
    }
    return td;
  }

  function messageRow(tbody, message, columns) {
    const tr = node("tr");
    const td = node("td", message);
    td.colSpan = columns;
    tr.append(td);
    tbody.append(tr);
  }

  function hasPolicy(agent, key) {
    if (key === "unsupported") return agent.policy?.recall.reason === "native-unsupported";
    if (key === "pending" && agent.policy?.recall.reason === "native-unsupported") return false;
    return Object.values(agent.policy ?? {}).some(item => key === "conflict" ? item.reason === "native-conflict" : item.owner === key);
  }

  function bankCell(agent, activeBank) {
    const bank = node("td");
    const shared = $("bank").value || saved?.bank || snapshot.defaultBank || defaults.bank;
    const picked = draftRules[agent.id]?.bank || agent.bankOverride || "";
    if ($("agent_mode").value !== "legacy" && agent.id !== "unknown" && saved) {
      const selector = node("select", undefined, "bank-select");
      selector.dataset.agent = agent.id;
      selector.dataset.action = "bank";
      selector.setAttribute("aria-label", agent.name + " 网关记忆库");
      selector.add(new Option("继承 " + shared, ""));
      const available = new Set([...bankCatalog.map(bank => bank.id), shared, picked].filter(Boolean));
      for (const id of available) selector.add(new Option(id, id));
      selector.value = picked;
      selector.disabled = busy;
      selector.addEventListener("change", () => {
        const fallback = $("agent_mode").value === "auto" ? "auto" : "off";
        const rule = { recall: fallback, capture: fallback, ...(draftRules[agent.id] ?? {}) };
        if (selector.value) rule.bank = selector.value;
        else delete rule.bank;
        draftRules[agent.id] = rule;
        changed();
      });
      bank.append(selector);
    } else if (activeBank) {
      bank.append(node("strong", agent.gatewayBank ?? shared));
      bank.append(node("small", agent.bankOverride ? "网关 · 单独指定" : "网关 · 继承共享库"));
    }
    if (agent.native?.bank) bank.append(node("small",
      (agent.native.evidence === "installed-profile" ? "原生设定 " : "原生 ") + agent.native.bank));
    else if (hasPolicy(agent, "native") || agent.native?.variableBank)
      bank.append(node("small", agent.native?.variableBank ? "原生随会话或项目变化" : "原生库待确认"));
    const proof = evidence[agent.native?.evidence] ?? "未核实当前接线";
    bank.append(node("small", agent.native?.evidence === "observed" && agent.activity?.last ? proof + " · " + time(agent.activity.last) : proof));
    return bank;
  }

  function renderAgents() {
    const agents = currentRows();
    const keyword = $("filter-agent").value.trim().toLowerCase();
    const filter = $("filter-policy").value;
    const tbody = $("agent-rows");
    const focused = document.activeElement?.dataset;
    const rank = agent => hasPolicy(agent, "conflict") ? 0 : hasPolicy(agent, "gateway") ? 1 : hasPolicy(agent, "native") ? 2 : agent.connected ? 3 : 4;
    const selected = agents.filter(agent => (!keyword || (agent.name + " " + agent.id).toLowerCase().includes(keyword)) &&
      (filter === "all" || hasPolicy(agent, filter))).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    tbody.replaceChildren();
    show("agent-count", fmt(agents.length));
    const when = snapshot.discoveredAt ? "最近识别 " + time(snapshot.discoveredAt) : "等待识别结果";
    show("discovery", when + " · 来源含本机配置、Magpie 用量与网关实际请求");
    for (const button of document.querySelectorAll("[data-filter]")) {
      const key = button.dataset.filter;
      button.setAttribute("aria-pressed", String(key === filter));
      show("count-" + key, fmt(agents.filter(agent => hasPolicy(agent, key)).length));
    }
    const gateways = agents.filter(agent => hasPolicy(agent, "gateway"));
    const overrides = gateways.filter(agent => agent.bankOverride).length;
    show("shared-bank", (dirty ? $("bank").value : saved?.bank ?? snapshot.defaultBank) || defaults.bank);
    show("bank-coverage", fmt(gateways.length - overrides) + " 个网关 Agent 继承 · " + fmt(overrides) + " 个单独指定");
    if (!selected.length) messageRow(tbody, agents.length ? "没有符合筛选条件的 Agent。" : "暂无识别结果，可重新识别或添加自定义 Agent。", 5);
    const rows = snapshot.activity?.rows ?? [];
    for (const agent of selected) {
      const tr = node("tr");
      tr.dataset.conflict = String(hasPolicy(agent, "conflict"));
      const identity = node("td");
      identity.append(node("span", agent.name, "agent-name"));
      const agentRows = rows.filter(row => row.agent === agent.id);
      identity.append(node("small", (agent.name === agent.id ? "" : agent.id + " · ") +
        (agentRows.length || agent.fromUsage ? "有网关请求" : agent.connected ? "Magpie 已配置" : agent.installed ? "检测到本机配置" : "等待网关请求")));
      const bank = bankCell(agent, hasPolicy(agent, "gateway"));
      const queries = sum(agentRows, "recall", queryOutcomes);
      const requests = sum(agentRows, "request", new Set(["seen"]));
      const hits = sum(agentRows, "recall", new Set(["hit"]));
      const runtime = node("td", queries ? fmt(hits) + " 命中 / " + fmt(queries) + " 次召回"
        : requests ? "未发起网关召回" : "未观察到");
      if (agentRows.length) {
        const injected = sum(agentRows, "injection", new Set(["applied"]));
        const retained = sum(agentRows, "capture", new Set(["completed"]));
        if (queries || injected || retained) runtime.append(node("small", "注入 " + fmt(injected) + " · 已入库 " + fmt(retained)));
        else if (agent.policy?.recall.owner === "native") runtime.append(node("small", "当前交给原生召回"));
        else if (requests) runtime.append(node("small", fmt(requests) + " 个网关请求"));
        runtime.append(node("small", "最近 " + time(Math.max(...agentRows.map(row => row.last || 0)))));
      }
      tr.append(identity, policyCell(agent, "recall"), policyCell(agent, "capture"), bank, runtime);
      tbody.append(tr);
    }
    if (focused?.agent) {
      [...tbody.querySelectorAll("select")].find(input => input.dataset.agent === focused.agent && input.dataset.action === focused.action)?.focus({ preventScroll: true });
    }

    const agentFilter = $("stats-agent");
    const savedFilter = agentFilter.value;
    agentFilter.replaceChildren(new Option("全部 Agent", ""));
    for (const agent of agents) agentFilter.add(new Option(agent.name, agent.id));
    agentFilter.value = agents.some(agent => agent.id === savedFilter) ? savedFilter : "";
  }

  function renderActivity() {
    const filter = $("stats-agent").value;
    const bankFilter = $("stats-bank");
    const selectedBank = bankFilter.value;
    const known = new Set((stats.rows ?? []).map(row => row.bank).filter(Boolean));
    for (const id of currentRows().map(agent => agent.gatewayBank).filter(Boolean)) known.add(id);
    bankFilter.replaceChildren(new Option("全部记忆库", ""));
    for (const id of known) bankFilter.add(new Option(id, id));
    bankFilter.value = known.has(selectedBank) ? selectedBank : "";
    const matches = row => (!filter || row.agent === filter) && (!bankFilter.value || row.bank === bankFilter.value);
    const rows = (stats.rows ?? []).filter(matches);
    const metricRows = [
      ["召回命中", "recall", ["hit"]], ["召回空结果", "recall", ["empty"]],
      ["召回失败", "recall", [...failures]], ["记忆已注入", "injection", ["applied"]],
      ["同轮复用", "recall", ["reused"]], ["写入已提交", "capture", ["submitted"]],
      ["写入已入库", "capture", ["completed"]], ["写入失败", "capture", ["failed", ...failures]],
      ["写入状态待确认", "capture", ["unconfirmed", "unknown"]]
    ];
    const target = $("activity-totals");
    target.replaceChildren();
    for (const [label, action, selectedCodes] of metricRows) {
      const article = node("article");
      article.append(node("h3", label), node("p", rows.length ? fmt(sum(rows, action, new Set(selectedCodes))) : "—"));
      target.append(article);
    }
    show("stats-source", stats.source === "local"
      ? "保存在本机的运行计数 · 统计按小时汇总"
      : "当前进程的活动样本 · 重启后重新累计");
    const entries = (stats.recent ?? []).filter(matches);
    const tbody = $("event-rows");
    tbody.replaceChildren();
    if (!entries.length) messageRow(tbody, "该范围暂无事件。", 5);
    for (const event of entries.slice(0, 24)) {
      const tr = node("tr");
      const result = (codes[event.code] || event.code) + (event.ms ? " · " + fmt(event.ms) + " ms" : "");
      for (const value of [time(event.ts), event.agent, phases[event.action] ?? event.action, result, event.bank || "—"]) tr.append(node("td", value));
      tbody.append(tr);
    }
    const native = $("native-activity");
    native.replaceChildren();
    const agents = (snapshot.agents ?? []).filter(agent => agent.activity && (!filter || agent.id === filter) &&
      (!bankFilter.value || agent.native?.bank === bankFilter.value));
    if (!agents.length) native.append(node("p", "暂无可用的原生活动记录。", "callout"));
    for (const item of agents) {
      const line = node("div", undefined, "native-row");
      const info = item.activity;
      line.append(node("strong", item.name), node("small", "工具调用 " + fmt(info.tools)),
        node("small", "检索事件 " + fmt(info.retrievals)), node("small", "检索失败 " + fmt(info.errors)),
        node("small", "最近 " + time(info.last)));
      native.append(line);
    }
  }

  async function refreshStats() {
    const hours = Number($("period").value);
    try {
      const result = hours === 24 ? snapshot : await api("status", { hours, hints });
      if (Number($("period").value) !== hours) return;
      if (result.activity) stats = result.activity;
      renderActivity();
    } catch { show("stats-source", "暂时无法读取活动。", "warn"); }
  }

  let refreshing;
  async function refresh(force = false) {
    if (pendingReconnect) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const result = await api("status", { hours: 24, refresh: force, hints });
        if (result.error) throw new Error(result.error);
        snapshot = result;
        renderOverview();
        renderAgents();
        if (activePanel === "activity") void refreshStats();
        if (force && dirty) void preview();
      } catch {
        show("discovery", stale ? "工作台服务已更新，请重新打开。" : "本地工作台服务无响应。");
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function getUsageHint() {
    if (!host) return;
    try {
      const response = await call("read", { name: "usage:day", params: {} });
      if (Array.isArray(response?.data?.agents)) {
        hints = response.data.agents.map(agent => agent.id ?? agent.agent ?? agent.name).filter(id => typeof id === "string");
      }
    } catch { /* Older hosts can use local inventory and hook activity. */ }
  }

  async function loadBanks(draft = false) {
    $("read-banks").disabled = true;
    try {
      const result = await api("banks", draft && saved ? { options: { ...saved, ...values() } } : {});
      if (!Array.isArray(result.banks)) throw new Error("bank-directory");
      bankCatalog = result.banks;
      $("bank-options").replaceChildren(...bankCatalog.map(bank => {
        const option = new Option(bank.name || bank.id, bank.id);
        return option;
      }));
      show("bank-catalog-note", "可选择 " + fmt(bankCatalog.length) + " 个可见记忆库" +
        (result.partial ? " · 也可输入已知的完整 ID" : "") + "。保存会验证新选择。");
      renderAgents();
    } catch {
      show("bank-catalog-note", "读取库目录失败。检查 API 地址与权限后重试。", "warn");
    } finally { $("read-banks").disabled = false; }
  }

  async function check(draft = false) {
    const button = $(draft ? "check-draft" : "check");
    button.disabled = true;
    if (draft) {
      $("draft-result").hidden = false;
      show("draft-result", "正在检查当前表单…");
    } else show("api-state", "正在检查…");
    try {
      const result = await api("check", draft ? { options: { ...saved, ...values() } } : {});
      if (result.error) {
        if (draft) show("draft-result", "正在处理另一项检查，请稍后重试。", "warn");
        else show("api-state", "检查进行中", "warn");
        return;
      }
      if (draft) {
        const bank = result.bank ? " · " + result.bank + " " + (optionsText[result.bankStatus] ?? result.bankStatus) : "";
        show("draft-result", (optionsText[result.api] ?? result.api) + bank + (result.field ? " · " + result.field : ""),
          result.bankStatus === "accessible" ? "good" : "warn");
      } else {
        snapshot.connection = result;
        renderOverview();
      }
    } catch {
      show(draft ? "draft-result" : "api-state", "无法完成检查，请重新打开工作台。", "error");
    } finally {
      button.disabled = false;
    }
  }

  async function save() {
    if (!host || !saved || !dirty || busy) return;
    busy = true;
    buttons();
    show("status", "正在验证并保存…");
    try {
      const edits = values();
      const candidate = { ...saved, ...edits };
      const result = await api("preview", { options: candidate, hints, verifyBanks: true });
      if (result.error) {
        if (result.error === "bank-unverified") {
          return show("status", "无法在 Hindsight 核实以下记忆库：" + result.missing.join("、") + "。请选择已有库。", "error");
        }
        if (result.error === "bank-directory-unavailable") return show("status", "无法读取 Hindsight 库目录，请检查 API 与权限后重试。", "error");
        const field = $(result.field);
        if (field) {
          if (["capture", "agent_mode"].includes(result.field)) panels("agents");
          else panels("connection");
          field.setAttribute("aria-invalid", "true");
          field.focus();
        }
        return show("status", "配置验证失败" + (field ? "，请检查标记字段。" : "，请检查 Agent 规则。"), "error");
      }
      const { data: current } = await call("options.get");
      if (JSON.stringify(current ?? {}) !== JSON.stringify(saved)) {
        show("status", "配置在其他页面被修改。先放弃本页草稿并读取最新配置。", "error");
        return;
      }
      const oldPort = saved.port ?? defaults.port;
      const response = await call("options.set", { options: candidate });
      saved = response.data && typeof response.data === "object" ? response.data : candidate;
      fill(saved);
      const url = new URL(location.href);
      if (!(host.service) && edits.port !== oldPort) url.port = edits.port;
      url.searchParams.set("saved", "1");
      url.searchParams.set("panel", activePanel);
      pendingReconnect = { url, revision: result.revision };
      await reconnect();
    } catch {
      show("status", stale ? "本地服务已重新加载，请重新打开页面。" : "保存失败，草稿仍在本页。", "error");
    } finally {
      busy = false;
      buttons();
    }
  }

  async function reconnect() {
    if (!pendingReconnect) return;
    const { url, revision } = pendingReconnect;
    const ready = new URL("./ready", url);
    ready.searchParams.set("revision", revision);
    $("reconnect").hidden = true;
    show("status", "配置已保存，正在等待工作台服务恢复…");
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      let online = false;
      try {
        const response = await fetch(ready, { credentials: "omit", cache: "no-store",
          redirect: "error", signal: AbortSignal.timeout(1000) });
        online = response.status === 204;
      } catch { /* The service listener may temporarily disappear during save. */ }
      if (online) {
        location.replace(url.href);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    $("reconnect").hidden = false;
    show("status", "配置已保存，工作台服务尚未恢复。可重试连接，或切到其他页面后重新打开。", "warn");
  }

  for (const button of document.querySelectorAll("[data-panel]")) {
    button.addEventListener("click", () => panels(button.dataset.panel));
  }
  for (const id of [...Object.keys(defaults), "recall_tags"]) {
    $(id).addEventListener("input", () => {
      if (!saved || busy) return;
      $(id).removeAttribute("aria-invalid");
      changed();
    });
  }
  $("agent_mode").addEventListener("change", () => {
    const legacy = saved && (saved.agent_mode ?? (Object.hasOwn(saved, "agents") ? "legacy" : "auto")) === "legacy";
    if (legacy && $("agent_mode").value === "manual") {
      for (const id of saved.agents ?? []) {
        const name = id.trim().toLowerCase();
        if (!Object.hasOwn(draftRules, name)) draftRules[name] = { recall: "gateway", capture: "gateway" };
      }
      for (const agent of snapshot.agents) {
        if (agent.id === "unknown" || draftRules[agent.id]) continue;
        const recall = agent.policy?.recall.owner === "gateway" ? "gateway" : "off";
        const capture = recall === "gateway" ? "gateway" : "off";
        draftRules[agent.id] = { recall, capture };
      }
    }
    changed();
  });
  $("filter-agent").addEventListener("input", renderAgents);
  $("filter-policy").addEventListener("change", renderAgents);
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => {
      $("filter-policy").value = $("filter-policy").value === button.dataset.filter ? "all" : button.dataset.filter;
      renderAgents();
    });
  }
  $("period").addEventListener("change", () => void refreshStats());
  $("stats-agent").addEventListener("change", renderActivity);
  $("stats-bank").addEventListener("change", renderActivity);
  $("manage-banks").addEventListener("click", () => panels("connection"));
  $("read-banks").addEventListener("click", () => void loadBanks(true));
  $("refresh-agents").addEventListener("click", async () => {
    $("refresh-agents").disabled = true;
    try { await getUsageHint(); await refresh(true); }
    finally { $("refresh-agents").disabled = false; }
  });
  $("check").addEventListener("click", () => void check());
  $("check-draft").addEventListener("click", () => void check(true));
  $("save").addEventListener("click", () => void save());
  $("reconnect").addEventListener("click", () => void reconnect());
  $("discard").addEventListener("click", async () => {
    try {
      const response = await call("options.get");
      saved = response.data ?? {};
      fill(saved);
      await refresh();
      show("status", "草稿已放弃。");
    } catch { show("status", "无法重新读取配置。", "error"); }
  });
  $("back").addEventListener("click", () => history.back());
  $("add-agent").addEventListener("click", () => {
    $("manual-id").value = "";
    show("dialog-error", "");
    $("agent-dialog").showModal();
    $("manual-id").focus();
  });
  $("close-dialog").addEventListener("click", () => $("agent-dialog").close());
  $("confirm-agent").addEventListener("click", () => {
    const id = $("manual-id").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._# -]{0,127}$/.test(id) || id === "unknown") return show("dialog-error", "请输入有效的 Agent ID。");
    if (currentRows().some(row => row.id === id) || Object.hasOwn(draftRules, id)) return show("dialog-error", "这个 Agent 已在列表中。");
    const policy = $("agent_mode").value === "auto" ? "auto" : "off";
    draftRules[id] = { recall: policy, capture: policy };
    $("agent-dialog").close();
    changed();
  });
  $("manual-id").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) $("confirm-agent").click();
  });

  void (async () => {
    buttons();
    if (parent !== window) {
      try {
        const hello = await call("hello");
        host = { origin: hello.origin, service: hello.data?.service ?? "" };
        visible = hello.data?.visible !== false;
        theme(hello.data);
        saved = (await call("options.get")).data ?? {};
        fill(saved);
        show("status", new URLSearchParams(location.search).has("saved") ? "已保存。等待网关确认新配置。" : "配置已读取。");
        void getUsageHint().then(() => refresh());
      } catch {
        show("status", "Magpie 设置接口不可用。状态可查看，保存需从 Magpie 重新打开。", "warn");
      }
    } else {
      show("status", "本地预览模式。从 Magpie 打开可编辑策略。");
    }
    const panel = new URLSearchParams(location.search).get("panel");
    if (["activity", "connection"].includes(panel)) panels(panel);
    await refresh();
    void loadBanks();
    if (!snapshot.connection) void check();
    setInterval(() => { if (visible && !stale) void refresh(); }, 15000);
  })();
})();

// Page controller: renders graph, filters, polls status when same-origin, and manages detail cards.

(function () {
  const token = document.querySelector('meta[name="memory-graph-token"]')?.content || "";
  const isOpaqueOrigin = window.origin === "null" || location.origin === "null";
  const langParam = new URLSearchParams(location.search).get("lang");
  const lang = String(langParam || navigator.language || "en")
    .toLowerCase()
    .startsWith("zh")
    ? "zh"
    : "en";
  const isZh = lang === "zh";
  const t = (zh, en) => (isZh ? zh : en);
  const $ = (selector) => document.querySelector(selector);

  const KIND_LABEL = isZh
    ? {
        profile: "个人档案",
        preference: "偏好",
        rule: "规则",
        fact: "事实",
        procedure: "流程",
        episode: "经历",
        reference: "参考",
        unknown: "未分类",
      }
    : {
        profile: "Profile",
        preference: "Preference",
        rule: "Rule",
        fact: "Fact",
        procedure: "Procedure",
        episode: "Episode",
        reference: "Reference",
        unknown: "Unknown",
      };

  const KIND_ORDER = ["profile", "preference", "rule", "fact", "procedure", "episode", "reference", "unknown"];
  const SCOPE_LABEL = isZh
    ? { global: "全局", project: "项目", agent: "Agent" }
    : { global: "Global", project: "Project", agent: "Agent" };

  const I18N = {
    brandTitle: t("记忆图谱", "Memory Graph"),
    searchPlaceholder: t("搜索记忆标题、正文、标签…", "Search memory title, body, tags…"),
    filterKind: t("类型", "Kind"),
    filterScope: t("范围", "Scope"),
    filterTag: t("标签", "Tag"),
    clear: t("清空", "Clear"),
    similarity: t("相似度", "Similarity"),
    simTitle: t("拖动调节节点连线的最低语义相似度", "Adjust minimum semantic similarity for edges"),
    hideSuperseded: t("隐藏已取代", "Hide superseded"),
    fit: t("适配", "Fit"),
    fitTitle: t("适配窗口 (0)", "Fit to view (0)"),
    refresh: t("刷新", "Refresh"),
    refreshTitle: t("重新扫描记忆并计算相似度", "Rescan memories and recompute similarity"),
    theme: t("主题", "Theme"),
    themeTitle: t("切换主题", "Toggle theme"),
    canvasAria: t("记忆关系图谱", "Memory Graph"),
    controlsAria: t("画布控制", "Canvas controls"),
    settingsTitle: t("图谱显示设置", "Graph display settings"),
    zoomInTitle: t("放大", "Zoom in"),
    zoomOutTitle: t("缩小", "Zoom out"),
    reheatTitle: t("重新分布节点", "Reheat layout"),
    settingsHead: t("图谱显示", "Graph Display"),
    settingsReset: t("默认", "Reset"),
    nodeScale: t("节点大小", "Node size"),
    edgeScale: t("连线粗细", "Edge width"),
    repel: t("斥力强度", "Repulsion"),
    linkDist: t("连线长度", "Link distance"),
    labelZoom: t("文字显隐阈值", "Label zoom"),
    retry: t("重试", "Retry"),
    close: t("关闭", "Close"),
    hint: t("单击节点看详情 · 双击聚焦 · Esc 关闭", "Click node for details · Double-click to focus · Esc to close"),
    engineInit: t("引擎：语义相似度", "Engine: Semantic similarity"),
  };

  function applyI18n() {
    document.documentElement.lang = isZh ? "zh-CN" : "en";
    document.title = t("记忆图谱", "Memory Graph");
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      if (I18N[key]) el.textContent = I18N[key];
    }
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
      const key = el.dataset.i18nPlaceholder;
      if (I18N[key]) el.placeholder = I18N[key];
    }
    for (const el of document.querySelectorAll("[data-i18n-title]")) {
      const key = el.dataset.i18nTitle;
      if (I18N[key]) el.title = I18N[key];
    }
    for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
      const key = el.dataset.i18nAriaLabel;
      if (I18N[key]) el.setAttribute("aria-label", I18N[key]);
    }
    if (els.counts && !state.data) els.counts.textContent = t("正在读取…", "Loading…");
    if (els.status && !state.data) els.status.textContent = t("正在启动本地服务…", "Starting local service…");
  }

  const els = {
    counts: $("#counts"),
    q: $("#q"),
    kindCount: $("#kind-count"),
    scopeCount: $("#scope-count"),
    tagCount: $("#tag-count"),
    optMinSim: $("#opt-min-sim"),
    minSimVal: $("#min-sim-val"),
    hideSuperseded: $("#hide-superseded"),
    clearFilters: $("#clear-filters"),
    fit: $("#fit"),
    rebuild: $("#rebuild"),
    theme: $("#theme"),
    toggleSettings: $("#toggle-settings"),
    settingsPanel: $("#settings-panel"),
    settingsReset: $("#settings-reset"),
    zoomIn: $("#zoom-in"),
    zoomOut: $("#zoom-out"),
    ctrlFit: $("#ctrl-fit"),
    reheat: $("#reheat"),
    optNodeScale: $("#opt-node-scale"),
    optEdgeScale: $("#opt-edge-scale"),
    optRepel: $("#opt-repel"),
    optLinkDist: $("#opt-link-dist"),
    optLabelZoom: $("#opt-label-zoom"),
    progress: $("#progress"),
    progressText: $("#progress span"),
    canvas: $("#canvas"),
    tip: $("#tip"),
    legend: $("#legend"),
    banner: $("#banner"),
    bannerText: $("#banner span"),
    bannerRetry: $("#banner-retry"),
    bannerClose: $("#banner-close"),
    empty: $("#empty"),
    emptyTitle: $("#empty strong"),
    emptyText: $("#empty p"),
    emptyAction: $("#empty-action"),
    menu: $("#menu"),
    toast: $("#toast"),
    status: $("#status"),
    engine: $("#engine"),
  };

  const IDLE_MS = 5 * 60 * 1000;

  const state = {
    data: null,
    allEdges: null,
    byId: new Map(),
    adj: new Map(),
    visible: new Set(),
    status: { phase: "scanning" },
    builtAt: "",
    lastInteraction: Date.now(),
    pollTimer: 0,
    paused: false,
    filters: {
      q: "",
      kinds: new Set(),
      scopes: new Set(),
      tags: new Set(),
      minSim: 0.6,
      hideSuperseded: false,
    },
    menu: "",
    toastTimer: 0,
  };

  let card = null;

  const graph = window.MemoryGraph.create({
    svg: els.canvas,
    onSelect(node) {
      if (!node) {
        closeCard();
        setStatus();
        return;
      }
      openNodeCard(node);
      setStatus(t(`已选中：${node.title || node.id}`, `Selected: ${node.title || node.id}`));
    },
    onEdge(edge) {
      graph.select(null);
      openEdgeCard(edge);
      const a = state.byId.get(edge.a);
      const b = state.byId.get(edge.b);
      setStatus(t(`选中关联：${a?.title || edge.a} ↔ ${b?.title || edge.b}`, `Link: ${a?.title || edge.a} ↔ ${b?.title || edge.b}`));
    },
    onFocus(node) {
      if (!node) return;
      graph.focus(node.id);
      openNodeCard(node);
      setStatus(t(`聚焦：${node.title || node.id} 两跳以内`, `Focused: ${node.title || node.id} (2 hops)`));
    },
    onBackground() {
      closeCard();
      setStatus();
    },
    onView() {
      followView();
    },
  });

  const tip = window.MemoryTooltip.create(els.tip, {
    onTag(tag) {
      state.filters.tags.add(tag);
      applyFilters();
      renderBadges();
      toast(t(`已筛选标签 #${tag}`, `Filtered by #${tag}`));
    },
    onFocus(node) {
      graph.focus(node.id);
      graph.select(node.id);
      openNodeCard(node);
      setStatus(t(`聚焦：${node.title || node.id}`, `Focused: ${node.title || node.id}`));
    },
    onCopy(id) {
      toast(id ? t(`已复制 ${id}`, `Copied ${id}`) : t("复制失败，请手动选中", "Copy failed, select manually"));
    },
    onNotice(text) {
      if (text) toast(text);
    },
    onClose() {
      card = null;
      graph.select(null);
      setStatus();
    },
  });

  function cardContext() {
    return {
      adj: state.adj,
      byId: state.byId,
      edgeFor: (a, b) => graph.edgeBetween(a, b),
      isVisible: (id) => state.visible.has(id),
    };
  }

  function openNodeCard(node) {
    if (!node) return;
    card = { type: "node", id: node.id };
    tip.open(node, cardContext(), graph.screenPoint(node.id));
  }

  function openEdgeCard(edge) {
    if (!edge) return;
    card = { type: "edge", a: edge.a, b: edge.b };
    tip.openEdge(edge, cardContext(), graph.edgeScreenPoint(edge.a, edge.b));
  }

  function closeCard() {
    if (!card && !tip.visible) return;
    card = null;
    tip.close();
  }

  function syncOpenCard(visible, refresh = false) {
    if (!card || !tip.visible) return;
    if (card.type === "node") {
      const node = state.byId.get(card.id);
      if (!node || (visible && !visible.has(card.id))) {
        closeCard();
        return;
      }
      if (refresh) openNodeCard(node);
      return;
    }
    const edge = graph.edgeBetween(card.a, card.b);
    if (!edge || (visible && (!visible.has(card.a) || !visible.has(card.b)))) {
      closeCard();
      return;
    }
    if (refresh) openEdgeCard(edge);
  }

  // 缩放 / 平移 / 拖拽 / 布局微动时，让卡片跟着节点走。
  function followView() {
    if (!card || !tip.visible) return;
    if (card.type === "node") tip.anchor(graph.screenPoint(card.id));
    else tip.anchor(graph.edgeScreenPoint(card.a, card.b));
  }

  async function api(path, options = {}) {
    const headers = { "x-memory-graph-token": token };
    if (options.body) headers["content-type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function when(value) {
    const time = Date.parse(String(value || ""));
    if (!Number.isFinite(time)) return "—";
    const date = new Date(time);
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes(),
    )}`;
  }

  function toast(text) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = text;
    els.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function setStatus(text) {
    if (text) {
      els.status.textContent = text;
      return;
    }
    const data = state.data;
    if (!data) {
      els.status.textContent = t("正在启动本地服务…", "Starting local service…");
      return;
    }
    const cached = data.builtAt ? t(`缓存 ${when(data.builtAt)}`, `Cached ${when(data.builtAt)}`) : t("尚未建立缓存", "Not cached");
    const partial = data.complete === false ? t(" · 部分完成", " · Partial") : "";
    els.status.textContent = isZh
      ? `${data.nodes.length} 节点 · ${data.edges.length} 边 · ${cached}${partial}`
      : `${data.nodes.length} nodes · ${data.edges.length} edges · ${cached}${partial}`;
  }

  function showBanner(text, retry) {
    els.bannerText.textContent = text;
    els.banner.hidden = false;
    els.bannerRetry.onclick = retry || null;
    els.bannerRetry.hidden = !retry;
  }

  function hideBanner() {
    els.banner.hidden = true;
    els.bannerRetry.onclick = null;
  }

  function showEmpty(title, text, actionLabel, action) {
    els.empty.hidden = false;
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = text;
    if (actionLabel) {
      els.emptyAction.hidden = false;
      els.emptyAction.textContent = actionLabel;
      els.emptyAction.onclick = action;
    } else {
      els.emptyAction.hidden = true;
      els.emptyAction.onclick = null;
    }
  }

  function hideEmpty() {
    els.empty.hidden = true;
  }

  function buildIndexes(nodes, edges) {
    state.byId = new Map(nodes.map((node) => [node.id, node]));
    state.adj = new Map(nodes.map((node) => [node.id, new Set()]));
    for (const edge of edges) {
      state.adj.get(edge.a)?.add(edge.b);
      state.adj.get(edge.b)?.add(edge.a);
    }
  }

  function scopeGroup(scope) {
    const text = String(scope || "global");
    if (text === "global") return "global";
    if (text.startsWith("project:")) return "project";
    if (text.startsWith("agent:")) return "agent";
    return "global";
  }

  function renderGraphData(data, { keepLayout = false } = {}) {
    state.data = data;
    if (Array.isArray(data.allEdges)) state.allEdges = data.allEdges;
    state.builtAt = data.builtAt || "";
    if (typeof data.phase === "string" || typeof data.lastError === "string") {
      state.status = {
        ...state.status,
        ...(typeof data.phase === "string" ? { phase: data.phase } : {}),
        ...(typeof data.lastError === "string" ? { lastError: data.lastError } : {}),
      };
    }
    if (Number.isFinite(Number(data.minSimilarity))) {
      state.filters.minSim = Number(data.minSimilarity);
      if (els.optMinSim) els.optMinSim.value = state.filters.minSim.toFixed(2);
      if (els.minSimVal) els.minSimVal.textContent = state.filters.minSim.toFixed(2);
    }
    buildIndexes(data.nodes, data.edges);
    if (keepLayout) {
      graph.updateEdges(data.edges);
    } else {
      graph.setData(data.nodes, data.edges);
    }
    applyFilters({ refreshCard: true });
    if (!keepLayout && card?.type === "node" && state.byId.has(card.id) && state.visible.has(card.id)) {
      graph.select(card.id);
    }
    renderLegend(data);
    renderBadges();
    setStatus();
    hideBanner();

    if (data.vectorInfo?.matched > 0) {
      els.engine.textContent = t(
        `引擎：本地语义向量 (${data.vectorInfo.matched}/${data.vectorInfo.totalVisible})`,
        `Engine: Local semantic vectors (${data.vectorInfo.matched}/${data.vectorInfo.totalVisible})`,
      );
    } else {
      els.engine.textContent = t("引擎：本地词法+标签相似度", "Engine: Local lexical + tag similarity");
    }

    if (!data.nodes.length) {
      const status = state.status;
      if (!isOpaqueOrigin && status && status.phase && status.phase !== "idle" && status.phase !== "error") {
        showEmpty(
          t("正在读取记忆…", "Reading memories…"),
          t("正在扫描记忆目录并计算本地语义相似度。", "Scanning memory directory and computing local semantic similarity."),
        );
      } else if (status?.phase === "error") {
        showEmpty(
          t("没能读到记忆", "Failed to read memories"),
          status.lastError ||
            t(
              `检查 ${status.memoryDir || "~/.config/magpie/memory"} 是否存在。`,
              `Check whether ${status.memoryDir || "~/.config/magpie/memory"} exists.`,
            ),
          t("再试一次", "Retry"),
          () => retry(),
        );
      } else {
        showEmpty(
          t("还没有可显示的记忆", "No memories to display"),
          t(
            "让 magpie 先记住几件事，或者检查记忆目录是否有 status: active 的 m_*.md。",
            "Save a few memories in magpie first, or check for active m_*.md files in your memory directory.",
          ),
          t("重新扫描", "Rescan"),
          () => retry(),
        );
      }
    } else {
      hideEmpty();
    }
  }

  function computeFilteredEdges(nodes, allEdges, minSim) {
    const filtered = allEdges.filter(
      (e) => e.lineage || e.source === "lineage" || Number(e.sim) >= minSim,
    );
    const deg = new Map();
    const strength = new Map();
    for (const e of filtered) {
      deg.set(e.a, (deg.get(e.a) || 0) + 1);
      deg.set(e.b, (deg.get(e.b) || 0) + 1);
      const s = Number(e.sim) || 0;
      strength.set(e.a, (strength.get(e.a) || 0) + s);
      strength.set(e.b, (strength.get(e.b) || 0) + s);
    }
    for (const n of nodes) {
      n.degree = deg.get(n.id) || 0;
      n.strengthSum = Number((strength.get(n.id) || 0).toFixed(4));
    }
    return filtered;
  }

  function filterEdgesLocally(minSim) {
    if (!state.data || !Array.isArray(state.allEdges)) return;
    const filtered = computeFilteredEdges(state.data.nodes, state.allEdges, minSim);
    state.data.edges = filtered;
    state.data.minSimilarity = minSim;
    buildIndexes(state.data.nodes, filtered);
    graph.updateEdges(filtered);
    applyFilters({ refreshCard: true });
    setStatus();
  }

  async function load({ keepLayout = false } = {}) {
    try {
      const qs = `?minSim=${encodeURIComponent(state.filters.minSim.toFixed(2))}`;
      const data = await api(`/api/graph${qs}`);
      renderGraphData(data, { keepLayout });
    } catch (error) {
      if (error.status === 401) {
        showBanner(
          t(
            "页面口令失效了。请从 magpie 的插件入口重新打开记忆图谱。",
            "Page token expired. Please reopen Memory Graph from magpie.",
          ),
        );
      } else {
        showBanner(t(`加载失败：${error.message}`, `Failed to load: ${error.message}`), () => retry());
      }
    }
  }

  function retry() {
    hideBanner();
    if (isOpaqueOrigin) {
      rebuild();
      return;
    }
    load();
  }

  function applyFilters({ refreshCard = false } = {}) {
    const data = state.data;
    if (!data) return;

    const filters = state.filters;
    const query = filters.q.trim().toLowerCase();
    const visible = new Set();

    for (const node of data.nodes) {
      if (filters.hideSuperseded && node.status === "superseded") continue;
      if (filters.kinds.size && !filters.kinds.has(node.kind)) continue;
      if (filters.scopes.size && !filters.scopes.has(scopeGroup(node.scope))) continue;
      if (filters.tags.size && ![...filters.tags].every((tag) => node.tags?.includes(tag))) continue;
      if (query) {
        const haystack = `${node.title || ""}\n${node.body || ""}\n${(node.tags || []).join(" ")}\n${
          node.id
        }`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      visible.add(node.id);
    }

    state.visible = visible;
    graph.setVisible(visible);
    syncOpenCard(visible, refreshCard);

    let edgeCount = 0;
    for (const edge of data.edges) {
      if (!visible.has(edge.a) || !visible.has(edge.b)) continue;
      edgeCount++;
    }

    els.counts.textContent = isZh
      ? `${visible.size}/${data.nodes.length} 节点 · ${edgeCount} 边`
      : `${visible.size}/${data.nodes.length} nodes · ${edgeCount} edges`;
    setStatus();

    if (data.nodes.length && !visible.size) {
      showEmpty(
        t("当前筛选没有结果", "No matching memories"),
        t("把搜索词或类型/范围/标签清掉再看看。", "Clear the search query or kind/scope/tag filters to see all nodes."),
        t("清空筛选", "Clear filters"),
        () => clearFilters(),
      );
    } else if (data.nodes.length) {
      hideEmpty();
    }
  }

  function clearFilters() {
    state.filters.q = "";
    state.filters.kinds.clear();
    state.filters.scopes.clear();
    state.filters.tags.clear();
    state.filters.hideSuperseded = false;
    els.q.value = "";
    els.hideSuperseded.checked = false;
    renderBadges();
    applyFilters();
  }

  function renderBadges() {
    els.kindCount.textContent = state.filters.kinds.size ? String(state.filters.kinds.size) : "";
    els.scopeCount.textContent = state.filters.scopes.size ? String(state.filters.scopes.size) : "";
    els.tagCount.textContent = state.filters.tags.size ? String(state.filters.tags.size) : "";
    els.kindCount.parentElement.classList.toggle("active", state.filters.kinds.size > 0);
    els.scopeCount.parentElement.classList.toggle("active", state.filters.scopes.size > 0);
    els.tagCount.parentElement.classList.toggle("active", state.filters.tags.size > 0);
    const hasAny = Boolean(
      state.filters.q.trim() ||
        state.filters.kinds.size ||
        state.filters.scopes.size ||
        state.filters.tags.size ||
        state.filters.hideSuperseded,
    );
    if (els.clearFilters) els.clearFilters.hidden = !hasAny;
    renderLegend(state.data);
  }

  function renderLegend(data) {
    if (!data) return;
    els.legend.textContent = "";
    const counts = new Map();
    for (const node of data.nodes) counts.set(node.kind, (counts.get(node.kind) || 0) + 1);
    for (const kind of KIND_ORDER) {
      if (!counts.get(kind)) continue;
      const item = document.createElement("button");
      item.type = "button";
      item.className = `legend-item${state.filters.kinds.has(kind) ? " active" : ""}`;
      item.title = t("点击快速筛选此类型", "Click to filter by this kind");
      const dot = document.createElement("i");
      dot.style.background = `var(--k-${kind})`;
      item.append(dot, `${KIND_LABEL[kind] || kind} ${counts.get(kind)}`);
      item.addEventListener("click", () => {
        if (state.filters.kinds.has(kind)) state.filters.kinds.delete(kind);
        else state.filters.kinds.add(kind);
        applyFilters();
        renderBadges();
      });
      els.legend.appendChild(item);
    }
    const superseded = data.nodes.filter((node) => node.status === "superseded").length;
    if (superseded) {
      const item = document.createElement("span");
      item.className = "legend-note";
      item.textContent = t(`空心虚线环 = 已取代 ${superseded}`, `Dashed ring = Superseded ${superseded}`);
      els.legend.appendChild(item);
    }
  }

  function menuButton(title, onClear) {
    const head = document.createElement("div");
    head.className = "menu-head";
    head.textContent = title;
    if (onClear) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = t("清空", "Clear");
      clear.style.cssText =
        "float:right;border:0;background:transparent;color:var(--accent);cursor:pointer;font-size:10px;padding:0";
      clear.addEventListener("click", onClear);
      head.appendChild(clear);
    }
    return head;
  }

  function optionRow(label, checked, count, dotColor, onChange) {
    const row = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", onChange);
    row.appendChild(input);
    if (dotColor) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = dotColor;
      row.appendChild(dot);
    }
    const text = document.createElement("span");
    text.textContent = label;
    row.appendChild(text);
    if (count != null) {
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(count);
      row.appendChild(n);
    }
    return row;
  }

  function openMenu(kind, anchor) {
    if (state.menu === kind && !els.menu.hidden) {
      closeMenu();
      return;
    }
    state.menu = kind;
    els.menu.textContent = "";
    els.menu.hidden = false;

    const data = state.data;
    if (!data) return;

    if (kind === "kind") {
      const counts = new Map();
      for (const node of data.nodes) counts.set(node.kind, (counts.get(node.kind) || 0) + 1);
      els.menu.appendChild(
        menuButton(t("按类型筛选", "Filter by kind"), () => {
          state.filters.kinds.clear();
          renderBadges();
          applyFilters();
        }),
      );
      for (const value of KIND_ORDER) {
        if (!counts.get(value)) continue;
        els.menu.appendChild(
          optionRow(
            KIND_LABEL[value] || value,
            state.filters.kinds.has(value),
            counts.get(value),
            `var(--k-${value})`,
            (event) => {
              if (event.target.checked) state.filters.kinds.add(value);
              else state.filters.kinds.delete(value);
              renderBadges();
              applyFilters();
            },
          ),
        );
      }
    }

    if (kind === "scope") {
      const counts = new Map();
      for (const node of data.nodes) {
        const group = scopeGroup(node.scope);
        counts.set(group, (counts.get(group) || 0) + 1);
      }
      els.menu.appendChild(
        menuButton(t("按范围筛选", "Filter by scope"), () => {
          state.filters.scopes.clear();
          renderBadges();
          applyFilters();
        }),
      );
      for (const value of ["global", "project", "agent"]) {
        if (!counts.get(value)) continue;
        els.menu.appendChild(
          optionRow(SCOPE_LABEL[value], state.filters.scopes.has(value), counts.get(value), null, (event) => {
            if (event.target.checked) state.filters.scopes.add(value);
            else state.filters.scopes.delete(value);
            renderBadges();
            applyFilters();
          }),
        );
      }
    }

    if (kind === "tag") {
      els.menu.appendChild(
        menuButton(t("按标签筛选", "Filter by tag"), () => {
          state.filters.tags.clear();
          renderBadges();
          applyFilters();
        }),
      );
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = t("找标签…", "Find tag…");
      els.menu.appendChild(search);

      const counts = new Map();
      for (const node of data.nodes) {
        for (const tag of node.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const list = document.createElement("div");
      els.menu.appendChild(list);

      const paint = () => {
        list.textContent = "";
        const query = search.value.trim().toLowerCase();
        const rows = sorted
          .filter(([tag]) => !query || tag.toLowerCase().includes(query))
          .slice(0, 40);
        if (!rows.length) {
          const note = document.createElement("div");
          note.className = "empty-note";
          note.textContent = t("没有匹配的标签", "No matching tags");
          list.appendChild(note);
          return;
        }
        for (const [tag, count] of rows) {
          list.appendChild(
            optionRow(`#${tag}`, state.filters.tags.has(tag), count, null, (event) => {
              if (event.target.checked) state.filters.tags.add(tag);
              else state.filters.tags.delete(tag);
              renderBadges();
              applyFilters();
            }),
          );
        }
      };

      search.addEventListener("input", paint);
      paint();
      setTimeout(() => search.focus(), 0);
    }

    const stage = els.canvas.parentElement.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const menuRect = els.menu.getBoundingClientRect();
    let left = rect.left - stage.left;
    let top = rect.bottom - stage.top + 6;
    if (left + menuRect.width > stage.width - 8) left = stage.width - menuRect.width - 8;
    if (top + menuRect.height > stage.height - 8) top = rect.top - stage.top - menuRect.height - 6;
    els.menu.style.left = `${Math.max(8, left)}px`;
    els.menu.style.top = `${Math.max(8, top)}px`;
  }

  function closeMenu() {
    state.menu = "";
    els.menu.hidden = true;
  }

  function renderProgress(status) {
    if (!status) return;
    const phase = status.phase || "idle";
    const busy = phase !== "idle" && phase !== "error" && phase !== "asleep";
    els.progress.hidden = !busy;

    if (phase === "scanning") {
      els.progressText.textContent = t("扫描记忆目录…", "Scanning memory directory…");
      els.progress.style.setProperty("--p", "25%");
    } else if (phase === "computing") {
      els.progressText.textContent = t("计算本地语义相似度…", "Computing local semantic similarity…");
      els.progress.style.setProperty("--p", "70%");
    } else if (phase === "writing") {
      els.progressText.textContent = t("写入缓存…", "Writing cache…");
      els.progress.style.setProperty("--p", "96%");
    } else if (phase === "error") {
      els.progress.hidden = true;
      showBanner(t(`构建失败：${status.lastError || "未知错误"}`, `Build failed: ${status.lastError || "Unknown error"}`), () => retry());
    } else if (phase === "asleep") {
      els.progress.hidden = true;
    }

    if (busy) {
      els.rebuild.disabled = true;
      els.rebuild.textContent = t("计算中…", "Building…");
    } else {
      els.rebuild.disabled = false;
      els.rebuild.textContent = t("刷新", "Refresh");
    }

    if (status.vectorInfo?.matched > 0) {
      els.engine.textContent = t(
        `引擎：本地语义向量 (${status.vectorInfo.matched}/${status.vectorInfo.totalVisible})`,
        `Engine: Local semantic vectors (${status.vectorInfo.matched}/${status.vectorInfo.totalVisible})`,
      );
    } else if (status.cached) {
      els.engine.textContent = t("引擎：本地词法+标签相似度", "Engine: Local lexical + tag similarity");
    }

    if (phase === "idle" && status.lastBuiltAt && status.lastBuiltAt !== state.builtAt) {
      state.builtAt = status.lastBuiltAt;
      load();
    }
  }

  async function poll() {
    if (isOpaqueOrigin) return;
    clearTimeout(state.pollTimer);
    state.pollTimer = 0;

    // 页面在后台：不发请求，让服务自己按空闲策略休眠。
    if (document.hidden) {
      state.pollTimer = setTimeout(poll, 15000);
      return;
    }

    // 前台但 5 分钟没人动：停止轮询（服务端也会跟着休眠），任意交互立即恢复。
    if (Date.now() - state.lastInteraction >= IDLE_MS) {
      state.paused = true;
      els.status.textContent = t("已休眠（空闲 5 分钟）· 动一下鼠标唤醒", "Idle (5m) · Move mouse to wake");
      return;
    }
    state.paused = false;

    try {
      const status = await api("/api/status");
      state.status = status;
      renderProgress(status);
      if (status.phase === "idle" && status.lastBuiltAt && status.lastBuiltAt !== state.builtAt) {
        state.builtAt = status.lastBuiltAt;
        await load();
      }
      if (status.phase === "idle" && !state.data?.nodes?.length) {
        await load();
      }
    } catch (error) {
      if (error.status === 401) {
        showBanner(
          t(
            "页面口令失效了。请从 magpie 的插件入口重新打开记忆图谱。",
            "Page token expired. Please reopen Memory Graph from magpie.",
          ),
        );
      }
    }
    const busy = state.status && !["idle", "error", "asleep"].includes(state.status.phase);
    state.pollTimer = setTimeout(poll, busy ? 1000 : 5000);
  }

  function markActive() {
    if (isOpaqueOrigin) return;
    state.lastInteraction = Date.now();
    if (!state.paused && state.pollTimer) return;
    if (state.paused) {
      state.paused = false;
      setStatus(t("已唤醒，正在载入…", "Waking up, loading…"));
    }
    if (state.pollTimer) return;
    poll();
  }

  async function rebuild() {
    if (isOpaqueOrigin) {
      if (!token) {
        showBanner(
          t(
            "页面口令缺失或已失效，请从 magpie 的插件入口重新打开记忆图谱。",
            "Page token missing or expired. Please reopen Memory Graph from magpie.",
          ),
        );
        return;
      }
      const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      location.replace(
        `/?refresh=1&t=${encodeURIComponent(token)}&minSim=${state.filters.minSim.toFixed(2)}&theme=${currentTheme}&lang=${lang}`,
      );
      return;
    }
    try {
      const result = await api("/api/rebuild", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (result.started) {
        toast(t("正在重新扫描并计算相似度…", "Rescanning memories and computing similarity…"));
        els.rebuild.disabled = true;
        els.rebuild.textContent = t("计算中…", "Building…");
      } else {
        toast(t("正在计算中", "Already building"));
      }
    } catch (error) {
      showBanner(t(`刷新失败：${error.message}`, `Refresh failed: ${error.message}`), () => rebuild());
    }
  }

  function applyTheme(value) {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("memory-graph-theme", value);
    } catch {
      /* 隐私模式写不了 */
    }
  }

  function initialTheme() {
    const fromUrl = new URLSearchParams(location.search).get("theme");
    if (fromUrl === "dark" || fromUrl === "light") return fromUrl;
    try {
      const saved = localStorage.getItem("memory-graph-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      /* 读不到就用系统 */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }

  function bind() {
    els.q.addEventListener("input", () => {
      clearTimeout(bind.timer);
      bind.timer = setTimeout(() => {
        state.filters.q = els.q.value;
        applyFilters();
      }, 150);
    });

    els.optMinSim?.addEventListener("input", () => {
      const val = Number(els.optMinSim.value);
      state.filters.minSim = Number.isFinite(val) ? val : 0.6;
      if (els.minSimVal) els.minSimVal.textContent = state.filters.minSim.toFixed(2);
      if (Array.isArray(state.allEdges)) {
        filterEdgesLocally(state.filters.minSim);
        return;
      }
      if (isOpaqueOrigin) return;
      clearTimeout(bind.simTimer);
      bind.simTimer = setTimeout(() => {
        load({ keepLayout: true });
      }, 90);
    });

    els.hideSuperseded.addEventListener("change", () => {
      state.filters.hideSuperseded = els.hideSuperseded.checked;
      renderBadges();
      applyFilters();
    });

    for (const button of document.querySelectorAll("[data-menu]")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openMenu(button.dataset.menu, button);
      });
    }

    document.addEventListener("pointerdown", (event) => {
      if (els.menu.hidden) return;
      if (els.menu.contains(event.target)) return;
      if (event.target.closest?.("[data-menu]")) return;
      closeMenu();
    });

    els.fit.addEventListener("click", () => graph.zoomToFit());
    els.ctrlFit?.addEventListener("click", () => graph.zoomToFit());
    els.zoomIn?.addEventListener("click", () => graph.zoomBy(1.25));
    els.zoomOut?.addEventListener("click", () => graph.zoomBy(0.8));
    els.reheat?.addEventListener("click", () => graph.reheat(0.85));
    els.clearFilters?.addEventListener("click", () => clearFilters());
    els.rebuild.addEventListener("click", () => rebuild());
    els.bannerClose.addEventListener("click", () => hideBanner());

    const syncVisual = () => {
      graph.setVisual({
        nodeScale: Number(els.optNodeScale?.value || 1),
        edgeScale: Number(els.optEdgeScale?.value || 1),
        repel: Number(els.optRepel?.value || 1),
        linkDist: Number(els.optLinkDist?.value || 1),
        labelZoom: Number(els.optLabelZoom?.value || 1.45),
      });
    };
    for (const slider of [
      els.optNodeScale,
      els.optEdgeScale,
      els.optRepel,
      els.optLinkDist,
      els.optLabelZoom,
    ]) {
      slider?.addEventListener("input", syncVisual);
    }
    els.toggleSettings?.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = els.settingsPanel.hidden;
      els.settingsPanel.hidden = !open;
      els.toggleSettings.classList.toggle("active", open);
    });
    els.settingsReset?.addEventListener("click", () => {
      if (els.optNodeScale) els.optNodeScale.value = "1";
      if (els.optEdgeScale) els.optEdgeScale.value = "1";
      if (els.optRepel) els.optRepel.value = "1";
      if (els.optLinkDist) els.optLinkDist.value = "1";
      if (els.optLabelZoom) els.optLabelZoom.value = "1.45";
      syncVisual();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!els.settingsPanel || els.settingsPanel.hidden) return;
      if (els.settingsPanel.contains(event.target) || event.target === els.toggleSettings) return;
      els.settingsPanel.hidden = true;
      els.toggleSettings?.classList.remove("active");
    });

    els.theme.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });

    window.addEventListener("keydown", (event) => {
      const tag = document.activeElement?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA";
      if (event.key === "Escape") {
        if (editing) document.activeElement.blur();
        graph.reset();
        closeCard();
        closeMenu();
      } else if (!editing && (event.key === "0" || event.key.toLowerCase() === "f")) {
        graph.zoomToFit();
      } else if (!editing && (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"))) {
        event.preventDefault();
        els.q.focus();
      }
    });
    // 交互即「有人在场」：休眠后动一下鼠标就能恢复轮询。
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      window.addEventListener(type, () => markActive(), { passive: type !== "keydown" });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden || isOpaqueOrigin) return;
      state.lastInteraction = Date.now();
      state.paused = false;
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
      poll();
    });
  }

  applyTheme(initialTheme());
  if (location.search) {
    try {
      const clean = new URL(location.href);
      if (clean.searchParams.has("t") || clean.searchParams.has("refresh")) {
        clean.searchParams.delete("t");
        clean.searchParams.delete("refresh");
        history.replaceState(null, "", clean.pathname + (clean.search || ""));
      }
    } catch {
      /* ignore */
    }
  }
  applyI18n();
  bind();
  const rawMinSim = new URLSearchParams(location.search).get("minSim");
  const parsedMinSim = rawMinSim !== null && rawMinSim !== "" ? Number(rawMinSim) : NaN;
  const urlMinSim = Number.isFinite(parsedMinSim) ? Math.max(0.35, Math.min(0.9, parsedMinSim)) : null;
  if (urlMinSim !== null) {
    state.filters.minSim = urlMinSim;
    if (els.optMinSim) els.optMinSim.value = urlMinSim.toFixed(2);
    if (els.minSimVal) els.minSimVal.textContent = urlMinSim.toFixed(2);
  }
  if (window.__INITIAL_GRAPH__) {
    const initial = window.__INITIAL_GRAPH__;
    state.allEdges = Array.isArray(initial.allEdges) ? initial.allEdges : (initial.edges || []);
    const effectiveInitial =
      urlMinSim !== null
        ? {
            ...initial,
            edges: computeFilteredEdges(initial.nodes || [], state.allEdges, urlMinSim),
            minSimilarity: urlMinSim,
          }
        : initial;
    renderGraphData(effectiveInitial);
  } else {
    load();
  }
  if (!isOpaqueOrigin) poll();
})();

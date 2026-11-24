// 本文由AI自动生成
// 页面控制器：拉数据、筛选、轮询构建进度、维护悬浮卡与状态栏。

(function () {
  const token = document.querySelector('meta[name="memory-graph-token"]')?.content || "";
  const $ = (selector) => document.querySelector(selector);

  const KIND_LABEL = {
    profile: "个人档案",
    preference: "偏好",
    rule: "规则",
    fact: "事实",
    procedure: "流程",
    episode: "经历",
    reference: "参考",
    unknown: "未分类",
  };

  const KIND_ORDER = ["profile", "preference", "rule", "fact", "procedure", "episode", "reference", "unknown"];
  const SCOPE_LABEL = { global: "全局", project: "项目", agent: "Agent" };

  const els = {
    counts: $("#counts"),
    q: $("#q"),
    kindCount: $("#kind-count"),
    scopeCount: $("#scope-count"),
    tagCount: $("#tag-count"),
    onlyMutual: $("#only-mutual"),
    hideSuperseded: $("#hide-superseded"),
    fit: $("#fit"),
    rebuild: $("#rebuild"),
    theme: $("#theme"),
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
    byId: new Map(),
    adj: new Map(),
    edgeList: [],
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
      mutual: false,
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
      setStatus(`已选中：${node.title || node.id}`);
    },
    onEdge(edge) {
      graph.select(null);
      openEdgeCard(edge);
      const a = state.byId.get(edge.a);
      const b = state.byId.get(edge.b);
      setStatus(`选中关联：${a?.title || edge.a} ↔ ${b?.title || edge.b}`);
    },
    onFocus(node) {
      if (!node) return;
      graph.focus(node.id);
      openNodeCard(node);
      setStatus(`聚焦：${node.title || node.id} 两跳以内`);
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
      toast(`已筛选标签 #${tag}`);
    },
    onFocus(node) {
      graph.focus(node.id);
      graph.select(node.id);
      openNodeCard(node);
      setStatus(`聚焦：${node.title || node.id}`);
    },
    onCopy(id) {
      toast(id ? `已复制 ${id}` : "复制失败，请手动选中");
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
      els.status.textContent = "正在启动本地服务…";
      return;
    }
    const cached = data.builtAt ? `缓存 ${when(data.builtAt)}` : "尚未建立缓存";
    els.status.textContent = `${data.nodes.length} 节点 · ${data.edges.length} 边 · ${cached}${
      data.complete === false ? " · 部分完成" : ""
    }`;
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
    state.edgeList = edges;
  }

  function scopeGroup(scope) {
    const text = String(scope || "global");
    if (text === "global") return "global";
    if (text.startsWith("project:")) return "project";
    if (text.startsWith("agent:")) return "agent";
    return "global";
  }

  async function load() {
    try {
      const data = await api("/api/graph");
      state.data = data;
      state.builtAt = data.builtAt || "";
      buildIndexes(data.nodes, data.edges);
      graph.setData(data.nodes, data.edges);
      applyFilters();
      renderLegend(data);
      renderBadges();
      setStatus();
      hideBanner();

      if (data.mcp?.lastError) {
        showBanner(`构建出错：${data.mcp.lastError}`, () => retry());
      } else if (data.complete === false) {
        showBanner("这次构建只跑完一部分，点重试可以接着补。", () => retry());
      }

      if (!data.nodes.length) {
        const status = state.status;
        if (status && status.phase && status.phase !== "idle" && status.phase !== "error") {
          showEmpty("正在读取记忆…", "第一次打开会扫描记忆目录并逐条调用 memory_search，先等一下。");
        } else if (status?.phase === "error") {
          showEmpty(
            "没能读到记忆",
            status.lastError || `检查 ${status.memoryDir || "~/.config/magpie/memory"} 是否存在。`,
            "再试一次",
            () => retry(),
          );
        } else {
          showEmpty(
            "还没有可显示的记忆",
            "让 magpie 先记住几件事，或者检查记忆目录是否有 status: active 的 m_*.md。",
            "重新扫描",
            () => retry(),
          );
        }
      } else {
        hideEmpty();
      }
    } catch (error) {
      if (error.status === 401) {
        showBanner("页面口令失效了。请从 magpie 的插件入口重新打开记忆图谱。");
      } else {
        showBanner(`加载失败：${error.message}`, () => load());
      }
    }
  }

  function retry() {
    hideBanner();
    load();
  }

  function applyFilters() {
    const data = state.data;
    if (!data) return;

    const filters = state.filters;
    const query = filters.q.trim().toLowerCase();
    const visible = new Set();
    const mutualNodes = new Set();
    const allowedEdges = filters.mutual ? new Set() : null;

    for (const edge of data.edges) {
      if (!edge.m) continue;
      mutualNodes.add(edge.a);
      mutualNodes.add(edge.b);
      allowedEdges?.add(edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`);
    }

    for (const node of data.nodes) {
      if (filters.hideSuperseded && node.status === "superseded") continue;
      if (filters.kinds.size && !filters.kinds.has(node.kind)) continue;
      if (filters.scopes.size && !filters.scopes.has(scopeGroup(node.scope))) continue;
      if (filters.tags.size && ![...filters.tags].every((tag) => node.tags?.includes(tag))) continue;
      if (filters.mutual && !mutualNodes.has(node.id)) continue;
      if (query) {
        const haystack = `${node.title || ""}\n${node.body || ""}\n${(node.tags || []).join(" ")}\n${
          node.id
        }`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      visible.add(node.id);
    }

    graph.setVisible(visible, allowedEdges);

    let edgeCount = 0;
    for (const edge of data.edges) {
      if (!visible.has(edge.a) || !visible.has(edge.b)) continue;
      if (filters.mutual && !edge.m) continue;
      edgeCount++;
    }

    els.counts.textContent = `${visible.size}/${data.nodes.length} 节点 · ${edgeCount} 边`;
    setStatus();

    if (data.nodes.length && !visible.size) {
      showEmpty("当前筛选没有结果", "把搜索词或类型/范围/标签清掉再看看。", "清空筛选", () => clearFilters());
    } else if (data.nodes.length) {
      hideEmpty();
    }
  }

  function clearFilters() {
    state.filters.q = "";
    state.filters.kinds.clear();
    state.filters.scopes.clear();
    state.filters.tags.clear();
    state.filters.mutual = false;
    state.filters.hideSuperseded = false;
    els.q.value = "";
    els.onlyMutual.checked = false;
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
  }

  function renderLegend(data) {
    els.legend.textContent = "";
    const counts = new Map();
    for (const node of data.nodes) counts.set(node.kind, (counts.get(node.kind) || 0) + 1);
    for (const kind of KIND_ORDER) {
      if (!counts.get(kind)) continue;
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = `var(--k-${kind})`;
      item.append(dot, `${KIND_LABEL[kind] || kind} ${counts.get(kind)}`);
      els.legend.appendChild(item);
    }
    const superseded = data.nodes.filter((node) => node.status === "superseded").length;
    if (superseded) {
      const item = document.createElement("span");
      item.textContent = `虚线环 = 已取代 ${superseded}`;
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
      clear.textContent = "清空";
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
        menuButton("按类型筛选", () => {
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
        menuButton("按范围筛选", () => {
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
        menuButton("按标签筛选", () => {
          state.filters.tags.clear();
          renderBadges();
          applyFilters();
        }),
      );
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "找标签…";
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
          note.textContent = "没有匹配的标签";
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
      els.progressText.textContent = "扫描记忆目录…";
      els.progress.style.setProperty("--p", "8%");
    } else if (phase === "querying") {
      const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
      els.progressText.textContent = `语义查询 ${status.done}/${status.total} · 并发 ${status.concurrency || ""}`.trim();
      els.progress.style.setProperty("--p", `${pct}%`);
    } else if (phase === "writing" || phase === "ranking") {
      els.progressText.textContent = "计算关联并写入缓存…";
      els.progress.style.setProperty("--p", "96%");
    } else if (phase === "error") {
      els.progress.hidden = true;
      showBanner(`构建失败：${status.lastError || "未知错误"}`, () => retry());
    } else if (phase === "asleep") {
      els.progress.hidden = true;
    }

    if (busy) {
      els.rebuild.disabled = true;
      els.rebuild.textContent = "构建中…";
    } else {
      els.rebuild.disabled = false;
      els.rebuild.textContent = "重建全部";
    }

    els.engine.textContent = `引擎：memory_search · ${status.counts?.queried || 0}/${status.counts?.active || 0} 条已查询`;

    if (phase === "idle" && status.lastBuiltAt && status.lastBuiltAt !== state.builtAt) {
      state.builtAt = status.lastBuiltAt;
      load();
    }
  }

  async function poll() {
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
      els.status.textContent = "已休眠（空闲 5 分钟）· 动一下鼠标唤醒";
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
        showBanner("页面口令失效了。请从 magpie 的插件入口重新打开记忆图谱。");
      }
    }
    const busy = state.status && !["idle", "error", "asleep"].includes(state.status.phase);
    state.pollTimer = setTimeout(poll, busy ? 1000 : 5000);
  }

  function markActive() {
    state.lastInteraction = Date.now();
    if (!state.paused && state.pollTimer) return;
    if (state.paused) {
      state.paused = false;
      setStatus("已唤醒，正在载入…");
    }
    if (state.pollTimer) return;
    poll();
  }

  async function rebuild() {
    if (!window.confirm("重新查询全部 active 记忆？按当前数量大约需要几十秒。")) return;
    try {
      const result = await api("/api/rebuild", {
        method: "POST",
        body: JSON.stringify({ mode: "all" }),
      });
      if (result.started) {
        toast("已开始重建，图会边算边更新");
        els.rebuild.disabled = true;
        els.rebuild.textContent = "构建中…";
      } else {
        toast("已经有一个构建在跑");
      }
    } catch (error) {
      showBanner(`重建失败：${error.message}`, () => rebuild());
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

    els.onlyMutual.addEventListener("change", () => {
      state.filters.mutual = els.onlyMutual.checked;
      applyFilters();
    });

    els.hideSuperseded.addEventListener("change", () => {
      state.filters.hideSuperseded = els.hideSuperseded.checked;
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
    els.rebuild.addEventListener("click", () => rebuild());
    els.bannerClose.addEventListener("click", () => hideBanner());

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
      } else if (!editing && (event.key === "/" || (event.metaKey && event.key.toLowerCase() === "k"))) {
        event.preventDefault();
        els.q.focus();
      }
    });
    // 交互即「有人在场」：休眠后动一下鼠标就能恢复轮询。
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      window.addEventListener(type, () => markActive(), { passive: type !== "keydown" });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      state.lastInteraction = Date.now();
      state.paused = false;
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
      poll();
    });
  }

  applyTheme(initialTheme());
  bind();
  load();
  poll();
})();

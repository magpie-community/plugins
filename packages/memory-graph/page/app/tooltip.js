// 本文由AI自动生成
// 悬浮详情卡：延迟出现、靠近光标、越界翻转、可滚动静止、移入卡片不消失。

(function () {
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

  const STATUS_LABEL = {
    active: "活跃",
    superseded: "已被取代",
    candidate: "候选",
    archived: "归档",
  };

  const pad = (value) => String(value).padStart(2, "0");

  function when(value) {
    const time = Date.parse(String(value || ""));
    if (!Number.isFinite(time)) return value || "—";
    const date = new Date(time);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  }

  function shortDir(value) {
    const text = String(value || "");
    if (!text) return "";
    const parts = text.split("/").filter(Boolean);
    return parts.length <= 2 ? text : `…/${parts.slice(-2).join("/")}`;
  }

  const MAX_LINKS = 6;
  const SOURCE_LABEL = {
    vector: "向量",
    lexical: "词法",
    lineage: "演进",
  };

  function formatSim(edge) {
    if (edge?.source === "lineage") return "演进";
    const pct = Number.isFinite(Number(edge?.sim)) ? `${Math.round(Number(edge.sim) * 100)}%` : "";
    const parts = [];
    if (pct) parts.push(pct);
    if (edge?.lineage) parts.push("演进");
    else if (SOURCE_LABEL[edge?.source]) parts.push(SOURCE_LABEL[edge.source]);
    return parts.join(" · ");
  }

  function create(el, handlers = {}) {
    let currentId = "";
    let size = { w: 0, h: 0 };

    el.textContent = "";

    const head = document.createElement("div");
    head.className = "tip-head";

    const kind = document.createElement("span");
    kind.className = "tip-kind";

    const idButton = document.createElement("button");
    idButton.type = "button";
    idButton.className = "tip-id";
    idButton.title = "复制记忆 id";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "tip-close";
    closeButton.title = "关闭";
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => {
      close();
      handlers.onClose?.();
    });

    head.append(kind, idButton, closeButton);

    const title = document.createElement("div");
    title.className = "tip-title";

    const meta = document.createElement("div");
    meta.className = "tip-meta";

    const body = document.createElement("div");
    body.className = "tip-body";

    const truncated = document.createElement("div");
    truncated.className = "tip-truncated";

    const why = document.createElement("details");
    why.className = "tip-why";
    const whySummary = document.createElement("summary");
    whySummary.textContent = "为什么记下它";
    const whyText = document.createElement("p");
    why.append(whySummary, whyText);

    const tags = document.createElement("div");
    tags.className = "tip-tags";

    const times = document.createElement("div");
    times.className = "tip-times";

    const sources = document.createElement("div");
    sources.className = "tip-sources";

    const links = document.createElement("div");
    links.className = "tip-links";

    const foot = document.createElement("div");
    foot.className = "tip-foot";

    el.append(head, title, meta, body, truncated, why, tags, times, links, sources, foot);

    idButton.addEventListener("click", async () => {
      if (!currentId) return;
      try {
        await navigator.clipboard.writeText(currentId);
        handlers.onCopy?.(currentId);
      } catch {
        handlers.onCopy?.("");
      }
    });

    // 点击驱动的卡片：不再靠 hover 计时器，开着就一直开着，直到 close()。
    function measure() {
      size = { w: el.offsetWidth || 380, h: el.offsetHeight || 300 };
    }

    function place(point) {
      const gap = 14;
      const radius = point.r || 0;
      let left = point.x + radius + gap;
      let top = point.y - 18;
      if (left + size.w > window.innerWidth - 8) left = point.x - radius - size.w - gap;
      if (top + size.h > window.innerHeight - 8) top = window.innerHeight - size.h - 8;
      left = Math.max(8, Math.min(left, window.innerWidth - size.w - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - size.h - 8));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    function anchor(point) {
      if (!point) return;
      if (el.hidden) return;
      if (!size.w) measure();
      place(point);
    }

    function close() {
      el.hidden = true;
      currentId = "";
      size = { w: 0, h: 0 };
    }

    function reset() {
      title.textContent = "";
      meta.textContent = "";
      body.textContent = "";
      body.hidden = false;
      truncated.textContent = "";
      truncated.hidden = true;
      why.hidden = true;
      whyText.textContent = "";
      tags.textContent = "";
      tags.hidden = true;
      times.textContent = "";
      times.hidden = true;
      sources.textContent = "";
      sources.hidden = true;
      links.textContent = "";
      links.hidden = true;
      foot.textContent = "";
      foot.hidden = true;
    }

    function addMeta(label, value) {
      if (!value) return;
      const span = document.createElement("span");
      span.textContent = label;
      const strong = document.createElement("b");
      strong.textContent = value;
      span.append(" ", strong);
      meta.appendChild(span);
    }

    function renderNode(node, ctx) {
      reset();
      currentId = node.id;

      kind.textContent = KIND_LABEL[node.kind] || node.kind || "未分类";
      kind.dataset.kind = node.kind || "unknown";
      el.dataset.kind = node.kind || "unknown";
      idButton.textContent = node.id;

      title.textContent = node.title || node.id;

      addMeta("范围", node.scopeLabel || node.scope);
      addMeta("状态", STATUS_LABEL[node.status] || node.status);
      addMeta("来源", node.origin);
      if (node.status === "superseded" && node.supersededBy) {
        const span = document.createElement("span");
        span.textContent = "取代者 ";
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "tip-jump";
        jump.textContent = node.supersededBy;
        jump.addEventListener("click", () => {
          const target = ctx.byId?.get(node.supersededBy);
          if (target) handlers.onFocus?.(target);
        });
        span.appendChild(jump);
        meta.appendChild(span);
      }

      body.textContent = node.body || "（正文为空）";
      if (node.bodyTruncated) {
        truncated.hidden = false;
        truncated.textContent = `正文已截断，完整内容见 ${node.id}.md`;
      }

      if (node.why) {
        why.hidden = false;
        why.open = node.why.length <= 100;
        whyText.textContent = node.why;
      }

      if (Array.isArray(node.tags) && node.tags.length) {
        tags.hidden = false;
        for (const tag of node.tags) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `#${tag}`;
          button.addEventListener("click", () => handlers.onTag?.(tag));
          tags.appendChild(button);
        }
      }

      if (node.created || node.updated) {
        times.hidden = false;
        times.append("创建", Object.assign(document.createElement("b"), { textContent: when(node.created) }));
        times.append("更新", Object.assign(document.createElement("b"), { textContent: when(node.updated) }));
      }

      if (Array.isArray(node.sources) && node.sources.length) {
        sources.hidden = false;
        const heading = document.createElement("div");
        heading.textContent = "记录来源";
        sources.appendChild(heading);
        for (const source of node.sources) {
          const block = document.createElement("div");
          block.className = "tip-source";
          block.textContent = [source.agent, shortDir(source.dir)].filter(Boolean).join(" · ") || "未知来源";
          if (source.quote) {
            const quote = document.createElement("em");
            quote.textContent = `“${source.quote}”`;
            block.appendChild(quote);
          }
          sources.appendChild(block);
        }
      }

      const related = [];
      for (const other of ctx.adj?.get(node.id) || []) {
        const edge = ctx.edgeFor?.(node.id, other);
        if (edge) related.push({ edge, other });
      }
      related.sort(
        (a, b) =>
          Number(Boolean(b.edge.lineage || b.edge.source === "lineage")) -
            Number(Boolean(a.edge.lineage || a.edge.source === "lineage")) ||
          (Number(b.edge.sim) || 0) - (Number(a.edge.sim) || 0),
      );

      if (related.length) {
        links.hidden = false;
        const heading = document.createElement("h4");
        heading.textContent =
          related.length > MAX_LINKS
            ? `关联 ${related.length} 条 · 显示最相似前 ${MAX_LINKS}`
            : `关联 ${related.length} 条`;
        links.appendChild(heading);
        for (const { edge, other } of related.slice(0, MAX_LINKS)) {
          const peer = ctx.byId?.get(other);
          if (!peer) continue;
          const row = document.createElement("button");
          row.type = "button";
          row.className = "tip-link";

          const dot = document.createElement("i");
          dot.className = "tip-link-dot";
          dot.dataset.kind = peer.kind || "unknown";

          const who = document.createElement("span");
          who.className = "who";
          who.textContent = peer.title || peer.id;

          const meta = document.createElement("span");
          meta.className = "s";
          meta.textContent = formatSim(edge);

          row.append(dot, who, meta);
          row.addEventListener("click", () => handlers.onFocus?.(peer));
          links.appendChild(row);
        }
      }

      foot.hidden = false;
      foot.textContent = `${node.degree || 0} 条关联 · 基于本地语义相似度`;
    }

    function renderEdge(edge, ctx) {
      reset();
      currentId = "";
      kind.textContent = edge.source === "lineage" ? "演进" : "语义关联";
      kind.dataset.kind = edge.source === "lineage" ? "procedure" : "reference";
      el.dataset.kind = edge.source === "lineage" ? "procedure" : "reference";
      idButton.textContent = `${edge.a} ↔ ${edge.b}`;
      const a = ctx.byId?.get(edge.a);
      const b = ctx.byId?.get(edge.b);
      title.textContent = `${a?.title || edge.a} ↔ ${b?.title || edge.b}`;
      if (edge.source !== "lineage" && Number.isFinite(Number(edge.sim))) {
        addMeta("相似度", `${(Number(edge.sim) * 100).toFixed(1)}%`);
      }
      addMeta(
        "来源",
        edge.source === "lineage"
          ? "记忆取代关系 (supersededBy)"
          : edge.source === "lexical"
            ? "词法 + 标签回退"
            : "本地多语言向量余弦",
      );
      if (edge.lineage && edge.source !== "lineage") {
        addMeta("演进", "存在取代关系 (supersededBy)");
      }

      links.hidden = false;
      for (const peer of [a, b]) {
        if (!peer) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tip-link";
        const dot = document.createElement("i");
        dot.className = "tip-link-dot";
        dot.dataset.kind = peer.kind || "unknown";
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = peer.title || peer.id;
        row.append(dot, who);
        row.addEventListener("click", () => handlers.onFocus?.(peer));
        links.appendChild(row);
      }

      foot.hidden = false;
      foot.textContent = "节点关联由本地向量余弦相似度决定，可在顶栏实时调节阈值";
    }

    function open(node, ctx, point) {
      renderNode(node, ctx);
      currentId = node.id;
      show(point);
    }

    function openEdge(edge, ctx, point) {
      renderEdge(edge, ctx);
      currentId = "";
      show(point);
    }

    // 先量再显示：量尺寸时藏起来，避免卡片在上一次的位置闪一下。
    function show(point) {
      el.style.visibility = "hidden";
      el.hidden = false;
      size = { w: 0, h: 0 };
      measure();
      anchor(point);
      el.style.visibility = "visible";
    }

    return {
      open,
      openEdge,
      anchor,
      close,
      get id() {
        return currentId;
      },
      get visible() {
        return !el.hidden;
      },
    };
  }

  window.MemoryTooltip = { create };
})();

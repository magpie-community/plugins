// 本文由AI自动生成
// 无第三方依赖的 SVG 力导向图：布局、缩放、平移、拖拽、悬浮与聚焦。

(function () {
  const NS = "http://www.w3.org/2000/svg";
  const KIND_ORDER = ["profile", "preference", "rule", "fact", "procedure", "episode", "reference", "unknown"];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0) / 4294967296;
  }

  function keyOf(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function create({ svg, onSelect, onFocus, onBackground, onEdge, onView }) {
    const viewport = svg.querySelector("#viewport");
    const edgeLayer = svg.querySelector("#edges");
    const nodeLayer = svg.querySelector("#nodes");

    let nodes = [];
    let edges = [];
    let byId = new Map();
    let adj = new Map();
    let edgeMap = new Map();
    let visible = new Set();
    let transform = { x: 0, y: 0, k: 1 };
    let alpha = 0;
    let running = false;
    let raf = 0;
    let hovered = null;
    let hoveredEdge = null;
    let selected = null;
    let focusSet = null;
    let drag = null;
    let pan = null;
    let panMoved = false;
    let swallowClick = 0;
    let lastClick = { id: "", at: 0 };

    const width = () => svg.clientWidth || 900;
    const height = () => svg.clientHeight || 600;

    // 拖拽前把可能存在的文本选区清掉：SVG 标题一旦被选中，整张图会盖上一层蓝色。
    function dropSelection() {
      const selection = window.getSelection?.();
      if (selection && selection.rangeCount) selection.removeAllRanges();
    }

    function screenToWorld(x, y) {
      const rect = svg.getBoundingClientRect();
      return {
        x: (x - rect.left - transform.x) / transform.k,
        y: (y - rect.top - transform.y) / transform.k,
      };
    }

    // 详情卡要贴在节点旁边，所以需要节点的视口坐标（含缩放）与半径。
    function screenPoint(id) {
      const node = byId.get(id);
      if (!node) return null;
      const rect = svg.getBoundingClientRect();
      return {
        x: rect.left + transform.x + node.x * transform.k,
        y: rect.top + transform.y + node.y * transform.k,
        r: node.r * transform.k,
      };
    }

    function edgeScreenPoint(a, b) {
      const one = screenPoint(a);
      const two = screenPoint(b);
      if (!one || !two) return null;
      return { x: (one.x + two.x) / 2, y: (one.y + two.y) / 2, r: 0 };
    }

    function applyTransform() {
      viewport.setAttribute(
        "transform",
        `translate(${transform.x.toFixed(2)},${transform.y.toFixed(2)}) scale(${transform.k.toFixed(3)})`,
      );
      updateLabels();
      onView?.();
    }

    function neighbors(id, depth = 1) {
      const found = new Set([id]);
      let frontier = [id];
      for (let step = 0; step < depth; step++) {
        const next = [];
        for (const current of frontier) {
          for (const other of adj.get(current) || []) {
            if (found.has(other)) continue;
            found.add(other);
            next.push(other);
          }
        }
        frontier = next;
      }
      return found;
    }

    function updateLabels() {
      const showAll = transform.k >= 1.45 || visible.size <= 100;
      for (const node of nodes) {
        if (!node.el) continue;
        const show =
          !node.hidden &&
          (showAll || node.id === hovered || node.id === selected);
        node.el.classList.toggle("show-label", show);
      }
    }

    function paint() {
      const focus = hovered
        ? neighbors(hovered, 1)
        : focusSet || (selected ? neighbors(selected, 1) : null);
      const hot = hovered || selected;

      for (const node of nodes) {
        if (!node.el) continue;
        node.el.classList.toggle("dim", Boolean(focus) && !focus.has(node.id));
        node.el.classList.toggle("hl", Boolean(hot) && focus && focus.has(node.id));
        node.el.classList.toggle("sel", node.id === selected);
      }

      for (const edge of edges) {
        if (!edge.el) continue;
        const inside = !focus || (focus.has(edge.a) && focus.has(edge.b));
        edge.el.classList.toggle("dim", Boolean(focus) && !inside);
        edge.hit?.classList.toggle("dim", Boolean(focus) && !inside);
        const lit = Boolean(hot) && focus && focus.has(edge.a) && focus.has(edge.b);
        edge.el.classList.toggle("hl", Boolean(lit) || edge === hoveredEdge);
      }

      updateLabels();
    }

    function simulate() {
      const W = width();
      const H = height();
      const cx = W / 2;
      const cy = H / 2;
      const shown = nodes.filter((node) => !node.hidden);
      const k = Math.sqrt((W * H) / Math.max(1, shown.length)) * 0.55;

      for (let i = 0; i < shown.length; i++) {
        const a = shown[i];
        for (let j = i + 1; j < shown.length; j++) {
          const b = shown[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distance2 = dx * dx + dy * dy;
          if (distance2 < 1) {
            dx = hash(a.id + b.id) - 0.5;
            dy = hash(b.id + a.id) - 0.5;
            distance2 = dx * dx + dy * dy || 1;
          }
          const distance = Math.sqrt(distance2);
          const limit = a.r + b.r + 7;

          let force = Math.min((k * k) / Math.max(distance2, 500), 12);
          if (distance < limit) force += (limit - distance) * 0.14;

          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const edge of edges) {
        if (edge.hidden) continue;
        const a = byId.get(edge.a);
        const b = byId.get(edge.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const rest = 72 + (3 - edge.s) * 26;
        const force = (distance - rest) * 0.012;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const node of shown) {
        node.vx += (cx - node.x) * 0.006;
        node.vy += (cy - node.y) * 0.006;
        node.vx *= 0.86;
        node.vy *= 0.86;

        const speed = Math.hypot(node.vx, node.vy);
        if (speed > 10) {
          node.vx = (node.vx / speed) * 10;
          node.vy = (node.vy / speed) * 10;
        }

        if (!node.fixed) {
          node.x += node.vx;
          node.y += node.vy;
        }
      }

      alpha *= 0.985;
    }

    function render() {
      for (const node of nodes) {
        if (!node.el) continue;
        node.el.setAttribute("transform", `translate(${node.x.toFixed(2)},${node.y.toFixed(2)})`);
      }
      for (const edge of edges) {
        const a = byId.get(edge.a);
        const b = byId.get(edge.b);
        if (!a || !b) continue;
        for (const line of [edge.el, edge.hit]) {
          if (!line) continue;
          line.setAttribute("x1", a.x.toFixed(2));
          line.setAttribute("y1", a.y.toFixed(2));
          line.setAttribute("x2", b.x.toFixed(2));
          line.setAttribute("y2", b.y.toFixed(2));
        }
      }
    }

    function frame() {
      raf = 0;
      simulate();
      simulate();
      render();
      onView?.();
      if (alpha > 0.03) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false;
        render();
      }
    }

    function reheat(value = 0.7) {
      alpha = Math.max(alpha, value);
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }

    function clearLayers() {
      edgeLayer.textContent = "";
      nodeLayer.textContent = "";
    }

    function setData(nextNodes, nextEdges) {
      cancelAnimationFrame(raf);
      raf = 0;
      running = false;
      hovered = null;
      hoveredEdge = null;
      selected = null;
      focusSet = null;

      const degree = new Map();
      for (const edge of nextEdges) {
        degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
        degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
      }

      const W = width();
      const H = height();
      nodes = nextNodes.map((node) => {
        const d = degree.get(node.id) || 0;
        const kindIndex = Math.max(0, KIND_ORDER.indexOf(node.kind));
        const angle =
          (kindIndex / KIND_ORDER.length) * Math.PI * 2 + (hash(node.id) - 0.5) * 0.55;
        const radius = Math.min(W, H) * 0.34 * (0.55 + hash(`${node.id}r`) * 0.45);
        return {
          ...node,
          x: W / 2 + Math.cos(angle) * radius + (hash(`${node.id}x`) - 0.5) * 24,
          y: H / 2 + Math.sin(angle) * radius + (hash(`${node.id}y`) - 0.5) * 24,
          vx: 0,
          vy: 0,
          degree: d,
          r: Math.min(15, 4 + Math.sqrt(d) * 1.9),
          fixed: false,
          hidden: false,
          el: null,
        };
      });

      byId = new Map(nodes.map((node) => [node.id, node]));
      adj = new Map(nodes.map((node) => [node.id, new Set()]));
      edgeMap = new Map();

      for (const edge of nextEdges) {
        adj.get(edge.a)?.add(edge.b);
        adj.get(edge.b)?.add(edge.a);
        edgeMap.set(keyOf(edge.a, edge.b), edge);
      }

      edges = nextEdges.map((edge) => ({ ...edge, hidden: false, el: null, hit: null }));
      visible = new Set(nodes.map((node) => node.id));

      clearLayers();

      for (const edge of edges) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("class", `edge s${edge.s}${edge.m ? "" : " one"}`);
        edge.el = line;
        edgeLayer.appendChild(line);

        const hit = document.createElementNS(NS, "line");
        hit.setAttribute("class", "edge-hit");
        hit.addEventListener("pointerenter", () => {
          hoveredEdge = edge;
          paint();
        });
        hit.addEventListener("pointerleave", () => {
          if (hoveredEdge !== edge) return;
          hoveredEdge = null;
          paint();
        });
        hit.addEventListener("click", (event) => {
          event.stopPropagation();
          onEdge?.(edge, event);
        });
        edge.hit = hit;
        edgeLayer.appendChild(hit);
      }

      for (const node of nodes) {
        const group = document.createElementNS(NS, "g");
        group.setAttribute("class", `node${node.status === "superseded" ? " superseded" : ""}`);
        group.dataset.id = node.id;
        group.dataset.kind = node.kind;

        if (node.status === "superseded") {
          const ring = document.createElementNS(NS, "circle");
          ring.setAttribute("class", "ring");
          ring.setAttribute("r", String(node.r + 4));
          group.appendChild(ring);
        }

        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("class", "main");
        circle.setAttribute("r", String(node.r));
        group.appendChild(circle);

        const label = document.createElementNS(NS, "text");
        const title = String(node.title || node.id);
        label.textContent = title.length > 20 ? `${title.slice(0, 19)}…` : title;
        label.setAttribute("y", String(node.r + 13));
        group.appendChild(label);

        group.addEventListener("pointerenter", () => {
          hovered = node.id;
          paint();
        });
        group.addEventListener("pointerleave", () => {
          hovered = null;
          paint();
        });

        group.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.preventDefault();
          dropSelection();
          const point = screenToWorld(event.clientX, event.clientY);
          drag = {
            node,
            dx: point.x - node.x,
            dy: point.y - node.y,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          node.fixed = true;
          svg.setPointerCapture?.(event.pointerId);
        });

        // 单击/双击都在 pointerup 里判定：pointer capture 会把原生 click 重定向到 svg，
        // 靠 click 监听会时灵时不灵。

        node.el = group;
        nodeLayer.appendChild(group);
      }

      nodes.sort((a, b) => a.r - b.r);

      render();
      applyTransform();
      paint();
      zoomToFit();
      reheat(1);
    }

    function setVisible(set, allowedEdges = null) {
      visible = new Set(set);
      for (const node of nodes) {
        node.hidden = !visible.has(node.id);
        node.el?.classList.toggle("hidden", node.hidden);
      }
      for (const edge of edges) {
        const pair = keyOf(edge.a, edge.b);
        edge.hidden = !(
          visible.has(edge.a) &&
          visible.has(edge.b) &&
          (!allowedEdges || allowedEdges.has(pair))
        );
        edge.el?.classList.toggle("hidden", edge.hidden);
        edge.hit?.classList.toggle("hidden", edge.hidden);
      }
      if (selected && !visible.has(selected)) {
        selected = null;
        onSelect?.(null);
      }
      if (focusSet) {
        focusSet = new Set([...focusSet].filter((id) => visible.has(id)));
        if (!focusSet.size) focusSet = null;
      }
      paint();
      updateLabels();
      zoomToFit();
      reheat(0.45);
    }

    function highlight(id) {
      hovered = id;
      paint();
    }

    function select(id) {
      if (id !== selected) focusSet = null;
      selected = id || null;
      paint();
    }

    function focus(id) {
      const set = neighbors(id, 2);
      focusSet = set;
      selected = id;
      paint();
      zoomToNodes(set);
    }

    function reset() {
      selected = null;
      focusSet = null;
      hovered = null;
      paint();
      zoomToFit();
      onSelect?.(null);
    }

    function bounds(ids) {
      const chosen = ids ? nodes.filter((node) => ids.has(node.id)) : nodes.filter((node) => !node.hidden);
      if (!chosen.length) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of chosen) {
        minX = Math.min(minX, node.x - node.r);
        minY = Math.min(minY, node.y - node.r);
        maxX = Math.max(maxX, node.x + node.r);
        maxY = Math.max(maxY, node.y + node.r);
      }
      return { minX, minY, maxX, maxY };
    }

    function zoomToNodes(ids, maxScale = 1.9) {
      const box = bounds(ids);
      if (!box) return;
      const pad = 80;
      const bw = Math.max(120, box.maxX - box.minX);
      const bh = Math.max(120, box.maxY - box.minY);
      const scale = clamp(Math.min((width() - pad) / bw, (height() - pad) / bh), 0.28, maxScale);
      transform.k = scale;
      transform.x = width() / 2 - ((box.minX + box.maxX) / 2) * scale;
      transform.y = height() / 2 - ((box.minY + box.maxY) / 2) * scale;
      applyTransform();
    }

    function zoomToFit() {
      zoomToNodes(null, 1.35);
    }

    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const before = screenToWorld(event.clientX, event.clientY);
        const next = clamp(transform.k * Math.exp(-event.deltaY * 0.0015), 0.22, 4);
        transform.k = next;
        transform.x = px - before.x * next;
        transform.y = py - before.y * next;
        applyTransform();
      },
      { passive: false },
    );

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".node") || event.target.closest(".edge-hit")) return;
      dropSelection();
      swallowClick = 0;
      panMoved = false;
      pan = {
        x: event.clientX,
        y: event.clientY,
        tx: transform.x,
        ty: transform.y,
      };
      svg.classList.add("panning");
      svg.setPointerCapture?.(event.pointerId);
    });

    svg.addEventListener("pointermove", (event) => {
      if (drag) {
        const point = screenToWorld(event.clientX, event.clientY);
        drag.node.x = point.x - drag.dx;
        drag.node.y = point.y - drag.dy;
        drag.node.vx = 0;
        drag.node.vy = 0;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
          drag.moved = true;
        }
        reheat(0.35);
        return;
      }
      if (pan) {
        transform.x = pan.tx + (event.clientX - pan.x);
        transform.y = pan.ty + (event.clientY - pan.y);
        if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > 3) panMoved = true;
        applyTransform();
      }
    });

    function endPointer(event) {
      const node = drag?.node || null;
      const moved = Boolean(drag?.moved);
      const wasPan = Boolean(pan);
      const panDrag = panMoved;

      if (drag) {
        drag.node.fixed = false;
        drag = null;
        reheat(0.2);
      }
      if (pan) {
        pan = null;
        panMoved = false;
        svg.classList.remove("panning");
      }
      try {
        svg.releasePointerCapture?.(event.pointerId);
      } catch {
        /* 没有捕获 */
      }

      if (event.type !== "pointerup" || event.button !== 0) return;

      // 背景被拖动过：这次松手不算点击，别把视图复位掉。
      if (wasPan) {
        if (panDrag) swallowClick = Date.now() + 400;
        return;
      }
      if (!node || moved) return;

      swallowClick = Date.now() + 400;
      const now = Date.now();
      if (lastClick.id === node.id && now - lastClick.at < 360) {
        lastClick = { id: "", at: 0 };
        onFocus?.(node);
        focus(node.id);
        return;
      }
      lastClick = { id: node.id, at: now };
      select(selected === node.id ? null : node.id);
      onSelect?.(selected ? node : null);
    }

    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);

    svg.addEventListener("click", (event) => {
      if (swallowClick && Date.now() < swallowClick) {
        swallowClick = 0;
        return;
      }
      if (event.target.closest(".node") || event.target.closest(".edge-hit")) return;
      reset();
      onBackground?.();
    });

    window.addEventListener("resize", () => {
      if (!nodes.length) return;
      applyTransform();
      updateLabels();
    });

    return {
      setData,
      setVisible,
      highlight,
      select,
      focus,
      reset,
      zoomToFit,
      reheat,
      neighbors,
      screenPoint,
      edgeScreenPoint,
      edgeBetween: (a, b) => edgeMap.get(keyOf(a, b)) || null,
      get selected() {
        return selected;
      },
    };
  }

  window.MemoryGraph = { create };
})();

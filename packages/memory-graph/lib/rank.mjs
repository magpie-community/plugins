// 本文由AI自动生成
// 把 memory_search 的「命中顺序」折成边。
//
// 重要：memory_search 只返回排序，不返回任何分数。所以这里不造相似度，
// 只保留位次本身（ra/rb），展示层直接显示「第 N 位」。
// s 是位次所在的粗细档（仅用于线宽，不对外展示）；两边互相进入对方 topK
// 时加一档，表示「双向都认为相关」，上限仍是 3。

export function queryText(node, chars = 500) {
  const body = String(node?.body || "").trim();
  const title = String(node?.title || "").trim();
  const head = title && !body.startsWith(title) ? `${title}\n` : "";
  return (head + body).slice(0, chars);
}

// 档位随 topK 自适应：topK=3 时 1→3、2→2、3→1；topK=8 时 1→3、2–3→2、4–8→1。
export function bandOf(rank, topK = 3) {
  const k = Math.max(1, Number(topK) || 3);
  if (rank <= 1) return 3;
  if (rank <= Math.max(2, Math.ceil(k / 3))) return 2;
  return 1;
}

export function edgesFromHits(nodes, hits, { topK = 3, visible = null } = {}) {
  const k = Math.max(1, Math.min(20, Number(topK) || 3));
  const allowed = visible || new Set(Object.keys(nodes || {}));
  const pairs = new Map();

  for (const node of Object.values(nodes || {})) {
    if (node.status !== "active") continue;
    const hit = hits?.[node.id];
    if (!hit || !Array.isArray(hit.ids)) continue;

    let rank = 0;
    for (const id of hit.ids) {
      if (id === node.id || !allowed.has(id)) continue;
      rank++;
      if (rank > k) break;

      const [a, b] = node.id < id ? [node.id, id] : [id, node.id];
      const key = `${a}|${b}`;
      let edge = pairs.get(key);
      if (!edge) {
        edge = { a, b, ra: 0, rb: 0, sa: 0, sb: 0 };
        pairs.set(key, edge);
      }

      const strength = bandOf(rank, k);
      if (node.id === a) {
        edge.ra = edge.ra || rank;
        edge.sa = Math.max(edge.sa, strength);
      } else {
        edge.rb = edge.rb || rank;
        edge.sb = Math.max(edge.sb, strength);
      }
    }
  }

  const edges = [];
  for (const edge of pairs.values()) {
    const mutual = edge.ra && edge.rb ? 1 : 0;
    edges.push({
      a: edge.a,
      b: edge.b,
      s: Math.min(3, Math.max(edge.sa, edge.sb) + (mutual ? 1 : 0)),
      m: mutual,
      ra: edge.ra,
      rb: edge.rb,
    });
  }
  edges.sort(
    (x, y) =>
      Math.min(x.ra || 99, x.rb || 99) - Math.min(y.ra || 99, y.rb || 99) || y.s - x.s,
  );
  return edges;
}

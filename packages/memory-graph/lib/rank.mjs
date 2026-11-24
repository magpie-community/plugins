// 本文由AI自动生成
// 把 memory_search 的「命中顺序」折成边。
//
// 重要：memory_search 不返回相似度分数，只返回排序。这里的 s 是位次折算的
// 相对强度（1–2 位强、3–5 位中、6–8 位弱），不是余弦相似度；两边互相进入
// 对方 topK 时加一档，表示「双向都认为相关」，上限仍是 3。

export function queryText(node, chars = 500) {
  const body = String(node?.body || "").trim();
  const title = String(node?.title || "").trim();
  const head = title && !body.startsWith(title) ? `${title}\n` : "";
  return (head + body).slice(0, chars);
}

export function bandOf(rank) {
  if (rank <= 2) return 3;
  if (rank <= 5) return 2;
  return 1;
}

export function edgesFromHits(nodes, hits, { topK = 8, visible = null } = {}) {
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
      if (rank > topK) break;

      const [a, b] = node.id < id ? [node.id, id] : [id, node.id];
      const key = `${a}|${b}`;
      let edge = pairs.get(key);
      if (!edge) {
        edge = { a, b, ra: 0, rb: 0, sa: 0, sb: 0 };
        pairs.set(key, edge);
      }

      const strength = bandOf(rank);
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
    const ranks = [edge.ra, edge.rb].filter(Boolean);
    const bestRank = Math.min(...ranks);
    const base = (topK - bestRank + 1) / topK;
    const score = Math.min(1, base + (mutual ? 0.05 : 0));
    edges.push({
      a: edge.a,
      b: edge.b,
      s: Math.min(3, Math.max(edge.sa, edge.sb) + (mutual ? 1 : 0)),
      score: Number(score.toFixed(3)),
      m: mutual,
      ra: edge.ra,
      rb: edge.rb,
    });
  }
  edges.sort((x, y) => y.s - x.s || Math.min(x.ra || 99, x.rb || 99) - Math.min(y.ra || 99, y.rb || 99));
  return edges;
}

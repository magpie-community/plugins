// 本文由AI自动生成
// 组装给页面的图数据。节点只暴露 active / superseded；candidate 和 archived 不进图。

export function scopeLabel(scope) {
  const text = String(scope || "global");
  if (text === "global") return "全局";
  if (text.startsWith("project:dir:")) {
    const path = text.slice("project:dir:".length);
    const parts = path.split("/").filter(Boolean);
    return `项目 · ${parts.slice(-2).join("/") || path}`;
  }
  if (text.startsWith("agent:")) return `Agent · ${text.slice("agent:".length)}`;
  return text;
}

function statusRank(status) {
  if (status === "active") return 0;
  if (status === "superseded") return 1;
  return 2;
}

export function buildPayload({
  nodes,
  edges = [],
  vectorInfo = null,
  builtAt,
  options = {},
  state = {},
  memoryDir = "",
}) {
  const all = Object.values(nodes || {});
  const visibleNodes = all.filter((node) => node.status === "active" || node.status === "superseded");
  const visible = new Set(visibleNodes.map((node) => node.id));

  const rawMinSim = Number(options.minSimilarity);
  const minSimilarity = Number.isFinite(rawMinSim)
    ? Math.max(0.35, Math.min(0.95, rawMinSim))
    : 0.6;

  const filteredEdges = (Array.isArray(edges) ? edges : []).filter(
    (edge) =>
      visible.has(edge.a) &&
      visible.has(edge.b) &&
      (edge.lineage || edge.source === "lineage" || Number(edge.sim) >= minSimilarity),
  );

  const degree = new Map();
  const strength = new Map();
  for (const edge of filteredEdges) {
    degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
    const sim = Number(edge.sim) || 0;
    strength.set(edge.a, (strength.get(edge.a) || 0) + sim);
    strength.set(edge.b, (strength.get(edge.b) || 0) + sim);
  }

  const payloadNodes = visibleNodes.map((node) => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    scope: node.scope,
    scopeLabel: scopeLabel(node.scope),
    status: node.status,
    origin: node.origin,
    tags: node.tags,
    why: node.why,
    created: node.created,
    updated: node.updated,
    supersededBy: node.supersededBy,
    sources: node.sources,
    body: node.body,
    bodyTruncated: Boolean(node.bodyTruncated),
    degree: degree.get(node.id) || 0,
    strengthSum: Math.round((strength.get(node.id) || 0) * 1000) / 1000,
  }));

  payloadNodes.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      b.degree - a.degree ||
      String(b.updated || "").localeCompare(String(a.updated || "")),
  );

  const rawMax = Number(options.maxNodes);
  const maxNodes = Number.isFinite(rawMax) && rawMax === 0 ? Infinity : Math.max(1, rawMax || 1000);
  const kept = payloadNodes.slice(0, maxNodes);
  const keptIds = new Set(kept.map((node) => node.id));
  const keptEdges = filteredEdges.filter((edge) => keptIds.has(edge.a) && keptIds.has(edge.b));

  const keptDegree = new Map();
  for (const edge of keptEdges) {
    keptDegree.set(edge.a, (keptDegree.get(edge.a) || 0) + 1);
    keptDegree.set(edge.b, (keptDegree.get(edge.b) || 0) + 1);
  }
  for (const node of kept) node.degree = keptDegree.get(node.id) || 0;

  const warnings = Array.isArray(state.warnings) ? state.warnings.slice(-8) : [];
  if (!payloadNodes.length) {
    warnings.push({ level: "info", text: "还没有可显示的记忆，正在等第一次扫描结果。" });
  } else if (!keptEdges.length && builtAt) {
    warnings.push({
      level: "info",
      text: `当前相似度阈值 ${minSimilarity.toFixed(2)} 下暂无连线，可在右下角 ⚙ 设置中调低阈值。`,
    });
  }
  if (payloadNodes.length > kept.length) {
    warnings.push({
      level: "info",
      text: `图上展示关联度最高的 ${kept.length} 条，另有 ${payloadNodes.length - kept.length} 条未画。`,
    });
  }

  const totals = {
    total: all.length,
    active: all.filter((node) => node.status === "active").length,
    superseded: all.filter((node) => node.status === "superseded").length,
    candidate: all.filter((node) => node.status === "candidate").length,
    archived: all.filter((node) => node.status === "archived").length,
    vectorized: vectorInfo?.matched || 0,
  };

  return {
    ok: true,
    engine: "similarity",
    minSimilarity,
    vectorInfo: vectorInfo || null,
    builtAt: builtAt || null,
    complete: state.complete !== false,
    source: { ...totals, dir: memoryDir },
    nodes: kept,
    edges: keptEdges,
    stats: {
      edges: keptEdges.length,
      vectorEdges: keptEdges.filter((edge) => edge.source === "vector").length,
      lexicalEdges: keptEdges.filter((edge) => edge.source === "lexical").length,
      lineageEdges: keptEdges.filter((edge) => edge.lineage || edge.source === "lineage").length,
      isolated: kept.filter((node) => !node.degree).length,
      nodesReturned: kept.length,
      totalNodes: payloadNodes.length,
      truncated: payloadNodes.length > kept.length,
    },
    warnings,
  };
}

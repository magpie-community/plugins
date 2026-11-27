// Builds the graph payload for the UI. Only active and superseded nodes are exposed.

function statusRank(status) {
  if (status === "active") return 0;
  if (status === "superseded") return 1;
  return 2;
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return NaN;
  if (typeof value === "string" && !value.trim()) return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function buildPayload({
  nodes,
  edges = [],
  vectorInfo = null,
  builtAt,
  options = {},
  state = {},
}) {
  const all = Object.values(nodes || {});
  const visibleNodes = all.filter((node) => node.status === "active" || node.status === "superseded");
  const visible = new Set(visibleNodes.map((node) => node.id));

  const rawMinSim = finiteNumber(options.minSimilarity);
  const minSimilarity = Number.isFinite(rawMinSim)
    ? Math.max(0.35, Math.min(0.9, rawMinSim))
    : 0.6;

  const filteredEdges = (Array.isArray(edges) ? edges : []).filter(
    (edge) =>
      visible.has(edge.a) &&
      visible.has(edge.b) &&
      (edge.lineage || edge.source === "lineage" || Number(edge.sim) >= minSimilarity),
  );

  const degree = new Map();
  for (const edge of filteredEdges) {
    degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
  }

  const payloadNodes = visibleNodes.map((node) => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    scope: node.scope,
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
  }));

  payloadNodes.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      b.degree - a.degree ||
      String(b.updated || "").localeCompare(String(a.updated || "")),
  );

  const rawMax = finiteNumber(options.maxNodes);
  const maxNodes = Number.isFinite(rawMax)
    ? rawMax === 0
      ? Infinity
      : Math.max(1, Math.floor(rawMax))
    : 1000;
  const kept = payloadNodes.slice(0, maxNodes);
  const keptIds = new Set(kept.map((node) => node.id));
  const keptEdges = filteredEdges.filter((edge) => keptIds.has(edge.a) && keptIds.has(edge.b));

  const keptDegree = new Map();
  for (const edge of keptEdges) {
    keptDegree.set(edge.a, (keptDegree.get(edge.a) || 0) + 1);
    keptDegree.set(edge.b, (keptDegree.get(edge.b) || 0) + 1);
  }
  for (const node of kept) {
    node.degree = keptDegree.get(node.id) || 0;
  }

  const warnings = Array.isArray(state.warnings) ? state.warnings.slice(-8) : [];
  if (!payloadNodes.length) {
    warnings.push({ level: "info", text: "No visible memories yet; waiting for initial scan." });
  } else if (!keptEdges.length && builtAt) {
    warnings.push({
      level: "info",
      text: `No edges at similarity threshold ${minSimilarity.toFixed(2)}; lower the threshold in the top bar to reveal more links.`,
    });
  }
  if (payloadNodes.length > kept.length) {
    warnings.push({
      level: "info",
      text: `Showing top ${kept.length} connected nodes (${payloadNodes.length - kept.length} omitted by maxNodes).`,
    });
  }

  return {
    ok: true,
    engine: "similarity",
    phase: state?.phase || "idle",
    lastError: state?.lastError || "",
    minSimilarity,
    vectorInfo: vectorInfo || null,
    builtAt: builtAt || null,
    complete: state.complete !== false,
    nodes: kept,
    edges: keptEdges,
    stats: {
      truncated: payloadNodes.length > kept.length,
    },
    warnings,
  };
}

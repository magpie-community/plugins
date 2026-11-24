// 本文由AI自动生成
// 组装给页面的图数据。节点只暴露 active / superseded；candidate 和 archived 不进图。

import { edgesFromHits } from "./rank.mjs";

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

export function buildPayload({ nodes, hits, stats, builtAt, options = {}, state = {}, memoryDir = "" }) {
  const all = Object.values(nodes || {});
  const visibleNodes = all.filter((node) => node.status === "active" || node.status === "superseded");
  const visible = new Set(visibleNodes.map((node) => node.id));
  const edges = edgesFromHits(nodes, hits, {
    topK: Number(options.topK) || 8,
    visible,
  });

  const degree = new Map();
  const strength = new Map();
  const scoreSum = new Map();
  for (const edge of edges) {
    degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
    strength.set(edge.a, (strength.get(edge.a) || 0) + edge.s);
    strength.set(edge.b, (strength.get(edge.b) || 0) + edge.s);
    scoreSum.set(edge.a, (scoreSum.get(edge.a) || 0) + (edge.score || 0));
    scoreSum.set(edge.b, (scoreSum.get(edge.b) || 0) + (edge.score || 0));
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
    strengthSum: strength.get(node.id) || 0,
    scoreSum: Number((scoreSum.get(node.id) || 0).toFixed(3)),
  }));

  payloadNodes.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      b.degree - a.degree ||
      String(b.updated || "").localeCompare(String(a.updated || "")),
  );

  const maxNodes = Math.max(1, Number(options.maxNodes) || 200);
  const kept = payloadNodes.slice(0, maxNodes);
  const keptIds = new Set(kept.map((node) => node.id));
  const keptEdges = edges.filter((edge) => keptIds.has(edge.a) && keptIds.has(edge.b));

  const keptDegree = new Map();
  for (const edge of keptEdges) {
    keptDegree.set(edge.a, (keptDegree.get(edge.a) || 0) + 1);
    keptDegree.set(edge.b, (keptDegree.get(edge.b) || 0) + 1);
  }
  for (const node of kept) node.degree = keptDegree.get(node.id) || 0;

  const warnings = Array.isArray(state.warnings) ? state.warnings.slice(-8) : [];
  if (!payloadNodes.length) {
    warnings.push({ level: "info", text: "还没有可显示的记忆，正在等第一次扫描结果。" });
  } else if (!keptEdges.length && (stats?.queried || 0) > 0) {
    warnings.push({ level: "info", text: "这些记忆之间暂时没有进入彼此前 8 位的语义关联。" });
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
    queried: Object.keys(hits || {}).length,
  };

  return {
    ok: true,
    builtAt: builtAt || null,
    complete: state.complete !== false,
    source: { ...totals, dir: memoryDir },
    mcp: { ok: state.phase !== "error", lastError: state.lastError || "" },
    nodes: kept,
    edges: keptEdges,
    stats: {
      edges: keptEdges.length,
      mutual: keptEdges.filter((edge) => edge.m).length,
      isolated: kept.filter((node) => !node.degree).length,
      nodesReturned: kept.length,
      totalNodes: payloadNodes.length,
      truncated: payloadNodes.length > kept.length,
    },
    warnings,
  };
}

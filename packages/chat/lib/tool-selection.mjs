// Keep schemas bounded, but do not treat a whole unspaced Chinese question
// as one word. Rare matching terms outrank boilerplate repeated in catalogs.
export function selectTools(all, query, limit = 12) {
  const q = String(query).toLowerCase();
  const terms = new Set(q.match(/[a-z0-9_-]+/g)?.filter(w => w.length >= 3) || []);
  for (const run of q.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  const rows = all.map(t => ({ t, hay: `${t.name} ${t.description || ""}`.toLowerCase(), score: 0 }));
  for (const term of terms) {
    const hits = rows.filter(r => r.hay.includes(term));
    const weight = Math.log(1 + all.length / Math.max(1, hits.length));
    for (const row of hits) row.score += weight;
  }
  for (const row of rows) {
    // Explicit tool identifiers must win even over verbose descriptions.
    const name = String(row.t.rawName || row.t.name).toLowerCase();
    if (terms.has(name)) row.score += 1000;
  }
  const selected = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, limit).map(r => r.t);
  if (selected.length < 3) {
    const common = /^(get|list|search|read|fetch|query)_|(_search|_list|_get)$/;
    selected.push(...all.filter(t => common.test(t.rawName) && !selected.includes(t)).slice(0, 8));
  }
  return selected.slice(0, limit);
}

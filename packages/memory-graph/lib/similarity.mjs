// Local semantic similarity engine:
// 1. Reuses magpie's built-in multilingual vectors (MEV1 vectors.bin) for exact cosine similarity.
// 2. Falls back to zero-dependency TF-IDF (CJK bigrams + word tokens) + tag Jaccard overlap.
// 3. Adds dashed lineage edges for supersededBy memories.
// 4. Time-slices O(n^2) loops so the shared plugin host event loop never stalls.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MEV1_MAGIC = "MEV1";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export async function findVectorsFile(basePath) {
  if (!basePath) return null;
  try {
    const info = await stat(basePath);
    if (info.isFile()) return { path: basePath, mtimeMs: info.mtimeMs };
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }

  let best = null;
  const direct = join(basePath, "vectors.bin");
  try {
    const info = await stat(direct);
    if (info.isFile()) best = { path: direct, mtimeMs: info.mtimeMs };
  } catch {
    /* scan subdirectories */
  }

  try {
    const entries = await readdir(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(basePath, entry.name, "vectors.bin");
      try {
        const info = await stat(candidate);
        if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) {
          best = { path: candidate, mtimeMs: info.mtimeMs };
        }
      } catch {
        /* ignore directories without vectors.bin */
      }
    }
  } catch {
    /* ignore unreadable directories */
  }
  return best;
}

export async function loadVectors(filePath) {
  if (!filePath) return { dim: 0, vectors: new Map(), count: 0 };
  const buf = await readFile(filePath);
  if (buf.length < 8 || buf.subarray(0, 4).toString("ascii") !== MEV1_MAGIC) {
    throw new Error("Invalid vectors.bin format (expected MEV1)");
  }
  const dim = buf.readUInt32LE(4);
  if (!dim || dim > 4096) throw new Error(`Invalid vectors.bin dimension: ${dim}`);

  const recSize = 32 + dim * 4;
  const vectors = new Map();
  for (let off = 8; off + recSize <= buf.length; off += recSize) {
    const hash = buf.subarray(off, off + 32).toString("hex");
    const vec = new Float32Array(dim);
    let norm2 = 0;
    let valid = true;
    for (let i = 0; i < dim; i++) {
      const x = buf.readFloatLE(off + 32 + i * 4);
      if (!Number.isFinite(x)) {
        valid = false;
        break;
      }
      vec[i] = x;
      norm2 += x * x;
    }
    if (!valid) continue;
    const norm = Math.sqrt(norm2);
    if (norm > 0 && Number.isFinite(norm)) {
      for (let i = 0; i < dim; i++) vec[i] /= norm;
      vectors.set(hash, vec);
    }
  }
  return { dim, vectors, count: vectors.size };
}

export function matchNodeVector(node, vectorMap) {
  if (!vectorMap || !vectorMap.size || !node) return null;
  if (Array.isArray(node.vecHashes)) {
    for (const h of node.vecHashes) {
      const hit = vectorMap.get(h);
      if (hit) return hit;
    }
  }
  const body = String(node.body || "").trim();
  const why = String(node.why || "").trim();
  const title = String(node.title || "").trim();

  if (body && why) {
    const hit = vectorMap.get(sha256(`${body}\n${why}`));
    if (hit) return hit;
  }
  if (body) {
    const hit = vectorMap.get(sha256(body));
    if (hit) return hit;
  }
  if (title && why) {
    const hit = vectorMap.get(sha256(`${title}\n${why}`));
    if (hit) return hit;
  }
  if (title) {
    const hit = vectorMap.get(sha256(title));
    if (hit) return hit;
  }
  return null;
}

function tokenize(text) {
  const tokens = [];
  const raw = String(text || "").toLowerCase();

  const words = raw.match(/[a-z0-9_+#.-]{2,}/g);
  if (words) {
    for (const w of words) tokens.push(w);
  }

  const cjkRuns = raw.match(/[\u4e00-\u9fff]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    }
  }
  return tokens;
}

function buildLexicalVectors(nodesList) {
  const docCount = nodesList.length || 1;
  const df = new Map();
  const tfs = nodesList.map((node) => {
    const text = [node.title, node.body, node.why, ...(node.tags || [])].filter(Boolean).join(" ");
    const tf = new Map();
    for (const tok of tokenize(text)) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }
    for (const tok of tf.keys()) {
      df.set(tok, (df.get(tok) || 0) + 1);
    }
    return tf;
  });

  return tfs.map((tf) => {
    const vec = new Map();
    let norm2 = 0;
    for (const [tok, count] of tf.entries()) {
      const idf = Math.log((docCount + 1) / ((df.get(tok) || 1) + 1)) + 1;
      const w = (1 + Math.log(count)) * idf;
      vec.set(tok, w);
      norm2 += w * w;
    }
    const norm = Math.sqrt(norm2);
    if (norm > 0) {
      for (const [tok, w] of vec.entries()) vec.set(tok, w / norm);
    }
    return vec;
  });
}

function cosineDense(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

function cosineSparse(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [tok, w] of small.entries()) {
    const other = large.get(tok);
    if (other) dot += w * other;
  }
  return Math.max(0, Math.min(1, dot));
}

function tagJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (!inter) return 0;
  return inter / (a.size + b.size - inter);
}

function bandOfSimilarity(sim) {
  if (sim >= 0.75) return 3;
  if (sim >= 0.65) return 2;
  return 1;
}

function insertTopK(heap, candidate, limit) {
  heap.push(candidate);
  if (heap.length <= limit) return;
  let minIdx = 0;
  for (let i = 1; i < heap.length; i++) {
    if (heap[i].sim < heap[minIdx].sim) minIdx = i;
  }
  heap.splice(minIdx, 1);
}

export async function computeSimilarityEdges(
  nodes,
  vectorMap = new Map(),
  { floor = 0.35, maxNodes = 1000, maxEdgesPerNode = 12 } = {},
) {
  let visibleNodes = Object.values(nodes || {}).filter(
    (node) => node && (node.status === "active" || node.status === "superseded"),
  );
  const cap =
    maxNodes === "" || maxNodes === null || maxNodes === undefined || typeof maxNodes === "boolean"
      ? NaN
      : Number(maxNodes);
  if (Number.isFinite(cap) && cap > 0 && visibleNodes.length > cap) {
    visibleNodes.sort(
      (a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        String(b.updated || "").localeCompare(String(a.updated || "")) ||
        (b.mtime || 0) - (a.mtime || 0),
    );
    visibleNodes = visibleNodes.slice(0, cap);
  }
  const totalVisible = visibleNodes.length;

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const denseVecs = visibleNodes.map((node) => matchNodeVector(node, vectorMap));
  const vectorMatched = denseVecs.filter(Boolean).length;
  const needsLexical = vectorMatched < visibleNodes.length;
  const lexicalVecs = needsLexical ? buildLexicalVectors(visibleNodes) : null;
  const tagSets = needsLexical
    ? visibleNodes.map((node) => new Set((node.tags || []).map((t) => String(t).toLowerCase())))
    : null;

  const minFloor = Math.max(0.05, Math.min(0.95, Number(floor) || 0.35));
  const edgeCap = Math.max(1, Number(maxEdgesPerNode) || 12);
  const perNode = Array.from({ length: visibleNodes.length }, () => []);

  let sliceStart = Date.now();
  for (let i = 0; i < visibleNodes.length; i++) {
    const vi = denseVecs[i];
    for (let j = i + 1; j < visibleNodes.length; j++) {
      const vj = denseVecs[j];

      let sim = 0;
      let source = "vector";
      if (vi && vj) {
        sim = cosineDense(vi, vj);
      } else if (lexicalVecs) {
        const lex = cosineSparse(lexicalVecs[i], lexicalVecs[j]);
        const tagJ = tagJaccard(tagSets[i], tagSets[j]);
        sim = tagJ > 0 ? Math.min(1, lex * 0.78 + tagJ * 0.22) : lex;
        source = "lexical";
      }

      if (sim < minFloor) continue;
      const rounded = Math.round(sim * 1000) / 1000;
      insertTopK(perNode[i], { peer: j, sim: rounded, source }, edgeCap);
      insertTopK(perNode[j], { peer: i, sim: rounded, source }, edgeCap);
    }
    if (Date.now() - sliceStart >= 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = Date.now();
    }
  }

  const pairMap = new Map();
  for (let i = 0; i < visibleNodes.length; i++) {
    const ni = visibleNodes[i];
    for (const item of perNode[i]) {
      const nj = visibleNodes[item.peer];
      const [a, b] = ni.id < nj.id ? [ni.id, nj.id] : [nj.id, ni.id];
      const key = `${a}|${b}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, {
          a,
          b,
          sim: item.sim,
          s: bandOfSimilarity(item.sim),
          source: item.source,
        });
      }
    }
  }

  for (const node of visibleNodes) {
    if (node.status !== "superseded" || !node.supersededBy || !visibleIds.has(node.supersededBy)) {
      continue;
    }
    if (node.id === node.supersededBy) continue;
    const [a, b] = node.id < node.supersededBy ? [node.id, node.supersededBy] : [node.supersededBy, node.id];
    const key = `${a}|${b}`;
    const existing = pairMap.get(key);
    if (existing) {
      existing.lineage = true;
    } else {
      pairMap.set(key, {
        a,
        b,
        sim: 1,
        s: 2,
        source: "lineage",
        lineage: true,
      });
    }
  }

  const edges = [...pairMap.values()].sort(
    (x, y) => Number(Boolean(y.lineage)) - Number(Boolean(x.lineage)) || y.sim - x.sim,
  );

  return {
    edges,
    vectorMatched,
    totalVisible,
  };
}

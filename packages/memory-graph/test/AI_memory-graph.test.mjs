// 本文由AI自动生成
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AI_computeSimilarityEdges,
  AI_findVectorsFile,
  AI_loadVectors,
  AI_matchNodeVector,
} from "../lib/AI_similarity.mjs";
import { createBuilder } from "../lib/build.mjs";
import { SCHEMA, cleanupTempFiles, loadCache, saveCache, writeJSON } from "../lib/cache.mjs";
import { buildPayload } from "../lib/graph.mjs";
import { corsHeaders, fetchSiteAllowed, hostAllowed, originAllowed, tokenOK } from "../lib/http.mjs";

function AI_makeMemory(id, body, status = "active", extra = []) {
  return [
    "---",
    `id: ${id}`,
    "kind: fact",
    "scope: global",
    `status: ${status}`,
    "created: 2026-11-26T10:00:00+08:00",
    "updated: 2026-11-26T10:00:00+08:00",
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function AI_buildMev1(entries, dim = 4) {
  const recSize = 32 + dim * 4;
  const buf = Buffer.alloc(8 + entries.length * recSize);
  buf.write("MEV1", 0, "ascii");
  buf.writeUInt32LE(dim, 4);
  entries.forEach(({ text, vec }, idx) => {
    const off = 8 + idx * recSize;
    createHash("sha256").update(text).digest().copy(buf, off);
    for (let i = 0; i < dim; i++) {
      buf.writeFloatLE(vec[i] || 0, off + 32 + i * 4);
    }
  });
  return buf;
}

test("http security: rejects null origin on static HTML while allowing token-gated API for sandboxed iframe", () => {
  assert.equal(originAllowed({ headers: { origin: "null" } }, 3491, false), false);
  assert.equal(originAllowed({ headers: { origin: "null" } }, 3491, true), true);
  assert.equal(originAllowed({ headers: { origin: "http://evil.example" } }, 3491, true), false);
  assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:3491" } }, 3491, false), true);
  assert.equal(originAllowed({ headers: {} }, 3491, false), true);

  const staticNullCors = corsHeaders({ headers: { origin: "null" } }, 3491, false);
  assert.equal(staticNullCors["access-control-allow-origin"], undefined);

  const apiNullCors = corsHeaders({ headers: { origin: "null" } }, 3491, true);
  assert.equal(apiNullCors["access-control-allow-origin"], "null");

  const ownCors = corsHeaders({ headers: { origin: "http://127.0.0.1:3491" } }, 3491, false);
  assert.equal(ownCors["access-control-allow-origin"], "http://127.0.0.1:3491");

  assert.equal(hostAllowed({ headers: { host: "127.0.0.1:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "evil.com:3491" } }, 3491), false);

  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "same-origin" } }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "cross-site" } }), false);

  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "abc" } }, "abc"), true);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "abd" } }, "abc"), false);
});

test("cache: uses SCHEMA=2, strips body on saveCache, and cleans up .tmp-* files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mg-cache-"));
  try {
    await writeFile(join(dir, "graph-cache.json.tmp-1234-deadbeef"), "junk");
    await cleanupTempFiles(dir);
    const afterCleanup = await readdir(dir);
    assert.equal(afterCleanup.length, 0);

    await saveCache(dir, {
      builtAt: "2026-11-26T10:00:00Z",
      nodes: {
        m_111111111111: { id: "m_111111111111", status: "active", title: "T", body: "secret body" },
      },
      edges: [{ a: "m_111111111111", b: "m_222222222222", sim: 0.8, s: 3, source: "vector" }],
      vectorInfo: { matched: 1, totalVisible: 1 },
      stats: {},
    });

    const loaded = await loadCache(dir);
    assert.equal(loaded.v, SCHEMA);
    assert.equal(SCHEMA, 2);
    assert.equal(loaded.nodes.m_111111111111.body, undefined);
    assert.equal(loaded.nodes.m_111111111111.title, "T");
    assert.equal(loaded.edges.length, 1);

    await mkdir(join(dir, "sub"));
    await assert.rejects(() => writeJSON(join(dir, "sub"), { ok: true }));
    const entries = await readdir(dir);
    assert.equal(entries.some((name) => name.includes(".tmp-")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("similarity: parses MEV1 vectors, computes cosine + lineage edges, and falls back to TF-IDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mg-vec-"));
  const sub = join(dir, "model-hash");
  await mkdir(sub, { recursive: true });
  try {
    const binPath = join(sub, "vectors.bin");
    const buf = AI_buildMev1(
      [
        { text: "Alpha body\nwhy alpha", vec: [1, 0, 0, 0] },
        { text: "Beta body", vec: [0.8, 0.6, 0, 0] },
        { text: "Gamma unrelated", vec: [0, 0, 1, 0] },
      ],
      4,
    );
    await writeFile(binPath, buf);

    const found = await AI_findVectorsFile(dir);
    assert.equal(found?.path, binPath);

    const loaded = await AI_loadVectors(found.path);
    assert.equal(loaded.dim, 4);
    assert.equal(loaded.count, 3);

    const nodes = {
      m_aaaaaaaaaaaa: {
        id: "m_aaaaaaaaaaaa",
        status: "active",
        title: "Alpha",
        body: "Alpha body",
        why: "why alpha",
        tags: [],
      },
      m_bbbbbbbbbbbb: {
        id: "m_bbbbbbbbbbbb",
        status: "active",
        title: "Beta",
        body: "Beta body",
        why: "",
        tags: [],
      },
      m_cccccccccccc: {
        id: "m_cccccccccccc",
        status: "active",
        title: "Gamma",
        body: "Gamma unrelated",
        why: "",
        tags: [],
      },
      m_dddddddddddd: {
        id: "m_dddddddddddd",
        status: "superseded",
        supersededBy: "m_aaaaaaaaaaaa",
        title: "Old Alpha",
        body: "completely old wording",
        why: "",
        tags: [],
      },
    };

    assert.ok(AI_matchNodeVector(nodes.m_aaaaaaaaaaaa, loaded.vectors));
    const { edges, vectorMatched } = AI_computeSimilarityEdges(nodes, loaded.vectors, { floor: 0.35 });
    assert.equal(vectorMatched, 3);

    const ab = edges.find((e) => e.a === "m_aaaaaaaaaaaa" && e.b === "m_bbbbbbbbbbbb");
    assert.ok(ab);
    assert.equal(ab.source, "vector");
    assert.equal(ab.sim, 0.8);

    const lineage = edges.find((e) => e.a === "m_aaaaaaaaaaaa" && e.b === "m_dddddddddddd");
    assert.ok(lineage);
    assert.equal(lineage.lineage, true);
    assert.equal(lineage.source, "lineage");

    // Lexical fallback when no vectors exist (CJK bigram + tag Jaccard)
    const lexicalOnly = AI_computeSimilarityEdges(
      {
        m_111111111111: {
          id: "m_111111111111",
          status: "active",
          title: "知识图谱配色方案",
          body: "知识图谱采用暗色主题与余弦相似度连线",
          tags: ["graph", "ui"],
        },
        m_222222222222: {
          id: "m_222222222222",
          status: "active",
          title: "知识图谱布局细节",
          body: "知识图谱采用力导向布局与余弦相似度阈值",
          tags: ["graph", "ui"],
        },
      },
      new Map(),
      { floor: 0.35 },
    );
    assert.equal(lexicalOnly.vectorMatched, 0);
    assert.equal(lexicalOnly.edges.length, 1);
    assert.equal(lexicalOnly.edges[0].source, "lexical");
    assert.ok(lexicalOnly.edges[0].sim >= 0.45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("graph payload: renders >200 nodes and filters edges by minSimilarity while keeping lineage", () => {
  const nodes = {};
  for (let i = 0; i < 250; i++) {
    const id = `m_${i.toString(16).padStart(12, "0")}`;
    nodes[id] = {
      id,
      title: `Mem ${i}`,
      kind: "fact",
      scope: "global",
      status: i < 180 ? "active" : "superseded",
      tags: [],
      body: "text",
    };
  }
  const edges = [
    { a: "m_000000000000", b: "m_000000000001", sim: 0.72, s: 2, source: "vector", lineage: false },
    { a: "m_000000000000", b: "m_000000000002", sim: 0.48, s: 1, source: "vector", lineage: false },
    { a: "m_000000000000", b: "m_0000000000b4", sim: 1, s: 2, source: "lineage", lineage: true },
  ];
  const payload = buildPayload({ nodes, edges, options: { minSimilarity: 0.6 } });
  assert.equal(payload.nodes.length, 250);
  assert.equal(payload.stats.truncated, false);
  assert.equal(payload.edges.length, 2);
});

test("builder: builds similarity graph from MEV1 vectors, supports live minSim, and detects new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-build-"));
  const dataDir = join(root, "data");
  const memoryDir = join(root, "memory");
  const vecDir = join(root, "vectors", "v1");
  await mkdir(dataDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(vecDir, { recursive: true });

  const idA = "m_aaaaaaaaaaaa";
  const idB = "m_bbbbbbbbbbbb";
  await writeFile(join(memoryDir, `${idA}.md`), AI_makeMemory(idA, "Alpha memory"));
  await writeFile(
    join(vecDir, "vectors.bin"),
    AI_buildMev1(
      [
        { text: "Alpha memory", vec: [1, 0, 0, 0] },
        { text: "Beta memory", vec: [0.5, 0.866, 0, 0] },
      ],
      4,
    ),
  );

  try {
    const builder = createBuilder({
      dir: dataDir,
      memoryDir,
      vectorsPath: join(root, "vectors"),
      options: { minSimilarity: 0.6, concurrency: 2 },
    });

    builder.run();
    while (builder.getStatus().phase !== "idle") {
      await new Promise((r) => setTimeout(r, 10));
    }

    let graph = await builder.getGraph();
    assert.equal(graph.nodes.length, 1);

    await writeFile(join(memoryDir, `${idB}.md`), AI_makeMemory(idB, "Beta memory"));
    const refreshed = await builder.maybeRefresh();
    assert.equal(refreshed, true);

    while (builder.getStatus().phase !== "idle") {
      await new Promise((r) => setTimeout(r, 10));
    }

    graph = await builder.getGraph({ minSimilarity: 0.6 });
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 0);

    graph = await builder.getGraph({ minSimilarity: 0.45 });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].sim, 0.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

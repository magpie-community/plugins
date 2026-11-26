// 本文由AI自动生成
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAppServer } from "../lib/server.mjs";
import {
  AI_computeSimilarityEdges,
  AI_findVectorsFile,
  AI_loadVectors,
  AI_matchNodeVector,
} from "../lib/AI_similarity.mjs";
import { createBuilder } from "../lib/build.mjs";
import { SCHEMA, cleanupTempFiles, loadCache, saveCache, writeJSON } from "../lib/cache.mjs";
import { parseMemory, titleOf } from "../lib/frontmatter.mjs";
import { buildPayload } from "../lib/graph.mjs";
import {
  corsHeaders,
  fetchSiteAllowed,
  hostAllowed,
  isCorsRequest,
  originAllowed,
  tokenOK,
} from "../lib/http.mjs";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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

function AI_httpReq(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          host: `127.0.0.1:${port}`,
          connection: "close",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("http unit gates: strict loopback Host/Origin, no Origin: null, and tokenOK edge cases", () => {
  assert.equal(originAllowed({ headers: { origin: "null" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://evil.example" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://sub.localhost:3491" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:9999" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: { origin: "http://localhost:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: { origin: "http://[::1]:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: {} }, 3491), true);

  const nullCors = corsHeaders({ headers: { origin: "null" } }, 3491);
  assert.equal(nullCors["access-control-allow-origin"], undefined);

  const ownCors = corsHeaders({ headers: { origin: "http://127.0.0.1:3491" } }, 3491);
  assert.equal(ownCors["access-control-allow-origin"], "http://127.0.0.1:3491");

  assert.equal(hostAllowed({ headers: { host: "127.0.0.1:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "localhost:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "[::1]:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "sub.localhost:3491" } }, 3491), false);
  assert.equal(hostAllowed({ headers: { host: "evil.example:3491" } }, 3491), false);
  assert.equal(hostAllowed({ headers: { host: "127.0.0.1:3492" } }, 3491), false);

  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "same-origin" } }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "none" } }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "cross-site" } }), false);
  assert.equal(isCorsRequest({ headers: { "sec-fetch-mode": "cors" } }), true);
  assert.equal(isCorsRequest({ headers: { "sec-fetch-mode": "navigate" } }), false);

  // tokenOK: empty, wrong, wrong length, valid
  assert.equal(tokenOK({ headers: {} }, "secret-token"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "" } }, "secret-token"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "secret-tokex" } }, "secret-token"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "short" } }, "secret-token"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "secret-token" } }, ""), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "secret-token" } }, "secret-token"), true);
});

test("http integration: real server enforces Origin/Host/Sec-Fetch-Mode/Token and injects __INITIAL_GRAPH__", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-http-"));
  const memoryDir = join(root, "memory");
  const dataDir = join(root, "data");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const idA = "m_111111111111";
  const secretPhrase = "top-secret-memory-body-phrase";
  await writeFile(join(memoryDir, `${idA}.md`), AI_makeMemory(idA, `Alpha node ${secretPhrase}`));

  const srv = await createAppServer({
    port: 0,
    memoryDir,
    dataDir,
    token: "test-integration-token-1234",
  });

  try {
    const { port, token } = srv;

    // 1. Origin: null on all routes -> 403, no ACAO: null, no token, no memory body leaked
    const nullRoutes = [
      { path: "/", method: "GET" },
      { path: "/index.html", method: "GET" },
      { path: "/app.js", method: "GET" },
      { path: "/api/graph", method: "GET" },
      { path: "/api/status", method: "GET" },
      { path: "/api/rebuild", method: "POST" },
      { path: "/api/health", method: "GET" },
    ];
    for (const route of nullRoutes) {
      const res = await AI_httpReq(port, route.path, {
        method: route.method,
        headers: { origin: "null" },
      });
      assert.equal(res.status, 403, `Expected 403 for Origin: null on ${route.method} ${route.path}`);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal(res.body.includes(token), false);
      assert.equal(res.body.includes(secretPhrase), false);
    }

    // 2. No Origin on / -> 200, contains window.__INITIAL_GRAPH__, no ACAO header
    const htmlRes = await AI_httpReq(port, "/");
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers["access-control-allow-origin"], undefined);
    assert.ok(htmlRes.body.includes("window.__INITIAL_GRAPH__="));
    assert.ok(htmlRes.body.includes(idA));

    // 3. No Origin on /api/graph -> 401 without token, 200 with valid token returning memory node
    const unauthApi = await AI_httpReq(port, "/api/graph");
    assert.equal(unauthApi.status, 401);

    const authApi = await AI_httpReq(port, "/api/graph", {
      headers: { "x-memory-graph-token": token },
    });
    assert.equal(authApi.status, 200);
    const parsedGraph = JSON.parse(authApi.body);
    assert.equal(parsedGraph.nodes.length, 1);
    assert.equal(parsedGraph.nodes[0].id, idA);

    // 4. External Origin on / and /api/graph -> 403
    const evilRoot = await AI_httpReq(port, "/", { headers: { origin: "https://evil.example" } });
    assert.equal(evilRoot.status, 403);
    const evilApi = await AI_httpReq(port, "/api/graph", {
      headers: { origin: "https://evil.example", "x-memory-graph-token": token },
    });
    assert.equal(evilApi.status, 403);

    // 5. *.localhost Origin and Host -> 403
    const subOrigin = await AI_httpReq(port, "/", {
      headers: { origin: `http://sub.localhost:${port}` },
    });
    assert.equal(subOrigin.status, 403);
    const subHost = await AI_httpReq(port, "/", {
      headers: { host: `sub.localhost:${port}` },
    });
    assert.equal(subHost.status, 403);

    // 6. Wrong Host -> 403
    const evilHost = await AI_httpReq(port, "/", {
      headers: { host: `evil.example:${port}` },
    });
    assert.equal(evilHost.status, 403);
    const wrongPortHost = await AI_httpReq(port, "/", {
      headers: { host: `127.0.0.1:${port + 1}` },
    });
    assert.equal(wrongPortHost.status, 403);

    // 7. Sec-Fetch-Mode: cors on / -> 403
    const corsRoot = await AI_httpReq(port, "/", {
      headers: { "sec-fetch-mode": "cors" },
    });
    assert.equal(corsRoot.status, 403);
  } finally {
    await srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter: parses YAML frontmatter, tags, sources, supersededBy, multiline why, and missing fallback", () => {
  const raw = [
    "---",
    "id: m_abcdef123456",
    "kind: preference",
    "scope: project",
    "status: superseded",
    "origin: user",
    "tags: [graph, ui, graph]",
    "why: |",
    "  First reason line",
    "  Second reason line",
    "supersededBy: m_123456abcdef",
    "sources:",
    "  - agent: claude",
    "    session: s1",
    '    dir: "/tmp/work"',
    '    quote: "Prefer dark mode"',
    "created: 2026-11-26T09:00:00Z",
    "updated: 2026-11-26T10:00:00Z",
    "---",
    "",
    "# Dark Theme Title",
    "Body details here.",
  ].join("\n");

  const parsed = parseMemory("m_abcdef123456", raw);
  assert.equal(parsed.kind, "preference");
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.status, "superseded");
  assert.equal(parsed.origin, "user");
  assert.deepEqual(parsed.tags, ["graph", "ui"]);
  assert.equal(parsed.why, "First reason line\nSecond reason line");
  assert.equal(parsed.supersededBy, "m_123456abcdef");
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].agent, "claude");
  assert.equal(parsed.sources[0].quote, "Prefer dark mode");
  assert.equal(titleOf(parsed.body, parsed.why, parsed.id), "Dark Theme Title");

  // Missing frontmatter fallback
  const plain = parseMemory("m_000000000000", "Just a plain body line\nMore text");
  assert.equal(plain.kind, "unknown");
  assert.equal(plain.status, "active");
  assert.equal(plain.scope, "global");
  assert.deepEqual(plain.tags, []);
  assert.equal(plain.supersededBy, null);
  assert.equal(plain.body, "Just a plain body line\nMore text");
  assert.equal(titleOf("", "Fallback why title", "m_000000000000"), "Fallback why title");
  assert.equal(titleOf("", "", "m_000000000000"), "m_000000000000");
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

test("graph payload: respects maxNodes truncation and filters edges by minSimilarity while keeping lineage", () => {
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
  const full = buildPayload({ nodes, edges, options: { minSimilarity: 0.6 } });
  assert.equal(full.nodes.length, 250);
  assert.equal(full.stats.truncated, false);
  assert.equal(full.edges.length, 2);

  const capped = buildPayload({ nodes, edges, options: { minSimilarity: 0.6, maxNodes: 50 } });
  assert.equal(capped.nodes.length, 50);
  assert.equal(capped.stats.truncated, true);
});

test("builder: ensureFresh, maybeRefresh, maxNodes, and getInlineGraph", async () => {
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
      options: { minSimilarity: 0.6, concurrency: 2, maxNodes: 1 },
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

    const inline = await builder.getInlineGraph({ minSimilarity: 0.6 });
    assert.equal(inline.nodes.length, 1);
    assert.equal(inline.stats.truncated, true);
    assert.ok(Array.isArray(inline.allEdges));

    const didForce = await builder.ensureFresh({ force: true });
    assert.equal(didForce, true);
    const didNoop = await builder.ensureFresh();
    assert.equal(didNoop, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest and icon: package.json has no _ai key and icon SVG contains no comments", async () => {
  const pkg = JSON.parse(await readFile(join(PKG_DIR, "package.json"), "utf8"));
  assert.equal("_ai" in pkg, false);

  const svg = await readFile(join(PKG_DIR, "page/icon.svg"), "utf8");
  assert.equal(svg.includes("<!--"), false);

  const iconUrl = pkg.magpie?.icon || "";
  assert.ok(iconUrl.startsWith("data:image/svg+xml;base64,"));
  const decoded = Buffer.from(iconUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.equal(decoded.includes("<!--"), false);
});

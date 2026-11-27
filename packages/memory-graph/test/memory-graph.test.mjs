import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import plugin from "../index.mjs";
import { createBuilder } from "../lib/build.mjs";
import { SCHEMA, cleanupTempFiles, loadCache, saveCache, writeJSON } from "../lib/cache.mjs";
import { parseMemory, titleOf } from "../lib/frontmatter.mjs";
import { buildPayload } from "../lib/graph.mjs";
import {
  corsHeaders,
  fetchSiteAllowed,
  hostAllowed,
  htmlDestAllowed,
  injectInitialGraph,
  injectToken,
  originAllowed,
  tokenMatch,
  tokenOK,
} from "../lib/http.mjs";
import { createAppServer } from "../lib/server.mjs";
import {
  computeSimilarityEdges,
  findVectorsFile,
  loadVectors,
  matchNodeVector,
} from "../lib/similarity.mjs";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

function makeMemory(id, body, status = "active", extra = []) {
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

function buildMev1(entries, dim = 4) {
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

function httpReq(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

test("http unit gates: strict loopback Host/Origin/Dest, no Origin: null, and tokenOK edge cases", () => {
  assert.equal(originAllowed({ headers: { origin: "null" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "https://evil.example" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://sub.localhost:3491" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:9999" } }, 3491), false);
  assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: { origin: "http://localhost:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: { origin: "http://[::1]:3491" } }, 3491), true);
  assert.equal(originAllowed({ headers: {} }, 3491), true);

  assert.equal(corsHeaders({ headers: { origin: "null" } }, 3491)["access-control-allow-origin"], undefined);
  assert.equal(corsHeaders({ headers: { origin: "https://evil.example" } }, 3491)["access-control-allow-origin"], undefined);
  assert.equal(corsHeaders({ headers: { origin: "http://127.0.0.1:3491" } }, 3491)["access-control-allow-origin"], "http://127.0.0.1:3491");

  assert.equal(hostAllowed({ headers: { host: "127.0.0.1:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "localhost:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "[::1]:3491" } }, 3491), true);
  assert.equal(hostAllowed({ headers: { host: "sub.localhost:3491" } }, 3491), false);
  assert.equal(hostAllowed({ headers: { host: "127.0.0.1:3492" } }, 3491), false);
  assert.equal(hostAllowed({ headers: { host: "evil.example:3491" } }, 3491), false);
  assert.equal(hostAllowed({ headers: {} }, 3491), false);

  assert.equal(fetchSiteAllowed({ headers: {} }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "same-origin" } }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "none" } }), true);
  assert.equal(fetchSiteAllowed({ headers: { "sec-fetch-site": "cross-site" } }), false);

  assert.equal(htmlDestAllowed({ headers: {} }), true);
  assert.equal(htmlDestAllowed({ headers: { "sec-fetch-dest": "document" } }), true);
  assert.equal(htmlDestAllowed({ headers: { "sec-fetch-dest": "iframe" } }), true);
  assert.equal(htmlDestAllowed({ headers: { "sec-fetch-dest": "image" } }), false);
  assert.equal(htmlDestAllowed({ headers: { "sec-fetch-dest": "script" } }), false);

  assert.equal(tokenOK({ headers: {} }, "secret"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "" } }, "secret"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "wrong" } }, "secret"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "secrex" } }, "secret"), false);
  assert.equal(tokenOK({ headers: { "x-memory-graph-token": "secret" } }, "secret"), true);
  assert.equal(tokenMatch("secret", "secret"), true);
  assert.equal(tokenMatch("wrong", "secret"), false);

  const injected = injectInitialGraph("<html><head></head><body></body></html>", {
    text: "</script><script>window.__xss=1</script>",
  });
  assert.equal(injected.includes("</script><script>"), false);
  assert.equal(injected.includes("\\u003c/script>"), true);

  const tokenHtml = injectToken(
    '<meta name="memory-graph-token" content="" />',
    'tok"en<&>\'123',
  );
  assert.equal(
    tokenHtml,
    '<meta name="memory-graph-token" content="tok&quot;en&lt;&amp;&gt;&#39;123">',
  );
});

test("http integration: real server enforces Origin/Host/Dest/Site/Token, XSS escaping, and HTML caching", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-http-"));
  const dataDir = join(root, "data");
  const memoryDir = join(root, "memory");
  await mkdir(dataDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  const idA = "m_aaaaaaaaaaaa";
  const secretText = "secret memory body </script><script>window.__xss=3</script>";
  await writeFile(join(memoryDir, `${idA}.md`), makeMemory(idA, secretText));

  const app = await createAppServer({
    port: 0,
    memoryDir,
    dataDir,
    vectorsPath: join(root, "no-vectors"),
    token: "test-token-123456",
  });

  try {
    const addr = app.server.address();
    assert.equal(addr.address, "127.0.0.1");

    // 1. Origin: null rejected across ALL routes
    for (const [method, path, extraHeaders] of [
      ["GET", "/", {}],
      ["GET", "/index.html", {}],
      ["GET", "/app.js", {}],
      ["GET", "/api/health", {}],
      ["GET", "/api/graph", { "x-memory-graph-token": app.token }],
      ["GET", "/api/status", { "x-memory-graph-token": app.token }],
      ["POST", "/api/rebuild", { "x-memory-graph-token": app.token }],
    ]) {
      const res = await httpReq(app.port, path, { method, headers: { Origin: "null", ...extraHeaders } });
      assert.equal(res.status, 403, `Origin: null must be 403 on ${method} ${path}`);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal(res.body.includes(app.token), false);
      assert.equal(res.body.includes("secret memory body"), false);
    }

    // 2. External Origin and *.localhost rejected
    for (const badOrigin of [
      "https://evil.example",
      `http://sub.localhost:${app.port}`,
      `http://127.0.0.1:${app.port + 1}`,
    ]) {
      const r1 = await httpReq(app.port, "/", { headers: { Origin: badOrigin } });
      assert.equal(r1.status, 403);
      assert.equal(r1.headers["access-control-allow-origin"], undefined);

      const r2 = await httpReq(app.port, "/api/graph", {
        headers: { Origin: badOrigin, "x-memory-graph-token": app.token },
      });
      assert.equal(r2.status, 403);
    }

    // 3. Wrong Host rejected (including *.localhost and wrong port)
    for (const badHost of [
      `evil.example:${app.port}`,
      `sub.localhost:${app.port}`,
      `127.0.0.1:${app.port + 1}`,
    ]) {
      const r = await httpReq(app.port, "/", { headers: { Host: badHost } });
      assert.equal(r.status, 403);
    }

    // 4. Sec-Fetch-Mode: cors & non-document Sec-Fetch-Dest rejected on HTML
    const corsHtml = await httpReq(app.port, "/", { headers: { "Sec-Fetch-Mode": "cors" } });
    assert.equal(corsHtml.status, 403);

    const imgHtml = await httpReq(app.port, "/", { headers: { "Sec-Fetch-Dest": "image" } });
    assert.equal(imgHtml.status, 403);

    // 5. Unauthenticated /?refresh=1 rejected; authenticated /?refresh=1&t=<token> returns 303 with stripped location
    const badRefresh = await httpReq(app.port, "/?refresh=1", {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(badRefresh.status, 403);

    const okRefresh = await httpReq(app.port, `/?refresh=1&t=${app.token}&minSim=0.7&lang=en`, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(okRefresh.status, 303);
    assert.equal(okRefresh.headers["referrer-policy"], "no-referrer");
    assert.equal(okRefresh.headers["cache-control"], "no-store");
    const redirectLoc = okRefresh.headers.location || "";
    assert.equal(redirectLoc.includes("t="), false);
    assert.equal(redirectLoc.includes("refresh="), false);
    assert.equal(redirectLoc.includes("minSim=0.7"), true);
    assert.equal(redirectLoc.includes("lang=en"), true);

    const afterRedirect = await httpReq(app.port, redirectLoc, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(afterRedirect.status, 200);
    assert.equal(afterRedirect.headers["referrer-policy"], "no-referrer");

    // 6. Normal navigation (no Origin) returns 200 with escaped inline graph, referrer-policy, and no ACAO
    const nav = await httpReq(app.port, "/", { headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(nav.status, 200);
    assert.equal(nav.headers["access-control-allow-origin"], undefined);
    assert.equal(nav.headers["referrer-policy"], "no-referrer");
    assert.equal(nav.body.includes("window.__INITIAL_GRAPH__="), true);
    assert.equal(nav.body.includes(secretText), false);
    assert.equal(nav.body.includes("\\u003c/script>\\u003cscript>"), true);

    // 6b. Cross-site iframe GET / and refresh succeed; script dest, cors mode, POST /, malformed URL //, and static methods enforced
    const crossIframeHtml = await httpReq(app.port, "/", {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(crossIframeHtml.status, 200);
    assert.equal(crossIframeHtml.headers["referrer-policy"], "no-referrer");
    assert.equal(crossIframeHtml.body.includes("window.__INITIAL_GRAPH__="), true);

    const crossIframeRefresh = await httpReq(app.port, `/?refresh=1&t=${app.token}&lang=en`, {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(crossIframeRefresh.status, 303);

    const scriptHtml = await httpReq(app.port, "/", { headers: { "Sec-Fetch-Dest": "script" } });
    assert.equal(scriptHtml.status, 403);

    const postHtml = await httpReq(app.port, "/", { method: "POST" });
    assert.equal(postHtml.status, 405);

    const crossJs = await httpReq(app.port, "/app.js", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(crossJs.status, 200);

    const corsJs = await httpReq(app.port, "/app.js", {
      headers: { "Sec-Fetch-Mode": "cors" },
    });
    assert.equal(corsJs.status, 403);

    const headJs = await httpReq(app.port, "/app.js", { method: "HEAD" });
    assert.equal(headJs.status, 200);
    assert.equal(headJs.body, "");

    const postJs = await httpReq(app.port, "/app.js", { method: "POST" });
    assert.equal(postJs.status, 405);

    const malformedUrl = await httpReq(app.port, "//");
    assert.equal(malformedUrl.status, 400);

    const htmlSim45 = await httpReq(app.port, "/?minSim=0.45", { headers: { "Sec-Fetch-Dest": "document" } });
    const htmlSim80 = await httpReq(app.port, "/?minSim=0.80", { headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(htmlSim45.status, 200);
    assert.equal(htmlSim80.status, 200);
    assert.equal(htmlSim45.body, htmlSim80.body);

    // 7. Unauthenticated /api/health hides pid/phase/tokenPresent; authenticated /api/health exposes them
    const anonHealth = await httpReq(app.port, "/api/health");
    assert.equal(anonHealth.status, 200);
    const anonJson = JSON.parse(anonHealth.body);
    assert.equal(anonJson.ok, true);
    assert.equal(anonJson.pid, undefined);
    assert.equal(anonJson.phase, undefined);
    assert.equal(anonJson.tokenPresent, undefined);

    const authHealth = await httpReq(app.port, "/api/health", {
      headers: { "x-memory-graph-token": app.token },
    });
    assert.equal(authHealth.status, 200);
    const authJson = JSON.parse(authHealth.body);
    assert.equal(typeof authJson.pid, "number");
    assert.equal(typeof authJson.phase, "string");

    // 8. /api/* rejects Sec-Fetch-Site: cross-site even with valid token
    for (const [method, path] of [
      ["GET", "/api/graph"],
      ["GET", "/api/status"],
      ["POST", "/api/rebuild"],
    ]) {
      const cross = await httpReq(app.port, path, {
        method,
        headers: {
          "x-memory-graph-token": app.token,
          "Sec-Fetch-Site": "cross-site",
        },
      });
      assert.equal(cross.status, 403, `Sec-Fetch-Site: cross-site must be 403 on ${method} ${path}`);
    }

    // 9. /api/graph requires valid token
    const noTok = await httpReq(app.port, "/api/graph");
    assert.equal(noTok.status, 401);

    const okApi = await httpReq(app.port, "/api/graph", {
      headers: { "x-memory-graph-token": app.token },
    });
    assert.equal(okApi.status, 200);
    const parsed = JSON.parse(okApi.body);
    assert.equal(parsed.nodes.length, 1);
    assert.equal(parsed.nodes[0].body, secretText);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin entry: index.mjs binds strictly to 127.0.0.1 and stops cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-entry-"));
  const dataDir = join(root, "data");
  const memoryDir = join(root, "memory");
  await mkdir(dataDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  const port = await getFreePort();
  try {
    await plugin.server({}, {
      port,
      dataDir,
      memoryDir,
      vectorsPath: join(root, "no-vectors"),
      maxNodes: "",
      minSimilarity: "",
      idleMinutes: null,
    });
    const health = await httpReq(port, "/api/health");
    assert.equal(health.status, 200);
    const body = JSON.parse(health.body);
    assert.equal(body.plugin, "memory-graph");
    assert.equal(body.port, port);
  } finally {
    await plugin.stop();
  }

  // stop() aborts an in-flight claim() sleep immediately instead of hanging 60s
  const blocker = createHttpServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;
  try {
    const startMs = Date.now();
    const pending = plugin.server({}, {
      port: busyPort,
      dataDir,
      memoryDir,
      vectorsPath: join(root, "no-vectors"),
    });
    await new Promise((r) => setTimeout(r, 80));
    await plugin.stop();
    await pending;
    assert.ok(Date.now() - startMs < 1000, "stop() must abort claim() sleep promptly");
  } finally {
    blocker.closeAllConnections?.();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter: parses YAML frontmatter, validates status, tags, sources, supersededBy, multiline why, and missing fallback", () => {
  const raw = [
    "---",
    "id: m_1234567890ab",
    "kind: preference",
    "scope: project:dir:/tmp/demo",
    "status: superseded",
    "supersededBy: m_abcdef123456",
    "origin: explicit",
    "tags: [graph, ui, graph]",
    "why: |",
    "  First reason line",
    "  Second reason line",
    "sources:",
    "  - agent: workbuddy",
    "    dir: /tmp/demo",
    '    quote: "Prefer Obsidian-style graph"',
    "created: 2026-11-25T10:00:00+08:00",
    "updated: 2026-11-26T10:00:00+08:00",
    "---",
    "",
    "# Graph Styling Preference",
    "",
    "Body content here.",
  ].join("\n");

  const parsed = parseMemory("m_1234567890ab", raw);
  assert.equal(parsed.kind, "preference");
  assert.equal(parsed.scope, "project:dir:/tmp/demo");
  assert.equal(parsed.status, "superseded");
  assert.equal(parsed.supersededBy, "m_abcdef123456");
  assert.deepEqual(parsed.tags, ["graph", "ui"]);
  assert.equal(parsed.why, "First reason line\nSecond reason line");
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].agent, "workbuddy");
  assert.equal(titleOf(parsed.body, parsed.why, parsed.id), "Graph Styling Preference");

  const invalidStatus = parseMemory("m_222222222222", "---\nstatus: invalid_status\n---\n\nHello");
  assert.equal(invalidStatus.status, "active");

  for (const st of ["active", "candidate", "superseded", "archived"]) {
    assert.equal(parseMemory("m_333333333333", `---\nstatus: ${st}\n---\n\nHi`).status, st);
  }

  const fallback = parseMemory("m_000000000001", "Plain text without frontmatter");
  assert.equal(fallback.kind, "unknown");
  assert.equal(fallback.status, "active");
  assert.equal(fallback.body, "Plain text without frontmatter");

  const emptyFm = parseMemory("m_444444444444", "---\n---\n\nBody after empty frontmatter");
  assert.equal(emptyFm.kind, "unknown");
  assert.equal(emptyFm.status, "active");
  assert.equal(emptyFm.body, "Body after empty frontmatter");

  const chompStrip = parseMemory(
    "m_555555555555",
    "---\nkind: fact\nwhy: |-\n  Line A\n  Line B\n\n---\n\nBody",
  );
  assert.equal(chompStrip.why, "Line A\nLine B");

  const foldedStrip = parseMemory(
    "m_666666666666",
    "---\nkind: fact\nwhy: >-\n  Folded A\n  Folded B\n\n---\n\nBody",
  );
  assert.equal(foldedStrip.why, "Folded A Folded B");

  const blockItems = parseMemory(
    "m_777777777777",
    [
      "---",
      "kind: fact",
      "nested:",
      "  note: |",
      "    nested line 1",
      "    nested line 2",
      "  sibling: kept",
      "status: superseded",
      "supersededBy: m_888888888888",
      "sources:",
      "  - quote: |",
      "      first line",
      "      second line",
      "    dir: /tmp/first",
      "    agent: workbuddy",
      "  - agent: other",
      "    quote: >-",
      "      folded line 1",
      "      folded line 2",
      "    dir: /tmp/second",
      "---",
      "",
      "Body",
    ].join("\n"),
  );
  assert.equal(blockItems.status, "superseded");
  assert.equal(blockItems.supersededBy, "m_888888888888");
  assert.equal(blockItems.sources.length, 2);
  assert.equal(blockItems.sources[0].quote, "first line\nsecond line");
  assert.equal(blockItems.sources[0].dir, "/tmp/first");
  assert.equal(blockItems.sources[0].agent, "workbuddy");
  assert.equal(blockItems.sources[1].agent, "other");
  assert.equal(blockItems.sources[1].quote, "folded line 1 folded line 2");
  assert.equal(blockItems.sources[1].dir, "/tmp/second");
});

test("cache: uses SCHEMA=3, strips body on saveCache, and cleans up .tmp-* files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mg-cache-"));
  try {
    await writeFile(join(dir, "graph-cache.json.tmp-1234-deadbeef"), "junk");
    await cleanupTempFiles(dir);
    const afterCleanup = await readdir(dir);
    assert.equal(afterCleanup.length, 0);

    await saveCache(dir, {
      builtAt: "2026-11-26T10:00:00Z",
      nodes: {
        m_111111111111: { id: "m_111111111111", status: "active", title: "T", body: "secret body", vecHashes: ["abc"] },
      },
      edges: [{ a: "m_111111111111", b: "m_222222222222", sim: 0.8, s: 3, source: "vector" }],
      vectorInfo: { matched: 1, totalVisible: 1 },
      stats: {},
    });

    const loaded = await loadCache(dir);
    assert.equal(loaded.v, SCHEMA);
    assert.equal(SCHEMA, 3);
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
    const buf = buildMev1(
      [
        { text: "Alpha body\nwhy alpha", vec: [1, 0, 0, 0] },
        { text: "Beta body", vec: [0.8, 0.6, 0, 0] },
        { text: "Gamma unrelated", vec: [0, 0, 1, 0] },
      ],
      4,
    );
    await writeFile(binPath, buf);

    const found = await findVectorsFile(dir);
    assert.equal(found?.path, binPath);

    const loaded = await loadVectors(found.path);
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

    assert.ok(matchNodeVector(nodes.m_aaaaaaaaaaaa, loaded.vectors));
    const { edges, vectorMatched } = await computeSimilarityEdges(nodes, loaded.vectors, { floor: 0.35 });
    assert.equal(vectorMatched, 3);

    const ab = edges.find((e) => e.a === "m_aaaaaaaaaaaa" && e.b === "m_bbbbbbbbbbbb");
    assert.ok(ab);
    assert.equal(ab.source, "vector");
    assert.equal(ab.sim, 0.8);

    const lineage = edges.find((e) => e.a === "m_aaaaaaaaaaaa" && e.b === "m_dddddddddddd");
    assert.ok(lineage);
    assert.equal(lineage.lineage, true);
    assert.equal(lineage.source, "lineage");

    const lexicalOnly = await computeSimilarityEdges(
      {
        m_111111111111: {
          id: "m_111111111111",
          status: "active",
          title: "Graph styling theme",
          body: "Graph uses obsidian dark theme and cosine similarity links",
          tags: ["graph", "ui"],
        },
        m_222222222222: {
          id: "m_222222222222",
          status: "active",
          title: "Graph layout controls",
          body: "Graph uses force layout and cosine similarity threshold",
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
    { a: "m_000000000000", b: "m_000000000001", sim: 0.72, s: 2, source: "vector" },
    { a: "m_000000000000", b: "m_000000000002", sim: 0.48, s: 1, source: "vector" },
    { a: "m_000000000000", b: "m_0000000000b4", sim: 1, s: 2, source: "lineage", lineage: true },
  ];
  const full = buildPayload({ nodes, edges, options: { minSimilarity: 0.6, maxNodes: 1000 } });
  assert.equal(full.nodes.length, 250);
  assert.equal(full.stats.truncated, false);
  assert.equal(full.edges.length, 2);

  const capped = buildPayload({ nodes, edges, options: { minSimilarity: 0.6, maxNodes: 20 } });
  assert.equal(capped.nodes.length, 20);
  assert.equal(capped.stats.truncated, true);
  const keptIds = new Set(capped.nodes.map((n) => n.id));
  const expectedDegree = new Map();
  for (const e of capped.edges) {
    assert.equal(keptIds.has(e.a), true);
    assert.equal(keptIds.has(e.b), true);
    expectedDegree.set(e.a, (expectedDegree.get(e.a) || 0) + 1);
    expectedDegree.set(e.b, (expectedDegree.get(e.b) || 0) + 1);
  }
  for (const n of capped.nodes) {
    assert.equal(n.degree, expectedDegree.get(n.id) || 0);
  }

  const fallbackOpts = buildPayload({
    nodes,
    edges,
    options: { minSimilarity: "", maxNodes: null },
    state: { phase: "error", lastError: "disk full" },
  });
  assert.equal(fallbackOpts.minSimilarity, 0.6);
  assert.equal(fallbackOpts.nodes.length, 250);
  assert.equal(fallbackOpts.stats.truncated, false);
  assert.equal(fallbackOpts.phase, "error");
  assert.equal(fallbackOpts.lastError, "disk full");

  const clampedSim = buildPayload({
    nodes,
    edges,
    options: { minSimilarity: 0.95, maxNodes: "" },
  });
  assert.equal(clampedSim.minSimilarity, 0.9);
  assert.equal(clampedSim.nodes.length, 250);
});

test("builder: matches >2000-char memory vectors using full-body hash, supports live minSim, and detects new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-build-"));
  const dataDir = join(root, "data");
  const memoryDir = join(root, "memory");
  const vecDir = join(root, "vectors", "v1");
  await mkdir(dataDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(vecDir, { recursive: true });

  const idA = "m_aaaaaaaaaaaa";
  const idB = "m_bbbbbbbbbbbb";
  const longBody = "Long memory prefix. " + "x".repeat(2500) + " unique-tail-marker";
  await writeFile(join(memoryDir, `${idA}.md`), makeMemory(idA, longBody));
  await writeFile(
    join(vecDir, "vectors.bin"),
    buildMev1(
      [
        { text: longBody, vec: [1, 0, 0, 0] },
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
      options: { minSimilarity: 0.6, concurrency: 2, refreshThrottleMs: 0 },
    });

    const didBuild = await builder.ensureFresh();
    assert.equal(didBuild, true);

    let graph = await builder.getGraph();
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].bodyTruncated, true);
    assert.equal(graph.vectorInfo.matched, 1);

    await writeFile(join(memoryDir, `${idB}.md`), makeMemory(idB, "Beta memory"));
    const refreshed = await builder.maybeRefresh();
    assert.equal(refreshed, true);

    while (builder.getStatus().phase !== "idle") {
      await new Promise((r) => setTimeout(r, 10));
    }

    const inline = await builder.getInlineGraph({ minSimilarity: 0.6 });
    assert.equal(inline.nodes.length, 2);
    assert.equal(inline.edges.length, 0);
    assert.equal(inline.allEdges.length, 1);
    assert.equal(inline.allEdges[0].source, "vector");
    assert.equal(inline.allEdges[0].sim, 0.5);

    graph = await builder.getGraph({ minSimilarity: 0.45 });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].sim, 0.5);

    const cappedBuilder = createBuilder({
      dir: dataDir,
      memoryDir,
      vectorsPath: join(root, "vectors"),
      options: { minSimilarity: 0.6, maxNodes: 1, concurrency: 2, refreshThrottleMs: 0 },
    });
    await cappedBuilder.ensureFresh();
    const cappedInline = await cappedBuilder.getInlineGraph({ minSimilarity: 0.6 });
    assert.equal(cappedInline.nodes.length, 1);
    const inlineKeptIds = new Set(cappedInline.nodes.map((n) => n.id));
    for (const e of cappedInline.allEdges) {
      assert.equal(inlineKeptIds.has(e.a) && inlineKeptIds.has(e.b), true);
    }
    assert.equal(cappedInline.allEdges.length, 0);

    // Builder getInlineGraph() and ensureFresh() auto-wake when sleeping
    assert.equal(cappedBuilder.sleep(), true);
    assert.equal(cappedBuilder.getStatus().asleep, true);
    const wokeInline = await cappedBuilder.getInlineGraph({ minSimilarity: 0.6 });
    assert.equal(cappedBuilder.getStatus().asleep, false);
    assert.equal(wokeInline.nodes.length, 1);

    assert.equal(cappedBuilder.sleep(), true);
    await cappedBuilder.ensureFresh();
    assert.equal(cappedBuilder.getStatus().asleep, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health probe & sleep wake: unauthenticated health stays asleep, GET / wakes and caches valid graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-sleep-"));
  const dataDir = join(root, "data");
  const memoryDir = join(root, "memory");
  await mkdir(dataDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "m_aaaaaaaaaaaa.md"), makeMemory("m_aaaaaaaaaaaa", "Sleep check memory"));

  let asleepFlag = false;
  const app = await createAppServer({
    port: 0,
    memoryDir,
    dataDir,
    vectorsPath: join(root, "no-vectors"),
    token: "sleep-token-123",
    getStatusExtra: () => ({ attached: false, asleep: asleepFlag, startedAt: Date.now(), idleMs: 0, initError: "" }),
    onTouch: (status) => {
      if (status >= 400 || !asleepFlag) return;
      asleepFlag = false;
      app.builder.wake();
    },
  });

  try {
    await app.builder.ensureFresh();
    asleepFlag = app.builder.sleep();
    assert.equal(asleepFlag, true);
    assert.equal(app.builder.getStatus().asleep, true);

    const anonHealth = await httpReq(app.port, "/api/health");
    assert.equal(anonHealth.status, 200);
    assert.equal(app.builder.getStatus().asleep, true);

    const firstHtml = await httpReq(app.port, "/", {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(firstHtml.status, 200);
    assert.equal(asleepFlag, false);
    assert.equal(app.builder.getStatus().asleep, false);
    assert.equal(firstHtml.body.includes("m_aaaaaaaaaaaa"), true);
    assert.equal(firstHtml.body.includes('"nodes":[]'), false);

    const cachedHtml = await httpReq(app.port, "/", {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
    });
    assert.equal(cachedHtml.status, 200);
    assert.equal(cachedHtml.body, firstHtml.body);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest, icon, and package cleanliness: no _ai key, no SVG comments, and clean HTML titles", async () => {
  const pkg = JSON.parse(await readFile(join(PKG_DIR, "package.json"), "utf8"));
  assert.equal("_ai" in pkg, false);

  const svg = await readFile(join(PKG_DIR, "page/icon.svg"), "utf8");
  assert.equal(svg.includes("<!--"), false);

  const dataPrefix = "data:image/svg+xml;base64,";
  assert.equal(pkg.magpie?.icon?.startsWith(dataPrefix), true);
  const decoded = Buffer.from(pkg.magpie.icon.slice(dataPrefix.length), "base64").toString("utf8");
  assert.equal(decoded.includes("<!--"), false);

  const launchHtml = await readFile(join(PKG_DIR, "page/index.html"), "utf8");
  const appHtml = await readFile(join(PKG_DIR, "page/app/index.html"), "utf8");
  assert.equal(launchHtml.includes("<title>Memory Graph</title>"), true);
  assert.equal(appHtml.includes("<title>Memory Graph</title>"), true);
});

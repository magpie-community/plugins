本文由AI自动生成

# @magpie-community/page-memory-graph

Draws the memories magpie already saved as an Obsidian-style graph inside magpie's window. Whether two memories are linked is decided **only by magpie's own `memory_search` order** — no embeddings, no external model, no API key. Hover any node to read its full text, kind, scope, tags, why, sources, in/out links and link strength.

把 magpie 已保存的记忆画成 Obsidian 式关系图谱。两条记忆是否关联，**只由 magpie 内置 `memory_search` 的排序结果决定**：不自建向量、不调用外部模型、不需要 API key。悬浮任意节点，可以看正文、类型、范围、标签、记录原因、来源、出入链与关联强度。

## Install

From magpie's **Plugins › Discover**, or:

```sh
magpie plugin add @magpie-community/page-memory-graph
```

Open **Memory Graph** from the sidebar. The first open scans `~/.config/magpie/memory/` and calls `memory_search` once per active memory; on a library of ~120 active memories that takes about 50 seconds on an 8-way local pool. The graph is usable while it builds, and later opens only query new or changed memories.

## How an edge is decided

For every memory with `status: active`, the plugin calls the built-in tool:

```json
{ "name": "memory_search", "arguments": { "query": "<title + first 500 chars>", "limit": 16, "scope": "all" } }
```

The returned order is the only signal. The plugin skips the memory itself and the first 8 remaining hits become edges:

| Position in `memory_search` | Link strength | Score shown |
| --- | --- | --- |
| 1–2 | strong | 1.000–0.875 |
| 3–5 | medium | 0.750–0.500 |
| 6–8 | weak | 0.375–0.125 |

The number shown is `(8 - rank + 1) / 8`, rounded to three decimals; a mutual edge gets `+0.05` capped at `1.000`. It is a **rank-normalized score, not a cosine similarity** — `memory_search` returns order, not a distance, so this is the only honest numeric signal available. A pair can rank differently under a different query; that is retrieval, not a bug.

Labels are hidden by default on a large graph. They appear when you zoom past `1.45×`, or when the current filter leaves at most 100 visible nodes; hover and selection always show a label.

Superseded memories are drawn as hollow nodes with a dashed ring; they can be link targets but are never used as query anchors. `candidate` and `archived` memories are not drawn.

## What it reads and writes

Read-only on magpie's data:

- `~/.config/magpie/memory/m_*.md` — parsed locally, never modified.
- `~/.config/magpie/gateway.json` — to find the local gateway address.
- the built-in `memory_search` tool over the loopback MCP endpoint.

Writes only its own derived cache:

```text
~/.config/magpie/memory-graph/graph-cache.json   # nodes + each memory's hit order
~/.config/magpie/memory-graph/service-token.json # token for the local page service
```

Delete the directory and the next open rebuilds everything. No memory file is touched, and `memory_save` / `memory_forget` are never called.

## Hover card

Each node's card shows, in order:

1. kind, memory id (click to copy), title;
2. scope, status, origin, `supersededBy` when present;
3. full body (truncated at 2,000 characters in the payload, with an explicit note);
4. `why` — the reason magpie recorded;
5. tags — click one to filter the graph;
6. created / updated timestamps;
7. sources — agent, shortened directory, quoted evidence;
8. related memories, each with a three-decimal score, rank and mutual marker; click one to focus it;
9. degree and total score.

Edges also have a hover card with both endpoints, strength, direction and rank.

## Controls

- drag a node to pin it while dragging; drag the background to pan; wheel to zoom;
- click a node for a one-hop highlight; double-click to focus two hops; `Esc` resets;
- labels stay off on a dense graph; zoom past `1.45×` or filter down to 100 nodes to show them;
- `/` or `⌘K` focuses search; `0` or `F` fits the graph;
- filters: kind, scope, tag, free text, mutual-only, hide superseded;
- **Rebuild all** re-queries every active memory (about 50 seconds for 120 memories).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `3491` | local page service; declared in `magpie.page.service` |
| `topK` | `8` | how many `memory_search` hits become edges per memory |
| `concurrency` | `8` | parallel `memory_search` calls |
| `maxNodes` | `200` | render cap; the current 182 visible nodes fit |

Set them in magpie's plugin options. `gateway`, `memoryDir`, `dataDir` and `buildTimeoutMs` are also accepted for unusual installs.

## Difference from the built-in `memory` knowledge-graph MCP

The `memory` MCP server magpie can expose to agents (`create_entities`, `create_relations`, `read_graph`, …) is a separate, in-memory entity graph: it is agent-facing, it does not persist, and its relations are whatever an agent wrote. This page is different:

- it is for **humans looking at the memories magpie already stores**;
- its edges are **derived from `memory_search` order**, not authored relations;
- it is **read-only** and adds no new write path to memory;
- its cache is rebuildable and disposable.

## Limits

- First build is dominated by `memory_search` latency (~3 seconds per call here); 120 active memories at 8-way concurrency is ~50 seconds.
- `memory_search` returns order, not scores; link strength is a banded rank, not a probability.
- The page is served on `127.0.0.1`; opening magpie web on another computer points at that computer's loopback, so this page is for the desktop window (same as other page+service plugins).
- The graph shows at most 200 nodes by default; raise `maxNodes` if your library is larger.

## Security

The local service binds `127.0.0.1` only, checks `Host` against loopback, allows only `Origin: null` (the sandboxed magpie page) or its own origin, and requires a 32-byte token injected into the HTML it serves. Memory text is rendered with `textContent`, never `innerHTML`. CORS headers are present on every response, including errors, so a failed request still shows its real status.

## Files

- `index.mjs` — plugin host, local HTTP service, token/Host/Origin checks;
- `lib/` — memory scan, frontmatter parser, MCP client, ranking, cache, graph payload;
- `page/index.html`, `page/boot.js` — sandboxed hand-off page;
- `page/app/` — the real UI, force layout and hover card.

## License

MIT. See `LICENSE`.

This package was written with AI assistance and reviewed by its author; it ships without a test suite.

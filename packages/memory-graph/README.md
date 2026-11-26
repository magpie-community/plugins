本文由AI自动生成

# @magpie-community/page-memory-graph

Draws the memories magpie already saved as an Obsidian-style graph inside magpie's window. Edges are computed locally from **semantic cosine similarity** — reusing magpie's built-in multilingual embedding vectors (`MEV1` `vectors.bin`), with a zero-dependency local TF-IDF + CJK bigram + tag Jaccard fallback when vectors are absent, plus dashed lineage edges for `supersededBy` memories.

把 magpie 已保存的记忆画成 Obsidian 式关系图谱。节点连线基于**本地语义余弦相似度**计算：直接复用 magpie 内置多语言向量库（`vectors.bin`），缺失向量时自动回退到零依赖本地 TF-IDF（中文二元词 + 英文词元）与标签 Jaccard 相似度，并为 `supersededBy` 记忆自动补全演进虚线。纯本地只读、零外部依赖、毫秒级出图。

## Install

From magpie's **Plugins › Discover**, or:

```sh
magpie plugin add @magpie-community/page-memory-graph
```

## How edges are decided

1. **Vector cosine similarity**: Reads `~/.cache/magpie/paraphrase-multilingual-MiniLM-L12-v2/*/vectors.bin` (`MEV1` 384-dim embeddings) and matches each memory via `sha256(text + "\n" + why)`. Pairwise cosine similarity determines edge presence and thickness.
2. **Zero-dependency lexical fallback**: For memories without cached embeddings (or environments with semantic search off), falls back to local TF-IDF (CJK 2-grams + word tokens) combined with tag Jaccard overlap.
3. **Evolution lineage**: Any `superseded` memory with `supersededBy` pointing to a visible node automatically receives a dashed lineage edge.
4. **Live threshold slider**: Defaults to `minSimilarity = 0.60`, adjustable in real time from `0.35` to `0.90` in the top bar without rebuilding.

## What it reads and writes

Read-only on magpie's data:

- `~/.config/magpie/memory/m_*.md` — parsed locally, never modified.
- `~/.cache/magpie/paraphrase-multilingual-MiniLM-L12-v2/*/vectors.bin` — read-only vector lookup.

Writes only its own derived cache:

```text
~/.config/magpie/memory-graph/graph-cache.json   # slim metadata + similarity edges (body omitted)
~/.config/magpie/memory-graph/service-token.json # token for the local page service
```

## Controls & Obsidian UI

- Drag a node to pin while dragging; drag background to pan; wheel or bottom-right `+` / `−` to zoom; `⌖` (`0` / `F`) to fit; `↻` to re-layout;
- `⚙` floating panel to tune node size, edge thickness, repel force, link distance, and label zoom threshold;
- Top-bar **similarity slider (`0.35 ~ 0.90`)** to filter edges live;
- Click legend dots to toggle kind filters; click a node or edge for its glassmorphic detail card (`supersededBy` jumps straight to the newer memory);
- Double-click a node to focus 2 hops; `/` or `⌘K` focuses search; `Esc` closes and resets.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `3491` | local page service; declared in `magpie.page.service` |
| `minSimilarity` | `0.6` | default cosine similarity threshold (`0.35`–`0.95`) |
| `maxNodes` | `1000` | render cap (`0` for unlimited) |
| `idleMinutes` | `5` | go to sleep after this many idle minutes; `0` never sleeps |

## License

MIT. See `LICENSE`.

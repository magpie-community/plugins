// 本文由AI自动生成
// 扫描 magpie 的记忆目录，按「stat 快路径 → 整文件 sha256」做增量。

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseMemory, titleOf } from "./frontmatter.mjs";

const NAME = /^(m_[0-9a-f]{12})\.md$/;
const statKey = (st) => `${st.size}:${Math.round(st.mtimeMs)}`;
const hashOf = (raw) => createHash("sha256").update(raw).digest("hex");

async function pool(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function scanMemories(dir, { cacheNodes = {}, concurrency = 8 } = {}) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    const wrapped = new Error(`Cannot read memory directory ${dir}`);
    wrapped.code = "NO_MEMORY_DIR";
    wrapped.cause = error;
    throw wrapped;
  }

  const names = entries.filter((name) => NAME.test(name));
  const nodes = new Map();
  const added = [];
  const changed = [];
  const warnings = [];

  await pool(names, concurrency, async (name) => {
    const id = NAME.exec(name)[1];
    const full = join(dir, name);
    try {
      const info = await stat(full);
      const key = statKey(info);
      const prev = cacheNodes[id];

      if (prev && prev.stat === key && prev.hash && prev.body !== undefined) {
        nodes.set(id, prev);
        return;
      }

      const raw = await readFile(full, "utf8");
      const hash = hashOf(raw);

      if (prev && prev.hash === hash && prev.body !== undefined) {
        nodes.set(id, { ...prev, stat: key, mtime: info.mtimeMs });
        return;
      }

      const meta = parseMemory(id, raw);
      const body = meta.body || "";
      const node = {
        id,
        hash,
        stat: key,
        mtime: info.mtimeMs,
        size: info.size,
        kind: meta.kind,
        scope: meta.scope,
        status: meta.status,
        origin: meta.origin,
        tags: meta.tags,
        why: meta.why,
        created: meta.created,
        updated: meta.updated,
        supersededBy: meta.supersededBy,
        sources: meta.sources,
        title: titleOf(body, meta.why, id),
        body: body.slice(0, 2000),
        bodyTruncated: body.length > 2000,
      };
      nodes.set(id, node);
      if (prev) changed.push(id);
      else added.push(id);
    } catch (error) {
      warnings.push({ level: "warn", text: `${id}: ${error?.message || error}` });
      const prev = cacheNodes[id];
      if (prev) {
        nodes.set(id, prev);
      } else {
        nodes.set(id, {
          id,
          hash: "",
          stat: "",
          mtime: 0,
          size: 0,
          kind: "unknown",
          scope: "global",
          status: "active",
          origin: "",
          tags: [],
          why: "",
          created: "",
          updated: "",
          supersededBy: null,
          sources: [],
          title: id,
          body: "",
          bodyTruncated: false,
          parseWarn: true,
        });
      }
    }
  });

  const removed = Object.keys(cacheNodes).filter((id) => !nodes.has(id));
  const stats = { total: nodes.size, active: 0, superseded: 0, candidate: 0, archived: 0 };
  for (const node of nodes.values()) {
    if (stats[node.status] !== undefined) stats[node.status]++;
  }

  return { nodes, added, changed, removed, warnings, stats, dir };
}

// 本文由AI自动生成
// 派生缓存：graph-cache.json 只存「扫描到的节点」和「每条记忆的 search 命中顺序」。
// 边永远由命中顺序现算，所以改 topK、改阈值不需要重新查询；
// 删掉整个文件也只是下次重算，不会丢 magpie 的任何原生记忆。

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SCHEMA = 1;

export async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJSON(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, JSON.stringify(value), { mode });
  await rename(temp, path);
}

export async function loadCache(dir) {
  const path = join(dir, "graph-cache.json");
  const raw = await readJSON(path, null);

  if (!raw || raw.v !== SCHEMA || typeof raw !== "object") {
    if (raw) {
      try {
        await rename(path, `${path}.v${String(raw.v ?? "unknown")}.bak`);
      } catch {
        /* 备份失败也继续，缓存坏了不该挡住页面 */
      }
    }
    return { v: SCHEMA, nodes: {}, hits: {}, stats: {}, builtAt: null };
  }

  return {
    v: SCHEMA,
    nodes: raw.nodes && typeof raw.nodes === "object" ? raw.nodes : {},
    hits: raw.hits && typeof raw.hits === "object" ? raw.hits : {},
    stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
    builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null,
  };
}

export async function saveCache(dir, payload) {
  await writeJSON(join(dir, "graph-cache.json"), { v: SCHEMA, ...payload });
}

export async function serviceToken(dir) {
  const path = join(dir, "service-token.json");
  const kept = await readJSON(path, null);
  if (kept && /^[a-f0-9]{64}$/.test(String(kept.token || ""))) return kept.token;
  const token = randomBytes(32).toString("hex");
  await writeJSON(path, { token });
  return token;
}

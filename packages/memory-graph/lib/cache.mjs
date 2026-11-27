// Derived cache: stores scanned node metadata and similarity edges.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SCHEMA = 3;

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJSON(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let renamed = false;
  try {
    await writeFile(temp, JSON.stringify(value), { mode });
    await rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(temp).catch(() => {});
    }
  }
}

export async function cleanupTempFiles(dir) {
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((name) => /\.tmp-[^/]+$/.test(name))
        .map((name) => unlink(join(dir, name)).catch(() => {})),
    );
  } catch {
    /* Ignore if directory does not exist or is unreadable */
  }
}

export async function loadCache(dir) {
  const path = join(dir, "graph-cache.json");
  const raw = await readJSON(path, null);

  if (!raw || raw.v !== SCHEMA || typeof raw !== "object") {
    if (raw) {
      try {
        await rename(path, `${path}.v${String(raw.v ?? "unknown")}.bak`);
      } catch {
        /* Continue even if backup fails; corrupt cache should not block the page */
      }
    }
    return { v: SCHEMA, nodes: {}, edges: [], vectorInfo: null, builtAt: null };
  }

  return {
    v: SCHEMA,
    nodes: raw.nodes && typeof raw.nodes === "object" ? raw.nodes : {},
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    vectorInfo: raw.vectorInfo && typeof raw.vectorInfo === "object" ? raw.vectorInfo : null,
    builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null,
  };
}

export async function saveCache(dir, payload) {
  const slimNodes = {};
  for (const [id, node] of Object.entries(payload?.nodes || {})) {
    if (!node || typeof node !== "object") continue;
    const { body: _body, ...rest } = node;
    slimNodes[id] = rest;
  }
  await writeJSON(join(dir, "graph-cache.json"), {
    v: SCHEMA,
    ...payload,
    nodes: slimNodes,
  });
}

export async function serviceToken(dir) {
  const path = join(dir, "service-token.json");
  const kept = await readJSON(path, null);
  if (kept && /^[a-f0-9]{64}$/.test(String(kept.token || ""))) return kept.token;
  const token = randomBytes(32).toString("hex");
  await writeJSON(path, { token });
  return token;
}

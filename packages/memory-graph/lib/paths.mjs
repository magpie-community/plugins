// Read-only path helpers for magpie memory and local vector directories.

import { homedir } from "node:os";
import { join } from "node:path";

function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function memoryDir() {
  return join(configDir(), "memory");
}

export function dataDir() {
  return process.env.MAGPIE_MEMORY_GRAPH_DATA_DIR || join(configDir(), "memory-graph");
}

function cacheDir() {
  if (process.env.MAGPIE_CACHE_DIR) return process.env.MAGPIE_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "magpie");
  return join(homedir(), ".cache", "magpie");
}

export function vectorsDir() {
  return process.env.MAGPIE_VECTORS_PATH || join(cacheDir(), "paraphrase-multilingual-MiniLM-L12-v2");
}

// 结果缓存：热榜/额度这类接口变化慢、额度有限，重复调用很浪费。
// 缓存键里带凭据的哈希，避免多账号之间串数据；键本身不保存密钥。

import { createHash } from "node:crypto";

export function cacheKey(token, path, query) {
  const digest = createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
  const params = Object.entries(query ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${digest}:${path}?${params}`;
}

// 有界的 TTL 缓存；同一键并发请求只打一次上游（in-flight 合并）。
export class Cache {
  constructor({ enabled = true, max = 200 } = {}) {
    this.enabled = enabled;
    this.max = max;
    this.entries = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // 移到末尾，Map 的插入顺序就充当 LRU。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttl) {
    if (!this.enabled || ttl <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + ttl });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  async remember(key, ttl, producer) {
    if (!this.enabled || ttl <= 0) return producer();

    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttl);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }
}
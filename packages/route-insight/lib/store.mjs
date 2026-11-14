import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir() {
  return process.env.MAGPIE_CONFIG_DIR || process.env.MAGPIE_CONFIG_HOME || path.join(os.homedir(), ".config", "magpie");
}

export function configFile(name) {
  return path.join(configDir(), name);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// usage.jsonl 一行是一次尝试。只留看板要用的字段，几万行也只占十几 MB。
export function compact(row) {
  if (!row || typeof row !== "object") return null;
  const t = typeof row.t === "string" ? row.t : "";
  const e = Date.parse(t);
  if (!t || !Number.isFinite(e)) return null;
  return {
    e,
    t,
    rid: row.route_id === undefined || row.route_id === null ? null : row.route_id,
    agent: row.agent || "",
    provider: row.provider || "",
    model: row.model || "",
    served: row.served || row.model || "",
    req: row.req || "",
    keyId: row.providerKeyId || "",
    ep: row.ep || "",
    stop: row.stop || "",
    status: num(row.status) || 0,
    inp: num(row.in) || 0,
    cr: num(row.cache_read) || 0,
    cw: num(row.cache_write) || 0,
    out: num(row.out) || 0,
    re: num(row.reasoning) || 0,
    // 强度直接来自 usage.jsonl（routing 日志对部分供应商不写 effort，之前只看 routing 就全空）
    ef: String(row.effort || ""),
    tier: String(row.tier_served || ""),
    ms: num(row.ms) || 0,
    ttft: num(row.ttft_ms) || 0,
    ttftr: num(row.first_reasoning_ms) || 0,
    sent: num(row.sent_ms) || 0,
    mask: num(row.masking_ms) || 0,
    flow: num(row.flow_ms) || 0,
    resp: row.response_id ? String(row.response_id) : "",
    credits: num(row.credits) || 0,
    cip: row.client_ip || "",
    host: row.host || ""
  };
}

function readSlice(file, from, to) {
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.max(0, to - from);
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) {
      const n = fs.readSync(fd, buf, got, size - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// 只增不重读：首次从文件尾部读 historyBytes，之后每次只读新增的字节。
export class UsageStore {
  constructor({ bytes = 24 * 1024 * 1024, keep = 60000 } = {}) {
    this.file = configFile("usage.jsonl");
    this.bytes = bytes;
    this.keep = keep;
    this.rows = [];
    this.offset = 0;
    this.tail = "";
    this.loaded = false;
    this.readAt = 0;
    this.skipped = 0;
  }

  reset() {
    this.rows = [];
    this.offset = 0;
    this.tail = "";
    this.loaded = false;
  }

  ingest(text) {
    const merged = this.tail + text;
    const parts = merged.split("\n");
    this.tail = parts.pop() ?? "";
    let added = 0;
    for (const line of parts) {
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.skipped += 1;
        continue;
      }
      const row = compact(parsed);
      if (row) {
        this.rows.push(row);
        added += 1;
      }
    }
    if (this.rows.length > this.keep) this.rows.splice(0, this.rows.length - this.keep);
    return added;
  }

  refresh() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.reset();
      this.readAt = Date.now();
      return this;
    }
    if (!this.loaded || stat.size < this.offset) {
      this.reset();
      const start = Math.max(0, stat.size - this.bytes);
      const text = readSlice(this.file, start, stat.size);
      this.offset = stat.size;
      // 从中间开始读时，第一行是半截的。
      if (start > 0) {
        const cut = text.indexOf("\n");
        if (cut >= 0) this.ingest(text.slice(cut + 1));
      } else {
        this.ingest(text);
      }
      this.loaded = true;
    } else if (stat.size > this.offset) {
      const text = readSlice(this.file, this.offset, stat.size);
      this.offset = stat.size;
      this.ingest(text);
    }
    this.readAt = Date.now();
    return this;
  }
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(configFile(name), "utf8"));
  } catch {
    return fallback;
  }
}

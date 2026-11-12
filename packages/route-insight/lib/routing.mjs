import fs from "node:fs";
import path from "node:path";
import { configFile } from "./store.mjs";

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

export function routingFileFor(now) {
  const date = new Date(now);
  const name = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + ".jsonl";
  return configFile(path.join("routing", name));
}

function ruleName(rule) {
  if (!rule) return "";
  if (typeof rule === "string") return rule;
  return String(rule.name || rule.id || rule.title || "");
}

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const length = size - from;
    if (length <= 0) return "";
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const read = fs.readSync(fd, buf, got, length - got, from + got);
      if (!read) break;
      got += read;
    }
    let text = buf.toString("utf8", 0, got);
    if (from > 0) {
      const cut = text.indexOf("\n");
      text = cut < 0 ? "" : text.slice(cut + 1);
    }
    return text;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 读不到就当没有。
    }
  }
}

// usage.jsonl 只有用量，推理强度和命中的规则在 routing/<date>.jsonl 里，按 responseId 或同一秒的落点对齐。
export class RoutingIndex {
  constructor({ bytes = 8 * 1024 * 1024 } = {}) {
    this.bytes = bytes;
    this.file = "";
    this.size = -1;
    this.byResponse = new Map();
    this.byMoment = new Map();
    this.loadedAt = 0;
  }

  reload(now) {
    const file = routingFileFor(now);
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = -1;
    }
    if (file === this.file && size === this.size) return;
    this.file = file;
    this.size = size;
    this.byResponse = new Map();
    this.byMoment = new Map();
    this.loadedAt = Date.now();
    if (size < 0) return;
    const text = readTail(file, this.bytes);
    for (const line of text.split("\n")) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row) continue;
      const usage = Array.isArray(row.usage) && row.usage.length ? row.usage[row.usage.length - 1] : null;
      const tries = Array.isArray(row.tries) ? row.tries : [];
      const lastTry = tries.length ? tries[tries.length - 1] : null;
      // magpie 只在部分请求上写顶层 effort；没有时退到实际发出的那一次尝试。
      const effort = String(row.effort || (lastTry && lastTry.effort) || "");
      const info = {
        effort,
        rule: ruleName(row.rule),
        req: String(row.model || ""),
        group: row.group && row.group.name ? String(row.group.name) : "",
        served: String(row.served || (usage && usage.model) || ""),
        provider: String((usage && usage.provider) || row.provider || ""),
        folder: String(row.folder || ""),
        tries: Array.isArray(row.order) ? row.order.length : 0
      };
      if (row.responseId) this.byResponse.set(String(row.responseId), info);
      const at = Date.parse(row.time);
      if (Number.isFinite(at)) {
        const key = Math.floor(at / 1000) + "|" + info.provider + "|" + info.served;
        this.byMoment.set(key, info);
      }
    }
  }

  lookup(row, now) {
    this.reload(now);
    const response = row.resp || row.responseId;
    if (response) {
      const hit = this.byResponse.get(String(response));
      if (hit) return hit;
    }
    const key = Math.floor(row.e / 1000) + "|" + row.provider + "|" + (row.served || row.model);
    return this.byMoment.get(key) || null;
  }

  decorate(rows, now) {
    this.reload(now);
    return rows.map((row) => {
      const info = this.lookup(row, now);
      // usage.jsonl 自己也带 effort；routing 缺失时不要用空串盖掉它（deepseek 这类就是这样丢的）。
      const own = row.ef || row.effort || "";
      if (!info) return Object.assign({}, row, { effort: own });
      return Object.assign({}, row, {
        effort: info.effort || own,
        rule: info.rule,
        asked: info.req,
        group: info.group,
        tries: info.tries
      });
    });
  }
}

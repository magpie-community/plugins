// JSONL read/write: serialized appends, corrupt lines skipped. Write failures throw an ApiError with a Chinese message (P5-2: disk write failure notice).
import { appendFile, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApiError } from "../ws/methods.js";

export async function readJsonl<T = unknown>(file: string): Promise<T[]> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // Skip corrupt lines
    }
  }
  return out;
}

// One serialized write queue per file to keep append order.
const writers = new Map<string, Promise<void>>();

export function appendJsonl(file: string, obj: unknown): Promise<void> {
  const prev = writers.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("io_error", `写入数据失败（${file}）：${(e as Error)?.message ?? e}`);
    }
  });
  writers.set(
    file,
    next.catch(() => {})
  );
  return next;
}

// Full rewrite (rare path, e.g. cleanup)
export async function writeJsonl(file: string, items: unknown[]): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid;
    await writeFile(tmp, items.map((o) => JSON.stringify(o)).join("\n") + (items.length ? "\n" : ""), "utf8");
    await rename(tmp, file);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("io_error", `写入数据失败（${file}）：${(e as Error)?.message ?? e}`);
  }
}

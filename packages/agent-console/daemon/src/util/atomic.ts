// Atomic JSON write: temp file + rename. On fs failure throws an ApiError with a Chinese message (P5-2: disk write failure notice).
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ApiError } from "../ws/methods.js";

export async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, file);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("io_error", `写入数据失败（${file}）：${(e as Error)?.message ?? e}`);
  }
}

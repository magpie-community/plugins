import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// The page shows `reason`, a code it translates; the message is for the log.
export const fail = (reason, message) =>
  Object.assign(new Error(message), { reason });
export const reasonOf = (e) => e?.reason || "unexpected";

export async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw fail(
      "fileUnreadable",
      `Cannot read ${path}: ${e instanceof SyntaxError ? "invalid JSON" : e.code || "read failed"}`,
    );
  }
}
export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

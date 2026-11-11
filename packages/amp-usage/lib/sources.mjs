import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, delimiter, isAbsolute } from "node:path";
import { projectThread, validThread } from "./parser.mjs";
import { readJSON, writeJSON } from "./storage.mjs";

const exec = promisify(execFile);
export async function findAmp(configured = "") {
  const names = process.platform === "win32" ? ["amp.exe"] : ["amp"];
  const paths = configured
    ? [configured]
    : [
        ...(process.env.PATH || "").split(delimiter),
        join(homedir(), ".amp", "bin"),
        join(homedir(), ".local", "share", "amp", "bin"),
      ].flatMap((d) => names.map((n) => join(d, n)));
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(
    "Amp CLI not found. Install Amp and run amp login, or set ampPath in plugin options.",
  );
}
export async function runAmp(binary, args, timeout = 30_000) {
  try {
    const pending = exec(binary, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return JSON.parse(stdout);
  } catch (e) {
    // The CLI's stderr may contain private server responses or credentials.
    if (e instanceof SyntaxError)
      throw new Error("Amp returned invalid JSON. Update Amp and try again.");
    throw new Error(
      e.killed
        ? "Amp command timed out. Try syncing again."
        : "Amp command failed. Check amp login and network access in your terminal.",
    );
  }
}
export function localDirs() {
  return [
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "amp",
      "threads",
    ),
  ];
}
export async function readLocal(dirs = localDirs()) {
  const threads = new Map();
  const errors = [];
  for (const dir of dirs) {
    if (!isAbsolute(dir))
      throw new Error("Thread directories must be absolute paths.");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(
        e.code === "ENOENT"
          ? "Local thread directory not found."
          : "Cannot read local thread directory.",
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      try {
        const st = await lstat(path);
        if (!st.isFile() || st.size > 32 * 1024 * 1024) throw new Error();
        const t = JSON.parse(await readFile(path, "utf8"));
        if (!validThread(t.id)) throw new Error();
        const projected = projectThread(t);
        if (
          threads.has(t.id) &&
          JSON.stringify(threads.get(t.id)) !== JSON.stringify(projected)
        ) {
          threads.set(t.id, null);
          errors.push(
            "Conflicting local copies of one thread; it was excluded.",
          );
        } else if (!threads.has(t.id)) threads.set(t.id, projected);
      } catch {
        errors.push(
          "A local thread was unreadable, oversized, or invalid; it was excluded.",
        );
      }
    }
  }
  return {
    threads: [...threads.values()].filter(Boolean),
    errors,
    remaining: 0,
  };
}

export async function readCloud({
  dataDir,
  ampPath = "",
  run,
  maxExports = 20,
  now = Date.now,
} = {}) {
  const binary = run ? "amp" : await findAmp(ampPath);
  const invoke = run || ((args, ms) => runAmp(binary, args, ms));
  const deadline = now() + 60_000;
  const call = (args) => {
    const ms = Math.min(30_000, deadline - now());
    if (ms <= 0)
      throw new Error("Amp sync time budget reached. Sync again to continue.");
    return invoke(args, ms);
  };
  const indexPath = join(dataDir, "cloud-index.json");
  const index = await readJSON(indexPath, { version: 1, threads: {} });
  if (
    index.version !== 1 ||
    !index.threads ||
    typeof index.threads !== "object"
  )
    throw new Error("Unsupported cloud cache index.");
  const listed = new Map();
  for (let offset = 0; offset < 100_000; offset += 200) {
    const page = await call([
      "threads",
      "list",
      "--json",
      "--include-archived",
      "--limit",
      "200",
      "--offset",
      String(offset),
    ]);
    if (!Array.isArray(page))
      throw new Error("Unexpected Amp thread list format.");
    let added = 0;
    for (const t of page) {
      if (
        !validThread(t?.id) ||
        typeof t.updated !== "string" ||
        !Number.isFinite(Date.parse(t.updated))
      )
        throw new Error("Unexpected Amp thread metadata.");
      if (!listed.has(t.id)) added++;
      listed.set(t.id, t);
    }
    if (page.length < 200) break;
    if (!added || offset + 200 >= 100_000)
      throw new Error("Amp pagination did not finish; no usage was imported.");
  }
  const threads = [],
    errors = [];
  let exported = 0,
    remaining = 0;
  // Oldest changed threads first; successful exports advance their own checkpoint.
  const order = [...listed.values()].sort((a, b) =>
    a.updated.localeCompare(b.updated),
  );
  for (const meta of order) {
    const file = join(dataDir, "cloud", `${meta.id}.json`);
    let cached = null;
    try {
      cached = await readJSON(file, null);
    } catch {
      /* Re-export a damaged projection. */
    }
    if (index.threads[meta.id] !== meta.updated || !cached) {
      if (exported >= maxExports || now() >= deadline) {
        remaining++;
        continue;
      }
      exported++;
      try {
        const raw = await call(["threads", "export", meta.id]);
        if (raw?.id !== meta.id)
          throw new Error("Amp export returned a different thread.");
        cached = projectThread(raw);
        await writeJSON(file, cached);
        index.threads[meta.id] = meta.updated;
        await writeJSON(indexPath, index);
      } catch (e) {
        errors.push(e.message);
        continue;
      }
    }
    if (cached?.id !== meta.id) {
      errors.push("Cached thread ID mismatch; cache entry excluded.");
      delete index.threads[meta.id];
      continue;
    }
    threads.push(cached);
  }
  await writeJSON(indexPath, index);
  return { threads, errors, remaining, listed: listed.size, exported };
}

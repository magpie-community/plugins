import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveDaemonMainJs(): string | null {
  const self = fileURLToPath(import.meta.url);
  const norm = self.replace(/\\/g, "/");
  // esbuild single-file bundle: the whole package is dist/main.js
  if (norm.endsWith("/daemon/dist/main.js") || norm.endsWith("/dist/main.js")) return self;

  const here = dirname(self);
  const candidates = [
    join(here, "..", "..", "dist", "main.js"), // src/util → daemon/dist/main.js (vitest/tsc)
    join(here, "main.js"), // Already in the dist directory
    join(here, "..", "main.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** mtime of daemon/dist/main.js, used by the plugin to detect code updates and restart the process */
export function daemonBuildStamp(): string {
  try {
    const mainJs = resolveDaemonMainJs();
    if (!mainJs) return "0";
    return String(statSync(mainJs).mtimeMs);
  } catch {
    return "0";
  }
}

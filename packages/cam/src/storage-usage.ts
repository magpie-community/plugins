import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

function bytesAt(path: string): number {
  try {
    const info = lstatSync(path);
    if (info.isFile()) return info.size;
    if (info.isDirectory()) return readdirSync(path).reduce((total, name) => total + bytesAt(join(path, name)), 0);
  } catch {}
  return 0;
}

export function measureStorage(root: string, panel: string) {
  let originals = 0;
  let indexes = bytesAt(join(root, "sessions")) + bytesAt(join(root, "policies"));
  try {
    for (const platform of readdirSync(join(root, "platforms"), { withFileTypes: true })) {
      if (!platform.isDirectory()) continue;
      const directory = join(root, "platforms", platform.name);
      originals += bytesAt(join(directory, "images"));
      indexes += bytesAt(join(directory, "sessions")) + bytesAt(join(directory, "latest.json"));
    }
  } catch {}
  return { originals, indexes, panel: bytesAt(join(panel, "images")) + bytesAt(join(panel, "live.js")) };
}

import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonBuildStamp } from "../../daemon/src/util/buildStamp.js";

describe("daemonBuildStamp", () => {
  it("matches daemon/dist/main.js mtime (not stuck at 0)", () => {
    const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
    const distMain = join(root, "daemon", "dist", "main.js");
    const stamp = daemonBuildStamp();
    expect(stamp).not.toBe("0");
    expect(stamp).toBe(String(statSync(distMain).mtimeMs));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "../../daemon/src/providers/types.js";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => home.path,
}));
import { cachedModels, clearProviderCache } from "../../daemon/src/providers/infoCache.js";
import { magpieConfigFingerprint } from "../../daemon/src/providers/magpieGateway.js";

let tick: number;
beforeEach(() => {
  home.path = mkdtempSync(join(tmpdir(), "ac-cache-fp-"));
  tick = 2000;
  clearProviderCache();
});
afterEach(() => {
  clearProviderCache();
  rmSync(home.path, { recursive: true, force: true });
});
function change(file: string) {
  const path = join(home.path, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}");
  // Deterministic mtime changes; no filesystem timestamp resolution or sleep dependency.
  utimesSync(path, tick, tick++);
}
function fake(id: string) {
  const listModels = vi.fn(async () => [{ id: "native/model", name: "Native" }]);
  return { id, listModels } as unknown as Provider & { listModels: typeof listModels };
}

describe("per-provider Magpie model cache fingerprint", () => {
  it("a change during listing invalidates the very next read (pre-list fingerprint)", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const barrier = new Promise<void>((r) => { release = r; });
    const p = fake("claude");
    p.listModels.mockImplementationOnce(async () => {
      enter();
      await barrier;
      return [{ id: "stale/model", name: "Stale" }];
    });
    const first = cachedModels(p);
    await entered;
    change(".claude/settings.json");
    release();
    expect((await first)[0].id).toBe("stale/model");
    expect((await cachedModels(p))[0].id).toBe("native/model");
    expect(p.listModels).toHaveBeenCalledTimes(2);
  });

  it.each([
    [".claude/settings.json", ["claude"]],
    [".codex/models.json", ["codex"]],
    [".config/magpie/settings.json", ["claude", "codex", "dsh"]],
  ])("%s invalidates only relevant providers", async (file, invalidated) => {
    const providers = ["claude", "codex", "dsh", "cursor", "copilot", "devin"].map(fake);
    await Promise.all(providers.map((p) => cachedModels(p)));
    change(file);
    await Promise.all(providers.map((p) => cachedModels(p)));
    for (const p of providers) {
      expect(p.listModels, p.id).toHaveBeenCalledTimes(invalidated.includes(p.id) ? 2 : 1);
    }
  });

  it.each(["cursor", "copilot", "devin"])("%s has no Magpie-overlay fingerprint", async (id) => {
    change(".config/magpie/applied.json");
    expect(await magpieConfigFingerprint(id)).toBe("");
  });
});

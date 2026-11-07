import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";

afterEach(() => vi.unstubAllEnvs());

describe("ACP explicit model pick vs default validation", () => {
  it("validates saved/default models but sends a newly enabled explicit pick beyond the startup snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-model-switch-"));
    const log = join(dir, "config.jsonl");
    vi.stubEnv("FAKE_ACP_CONFIG_OPTIONS", JSON.stringify([
      { id: "model", category: "model", type: "select", currentValue: "magpie/old", options: [{ value: "magpie/old" }] },
    ]));
    vi.stubEnv("FAKE_ACP_CONFIG_LOG", log);
    const p = createAcpProvider({ id: "fake-model", name: "Fake ACP", binName: "fake-acp", acpArgs: [], installHint: "" });
    const session = await p.createSession({
      threadId: "t1", cwd: dir, model: "bogus-saved-model", mode: "default", effort: null, resumeId: null,
      launch: { cmd: process.execPath, prefixArgs: [resolve(__dirname, "fixtures/fake-acp-agent.mjs")] },
    });
    const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)) : [];
    try {
      // 1.3.6: a skipped default reports false so the manager doesn't mark it synced
      expect(await session.setModel("bogus-unprefixed-model")).toBe(false);
      expect(calls()).toEqual([]); // Both startup and unchecked defaults are rejected.
      expect(await session.setModel("magpie/old")).toBe(true);
      expect(calls().map((c) => c.value)).toEqual(["magpie/old"]);
      await session.setModel("magpie/new", { force: true });
      expect(calls().map((c) => c.value)).toEqual(["magpie/old", "magpie/new"]);
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

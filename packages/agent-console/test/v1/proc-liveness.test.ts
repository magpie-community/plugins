import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pidAlive } from "../../daemon/src/util/proc.js";
import { processAlive } from "../../lib/proc.mjs";
import { hasZombieFixture, zombieFixture } from "./zombie-fixture.js";

// index.mjs aliases this same processAlive helper; plugin-entry.test also exercises the actual host startup.
for (const [name, alive] of [
  ["plugin helper", (pid: number, kill: (pid: number, sig: 0) => unknown, deps: Parameters<typeof processAlive>[1]) => processAlive(pid, { ...deps, kill })],
  ["daemon pidAlive", pidAlive],
] as const) {
  describe(name, () => {
    it("parses comm with spaces/parentheses; only confirmed Z/X states are dead", () => {
      for (const state of ["R", "S", "D", "T", "I", "Z", "X"]) {
        expect(alive(123, () => true, { platform: "linux", readFile: () => `123 (a ) b ( c)) ${state} 1 0` })).toBe(!["Z", "X"].includes(state));
      }
    });
    it("preserves EPERM, ESRCH, non-Linux and unreadable /proc semantics", () => {
      const error = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
      for (const code of ["ENOENT", "EACCES", "EIO"]) {
        const deps = { platform: "linux" as const, readFile: error(code) };
        expect(alive(123, () => true, deps)).toBe(true);
        expect(alive(123, error("EPERM"), deps)).toBe(true);
        expect(alive(123, error("ESRCH"), deps)).toBe(false);
      }
      for (const platform of ["win32", "darwin"] as const) {
        expect(alive(123, error("EPERM"), { platform, readFile: () => { throw new Error("must not read proc"); } })).toBe(true);
      }
      expect(alive(123, () => true, { platform: "linux", readFile: () => "truncated stat" })).toBe(true);
    });
    it.skipIf(!hasZombieFixture)("kill(0) succeeds for a real zombie but the liveness check rejects it", async () => {
      const z = await zombieFixture();
      try {
        expect(readFileSync(`/proc/${z.pid}/stat`, "utf8")).toMatch(/\) Z /);
        expect(() => process.kill(z.pid, 0)).not.toThrow();
        expect(alive(z.pid, (pid, sig) => process.kill(pid, sig), {})).toBe(false);
        expect(alive(process.pid, (pid, sig) => process.kill(pid, sig), {})).toBe(true);
      } finally { await z.release(); }
    });
  });
}

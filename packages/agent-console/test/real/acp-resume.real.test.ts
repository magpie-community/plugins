// Cheap real-CLI check: dsh advertises session/resume (not load), and Agent Console reopens via resume.
// Opt-in: AC_REAL_DSH=<dsh binary>. Throwaway HOME; no model call, no sign-in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import { acpConfigForEntry } from "../../daemon/src/providers/acp/specs.js";
import { sessionOpenFromInitialize } from "../../daemon/src/providers/acp/sessionCaps.js";
import { catalogById } from "../../daemon/src/providers/catalog.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const tee = resolve(__dirname, "acp-tee.mjs");
const has = !!process.env.AC_REAL_DSH;

describe.runIf(has)("real dsh reconnect", () => {
  let home: string;
  let slog: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ac-dsh-resume-"));
    slog = join(home, "session.jsonl");
    for (const [k, v] of Object.entries({
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
      ACP_TEE_SESSION_LOG: slog,
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it("initialize: resume yes, load no; reopen uses session/resume", async () => {
    // First: open a fresh session to get a real session id
    const cfg = acpConfigForEntry(catalogById("dsh")!, "real")!;
    const launch = { cmd: process.execPath, prefixArgs: [tee, process.env.AC_REAL_DSH!] };
    const first = await createAcpProvider(cfg).createSession({
      threadId: "a", cwd: home, model: null, mode: "default", effort: null, resumeId: null, launch,
    });
    const events: ProviderEvent[] = [];
    const pump = (async () => { for await (const ev of first.events) events.push(ev); })();
    const end = Date.now() + 30000;
    while (Date.now() < end && !events.some((e) => e.type === "provider_session_id")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const id = (events.find((e) => e.type === "provider_session_id") as { id: string } | undefined)?.id;
    expect(id).toBeTruthy();
    await first.close();
    await pump;

    // The tee logged session/new; clear and reopen with that id
    const firstLog = existsSync(slog) ? readFileSync(slog, "utf8") : "";
    expect(firstLog).toContain('"session/new"');
    writeFileSync(slog, "");

    const second = await createAcpProvider(cfg).createSession({
      threadId: "b", cwd: home, model: null, mode: "default", effort: null, resumeId: id!, launch,
    });
    const ev2: ProviderEvent[] = [];
    const pump2 = (async () => { for await (const ev of second.events) ev2.push(ev); })();
    const end2 = Date.now() + 30000;
    while (Date.now() < end2 && !ev2.some((e) => e.type === "provider_session_id")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const reopen = (ev2.find((e) => e.type === "provider_session_id") as { id: string } | undefined)?.id;
    const log = existsSync(slog) ? readFileSync(slog, "utf8") : "";
    console.log("[dsh-resume]", JSON.stringify({ id, reopen, log: log.trim() }));
    expect(log).toContain('"session/resume"');
    expect(log).not.toContain('"session/load"');
    expect(reopen).toBe(id);
    await second.close();
    await pump2;
  });
});

// Pure parse check against a recorded dsh initialize shape (no CLI needed)
describe("dsh initialize shape", () => {
  it("matches what real dsh 0.2.1-rc.5 advertises", () => {
    expect(sessionOpenFromInitialize({
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {}, list: {}, resume: {} } },
    })).toEqual({ load: false, resume: true });
  });
});

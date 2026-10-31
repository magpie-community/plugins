// Reopening an old ACP conversation: use the method the Agent's initialize advertises.
// - loadSession → session/load (Cursor, Copilot, OpenCode, Pi, Devin CLI)
// - sessionCapabilities.resume only → session/resume (dsh)
// - both → prefer load (OpenCode)
// - neither → new session + a notice that prior context wasn't restored
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import { pickReconnect, sessionOpenFromInitialize } from "../../daemon/src/providers/acp/sessionCaps.js";
import type { ProviderSession } from "../../daemon/src/providers/types.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-acp-agent.mjs");
const launch = { cmd: process.execPath, prefixArgs: [fixture] };

let dir: string;
const env = { session: process.env.FAKE_ACP_SESSION, slog: process.env.FAKE_ACP_SESSION_LOG };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-resume-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  if (env.session === undefined) delete process.env.FAKE_ACP_SESSION;
  else process.env.FAKE_ACP_SESSION = env.session;
  if (env.slog === undefined) delete process.env.FAKE_ACP_SESSION_LOG;
  else process.env.FAKE_ACP_SESSION_LOG = env.slog;
});

function provider() {
  return createAcpProvider({ id: "fake-resume", name: "Fake ACP", binName: "fake-acp", acpArgs: [], installHint: "" });
}

type Run = { session: ProviderSession; events: ProviderEvent[]; slog: string; done: Promise<void> };

async function open(sessionCaps: { loadSession?: boolean; resume?: boolean } | null, resumeId: string | null): Promise<Run> {
  const slog = join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  if (sessionCaps) process.env.FAKE_ACP_SESSION = JSON.stringify(sessionCaps);
  else delete process.env.FAKE_ACP_SESSION;
  process.env.FAKE_ACP_SESSION_LOG = slog;
  const session = await provider().createSession({
    threadId: "t1", cwd: dir, model: null, mode: "default", effort: null, resumeId, launch,
  });
  const events: ProviderEvent[] = [];
  const done = (async () => { for await (const ev of session.events) events.push(ev); })();
  return { session, events, slog, done };
}

async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sessions = (r: Run) =>
  existsSync(r.slog) ? readFileSync(r.slog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const notices = (r: Run) => r.events.filter((e): e is Extract<ProviderEvent, { type: "notice" }> => e.type === "notice");
const sid = (r: Run) => r.events.find((e) => e.type === "provider_session_id") as Extract<ProviderEvent, { type: "provider_session_id" }> | undefined;
async function close(r: Run) { await r.session.close(); await r.done; }

describe("sessionOpenFromInitialize / pickReconnect", () => {
  it("reads loadSession and sessionCapabilities.resume the way ACP defines them", () => {
    expect(sessionOpenFromInitialize({ agentCapabilities: { loadSession: true } })).toEqual({ load: true, resume: false });
    expect(sessionOpenFromInitialize({ agentCapabilities: { sessionCapabilities: { resume: {} } } })).toEqual({ load: false, resume: true });
    expect(sessionOpenFromInitialize({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } } })).toEqual({ load: true, resume: true });
    expect(sessionOpenFromInitialize({ agentCapabilities: { sessionCapabilities: { resume: null } } })).toEqual({ load: false, resume: false });
    expect(sessionOpenFromInitialize({})).toEqual({ load: false, resume: false });
  });
  it("prefers load, then resume, then none", () => {
    expect(pickReconnect({ load: true, resume: true })).toBe("load");
    expect(pickReconnect({ load: false, resume: true })).toBe("resume");
    expect(pickReconnect({ load: true, resume: false })).toBe("load");
    expect(pickReconnect({ load: false, resume: false })).toBe("none");
  });
});

describe("reopening an ACP conversation", () => {
  it("calls session/load when the Agent advertises loadSession (and keeps the stored id)", async () => {
    const r = await open({ loadSession: true }, "old-load-id");
    try {
      await until(() => !!sid(r));
      expect(sessions(r)).toEqual([{ method: "session/load", sessionId: "old-load-id" }]);
      expect(sid(r)?.id).toBe("old-load-id");
      expect(notices(r)).toEqual([]);
    } finally {
      await close(r);
    }
  });

  it("calls session/resume when the Agent only advertises resume (dsh)", async () => {
    const r = await open({ resume: true }, "old-resume-id");
    try {
      await until(() => !!sid(r));
      expect(sessions(r)).toEqual([{ method: "session/resume", sessionId: "old-resume-id" }]);
      expect(sid(r)?.id).toBe("old-resume-id");
      expect(notices(r)).toEqual([]);
    } finally {
      await close(r);
    }
  });

  it("prefers load when both are advertised", async () => {
    const r = await open({ loadSession: true, resume: true }, "both-id");
    try {
      await until(() => !!sid(r));
      expect(sessions(r)).toEqual([{ method: "session/load", sessionId: "both-id" }]);
    } finally {
      await close(r);
    }
  });

  it("starts a new session and notices when neither load nor resume is advertised", async () => {
    const r = await open({}, "orphaned-id");
    try {
      await until(() => !!sid(r) && notices(r).length >= 1);
      expect(sessions(r)).toEqual([{ method: "session/new", sessionId: "fake-session-1" }]);
      expect(sid(r)?.id).toBe("fake-session-1");
      expect(notices(r)[0].message).toMatch(/session\/load|session\/resume|prior context|先前/);
    } finally {
      await close(r);
    }
  });

  it("a fresh conversation still uses session/new", async () => {
    const r = await open({ loadSession: true, resume: true }, null);
    try {
      await until(() => !!sid(r));
      expect(sessions(r)).toEqual([{ method: "session/new", sessionId: "fake-session-1" }]);
      expect(sid(r)?.id).toBe("fake-session-1");
    } finally {
      await close(r);
    }
  });
});

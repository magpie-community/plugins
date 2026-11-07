import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  magpieDefaultModel: vi.fn(async (_providerId: string): Promise<string | null> => "hub/model-a"),
}));

vi.mock("../../daemon/src/providers/magpieGateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../daemon/src/providers/magpieGateway.js")>();
  return {
    ...actual,
    magpieDefaultModel: mocks.magpieDefaultModel,
  };
});

import { AgentManager } from "../../daemon/src/agents/manager.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { initProviders } from "../../daemon/src/providers/registry.js";
import { MockSession, mockProviderMetrics } from "../../daemon/src/providers/mock.js";
import type { Config } from "../../daemon/src/config.js";

process.env.AGENT_CONSOLE_MOCK = "1";

const cfg: Config = { port: 0, dataDir: "", token: "t", version: "0.0.0", idleExitMinutes: 60, buildStamp: "0" };

let dir: string;
let threads: ThreadsStore;
let projects: ProjectsStore;
let settings: SettingsStore;
let gw: Gateway;
let manager: AgentManager;
let threadId: string;
let setModelSpy: ReturnType<typeof vi.spyOn>;
let sendSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-defmodel-"));
  mockProviderMetrics.createSessionCalls = 0;
  mocks.magpieDefaultModel.mockReset();
  mocks.magpieDefaultModel.mockResolvedValue("hub/model-a");
  threads = new ThreadsStore(dir);
  projects = new ProjectsStore(dir);
  settings = new SettingsStore(dir);
  gw = new Gateway(cfg);
  initProviders();
  manager = new AgentManager(gw, threads, projects, settings, new AttachmentStore(join(dir, "attachments")));
  const proj = await projects.create(dir);
  const meta = await threads.create({ projectId: proj.id, provider: "mock" });
  threadId = meta.id;
  setModelSpy = vi.spyOn(MockSession.prototype, "setModel");
  sendSpy = vi.spyOn(MockSession.prototype, "send");
});

afterEach(() => {
  setModelSpy.mockRestore();
  sendSpy.mockRestore();
  manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error("waitFor timeout");
};

describe("AgentManager Magpie default-model sync", () => {
  it("starts「默认」session with Magpie default, syncs on next idle send, and setModel(null) resolves again", async () => {
    // First turn: createSession gets hub/model-a (no prior setModel needed)
    await manager.send(threadId, { text: "hi" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(mockProviderMetrics.createSessionCalls).toBe(1);
    // turn_started uses o.model from createSession
    const evs1 = await threads.readEvents(threadId, 0, 50000);
    const started1 = evs1.find((e) => e.type === "turn_started") as { model?: string | null } | undefined;
    expect(started1?.model).toBe("hub/model-a");
    expect(mocks.magpieDefaultModel).toHaveBeenCalled();

    // Magpie default changes while idle
    mocks.magpieDefaultModel.mockResolvedValue("hub/model-b");
    setModelSpy.mockClear();
    sendSpy.mockClear();

    await manager.send(threadId, { text: "again" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");

    // syncDefaultModelIfNeeded must call setModel before send
    expect(setModelSpy).toHaveBeenCalled();
    expect(setModelSpy.mock.calls[0]).toEqual(["hub/model-b"]);
    const setOrder = setModelSpy.mock.invocationCallOrder[0]!;
    const sendOrder = sendSpy.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(sendOrder);

    // Explicit pick
    setModelSpy.mockClear();
    await manager.setModel(threadId, "magpie/newly-enabled");
    expect(setModelSpy.mock.calls).toEqual([["magpie/newly-enabled", { force: true }]]);
    expect((await threads.get(threadId))?.model).toBe("magpie/newly-enabled");

    // Back to「默认」→ resolve current Magpie default (hub/model-b)
    setModelSpy.mockClear();
    await manager.setModel(threadId, null);
    expect(setModelSpy.mock.calls).toEqual([["hub/model-b"]]);
    expect((await threads.get(threadId))?.model).toBeNull();
  }, 30000);

  it("1.3.6: a Magpie default the session skipped (ACP validation) is not marked synced — the next idle send retries it", async () => {
    await manager.send(threadId, { text: "hi" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");

    // Magpie enables hub/model-new mid-session and makes it the default; the live session skips it (not forced)
    mocks.magpieDefaultModel.mockResolvedValue("hub/model-new");
    setModelSpy.mockClear();
    setModelSpy.mockResolvedValueOnce(false);
    await manager.send(threadId, { text: "second" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(setModelSpy.mock.calls).toEqual([["hub/model-new"]]);

    // Next idle send must try again (it used to early-return: syncedDefaultModel was already advanced)
    setModelSpy.mockClear();
    await manager.send(threadId, { text: "third" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(setModelSpy.mock.calls).toEqual([["hub/model-new"]]);

    // Applied now → synced; a further send doesn't push it again
    setModelSpy.mockClear();
    await manager.send(threadId, { text: "fourth" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(setModelSpy).not.toHaveBeenCalled();
  }, 30000);

  it("1.3.6: switching back to「默认」when the session skips the resolved default leaves it unsynced for the next send", async () => {
    await manager.send(threadId, { text: "hi" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    await manager.setModel(threadId, "magpie/explicit");
    mocks.magpieDefaultModel.mockResolvedValue("hub/model-new");
    setModelSpy.mockClear();
    setModelSpy.mockResolvedValueOnce(false);
    await manager.setModel(threadId, null);
    expect(setModelSpy.mock.calls).toEqual([["hub/model-new"]]);
    setModelSpy.mockClear();
    await manager.send(threadId, { text: "again" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(setModelSpy.mock.calls).toEqual([["hub/model-new"]]);
  }, 30000);
});

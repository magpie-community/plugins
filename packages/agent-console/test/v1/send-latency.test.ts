// 1.3 (Nolan, Windows): the user's message must not wait for the Agent to start. The daemon persists and pushes the
// user_message (with the page's clientId) before detection / spawn / ACP initialize, and a start that fails afterwards
// leaves the message with an error card instead of dropping it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../daemon/src/agents/manager.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { initProviders, getProvider } from "../../daemon/src/providers/registry.js";
import { clearProviderCache } from "../../daemon/src/providers/infoCache.js";
import type { Config } from "../../daemon/src/config.js";

process.env.AGENT_CONSOLE_MOCK = "1";
const cfg: Config = { port: 0, dataDir: "", token: "t", version: "0.0.0", idleExitMinutes: 60, buildStamp: "0" };

let dir: string;
let threads: ThreadsStore;
let projects: ProjectsStore;
let gw: Gateway;
let manager: AgentManager;
let threadId: string;
let projectId: string;
let pushed: { at: number; ch: string; data: { type?: string; status?: string; event?: { type: string; clientId?: string; text?: string } } }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-lat-"));
  threads = new ThreadsStore(dir);
  projects = new ProjectsStore(dir);
  gw = new Gateway(cfg);
  pushed = [];
  const orig = gw.publish.bind(gw);
  vi.spyOn(gw, "publish").mockImplementation((ch, data) => { pushed.push({ at: Date.now(), ch, data: data as never }); orig(ch, data); });
  initProviders();
  manager = new AgentManager(gw, threads, projects, new SettingsStore(dir), new AttachmentStore(join(dir, "attachments")));
  const proj = await projects.create(dir);
  projectId = proj.id;
  threadId = (await threads.create({ projectId, provider: "mock" })).id;
});

afterEach(async () => {
  delete process.env.AGENT_CONSOLE_MOCK_START_MS;
  delete process.env.AGENT_CONSOLE_MOCK_DETECT_MS;
  vi.restoreAllMocks();
  await manager.shutdown();
  // a status / title patch may still be renaming meta.json.tmp-*: wait for it before the directory goes (Windows ENOENT)
  await threads.idle();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); }
  throw new Error("waitFor 超时");
};
const userPush = (clientId?: string) => pushed.find((p) => p.ch === `thread:${threadId}` && p.data.type === "event" && p.data.event?.type === "user_message" && (!clientId || p.data.event.clientId === clientId));
const statusPush = (s: string) => pushed.find((p) => p.ch === `thread:${threadId}` && p.data.type === "status" && p.data.status === s);

describe("send latency (1.3)", () => {
  it("user_message (with clientId) is pushed before a slow Agent start finishes", async () => {
    process.env.AGENT_CONSOLE_MOCK_START_MS = "1500";
    const t0 = Date.now();
    const sending = manager.send(threadId, { text: "你好", clientId: "c-test-1" });
    await waitFor(() => !!userPush("c-test-1"), 3000);
    const echo = userPush("c-test-1")!;
    expect(echo.at - t0).toBeLessThan(300);
    // the working state follows right after (pushed once the title patch is on disk), the Agent is still starting
    await waitFor(() => !!statusPush("initializing"), 1000);
    expect(statusPush("running")).toBeFalsy();
    await sending;
    expect(statusPush("running")!.at - t0).toBeGreaterThanOrEqual(1400);
    // persisted with the clientId, ahead of turn_started (snapshot reconcile works after a reload)
    const evs = await threads.readEvents(threadId, 0, 1000);
    const iu = evs.findIndex((e) => e.type === "user_message");
    expect((evs[iu] as { clientId?: string }).clientId).toBe("c-test-1");
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 20000);
    const ev2 = await threads.readEvents(threadId, 0, 1000);
    expect(ev2.findIndex((e) => e.type === "turn_started")).toBeGreaterThan(iu);
    expect(ev2.filter((e) => e.type === "user_message").length).toBe(1);
  }, 30000);

  it("a slow detection (cold CLI probe) does not hold the message back either", async () => {
    process.env.AGENT_CONSOLE_MOCK_DETECT_MS = "1200";
    clearProviderCache("mock"); // a cold (or >60 s old) detection cache
    const t0 = Date.now();
    const sending = manager.send(threadId, { text: "检测慢", clientId: "c-test-2" });
    await waitFor(() => !!userPush("c-test-2"), 3000);
    expect(userPush("c-test-2")!.at - t0).toBeLessThan(300);
    await sending;
    expect(statusPush("running")!.at - t0).toBeGreaterThanOrEqual(1100); // detection did run, after the message
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 20000);
  }, 30000);

  it("a failed Agent start keeps the message, adds the error card, and doesn't lock the Agent", async () => {
    const mock = getProvider("mock")!;
    const spy = vi.spyOn(mock, "createSession").mockRejectedValue(new Error("spawn EPERM"));
    await expect(manager.send(threadId, { text: "启动失败", clientId: "c-test-3" })).rejects.toThrow(/EPERM/);
    const evs = await threads.readEvents(threadId, 0, 1000);
    expect(evs.map((e) => e.type)).toEqual(["user_message", "notice", "turn_ended"]);
    expect((evs[2] as { status?: string }).status).toBe("failed");
    spy.mockRestore();
    // the Agent never ran: switching it is still allowed (mock is the only one here, so switch to itself)
    await expect(manager.setProvider(threadId, "mock")).resolves.toBeUndefined();
  }, 20000);

  it("an unknown Agent is refused before anything is saved", async () => {
    const t = await threads.create({ projectId, provider: "nope-agent" });
    await expect(manager.send(t.id, { text: "x", clientId: "c-test-4" })).rejects.toThrow();
    expect((await threads.readEvents(t.id, 0, 100)).length).toBe(0);
  });

  it("a queued message keeps its clientId until its turn starts; steer carries it too", async () => {
    await manager.send(threadId, { text: "/slow", clientId: "c-a" });
    await waitFor(async () => (await threads.get(threadId))?.status === "running");
    expect(await manager.send(threadId, { text: "排队的", clientId: "c-q" })).toBe("queued");
    expect(userPush("c-q")).toBeFalsy();
    await waitFor(() => !!userPush("c-q"), 25000);
    // "running" is stored before session.send returns, and until then (rt.starting) a steer is queued by design:
    // wait for the turn to have really started, not just for the status (under load the poll lands in that window)
    await waitFor(async () => (await threads.get(threadId))?.status === "running" && manager.runtimeInfo(threadId)?.starting === false);
    expect(await manager.send(threadId, { text: "插话", clientId: "c-s" }, "steer")).toBe("steered");
    expect(userPush("c-s")).toBeTruthy();
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 25000);
  }, 60000);
});

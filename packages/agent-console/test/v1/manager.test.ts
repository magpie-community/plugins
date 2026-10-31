import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../daemon/src/agents/manager.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { initProviders } from "../../daemon/src/providers/registry.js";
import { mockProviderMetrics } from "../../daemon/src/providers/mock.js";
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-test-"));
  mockProviderMetrics.createSessionCalls = 0;
  threads = new ThreadsStore(dir);
  projects = new ProjectsStore(dir);
  settings = new SettingsStore(dir);
  gw = new Gateway(cfg);
  initProviders();
  manager = new AgentManager(gw, threads, projects, settings, new AttachmentStore(join(dir, "attachments")));
  const proj = await projects.create(dir);
  const meta = await threads.create({ projectId: proj.id, provider: "mock" });
  threadId = meta.id;
});

afterEach(() => {
  manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error("waitFor 超时");
};
const events = () => threads.readEvents(threadId, 0, 50000);

describe("AgentManager", () => {
  it("listCommands creates no session by default", async () => {
    await manager.listCommands(threadId);
    expect(mockProviderMetrics.createSessionCalls).toBe(0);
  });

  it("concurrent listCommands(load) and send create only one session", async () => {
    await Promise.all([
      manager.listCommands(threadId, { load: true }),
      manager.send(threadId, { text: "你好" }),
    ]);
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 20000);
    expect(mockProviderMetrics.createSessionCalls).toBe(1);
  }, 25000);

  it("send → turn_ended completed", async () => {
    await manager.send(threadId, { text: "你好" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    const evs = await events();
    expect(evs.some((e) => e.type === "user_message")).toBe(true);
    expect(evs.some((e) => e.type === "turn_started")).toBe(true);
    const end = evs.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("completed");
    // providerSessionId was written back
    const meta = await threads.get(threadId);
    expect(meta?.providerSessionId).toMatch(/^mock-/);
    // Auto title
    expect(meta?.title).toBe("你好");
  }, 15000);

  it("send while running → queued, sent automatically when done", async () => {
    await manager.send(threadId, { text: "/slow" });
    await waitFor(async () => (await threads.get(threadId))?.status === "running");
    await manager.send(threadId, { text: "第二条" });
    expect(manager.runtimeInfo(threadId)?.queue.length).toBe(1);
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 20000);
    const evs = await events();
    const users = evs.filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text);
    expect(users).toEqual(["/slow", "第二条"]);
  }, 25000);

  it("steer: steers directly while running", async () => {
    await manager.send(threadId, { text: "/slow" });
    await waitFor(async () => (await threads.get(threadId))?.status === "running");
    await manager.send(threadId, { text: "顺便改个名" }, "steer");
    const evs = await events();
    const steered = evs.find((e) => e.type === "user_message" && (e as { steered?: boolean }).steered);
    expect(steered).toBeTruthy();
    expect(manager.runtimeInfo(threadId)?.queue.length).toBe(0);
    await waitFor(async () => (await threads.get(threadId))?.status === "idle", 20000);
  }, 25000);

  it("interrupt: back to idle within 1 second", async () => {
    await manager.send(threadId, { text: "/slow" });
    await waitFor(async () => (await threads.get(threadId))?.status === "running");
    const t0 = Date.now();
    await manager.interrupt(threadId);
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    expect(Date.now() - t0).toBeLessThan(1000);
    const evs = await events();
    const end = evs.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("interrupted");
  }, 15000);

  it("pending permission → respond allow", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (manager.runtimeInfo(threadId)?.pending.length ?? 0) > 0);
    const pending = manager.runtimeInfo(threadId)!.pending[0] as { requestId: string };
    await manager.respond(threadId, pending.requestId, { optionId: "accept" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    const evs = await events();
    const resolved = evs.find((e) => e.type === "permission_resolved");
    expect(resolved && (resolved as { optionId?: string }).optionId).toBe("accept");
    const tool = evs.find((e) => e.type === "tool_call" && (e as { status?: string }).status === "ok");
    expect(tool).toBeTruthy();
  }, 15000);

  it("invalid optionId → 400 (bad_params)", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (manager.runtimeInfo(threadId)?.pending.length ?? 0) > 0);
    const pending = manager.runtimeInfo(threadId)!.pending[0] as { requestId: string };
    await expect(manager.respond(threadId, pending.requestId, { optionId: "bogus" })).rejects.toThrow(/optionId 非法/);
    // Still replies normally
    await manager.respond(threadId, pending.requestId, { optionId: "decline" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
  }, 15000);

  it("interrupt cancels pending permissions automatically", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (manager.runtimeInfo(threadId)?.pending.length ?? 0) > 0);
    // While /perm is pending the status is still running (waiting for the user) — manager.interrupt needs running, and a waiting mock counts as running
    const meta = await threads.get(threadId);
    expect(meta?.status).toBe("running");
    await manager.interrupt(threadId);
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    const evs = await events();
    expect(evs.some((e) => e.type === "permission_resolved" && (e as { cancelled?: boolean }).cancelled)).toBe(true);
    expect(manager.runtimeInfo(threadId)?.pending.length).toBe(0);
  }, 15000);

  it("/exit crash → closed; the next send resumes", async () => {
    await manager.send(threadId, { text: "/exit" });
    await waitFor(async () => (await threads.get(threadId))?.status === "closed");
    const evs = await events();
    const end = evs.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("failed");
    expect(end && (end as { error?: string }).error).toContain("意外退出");
    const oldSid = (await threads.get(threadId))?.providerSessionId;

    // Send again → resume
    await manager.send(threadId, { text: "再来" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    const meta = await threads.get(threadId);
    expect(meta?.providerSessionId).toBe(oldSid); // resumeId is passed to the new session; the mock keeps the same id
    const msgs = (await events()).filter((e) => e.type === "assistant_message");
    const last = msgs[msgs.length - 1] as { text?: string } | undefined;
    expect(last?.text?.startsWith("（已续接）")).toBe(true);
  }, 20000);

  it("restart recovery: running → closed + notice + turn_ended(interrupted) + permissions cancelled", async () => {
    // Build a running state + an unresolved permission request
    const proj = await projects.create(dir);
    const t = await threads.create({ projectId: proj.id, provider: "mock" });
    await threads.patch(t.id, { status: "running" });
    const seq0 = (await threads.get(t.id))!.seq;
    await threads.appendEvent(t.id, {
      seq: seq0 + 1, ts: Date.now(), threadId: t.id, type: "turn_started", turnId: "u1", model: null, mode: "default", effort: null,
    });
    await threads.appendEvent(t.id, {
      seq: seq0 + 2, ts: Date.now(), threadId: t.id, type: "permission_request", requestId: "r1",
      title: "运行 x", kind: "tool", options: [{ id: "accept", label: "允许", kind: "allow_once" }],
    });

    const m2 = new AgentManager(gw, threads, projects, settings, new AttachmentStore(join(dir, "attachments")));
    await m2.recoverOnStart();
    const meta = await threads.get(t.id);
    expect(meta?.status).toBe("closed");
    const evs = await threads.readEvents(t.id, 0, 50000);
    expect(evs.some((e) => e.type === "notice" && (e as { message?: string }).message?.includes("已重启"))).toBe(true);
    expect(evs.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "interrupted")).toBe(true);
    expect(evs.some((e) => e.type === "permission_resolved" && (e as { cancelled?: boolean }).cancelled)).toBe(true);
    m2.shutdown();
  }, 15000);

  it("idle recycling: idle timeout → closed", async () => {
    await settings.set({ idleCloseMinutes: 0.0001 }); // ~6ms
    await manager.send(threadId, { text: "你好" });
    await waitFor(async () => (await threads.get(threadId))?.status === "idle");
    // lastActivity is in milliseconds; wait more than 6ms, then trigger recycling by hand
    await sleep(50);
    await (manager as unknown as { recycleIdle(): Promise<void> }).recycleIdle();
    expect((await threads.get(threadId))?.status).toBe("closed");
  }, 15000);

  it("B17: at most MAX_WARM_IDLE idle agent processes stay warm", async () => {
    const proj = (await projects.list())[0]!;
    const ids = [threadId];
    for (let i = 0; i < 4; i++) ids.push((await threads.create({ projectId: proj.id, provider: "mock" })).id);
    for (const id of ids) {
      await manager.send(id, { text: "hi" });
      await waitFor(async () => (await threads.get(id))?.status === "idle", 20000);
    }
    await manager.recycleIdle();
    const warm = [...(manager as unknown as { runtimes: Map<string, { session: unknown }> }).runtimes.values()].filter((r) => r.session);
    expect(warm.length).toBeLessThanOrEqual(3);
  }, 60000);

  it("a queued message can be removed before it is sent", async () => {
    await manager.send(threadId, { text: "/slow" });
    await waitFor(async () => (await threads.get(threadId))?.status === "running");
    expect(await manager.send(threadId, { text: "later" })).toBe("queued");
    const q = manager.runtimeInfo(threadId)!.queue as { id: string }[];
    expect(q.length).toBe(1);
    expect(manager.removeQueued(threadId, q[0]!.id)).toBe(true);
    expect(manager.runtimeInfo(threadId)!.queue.length).toBe(0);
    expect(manager.removeQueued(threadId, "nope")).toBe(false);
    await manager.interrupt(threadId);
  }, 20000);
});

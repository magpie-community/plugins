// Regression tests for code-review fixes: delta types, permission event dedupe, restart recovery, upload CORS, WS buffer check
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AgentManager } from "../../daemon/src/agents/manager.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { createHttpServer } from "../../daemon/src/http.js";
import { initProviders } from "../../daemon/src/providers/registry.js";
import type { Config } from "../../daemon/src/config.js";

process.env.AGENT_CONSOLE_MOCK = "1";

const cfg: Config = { port: 0, dataDir: "", token: "t", version: "0.0.0", idleExitMinutes: 60, buildStamp: "0" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let threads: ThreadsStore;
let projects: ProjectsStore;
let settings: SettingsStore;
let gw: Gateway;
let manager: AgentManager;
let threadId: string;
let published: { ch: string; data: { type?: string; event?: { type: string; itemId?: string; text?: string } } }[];

type Internals = { onProviderEvent(id: string, ev: Record<string, unknown>): Promise<void> };
const feed = (ev: Record<string, unknown>) => (manager as unknown as Internals).onProviderEvent(threadId, ev);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-fix-"));
  threads = new ThreadsStore(dir);
  projects = new ProjectsStore(dir);
  settings = new SettingsStore(dir);
  gw = new Gateway(cfg);
  published = [];
  const orig = gw.publish.bind(gw);
  gw.publish = (ch: string, data: unknown) => {
    published.push({ ch, data: data as (typeof published)[number]["data"] });
    orig(ch, data);
  };
  initProviders();
  manager = new AgentManager(gw, threads, projects, settings, new AttachmentStore(join(dir, "attachments")));
  const proj = await projects.create(dir);
  threadId = (await threads.create({ projectId: proj.id, provider: "mock" })).id;
});

afterEach(() => {
  manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("review fixes", () => {
  it("thinking/tool-output deltas keep their type when pushed instead of becoming assistant_delta", async () => {
    await feed({ type: "reasoning_delta", itemId: "r1", text: "想" });
    await feed({ type: "tool_output_delta", itemId: "c1", text: "out" });
    await feed({ type: "assistant_delta", itemId: "a1", text: "答" });
    await sleep(100);
    const deltas = published.map((p) => p.data.event).filter((e) => e && e.type.endsWith("_delta"));
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning_delta", itemId: "r1", text: "想" }),
      expect.objectContaining({ type: "tool_output_delta", itemId: "c1", text: "out" }),
      expect.objectContaining({ type: "assistant_delta", itemId: "a1", text: "答" }),
    ]));
  });

  it("permission results already persisted by the manager are not written again as permission_resolved from the provider echo", async () => {
    await feed({ type: "permission_request", requestId: "p1", title: "x", kind: "tool", options: [{ id: "allow", label: "允许", kind: "allow_once" }] });
    await manager.respond(threadId, "p1", { optionId: "allow" });
    await feed({ type: "permission_resolved", requestId: "p1", optionId: "allow" });
    const evs = await threads.readEvents(threadId, 0, 1000);
    expect(evs.filter((e) => e.type === "permission_resolved")).toHaveLength(1);
  });

  it("turn_ended is recorded once per turn (a late end from the provider after the interrupt fallback is dropped)", async () => {
    await feed({ type: "turn_started", turnId: "u1", model: null, mode: "default", effort: null });
    await feed({ type: "turn_ended", turnId: "u1", status: "interrupted" });
    await feed({ type: "turn_ended", turnId: "u1", status: "completed" });
    const evs = await threads.readEvents(threadId, 0, 1000);
    expect(evs.filter((e) => e.type === "turn_ended")).toHaveLength(1);
  });

  it("restart recovery: previous turn has a status, the running turn never ended → turn_ended is still appended", async () => {
    await threads.patch(threadId, { status: "running", lastTurnStatus: "completed" });
    const base = { ts: Date.now(), threadId };
    let seq = (await threads.get(threadId))!.seq;
    await threads.appendEvent(threadId, { ...base, seq: ++seq, type: "turn_started", turnId: "u1", model: null, mode: "default", effort: null });
    await threads.appendEvent(threadId, { ...base, seq: ++seq, type: "turn_ended", turnId: "u1", status: "completed" });
    await threads.appendEvent(threadId, { ...base, seq: ++seq, type: "user_message", text: "第二轮" });
    await threads.appendEvent(threadId, { ...base, seq: ++seq, type: "turn_started", turnId: "u2", model: null, mode: "default", effort: null });
    const m2 = new AgentManager(gw, threads, projects, settings, new AttachmentStore(join(dir, "attachments")));
    await m2.recoverOnStart();
    const ends = (await threads.readEvents(threadId, 0, 1000)).filter((e) => e.type === "turn_ended");
    expect(ends).toHaveLength(2);
    expect(ends[1]).toMatchObject({ turnId: "u2", status: "interrupted" });
    m2.shutdown();
  });
});

describe("Provider disabled", () => {
  it("after disabling: new conversations cannot send; conversations that already ran keep working", async () => {
    await settings.set({ providerEnabled: { mock: false } });
    await expect(manager.send(threadId, { text: "你好" })).rejects.toThrow(/禁用/);

    const proj = (await projects.list())[0];
    const old = await threads.create({ projectId: proj.id, provider: "mock", providerSessionId: "mock-old" });
    await manager.send(old.id, { text: "继续" });
    const t0 = Date.now();
    while ((await threads.get(old.id))?.status !== "idle" && Date.now() - t0 < 10000) await sleep(50);
    const evs = await threads.readEvents(old.id, 0, 1000);
    expect(evs.some((e) => e.type === "turn_ended" && (e as { status?: string }).status === "completed")).toBe(true);
  }, 15000);
});

describe("upload CORS (sandbox iframe origin is null)", () => {
  it("POST responses for Origin: null also carry access-control-allow-origin", async () => {
    const appDir = join(dir, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "index.html"), "x");
    const c: Config = { ...cfg, dataDir: dir, token: "tok", buildStamp: "0" };
    const server = createHttpServer(c, appDir, new AttachmentStore(join(dir, "attachments")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    c.port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/api/upload?name=a.txt`, {
        method: "POST", headers: { origin: "null", "x-agent-console": "tok" }, body: "hello",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("null");
    } finally {
      server.close();
    }
  });
});

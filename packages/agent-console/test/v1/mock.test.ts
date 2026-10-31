import { describe, it, expect, beforeEach } from "vitest";
import { createMockProvider } from "../../daemon/src/providers/mock.js";
import type { MockSession } from "../../daemon/src/providers/mock.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";
import { initProviders, getProvider } from "../../daemon/src/providers/registry.js";

const opts = {
  threadId: "th1",
  cwd: "D:/proj",
  model: null,
  mode: "default" as const,
  effort: null,
  resumeId: null as string | null,
};

async function collect(session: MockSession, until: (ev: ProviderEvent) => boolean, timeoutMs = 15000): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  const it = session.events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([
      it.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), Math.max(1, deadline - Date.now()))),
    ]);
    if (r.done) break;
    out.push(r.value);
    if (until(r.value)) break;
  }
  return out;
}

const isEnd = (ev: ProviderEvent) => ev.type === "turn_ended";
const types = (evs: ProviderEvent[]) => evs.map((e) => e.type);

describe("mock provider", () => {
  beforeEach(() => {
    process.env.AGENT_CONSOLE_MOCK = "1";
  });

  it("registry registers mock only with MOCK=1", async () => {
    delete process.env.AGENT_CONSOLE_MOCK;
    initProviders();
    expect(getProvider("mock")).toBeUndefined();
    process.env.AGENT_CONSOLE_MOCK = "1";
    initProviders();
    expect(getProvider("mock")?.id).toBe("mock");
  });

  it("detect/listModels/createSession", async () => {
    const p = createMockProvider();
    expect((await p.detect()).available).toBe(true);
    const models = await p.listModels();
    expect(models.length).toBe(2);
    expect(models[0].isDefault).toBe(true);
    const s = (await p.createSession(opts)) as MockSession;
    const it = s.events[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value.type).toBe("provider_session_id");
    await s.close();
  });

  it("default script: a complete event sequence for one turn", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const collected: ProviderEvent[] = [];
    const pump = (async () => {
      for await (const ev of s.events) collected.push(ev);
    })();
    await s.send({ text: "帮我改一下", images: [] });
    await new Promise((r) => setTimeout(r, 9000));
    await s.close();
    await pump;
    const t = types(collected);
    expect(t[0]).toBe("provider_session_id");
    expect(t).toContain("turn_started");
    expect(t).toContain("reasoning");
    expect(t).toContain("tool_call");
    expect(t).toContain("todo");
    expect(t).toContain("assistant_delta");
    expect(t).toContain("assistant_message");
    expect(t).toContain("usage");
    const end = collected.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("completed");
  }, 20000);

  it("/perm allow → tool succeeds; deny → failed", async () => {
    const p = createMockProvider();
    // Allow
    let s = (await p.createSession(opts)) as MockSession;
    let pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "permission_request") {
          setTimeout(() => s.respond(ev.requestId, { optionId: "accept" }), 10);
        }
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/perm", images: [] });
    let evs = await pump;
    let tool = evs.find((e) => e.type === "tool_call" && e.status === "ok");
    expect(tool).toBeTruthy();
    await s.close();

    // Deny
    s = (await p.createSession(opts)) as MockSession;
    pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "permission_request") {
          setTimeout(() => s.respond(ev.requestId, { optionId: "decline" }), 10);
        }
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/perm", images: [] });
    evs = await pump;
    tool = evs.find((e) => e.type === "tool_call" && e.status === "failed");
    expect(tool).toBeTruthy();
    const msg = evs.find((e) => e.type === "assistant_message");
    expect(msg && (msg as { text?: string }).text).toContain("跳过");
    await s.close();
  }, 20000);

  it("/plan deny → reply", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "permission_request") {
          setTimeout(() => s.respond(ev.requestId, { optionId: "reject" }), 10);
        }
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/plan", images: [] });
    const evs = await pump;
    expect(evs.some((e) => e.type === "plan")).toBe(true);
    const msg = evs.find((e) => e.type === "assistant_message");
    expect(msg && (msg as { text?: string }).text).toContain("怎么改");
    await s.close();
  }, 20000);

  it("/ask answers are woven into the reply", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "question") {
          setTimeout(() => s.respond(ev.requestId, { answers: { q1: "prod", q2: "周五前" } }), 10);
        }
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/ask", images: [] });
    const evs = await pump;
    const msg = evs.find((e) => e.type === "assistant_message");
    expect(msg && (msg as { text?: string }).text).toContain("prod");
    await s.close();
  }, 20000);

  it("interrupt → interrupted within 1 second", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/slow", images: [] });
    await new Promise((r) => setTimeout(r, 600));
    const t0 = Date.now();
    await s.interrupt();
    const evs = await pump;
    expect(Date.now() - t0).toBeLessThan(1000);
    const end = evs.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("interrupted");
    await s.close();
  }, 20000);

  it("/error fails midway", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "/error", images: [] });
    const evs = await pump;
    const end = evs.find((e) => e.type === "turn_ended");
    expect(end && (end as { status?: string }).status).toBe("failed");
    expect(end && (end as { error?: string }).error).toContain("构建失败");
    await s.close();
  }, 20000);

  it("/exit crash: the stream ends with no turn_ended", async () => {
    const s = (await createMockProvider().createSession(opts)) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) evs.push(ev);
      return evs;
    })();
    await s.send({ text: "/exit", images: [] });
    const evs = await pump;
    expect(evs.some((e) => e.type === "turn_ended")).toBe(false);
  }, 20000);

  it("resumeId → the first reply carries the resumed prefix", async () => {
    const s = (await createMockProvider().createSession({ ...opts, resumeId: "abc123" })) as MockSession;
    const pump = (async () => {
      const evs: ProviderEvent[] = [];
      for await (const ev of s.events) {
        evs.push(ev);
        if (ev.type === "turn_ended") return evs;
      }
      return evs;
    })();
    await s.send({ text: "继续", images: [] });
    const evs = await pump;
    const msg = evs.find((e) => e.type === "assistant_message");
    expect(msg && (msg as { text?: string }).text?.startsWith("（已续接）")).toBe(true);
    await s.close();
  }, 20000);
});

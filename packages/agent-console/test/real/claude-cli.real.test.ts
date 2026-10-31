// The real `claude` CLI driven over stream-json by Agent Console's Claude provider, against test/real/fake-llm.mjs
// (a local stand-in for the Anthropic Messages API: no sign-in, no key, nothing leaves the machine).
// Opt-in: AC_REAL_CLAUDE=<path to claude> npm run test:real
// Covers what the stand-in CLI in test/v1/claude-cli.test.ts covers, with the real protocol: initialize + slash commands,
// streaming, a Bash permission approved and denied, interrupt, model switch, and reopening by --resume.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSession } from "../../daemon/src/providers/claude/session.js";
import { resolveBinWith, type ResolveResult } from "../../daemon/src/util/bin.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";
// @ts-ignore plain .mjs helper
import { startFakeLlm } from "./fake-llm.mjs";

const real = process.env.AC_REAL_CLAUDE;
type Fake = { url: string; requests: { url: string; body: any }[]; close(): Promise<void> };
let fake: Fake;
let home: string;
let bin: ResolveResult & { ok: true };

beforeAll(async () => {
  if (!real) return;
  fake = await startFakeLlm();
  home = mkdtempSync(join(tmpdir(), "ac-real-claude-"));
  const r = await resolveBinWith("claude", { find: () => [real] });
  if (!r.ok) throw new Error(r.reason);
  bin = r;
});
afterAll(async () => fake?.close());

function open(resumeId: string | null = null) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "fake", CLAUDE_CONFIG_DIR: join(home, ".claude") };
  const s = new ClaudeSession({ threadId: "real", cwd: home, model: "claude-sonnet-4-5", mode: "default", effort: null, resumeId, bin, env });
  const events: ProviderEvent[] = [];
  void (async () => { for await (const e of s.events) events.push(e); })();
  const until = async (pred: (e: ProviderEvent) => boolean, from = 0, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out; events: " + JSON.stringify(events.map((e) => e.type)));
  };
  return { s, events, until };
}
const ended = (e: ProviderEvent) => e.type === "turn_ended";

describe.runIf(real)("real claude over stream-json", () => {
  let sessionId = "";

  it("initialize lists slash commands; a turn streams text and completes", async () => {
    const { s, events, until } = open();
    try {
      const cmds = await s.listCommands();
      console.log("[claude] slash commands", cmds.length, cmds.slice(0, 5).map((c) => c.name).join(","));
      expect(cmds.length).toBeGreaterThan(0);
      await s.send({ text: "say something", images: [] });
      expect(await until(ended)).toMatchObject({ status: "completed" });
      expect(events.some((e) => e.type === "assistant_delta" && e.text === "I see it")).toBe(true);
      sessionId = (events.find((e) => e.type === "provider_session_id") as { id: string }).id;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await s.close();
    }
  });

  it("a Bash permission: approve runs it, deny does not", async () => {
    const { s, events, until } = open();
    try {
      await s.send({ text: "RUN_TOOL now", images: [] });
      const req = (await until((e) => e.type === "permission_request")) as Extract<ProviderEvent, { type: "permission_request" }>;
      console.log("[claude] permission", req.title, JSON.stringify(req.detail).slice(0, 120));
      s.respond(req.requestId, { optionId: "allow" });
      expect(await until(ended)).toMatchObject({ status: "completed" });
      const out = events.find((e) => e.type === "tool_call" && e.status === "ok") as { output: string } | undefined;
      expect(out?.output).toContain("real-hi");
      const mark = events.length;
      const reqMark = fake.requests.length;
      await s.send({ text: "RUN_TOOL again", images: [] });
      const req2 = (await until((e) => e.type === "permission_request", mark)) as Extract<ProviderEvent, { type: "permission_request" }>;
      s.respond(req2.requestId, { optionId: "deny" });
      await until(ended, mark);
      const after = events.slice(mark);
      expect(after.some((e) => e.type === "tool_call" && e.status === "ok" && String((e as { output?: string }).output).includes("real-hi"))).toBe(false);
      // claude reports the refusal as a failed tool call and asks the model again
      console.log("[claude] after deny:", JSON.stringify(after.map((e) => e.type + ":" + ((e as any).status ?? ""))), "model requests", fake.requests.length - reqMark);
      expect(after.some((e) => e.type === "tool_call" && e.status === "failed")).toBe(true);
      expect(after.find(ended)).toMatchObject({ status: "completed" });
    } finally {
      await s.close();
    }
  });

  it("interrupt ends a turn that is still answering", async () => {
    const { s, events, until } = open();
    try {
      await s.send({ text: "SLOW_REPLY please", images: [] });
      await until((e) => e.type === "assistant_delta");
      const t0 = Date.now();
      await s.interrupt();
      const end = await until(ended, 0, 20000);
      console.log("[claude] interrupt →", JSON.stringify(end), Date.now() - t0, "ms");
      expect(end).toMatchObject({ status: "interrupted" });
      // the CLI stays usable
      const mark = events.length;
      await s.send({ text: "still there?", images: [] });
      expect(await until(ended, mark)).toMatchObject({ status: "completed" });
    } finally {
      await s.close();
    }
  });

  it("reopening by --resume carries the old conversation; set_model switches the model", async () => {
    expect(sessionId).not.toBe("");
    const { s, events, until } = open(sessionId);
    try {
      await s.setModel("claude-opus-4-1");
      const before = fake.requests.length;
      await s.send({ text: "and now?", images: [] });
      expect(await until(ended)).toMatchObject({ status: "completed" });
      expect((events.find((e) => e.type === "provider_session_id") as { id: string }).id).toBe(sessionId);
      const req = fake.requests.slice(before).filter((r) => r.url.includes("/messages") && Array.isArray(r.body?.messages)).at(-1)!.body;
      const texts = JSON.stringify(req.messages);
      console.log("[claude] resumed request: model", req.model, "messages", req.messages.length);
      expect(texts).toContain("say something");
      expect(req.model).toMatch(/opus/); // claude maps the id to its current opus
    } finally {
      await s.close();
    }
  });
});

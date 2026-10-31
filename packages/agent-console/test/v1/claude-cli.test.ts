// The Claude provider drives the user's own `claude` over stream-json (no SDK). Against a stand-in CLI
// (fixtures/fake-claude.mjs) that speaks the same protocol: streaming text / thinking / tools, permission approve and
// deny, the CLI withdrawing an ask, interrupt, model / mode switches, resume, images, slash commands, and a claude
// that is missing or dies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeSession } from "../../daemon/src/providers/claude/session.js";
import { createClaudeProvider } from "../../daemon/src/providers/claude/provider.js";
import { setAppLocale } from "../../daemon/src/util/i18n.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-claude.mjs");
const bin = { ok: true as const, cmd: process.execPath, prefixArgs: [fixture], display: fixture, via: "shim-js" };
let dir: string;
let n = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
  setAppLocale("en");
});
afterAll(() => {
  setAppLocale("zh");
  rmSync(dir, { recursive: true, force: true });
});

function open(o: Partial<ConstructorParameters<typeof ClaudeSession>[0]> = {}, env: Record<string, string> = {}) {
  const logFile = join(dir, `log-${++n}.jsonl`);
  const s = new ClaudeSession({
    threadId: "t", cwd: dir, model: null, mode: "default", effort: null, resumeId: null, bin,
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, ...env }, ...o,
  });
  const events: ProviderEvent[] = [];
  const it = s.events[Symbol.asyncIterator]();
  const w: { fn: (() => void) | null } = { fn: null };
  void (async () => {
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      events.push(r.value);
      w.fn?.();
    }
    w.fn?.();
  })();
  const until = async (pred: (e: ProviderEvent) => boolean, ms = 8000): Promise<ProviderEvent> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error("timed out; events: " + JSON.stringify(events.map((e) => e.type)));
      await new Promise<void>((r) => { w.fn = r; setTimeout(r, 50); });
    }
  };
  const log = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { s, events, until, log };
}
const ended = (e: ProviderEvent) => e.type === "turn_ended";

describe("claude over stream-json", () => {
  it("launches with stream-json both ways and permissions over stdio, initializes, streams thinking and text, reports usage", async () => {
    const { s, events, until, log } = open({ model: "claude-sonnet-4-5", effort: "high" });
    try {
      await s.send({ text: "hello", images: [] });
      const end = await until(ended);
      expect(end).toMatchObject({ type: "turn_ended", status: "completed" });
      const argv = log()[0].argv as string[];
      expect(argv.slice(0, 1)).toEqual(["-p"]);
      expect(argv.join(" ")).toContain("--input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio");
      expect(argv).toEqual(expect.arrayContaining(["--model", "claude-sonnet-4-5", "--effort", "high", "--permission-mode", "default"]));
      expect(argv).not.toContain("--resume");
      const ins = log().filter((l) => l.in).map((l) => l.in);
      expect(ins[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
      expect(ins[1]).toMatchObject({ type: "user", message: { role: "user" }, parent_tool_use_id: null });
      expect(events.find((e) => e.type === "provider_session_id")).toEqual({ type: "provider_session_id", id: "sess-new" });
      expect(events.some((e) => e.type === "reasoning_delta" && e.text === "hmm")).toBe(true);
      expect(events.some((e) => e.type === "assistant_delta" && e.text.startsWith("echo hello"))).toBe(true);
      expect(events.some((e) => e.type === "assistant_message" && e.text.startsWith("echo hello | model=claude-sonnet-4-5"))).toBe(true);
      expect(events.find((e) => e.type === "usage")).toMatchObject({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, costUsd: 0.001 });
    } finally {
      await s.close();
    }
  });

  it("permission approve: the tool runs with its input, the result comes back as a tool call", async () => {
    const { s, events, until } = open();
    try {
      await s.send({ text: "TOOL please", images: [] });
      const req = (await until((e) => e.type === "permission_request")) as Extract<ProviderEvent, { type: "permission_request" }>;
      expect(req.kind).toBe("tool");
      expect(req.options.map((o) => o.id)).toEqual(["allow", "allow_always", "deny"]);
      s.respond(req.requestId, { optionId: "allow" });
      expect(await until(ended)).toMatchObject({ status: "completed" });
      expect(events.some((e) => e.type === "tool_call" && e.itemId === "tu_1" && e.status === "running")).toBe(true);
      expect(events.some((e) => e.type === "tool_call" && e.itemId === "tu_1" && e.status === "ok" && e.output === "hi\n")).toBe(true);
      expect(events.some((e) => e.type === "assistant_message" && e.text === "ran it")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("permission deny: claude gets a deny with a message and does not run the tool", async () => {
    const { s, events, until, log } = open();
    try {
      await s.send({ text: "TOOL please", images: [] });
      const req = (await until((e) => e.type === "permission_request")) as Extract<ProviderEvent, { type: "permission_request" }>;
      s.respond(req.requestId, { optionId: "deny" });
      await until(ended);
      const answer = log().find((l) => l.in?.type === "control_response")?.in;
      expect(answer.response).toMatchObject({ subtype: "success", request_id: "perm-1", response: { behavior: "deny" } });
      expect(events.some((e) => e.type === "tool_call" && e.status === "running")).toBe(false);
      expect(events.some((e) => e.type === "assistant_message" && e.text.startsWith("not run:"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("an ask claude withdraws (control_cancel_request) closes the card", async () => {
    const { s, until } = open();
    try {
      await s.send({ text: "CANCEL", images: [] });
      const req = (await until((e) => e.type === "permission_request")) as Extract<ProviderEvent, { type: "permission_request" }>;
      expect(await until((e) => e.type === "permission_resolved")).toMatchObject({ requestId: req.requestId, cancelled: true });
      await until(ended);
    } finally {
      await s.close();
    }
  });

  it("interrupt: a control request, and the turn ends interrupted", async () => {
    const { s, until, log } = open();
    try {
      await s.send({ text: "SLOW", images: [] });
      await until((e) => e.type === "assistant_delta");
      await s.interrupt();
      expect(await until(ended)).toMatchObject({ status: "interrupted" });
      expect(log().some((l) => l.in?.request?.subtype === "interrupt")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("model and mode switch in place; bypassPermissions and effort relaunch with --resume", async () => {
    const { s, events, until, log } = open();
    try {
      await s.send({ text: "one", images: [] });
      await until(ended);
      await s.setModel("opus");
      await s.setMode("acceptEdits");
      events.length = 0;
      await s.send({ text: "two", images: [] });
      expect(((await until((e) => e.type === "assistant_message")) as { text: string }).text).toContain("model=opus mode=acceptEdits");
      await until(ended);
      const ins = log().filter((l) => l.in?.type === "control_request").map((l) => l.in.request);
      expect(ins).toEqual(expect.arrayContaining([{ subtype: "set_model", model: "opus" }, { subtype: "set_permission_mode", mode: "acceptEdits" }]));
      await s.setMode("bypassPermissions");
      events.length = 0;
      await s.send({ text: "three", images: [] });
      await until(ended);
      const argvs = log().filter((l) => l.argv).map((l) => l.argv as string[]);
      expect(argvs).toHaveLength(2);
      expect(argvs[1]).toEqual(expect.arrayContaining(["--resume", "sess-new", "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions", "--model", "opus"]));
      expect(argvs[0]).not.toContain("--allow-dangerously-skip-permissions");
    } finally {
      await s.close();
    }
  });

  it("resume: an old conversation starts claude with --resume <its session id>", async () => {
    const { s, events, until, log } = open({ resumeId: "0b9c3c3e-aaaa-bbbb-cccc-000011112222" });
    try {
      await s.send({ text: "again", images: [] });
      await until(ended);
      expect(log()[0].argv).toEqual(expect.arrayContaining(["--resume", "0b9c3c3e-aaaa-bbbb-cccc-000011112222"]));
      const user = log().find((l) => l.in?.type === "user").in;
      expect(user.session_id).toBe("0b9c3c3e-aaaa-bbbb-cccc-000011112222");
      expect(events.find((e) => e.type === "provider_session_id")).toMatchObject({ id: "0b9c3c3e-aaaa-bbbb-cccc-000011112222" });
    } finally {
      await s.close();
    }
  });

  it("images: PNG / JPEG / GIF / WebP go as base64 image blocks, a text file as a document", async () => {
    const png = join(dir, "a.png");
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
    writeFileSync(png, Buffer.from(b64, "base64"));
    const jpg = join(dir, "b.jpg"); writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const gif = join(dir, "c.gif"); writeFileSync(gif, "GIF89a");
    const webp = join(dir, "d.webp"); writeFileSync(webp, "RIFF0000WEBP");
    const txt = join(dir, "notes.txt"); writeFileSync(txt, "hello notes");
    const { s, until, log } = open();
    try {
      await s.send({
        text: "look",
        images: [
          { path: png, mime: "image/png" }, { path: jpg, mime: "image/jpeg" }, { path: gif, mime: "image/gif" },
          { path: webp, mime: "image/webp" }, { path: txt, mime: "text/plain; charset=utf-8" },
        ],
      });
      await until(ended);
      const content = log().find((l) => l.in?.type === "user").in.message.content as any[];
      expect(content.filter((b) => b.type === "image").map((b) => b.source.media_type)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
      expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
      expect(content.find((b) => b.type === "document")).toMatchObject({ source: { type: "text", media_type: "text/plain", data: "hello notes" }, title: "notes.txt" });
      expect(content[content.length - 1]).toEqual({ type: "text", text: "look" });
    } finally {
      await s.close();
    }
  });

  it("slash commands come from the initialize answer", async () => {
    const { s } = open();
    try {
      const cmds = await s.listCommands();
      expect(cmds.map((c) => c.name).sort()).toEqual(["compact", "review"]);
      expect(cmds.find((c) => c.name === "review")).toMatchObject({ description: "Review the diff", argumentHint: "[path]" });
    } finally {
      await s.close();
    }
  });

  it("a claude that dies: an English notice with its stderr, the turn fails, the next send starts it again", async () => {
    const { s, events, until } = open({}, { FAKE_CLAUDE_EXIT: "3" });
    try {
      await s.send({ text: "hi", images: [] });
      const end = await until(ended);
      expect(end).toMatchObject({ status: "failed" });
      const notice = events.find((e) => e.type === "notice") as { message: string };
      expect(notice.message).toMatch(/^claude exited unexpectedly \(3\) — stderr: fake claude: boom/);
    } finally {
      await s.close();
    }
  });

  it("a claude that can't be started (a broken shim): an English notice and a failed turn, no hang", async () => {
    const broken = { ok: true as const, cmd: join(dir, "missing", "claude.exe"), prefixArgs: [], display: "claude", via: "shim-exe" };
    const { s, events, until } = open({ bin: broken });
    try {
      await s.send({ text: "hi", images: [] });
      expect(await until(ended)).toMatchObject({ status: "failed" });
      expect((events.find((e) => e.type === "notice") as { message: string }).message).toMatch(/^Could not start claude: .*ENOENT/);
    } finally {
      await s.close();
    }
  });

  it("no claude on PATH: createSession says, in English, that Claude Code is not bundled and how to install it", async () => {
    const missing = { ok: false as const, reason: "PATH has no claude" };
    await expect(createClaudeProvider({ resolve: async () => missing }).createSession({ threadId: "t", cwd: dir, model: null, mode: "default", effort: null, resumeId: null }))
      .rejects.toThrow(/^claude was not found .*Claude Code is not bundled with this plugin; install it first: npm i -g @anthropic-ai\/claude-code/);
  });
});

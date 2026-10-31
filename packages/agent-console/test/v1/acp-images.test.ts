// Images to ACP Agents (Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh all share AcpSession).
// A fake ACP agent (fixtures/fake-acp-agent.mjs) advertises promptCapabilities as told and logs every prompt it gets.
// - image support advertised → the prompt carries image blocks (base64 + mimeType)
// - not advertised → the image's absolute path goes as text and as a resource_link, with a notice in the timeline
// - an image-only message still starts (and ends) a turn
// - the provider's capabilities.images follows what initialize advertised (probe or session)
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import { acpProbeModels } from "../../daemon/src/providers/acp/probe.js";
import { buildAcpPrompt, MAX_INLINE_MEDIA_BYTES } from "../../daemon/src/providers/acp/prompt.js";
import { forgetPromptCaps, knownPromptCaps } from "../../daemon/src/providers/acp/promptCaps.js";
import type { ProviderSession } from "../../daemon/src/providers/types.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-acp-agent.mjs");
const launch = { cmd: process.execPath, prefixArgs: [fixture] };
// 1×1 transparent PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let dir: string;
let png: string;
let notes: string;
const env = { caps: process.env.FAKE_ACP_PROMPT_CAPS, log: process.env.FAKE_ACP_LOG };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-images-"));
  png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  notes = join(dir, "notes.txt");
  writeFileSync(notes, "hello from a text attachment\n");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  if (env.caps === undefined) delete process.env.FAKE_ACP_PROMPT_CAPS;
  else process.env.FAKE_ACP_PROMPT_CAPS = env.caps;
  if (env.log === undefined) delete process.env.FAKE_ACP_LOG;
  else process.env.FAKE_ACP_LOG = env.log;
  forgetPromptCaps();
});

function provider(id: string) {
  return createAcpProvider({ id, name: "Fake ACP", binName: "fake-acp", acpArgs: [], installHint: "" });
}

type Run = { session: ProviderSession; events: ProviderEvent[]; log: string; done: Promise<void> };

async function open(id: string, caps: Record<string, boolean> | null): Promise<Run> {
  const log = join(dir, `${id}-${Math.random().toString(36).slice(2)}.jsonl`);
  if (caps) process.env.FAKE_ACP_PROMPT_CAPS = JSON.stringify(caps);
  else delete process.env.FAKE_ACP_PROMPT_CAPS;
  process.env.FAKE_ACP_LOG = log;
  const session = await provider(id).createSession({
    threadId: "t1", cwd: dir, model: null, mode: "default", effort: null, resumeId: null, launch,
  });
  const events: ProviderEvent[] = [];
  const done = (async () => {
    for await (const ev of session.events) events.push(ev);
  })();
  return { session, events, log, done };
}

async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ended = (r: Run) => r.events.filter((e) => e.type === "turn_ended");
const prompts = (r: Run) =>
  existsSync(r.log) ? readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const notices = (r: Run) => r.events.filter((e): e is Extract<ProviderEvent, { type: "notice" }> => e.type === "notice");

async function close(r: Run) {
  await r.session.close();
  await r.done;
}

describe("ACP prompts with images", () => {
  it("sends image blocks when the Agent advertises promptCapabilities.image", async () => {
    const r = await open("fake-img", { image: true });
    try {
      await r.session.send({ text: "what is in this picture?", images: [{ path: png, mime: "image/png" }] });
      await until(() => ended(r).length === 1);
      expect(prompts(r)).toEqual([
        [
          { type: "text", text: "what is in this picture?" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
      ]);
      expect(ended(r)[0]).toMatchObject({ status: "completed" });
      expect(notices(r)).toEqual([]);
      // the Agent's reply reached the timeline: the turn really ran
      expect(r.events).toContainEqual(expect.objectContaining({ type: "assistant_delta", text: "ok: 2 blocks" }));
    } finally {
      await close(r);
    }
  });

  it("sends the image's path (text + resource_link) and a notice when the Agent doesn't take images", async () => {
    const r = await open("fake-noimg", null);
    try {
      await r.session.send({ text: "look at this", images: [{ path: png, mime: "image/png" }] });
      await until(() => ended(r).length === 1);
      const [prompt] = prompts(r);
      expect(prompt).toEqual([
        { type: "text", text: `look at this\n\nAttached image: ${png}` },
        { type: "resource_link", uri: pathToFileURL(png).href, name: "shot.png", mimeType: "image/png", size: readFileSync(png).length },
      ]);
      expect(prompt.some((b: { type: string }) => b.type === "image")).toBe(false);
      const n = notices(r);
      expect(n).toHaveLength(1);
      expect(n[0].level).toBe("warn");
      expect(n[0].message).toContain("Fake ACP");
      expect(n[0].message).toContain(png);
    } finally {
      await close(r);
    }
  });

  it("an image-only message starts a turn (with and without image support)", async () => {
    for (const caps of [{ image: true }, null]) {
      const r = await open(caps ? "fake-only-img" : "fake-only-noimg", caps);
      try {
        await r.session.send({ text: "   ", images: [{ path: png, mime: "image/png" }] });
        await until(() => ended(r).length === 1);
        expect(r.events.filter((e) => e.type === "turn_started")).toHaveLength(1);
        expect(ended(r)[0]).toMatchObject({ status: "completed" });
        const [prompt] = prompts(r);
        if (caps) expect(prompt).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
        else {
          expect(prompt[0]).toEqual({ type: "text", text: `Attached image: ${png}` });
          expect(prompt[1]).toMatchObject({ type: "resource_link", uri: pathToFileURL(png).href });
        }
      } finally {
        await close(r);
      }
    }
  });

  it("an empty message still ends at once without a prompt", async () => {
    const r = await open("fake-empty", { image: true });
    try {
      await r.session.send({ text: "", images: [] });
      await until(() => ended(r).length === 1);
      expect(prompts(r)).toEqual([]);
    } finally {
      await close(r);
    }
  });
});

describe("the provider's images capability follows the Agent", () => {
  it("is unknown before the Agent is asked, then what its initialize says (session)", async () => {
    const p = provider("fake-cap");
    expect(p.capabilities).toMatchObject({ images: false, imagesKnown: false });
    const r = await open("fake-cap", { image: true, embeddedContext: true });
    try {
      await r.session.send({ text: "hi", images: [] });
      await until(() => ended(r).length === 1);
      expect(knownPromptCaps("fake-cap")).toEqual({ image: true, audio: false, embeddedContext: true });
      expect(p.capabilities).toMatchObject({ images: true, imagesKnown: true });
    } finally {
      await close(r);
    }
  });

  it("the model probe records it too", async () => {
    process.env.FAKE_ACP_PROMPT_CAPS = JSON.stringify({ image: false });
    await acpProbeModels([], "fake-probe")({ ok: true, cmd: launch.cmd, prefixArgs: launch.prefixArgs, display: "fake", via: "custom" });
    expect(knownPromptCaps("fake-probe")).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(provider("fake-probe").capabilities).toMatchObject({ images: false, imagesKnown: true });
    process.env.FAKE_ACP_PROMPT_CAPS = JSON.stringify({ image: true });
    await acpProbeModels([], "fake-probe")({ ok: true, cmd: launch.cmd, prefixArgs: launch.prefixArgs, display: "fake", via: "custom" });
    expect(provider("fake-probe").capabilities).toMatchObject({ images: true, imagesKnown: true });
  });
});

describe("buildAcpPrompt", () => {
  it("embeds a text attachment when embeddedContext is advertised, else links it", async () => {
    const withCtx = await buildAcpPrompt("read this", [{ path: notes, mime: "text/plain" }], { image: false, audio: false, embeddedContext: true });
    expect(withCtx.blocks).toEqual([
      { type: "text", text: "read this" },
      { type: "resource", resource: { uri: pathToFileURL(notes).href, mimeType: "text/plain", text: "hello from a text attachment\n" } },
    ]);
    const without = await buildAcpPrompt("read this", [{ path: notes, mime: "text/plain" }], { image: false, audio: false, embeddedContext: false });
    expect(without.blocks[0]).toEqual({ type: "text", text: `read this\n\nAttached file: ${notes}` });
    expect(without.blocks[1]).toMatchObject({ type: "resource_link", uri: pathToFileURL(notes).href });
    expect(without.imagesByPath).toEqual([]);
  });

  it("sends an image over the inline limit by path, with a warning", async () => {
    const big = join(dir, "big.png");
    writeFileSync(big, "");
    truncateSync(big, MAX_INLINE_MEDIA_BYTES + 1);
    const r = await buildAcpPrompt("", [{ path: big, mime: "image/png" }], { image: true, audio: false, embeddedContext: false });
    expect(r.blocks.some((b) => b.type === "image")).toBe(false);
    expect(r.blocks[0]).toEqual({ type: "text", text: `Attached image: ${big}` });
    expect(r.imagesByPath).toEqual([big]);
    expect(r.warnings[0]).toContain("inline limit");
  });

  it("names an attachment that can't be found instead of failing the message", async () => {
    const r = await buildAcpPrompt("hi", [{ path: join(dir, "gone.png"), mime: "image/png" }], { image: true, audio: false, embeddedContext: false });
    expect(r.blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(r.warnings).toHaveLength(1);
  });
});

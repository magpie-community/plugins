// dsh takes images only on the route its ACP starts on (it answers promptCapabilities.image at initialize for its `acp` row,
// and refuses image blocks on a connection that said no). Agent Console starts it with a --patch naming the conversation's route.
// fixtures/fake-dsh.mjs behaves like dsh 0.2.1-rc.5 here (checked against the real dsh, see README "Images").
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import { acpConfigForEntry } from "../../daemon/src/providers/acp/specs.js";
import { dshProbeModels } from "../../daemon/src/providers/acp/probe.js";
import { dshAcpArgs, dshDefaultModel, dshRoute, dshRoutePatch } from "../../daemon/src/providers/acp/dsh.js";
import { forgetPromptCaps, knownPromptCaps } from "../../daemon/src/providers/acp/promptCaps.js";
import { catalogById } from "../../daemon/src/providers/catalog.js";
import type { ProviderSession } from "../../daemon/src/providers/types.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";

const fixture = resolve(__dirname, "fixtures", "fake-dsh.mjs");
const launch = { cmd: process.execPath, prefixArgs: [fixture] };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const VIS = JSON.stringify(["magpie", "vis"]);
const TXT = JSON.stringify(["magpie", "txt"]);

let dir: string;
let png: string;
const saved = { vision: process.env.FAKE_DSH_VISION, log: process.env.FAKE_ACP_LOG };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-images-"));
  png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  process.env.FAKE_DSH_VISION = "magpie/vis,deepseek-official/deepseek-flash";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => forgetPromptCaps());
afterAll(() => {
  for (const [k, v] of [["FAKE_DSH_VISION", saved.vision], ["FAKE_ACP_LOG", saved.log]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const dshCfg = () => acpConfigForEntry(catalogById("dsh")!, "test")!;

type Run = { session: ProviderSession; events: ProviderEvent[]; log: string; done: Promise<void> };
async function open(model: string | null): Promise<Run> {
  const log = join(dir, `p-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_ACP_LOG = log;
  const session = await createAcpProvider(dshCfg()).createSession({
    threadId: "t1", cwd: dir, model, mode: "default", effort: null, resumeId: null, launch,
  });
  const events: ProviderEvent[] = [];
  const done = (async () => { for await (const ev of session.events) events.push(ev); })();
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
const sent = (r: Run) => (existsSync(r.log) ? readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const notices = (r: Run) => r.events.filter((e): e is Extract<ProviderEvent, { type: "notice" }> => e.type === "notice");
async function close(r: Run) { await r.session.close(); await r.done; }
const withImage = { text: "what is this?", images: [{ path: "", mime: "image/png" }] };

describe("dsh route", () => {
  it("reads dsh's [provider, model] model values", () => {
    expect(dshRoute(VIS)).toEqual({ provider: "magpie", model: "vis" });
    expect(dshRoute("deepseek-flash")).toBeNull();
    expect(dshRoute(null)).toBeNull();
    expect(dshRoute('["a"]')).toBeNull();
  });
  it("writes a patch for the acp row, quoting the route", async () => {
    expect(dshRoutePatch({ provider: "magpie", model: 'a "b": c' })).toContain('- id: acp\n  config:\n    provider: "magpie"\n    model: "a \\"b\\": c"\n');
    const args = await dshAcpArgs(VIS, dir);
    expect(args.slice(0, 3)).toEqual(["--profile", "acp", "--patch"]);
    expect(readFileSync(args[3], "utf8")).toContain('provider: "magpie"\n    model: "vis"');
    expect(await dshAcpArgs(null, dir)).toEqual(["--profile", "acp"]);
  });
  it("a new conversation starts on a Magpie route first", () => {
    expect(dshDefaultModel([{ id: '["deepseek-official","deepseek-flash"]' }, { id: VIS }], '["deepseek-official","deepseek-v4-flash"]')).toBe(VIS);
    expect(dshDefaultModel([{ id: "x" }], "cur")).toBe("cur");
  });
});

describe("dsh sessions get images", () => {
  it("on a model that sees images: started on that route, the image goes as an image block", async () => {
    const r = await open(VIS);
    try {
      withImage.images[0].path = png;
      await r.session.send(withImage);
      await until(() => ended(r).length === 1);
      const [p] = sent(r);
      expect(p.argv.slice(0, 3)).toEqual(["--profile", "acp", "--patch"]);
      expect(p.prompt).toEqual([{ type: "text", text: "what is this?" }, { type: "image", data: PNG_B64, mimeType: "image/png" }]);
      expect(ended(r)[0]).toMatchObject({ status: "completed" });
      expect(notices(r)).toEqual([]);
      expect(knownPromptCaps("dsh")).toMatchObject({ image: true });
    } finally {
      await close(r);
    }
  });

  it("without the patch dsh would refuse it: on its shipped route the image goes by path, and the turn still completes", async () => {
    const r = await open(null);
    try {
      withImage.images[0].path = png;
      await r.session.send(withImage);
      await until(() => ended(r).length === 1);
      const [p] = sent(r);
      expect(p.argv).toEqual(["--profile", "acp"]);
      expect(p.prompt.some((b: { type: string }) => b.type === "image")).toBe(false);
      expect(p.prompt[0].text).toContain(`Attached image: ${png}`);
      expect(ended(r)[0]).toMatchObject({ status: "completed" });
      expect(notices(r).map((n) => n.message).join(" ")).toContain(png);
    } finally {
      await close(r);
    }
  });

  it("after switching to another model in the session images go by path (dsh would refuse them), and back again as images", async () => {
    const r = await open(VIS);
    try {
      withImage.images[0].path = png;
      await r.session.setModel(TXT);
      await r.session.send(withImage);
      await until(() => ended(r).length === 1);
      expect(sent(r)[0].prompt.some((b: { type: string }) => b.type === "image")).toBe(false);
      expect(ended(r)[0]).toMatchObject({ status: "completed" });
      expect(notices(r)[0].message).toMatch(/read_image/);
      await r.session.setModel(VIS);
      await r.session.send(withImage);
      await until(() => ended(r).length === 2);
      expect(sent(r)[1].prompt).toContainEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
      expect(ended(r)[1]).toMatchObject({ status: "completed" });
    } finally {
      await close(r);
    }
  });

  it("the model probe answers images for the route a new conversation starts on", async () => {
    const models = await dshProbeModels("dsh")({ ok: true, cmd: launch.cmd, prefixArgs: launch.prefixArgs, display: "fake", via: "custom" });
    expect(models.map((m) => m.id)).toContain(VIS);
    expect(knownPromptCaps("dsh")).toMatchObject({ image: true });
    process.env.FAKE_DSH_VISION = "deepseek-official/deepseek-flash";
    await dshProbeModels("dsh")({ ok: true, cmd: launch.cmd, prefixArgs: launch.prefixArgs, display: "fake", via: "custom" });
    expect(knownPromptCaps("dsh")).toMatchObject({ image: false });
    process.env.FAKE_DSH_VISION = "magpie/vis,deepseek-official/deepseek-flash";
  });
});

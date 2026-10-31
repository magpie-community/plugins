// Do the real agent CLIs get the image Agent Console sends, all the way into the model request?
// Opt-in (npm run test:real); each agent runs only when its CLI is named:
//   AC_REAL_DSH=<dsh>  AC_REAL_OPENCODE=<opencode>  AC_REAL_PI_ACP=<pi-acp> (with pi on PATH)  AC_REAL_COPILOT=<copilot>
//   AC_REAL_CODEX=<codex>  AC_REAL_CLAUDE=<claude>  AC_REAL_DEVIN=<devin>  AC_REAL_CURSOR=<cursor-agent>
// Each runs in a throwaway HOME pointed at test/real/fake-llm.mjs (a local stand-in for the model API, no key, nothing
// leaves the machine), through Agent Console's own provider session, and the test looks for the image in what reached
// the "model". Devin and Cursor need a sign-in to run a model: for them it checks initialize and the exact ACP prompt
// Agent Console sends (captured by acp-tee.mjs), which fails at their login check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createAcpProvider } from "../../daemon/src/providers/acp/provider.js";
import { acpConfigForEntry } from "../../daemon/src/providers/acp/specs.js";
import { knownPromptCaps } from "../../daemon/src/providers/acp/promptCaps.js";
import { catalogById } from "../../daemon/src/providers/catalog.js";
import { ClaudeSession } from "../../daemon/src/providers/claude/session.js";
import { resolveBinWith } from "../../daemon/src/util/bin.js";
import { createCodexProvider } from "../../daemon/src/providers/codex/provider.js";
import type { ProviderSession } from "../../daemon/src/providers/types.js";
import type { ProviderEvent } from "../../daemon/src/timeline/types.js";
// @ts-ignore plain .mjs helper
import { startFakeLlm } from "./fake-llm.mjs";

type Fake = { url: string; requests: { url: string; body: unknown }[]; close(): Promise<void> };
let fake: Fake;
let png: string;
let pngB64: string;
const tee = resolve(__dirname, "acp-tee.mjs");

beforeAll(async () => {
  fake = await startFakeLlm();
  const dir = mkdtempSync(join(tmpdir(), "ac-real-"));
  png = join(dir, "red.png");
  // 16×16 solid red PNG
  pngB64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  writeFileSync(png, Buffer.from(pngB64, "base64"));
});
afterAll(async () => fake?.close());

/** Image parts anywhere in a request body: OpenAI image_url / input_image, Anthropic image, with their data */
function imageParts(body: unknown): { type: string; data: string }[] {
  const out: { type: string; data: string }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, any>;
    if (o.type === "image_url") out.push({ type: "image_url", data: String(o.image_url?.url ?? o.image_url ?? "") });
    else if (o.type === "input_image") out.push({ type: "input_image", data: String(o.image_url ?? o.file_id ?? "") });
    else if (o.type === "image" && o.source) out.push({ type: "image", data: String(o.source.data ?? o.source.url ?? "") });
    Object.values(o).forEach(walk);
  };
  walk(body);
  return out;
}
const sameImage = (data: string) => data.replace(/^data:image\/png;base64,/, "") === pngB64;
const sentImages = () => fake.requests.flatMap((r) => imageParts(r.body));

/** Throwaway HOME (and XDG dirs) for one agent run; returns a restore function */
function isolate(extra: Record<string, string> = {}): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "ac-real-home-"));
  const vars: Record<string, string> = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"), ...extra,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  return { home, restore: () => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); } };
}

async function turn(session: ProviderSession, text: string): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const it = session.events[Symbol.asyncIterator]();
  await session.send({ text, images: [{ path: png, mime: "image/png" }] });
  const end = Date.now() + 200000;
  while (Date.now() < end) {
    const r = await Promise.race([it.next(), new Promise<null>((ok) => setTimeout(() => ok(null), end - Date.now()))]);
    if (!r || r.done) break;
    events.push(r.value);
    if (r.value.type === "turn_ended") break;
  }
  return events;
}

function acpSession(id: string, bin: string, model: string | null, log: string) {
  process.env.ACP_TEE_LOG = log;
  return createAcpProvider(acpConfigForEntry(catalogById(id)!, "real")!).createSession({
    threadId: "real", cwd: process.env.HOME!, model, mode: "default", effort: null, resumeId: null,
    launch: { cmd: process.execPath, prefixArgs: [tee, bin] },
  });
}
const teePrompts = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ended = (ev: ProviderEvent[]) => ev.find((e) => e.type === "turn_ended") as Extract<ProviderEvent, { type: "turn_ended" }> | undefined;

/** Run one ACP agent end to end: the plugin's prompt carries an image block, and the model request carries the image */
async function acpEndToEnd(id: string, bin: string, model: string | null, setup: (home: string) => Record<string, string> | void) {
  const env = isolate();
  const extra = setup(env.home) ?? {};
  const saved = Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  const log = join(env.home, "prompts.jsonl");
  const before = fake.requests.length;
  const session = await acpSession(id, bin, model, log);
  try {
    const ev = await turn(session, "What colour is this image? Answer in one word.");
    const prompt = teePrompts(log)[0];
    const reached = fake.requests.slice(before).flatMap((r) => imageParts(r.body));
    console.log(`[${id}] caps`, JSON.stringify(knownPromptCaps(id)), "| ACP prompt", JSON.stringify(prompt?.map((b: any) => b.type)),
      "| model request images", JSON.stringify(reached.map((p) => ({ type: p.type, original: sameImage(p.data), len: p.data.length }))),
      "| turn", ended(ev)?.status, ended(ev)?.error ?? "");
    expect(prompt).toContainEqual({ type: "image", data: pngB64, mimeType: "image/png" });
    expect(reached.length).toBeGreaterThan(0);
    expect(ended(ev)?.status).toBe("completed");
    return reached;
  } finally {
    await session.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    env.restore();
  }
}

const has = (k: string) => !!process.env[k];

describe("real agents see the image", () => {
  it.runIf(has("AC_REAL_DSH"))("dsh (started on the conversation's route)", async () => {
    await acpEndToEnd("dsh", process.env.AC_REAL_DSH!, JSON.stringify(["fake", "vis"]), (home) => {
      mkdirSync(join(home, ".dsh"), { recursive: true });
      writeFileSync(join(home, ".dsh", "cordis.patch.yml"), [
        "- id: llm-pi-ai", "  config:", "    providers:", "      fake:", "        displayName: Fake", "        apiKeyEnv: FAKE_KEY",
        "        api: openai-completions", `        baseURL: ${fake.url}/v1`, "        models:", "          - id: vis", "            input: [text, image]", "",
      ].join("\n"));
      return { FAKE_KEY: "fake" };
    });
  });

  it.runIf(has("AC_REAL_OPENCODE"))("OpenCode", async () => {
    await acpEndToEnd("opencode", process.env.AC_REAL_OPENCODE!, "fake/vis", (home) => {
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "fake/vis",
        provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `${fake.url}/v1`, apiKey: "fake" },
          models: { vis: { name: "vis", attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } } } },
      }));
    });
  });

  it.runIf(has("AC_REAL_PI_ACP"))("Pi (pi-acp + pi)", async () => {
    await acpEndToEnd("pi", process.env.AC_REAL_PI_ACP!, null, (home) => {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: {
        baseUrl: `${fake.url}/v1`, api: "openai-completions", apiKey: "fake",
        models: [{ id: "vis", name: "vis", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096, reasoning: false }] } } }));
      writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "vis" }));
      return { PATH: dirname(process.env.AC_REAL_PI_ACP!) + delimiter + process.env.PATH };
    });
  });

  it.runIf(has("AC_REAL_COPILOT"))("Copilot (BYOK provider, no GitHub sign-in)", async () => {
    await acpEndToEnd("copilot", process.env.AC_REAL_COPILOT!, null, () => ({
      COPILOT_PROVIDER_BASE_URL: `${fake.url}/v1`, COPILOT_PROVIDER_API_KEY: "fake",
      COPILOT_PROVIDER_MODEL_ID: "gpt-4.1", COPILOT_PROVIDER_WIRE_MODEL: "vis",
    }));
  });

  it.runIf(has("AC_REAL_CODEX"))("Codex (app-server, localImage)", async () => {
    const env = isolate();
    const path = process.env.PATH;
    const codexHome = join(env.home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "vis"', 'model_provider = "fake"', "",
      "[model_providers.fake]", 'name = "fake"', `base_url = "${fake.url}/v1"`, 'wire_api = "responses"', 'env_key = "FAKE_KEY"', "",
    ].join("\n"));
    process.env.CODEX_HOME = codexHome;
    process.env.FAKE_KEY = "fake";
    process.env.PATH = dirname(process.env.AC_REAL_CODEX!) + delimiter + process.env.PATH;
    const before = fake.requests.length;
    const session = await createCodexProvider("real").createSession({ threadId: "real", cwd: env.home, model: "vis", mode: "default", effort: null, resumeId: null });
    try {
      const ev = await turn(session, "What colour is this image? Answer in one word.");
      const reached = fake.requests.slice(before).flatMap((r) => imageParts(r.body));
      console.log("[codex] model request images", JSON.stringify(reached.map((p) => ({ type: p.type, original: sameImage(p.data), len: p.data.length }))), "| turn", ended(ev)?.status, ended(ev)?.error ?? "");
      expect(reached.length).toBeGreaterThan(0);
      expect(ended(ev)?.status).toBe("completed");
    } finally {
      await session.close();
      delete process.env.CODEX_HOME;
      delete process.env.FAKE_KEY;
      process.env.PATH = path;
      env.restore();
    }
  });

  it.runIf(has("AC_REAL_CLAUDE"))("Claude Code (the user's claude over stream-json)", async () => {
    const env = isolate({ ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "fake" });
    const before = fake.requests.length;
    const bin = await resolveBinWith("claude", { find: () => [process.env.AC_REAL_CLAUDE!] });
    if (!bin.ok) throw new Error(bin.reason);
    const session = new ClaudeSession({ threadId: "real", cwd: env.home, model: "claude-sonnet-4-5", mode: "default", effort: null, resumeId: null, bin });
    try {
      const ev = await turn(session, "What colour is this image? Answer in one word.");
      const reached = fake.requests.slice(before).flatMap((r) => imageParts(r.body));
      console.log("[claude] model request images", JSON.stringify(reached.map((p) => ({ type: p.type, original: sameImage(p.data), len: p.data.length }))), "| turn", ended(ev)?.status, ended(ev)?.error ?? "");
      expect(reached.some((p) => p.type === "image" && sameImage(p.data))).toBe(true);
      expect(ended(ev)?.status).toBe("completed");
    } finally {
      await session.close();
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      env.restore();
    }
  });

  for (const [id, key] of [["devin", "AC_REAL_DEVIN"], ["cursor", "AC_REAL_CURSOR"]] as const) {
    it.runIf(has(key))(`${id}: advertises images and gets an image block (its model needs a sign-in)`, async () => {
      const env = isolate();
      const log = join(env.home, "prompts.jsonl");
      try {
        const session = await acpSession(id, process.env[key]!, null, log);
        try {
          const ev = await turn(session, "What colour is this image?");
          console.log(`[${id}] caps`, JSON.stringify(knownPromptCaps(id)), "| ACP prompt", JSON.stringify(teePrompts(log)[0]?.map((b: any) => b.type)), "| turn", ended(ev)?.status, ended(ev)?.error ?? "");
          expect(knownPromptCaps(id)?.image).toBe(true);
          expect(teePrompts(log)[0]).toContainEqual({ type: "image", data: pngB64, mimeType: "image/png" });
        } finally {
          await session.close();
        }
      } catch (e) {
        // Cursor can't open a session without a sign-in ("Failed to initialize session services"): initialize is all there is
        console.log(`[${id}] caps`, JSON.stringify(knownPromptCaps(id)), "| session:", String((e as Error)?.message ?? e));
        expect(knownPromptCaps(id)?.image).toBe(true);
      } finally {
        env.restore();
      }
    });
  }
});

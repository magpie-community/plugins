// 1.1.0 fixes (QA B1–B21) and the self-heal after a plugin host restart.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { freePort, request } from "./helpers-net.js";
import { launchArgv, launchFromSettings, launchKey } from "../../daemon/src/providers/launch.js";
import { clampMode } from "../../daemon/src/providers/modes.js";
import { parseSettingsPatch, sanitizeStored, SettingsStore } from "../../daemon/src/store/settings.js";
import { mapSessionUpdate, newMapCtx } from "../../daemon/src/providers/acp/mapUpdate.js";
import { parseCodexConfig } from "../../daemon/src/providers/codex/provider.js";
import { mapNotification, newCodexMapState } from "../../daemon/src/providers/codex/map.js";
import { costIsReal } from "../../daemon/src/providers/claude/map.js";
import { setAppLocale as setLocale, tr } from "../../daemon/src/util/i18n.js";
import { safeBackUrl as webSafeBackUrl, backUrlFromHash, backTarget, watchReconnect } from "../../web/src/api/backToMagpie.js";
import { resolveTheme, normalizeThemeSetting } from "../../web/src/layout/theme.js";
import { parseArgsDraft, parseIdleDraft } from "../../web/src/components/settingsFields.js";

const gateUrl = pathToFileURL(join(resolve(__dirname, "..", ".."), "lib", "gate.mjs")).href;

describe("launch command (B3/B5)", () => {
  it("appends the user's args after the built-in ones; prefixArgs go first", () => {
    expect(launchArgv(["acp"], { cmd: "opencode", args: ["--foo"] })).toEqual(["acp", "--foo"]);
    expect(launchArgv(["app-server"], { cmd: "node", prefixArgs: ["fx.mjs"], args: ["-v"] })).toEqual(["fx.mjs", "app-server", "-v"]);
    expect(launchArgv(["x"])).toEqual(["x"]);
  });
  it("reads the settings and ignores an empty executable", () => {
    const s = { providerCommand: { codex: { executable: " /opt/codex ", args: ["a", 3 as unknown as string] }, claude: { executable: "  " } } };
    expect(launchFromSettings(s as never, "codex")).toEqual({ cmd: "/opt/codex", args: ["a"] });
    expect(launchFromSettings(s as never, "claude")).toBeUndefined();
    expect(launchFromSettings({} as never, "codex")).toBeUndefined();
  });
  it("cache key changes with the command", () => {
    expect(launchKey()).toBe("");
    expect(launchKey({ cmd: "a", args: ["1"] })).not.toBe(launchKey({ cmd: "a", args: ["2"] }));
  });
});

describe("clampMode (B8/B9)", () => {
  it("keeps a supported mode, else default, else the first", () => {
    expect(clampMode(["default", "acceptEdits", "bypassPermissions"], "acceptEdits")).toBe("acceptEdits");
    expect(clampMode(["default", "acceptEdits", "bypassPermissions"], "plan")).toBe("default");
    expect(clampMode(["plan", "build"] as never, "acceptEdits")).toBe("plan");
    expect(clampMode(["default"], undefined)).toBe("default");
  });
});

describe("settings schema (B18, B6)", () => {
  it("accepts known fields and rejects bad ones", () => {
    expect(parseSettingsPatch({ theme: "dark", idleCloseMinutes: 45 }).ok).toBe(true);
    expect(parseSettingsPatch({ theme: "purple" }).ok).toBe(false);
    expect(parseSettingsPatch({ idleCloseMinutes: 2 }).ok).toBe(false);
    expect(parseSettingsPatch({ idleCloseMinutes: 241 }).ok).toBe(false);
    expect(parseSettingsPatch({ idleCloseMinutes: 7.5 }).ok).toBe(false);
    expect(parseSettingsPatch({ nope: 1 }).ok).toBe(false);
    expect(parseSettingsPatch({ providerCommand: { opencode: { executable: "/x", args: ["--a"] } } }).ok).toBe(true);
    expect(parseSettingsPatch({ providerCommand: { opencode: { args: "--a" } } }).ok).toBe(false);
    expect(parseSettingsPatch({ providerEnabled: { codex: "yes" } }).ok).toBe(false);
  });
  it("drops wrongly typed stored values and clamps idle minutes", () => {
    const s = sanitizeStored({ theme: 3, showThinking: "no", idleCloseMinutes: 1, sendKey: "enter" });
    expect(s.theme).toBeUndefined();
    expect(s.showThinking).toBeUndefined();
    expect(s.sendKey).toBe("enter");
    expect(s.idleCloseMinutes).toBe(5);
    expect(sanitizeStored({ idleCloseMinutes: 9999 }).idleCloseMinutes).toBe(240);
  });
  it("store: removed settings are gone from the defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac11-"));
    try {
      const st = new SettingsStore(dir);
      const s = (await st.get()) as Record<string, unknown>;
      expect("defaultEffort" in s).toBe(false);
      expect("density" in s).toBe(false);
      expect("idleExitMinutes" in s).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("ACP text around tool calls (B1)", () => {
  it("text before and after a tool call are separate items", () => {
    const ctx = newMapCtx();
    const a = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } } as never, ctx);
    mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "pending" } as never, ctx);
    mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as never, ctx);
    const b = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } } as never, ctx);
    const ida = (a[0] as { itemId: string }).itemId;
    const idb = (b[0] as { itemId: string }).itemId;
    expect(ida).not.toBe(idb);
    // consecutive chunks stay in one item
    const c = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "!" } } as never, ctx);
    expect((c[0] as { itemId: string }).itemId).toBe(idb);
  });
});

describe("Codex (B10, B11, B15)", () => {
  it("reads model_provider/model and the provider's models, profile first", () => {
    const cfg = parseCodexConfig([
      'model = "gpt-5"', 'model_provider = "openai"', 'profile = "ds"',
      "[profiles.ds]", 'model = "deepseek-chat"', 'model_provider = "magpie"',
      "[model_providers.magpie]", 'models = ["deepseek-chat", "deepseek-reasoner"]',
      "[model_providers.other]", 'models = ["nope"]',
    ].join("\n"));
    expect(cfg.modelProvider).toBe("magpie");
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.providerModels).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });
  it("saves raw reasoning when there is no summary", () => {
    const st = newCodexMapState();
    mapNotification("item/reasoning/textDelta", { itemId: "r1", delta: "think " }, st);
    mapNotification("item/reasoning/textDelta", { itemId: "r1", delta: "hard" }, st);
    const evs = mapNotification("item/completed", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }, st);
    expect(evs).toContainEqual({ type: "reasoning", itemId: "r1", text: "think hard" });
  });
  it("remembers a fileChange item's changes for the approval card", () => {
    const st = newCodexMapState();
    const changes = [{ path: "a.txt", kind: { type: "add" }, diff: "hi" }];
    mapNotification("item/started", { item: { type: "fileChange", id: "f1", changes } }, st);
    expect(st.fileChangesByItemId.get("f1")).toEqual(changes);
  });
});

describe("Claude cost (B14)", () => {
  it("keeps Claude Code's cost only for Claude models", () => {
    expect(costIsReal({ "claude-sonnet-4-5": {} })).toBe(true);
    expect(costIsReal({ "deepseek-chat": {} })).toBe(false);
    expect(costIsReal({ "claude-haiku": {}, "deepseek-chat": {} })).toBe(false);
    expect(costIsReal(undefined)).toBe(true);
  });
});

describe("daemon i18n (B13)", () => {
  afterEach(() => setLocale("zh"));
  it("permission options follow the UI language", () => {
    setLocale("en");
    expect(tr("perm.allow")).toBe("Allow");
    expect(tr("http.tooLarge")).toContain("50 MB");
    setLocale("zh");
    expect(tr("perm.allow")).toBe("允许");
  });
});

describe("self-heal back URL (host restart)", () => {
  const good = "http://127.0.0.1:3430/_magpie/plugin/6434536d5169e4148a4e62c188afe049/index.html";
  const cases: [string, string | null][] = [
    [good, good],
    [good + "#frag", good],
    ["http://localhost:3425/_magpie/plugin/abc/page/index.html?x=1", "http://localhost:3425/_magpie/plugin/abc/page/index.html?x=1"],
    ["http://[::1]:3430/_magpie/plugin/abc/index.html", "http://[::1]:3430/_magpie/plugin/abc/index.html"],
    ["https://evil.example/_magpie/plugin/abc/index.html", null],
    ["http://127.0.0.1.evil.example/_magpie/plugin/abc/index.html", null],
    ["http://user:pw@127.0.0.1:3430/_magpie/plugin/abc/index.html", null],
    ["javascript:alert(1)//127.0.0.1/_magpie/plugin/a/index.html", null],
    ["file:///_magpie/plugin/abc/index.html", null],
    ["http://127.0.0.1:3430/other/index.html", null],
    ["http://127.0.0.1:3430/_magpie/plugin/../../x/index.html", null],
    ["http://127.0.0.1:3430/_magpie/plugin/abc/evil.html", null],
    ["", null],
  ];
  it("web and gate accept only a loopback Magpie plugin page", async () => {
    const { safeBackUrl } = await import(/* @vite-ignore */ gateUrl);
    for (const [input, want] of cases) {
      expect(webSafeBackUrl(input), input).toBe(want);
      expect(safeBackUrl(input), input).toBe(want);
    }
  });
  it("reads b= from the fragment next to the token", () => {
    expect(backUrlFromHash(`#t=abc&b=${encodeURIComponent(good)}`)).toBe(good);
    expect(backUrlFromHash("#t=abc")).toBeNull();
    expect(backUrlFromHash(`#t=abc&b=${encodeURIComponent("https://evil.example/")}`)).toBeNull();
  });
  it("going back carries the moment the connection dropped", () => {
    expect(backTarget(`#t=x&b=${encodeURIComponent(good)}`, 1234)).toBe(good + "?ac_lost=1234");
    expect(backTarget(`#t=x&b=${encodeURIComponent(good)}`, 0)).toBe(good);
    expect(backTarget("#t=x", 1234)).toBeNull();
  });
  it("gate forwards a valid back URL only in the fragment", async () => {
    const { createGate } = await import(/* @vite-ignore */ gateUrl);
    const port = await freePort();
    const daemonPort = await freePort();
    const key = "c".repeat(64);
    const token = "a".repeat(64);
    const gate = createGate({ port, key, token, ensureDaemon: async () => ({ port: daemonPort }) });
    await gate.listen();
    try {
      const ok = await request(port, `/open?k=${key}&theme=dark&back=${encodeURIComponent(good)}`);
      expect(ok.status).toBe(302);
      expect(ok.headers.location).toBe(`http://127.0.0.1:${daemonPort}/?theme=dark#t=${token}&b=${encodeURIComponent(good)}`);
      const bad = await request(port, `/open?k=${key}&back=${encodeURIComponent("https://evil.example/")}`);
      expect(bad.headers.location).toBe(`http://127.0.0.1:${daemonPort}/?#t=${token}`);
      // without the key there's still nothing
      expect((await request(port, `/open?back=${encodeURIComponent(good)}`)).status).toBe(403);
    } finally {
      await gate.close();
    }
  });
  it("goes back after the connection stays down, not on a short blip", async () => {
    let listener: (s: string) => void = () => {};
    let state = "open";
    const fake = { onState: (fn: (s: string) => void) => { listener = fn; return () => {}; }, getState: () => state };
    let stuck = 0;
    watchReconnect(fake, () => stuck++, 40);
    state = "reconnecting"; listener(state);
    await new Promise((r) => setTimeout(r, 15));
    state = "open"; listener(state);
    await new Promise((r) => setTimeout(r, 60));
    expect(stuck).toBe(0);
    state = "reconnecting"; listener(state);
    listener("reconnecting");
    await new Promise((r) => setTimeout(r, 70));
    expect(stuck).toBe(1);
  });
});

describe("theme (B4)", () => {
  it("explicit light/dark wins over the host; auto follows the host, then the OS", () => {
    expect(resolveTheme("light", "dark", "dark")).toEqual({ theme: "light", hostColors: false });
    expect(resolveTheme("dark", "dark", "light")).toEqual({ theme: "dark", hostColors: true });
    expect(resolveTheme("auto", "dark", "light")).toEqual({ theme: "dark", hostColors: true });
    expect(resolveTheme("auto", null, "dark")).toEqual({ theme: "dark", hostColors: false });
    expect(normalizeThemeSetting("bogus")).toBe("auto");
  });
});

describe("settings fields (B5, B6)", () => {
  it("args: JSON string array or empty", () => {
    expect(parseArgsDraft("")).toBeUndefined();
    expect(parseArgsDraft(' ["--foo", "bar"] ')).toEqual(["--foo", "bar"]);
    expect(parseArgsDraft("[")).toBeNull();
    expect(parseArgsDraft("[1]")).toBeNull();
    expect(parseArgsDraft('"--foo"')).toBeNull();
  });
  it("idle minutes: whole number 5–240", () => {
    expect(parseIdleDraft("1")).toBeNull();
    expect(parseIdleDraft("5")).toBe(5);
    expect(parseIdleDraft("240")).toBe(240);
    expect(parseIdleDraft("241")).toBeNull();
    expect(parseIdleDraft("12.5")).toBeNull();
    expect(parseIdleDraft("")).toBeNull();
  });
});

describe("boot.js (self-heal)", () => {
  async function runBoot(sessions: unknown[], href = "http://127.0.0.1:3430/_magpie/plugin/abc/index.html"): Promise<string | null> {
    const { readFileSync } = await import("node:fs");
    const vm = await import("node:vm");
    const code = readFileSync(join(resolve(__dirname, "..", ".."), "page", "boot.js"), "utf8");
    let replaced: string | null = null;
    let n = 0;
    const ctx: Record<string, unknown> = {
      setTimeout: (fn: () => void) => setImmediate(fn),
      location: { href, replace: (u: string) => { replaced = u; } },
      document: {
        getElementById: () => null, querySelector: () => null,
        createElement: () => ({ remove() {} }),
        head: { appendChild(s: { onload?: () => void }) { ctx.AgentConsoleSession = sessions[Math.min(n++, sessions.length - 1)]; setImmediate(() => s.onload?.()); } },
      },
      URLSearchParams, URL, Date, Object, String, JSON, Math, Number, encodeURIComponent, unescape, btoa,
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInNewContext(code, ctx);
    for (let i = 0; i < 200 && !replaced; i++) await new Promise((r) => setImmediate(r));
    return replaced;
  }
  const key1 = "1".repeat(64), key2 = "2".repeat(64);
  it("skips a killed host's stale session.js and opens the new gate, passing its own page as back", async () => {
    const url = await runBoot([
      { v: 2, port: 3488, key: key1, ts: Date.now() - 60_000, beat: true },
      { v: 2, port: 3488, key: key1, ts: Date.now() - 60_000, beat: true },
      { v: 2, port: 3488, key: key2, ts: Date.now(), beat: false },
    ]);
    expect(url).toBeTruthy();
    const u = new URL(url!);
    expect(u.searchParams.get("k")).toBe(key2);
    expect(u.searchParams.get("back")).toBe("http://127.0.0.1:3430/_magpie/plugin/abc/index.html");
  });
  it("after a lost connection, ignores a session.js refreshed before it (the killed host's)", async () => {
    const lost = Date.now() - 3000;
    const url = await runBoot([
      { v: 2, port: 3488, key: key1, ts: lost - 1000 },
      { v: 2, port: 3488, key: key2, ts: Date.now() },
    ], `http://127.0.0.1:3430/_magpie/plugin/abc/index.html?ac_lost=${lost}`);
    const u = new URL(url!);
    expect(u.searchParams.get("k")).toBe(key2);
    // ac_lost isn't passed on, so it can't pile up
    expect(u.searchParams.get("back")).toBe("http://127.0.0.1:3430/_magpie/plugin/abc/index.html");
  });
  it("accepts an old session.js that never beat (page never opened) on a normal load", async () => {
    const url = await runBoot([{ v: 2, port: 3488, key: key1, ts: Date.now() - 3_600_000, beat: false }]);
    expect(new URL(url!).searchParams.get("k")).toBe(key1);
  });
  it("after a lost connection, waits for a beat newer than the loss (gate still up, daemon crashed)", async () => {
    const lost = Date.now() - 2000;
    const url = await runBoot([
      { v: 2, port: 3488, key: key1, ts: lost - 3000, beat: true },
      { v: 2, port: 3488, key: key1, ts: lost - 3000, beat: true },
      { v: 2, port: 3488, key: key1, ts: Date.now(), beat: true },
    ], `http://127.0.0.1:3430/_magpie/plugin/abc/index.html?ac_lost=${lost}`);
    expect(new URL(url!).searchParams.get("k")).toBe(key1);
  });
  it("after a lost connection, a new host's first (non-beating) file written after the loss is used", async () => {
    const lost = Date.now() - 4000;
    const url = await runBoot([
      { v: 2, port: 3488, key: key1, ts: lost - 1000, beat: true },
      { v: 2, port: 3488, key: key2, ts: lost + 2500, beat: false },
    ], `http://127.0.0.1:3430/_magpie/plugin/abc/index.html?ac_lost=${lost}`);
    expect(new URL(url!).searchParams.get("k")).toBe(key2);
  });
  it("still accepts a session.js without ts (older host)", async () => {
    const url = await runBoot([{ v: 2, port: 3488, key: key1 }]);
    expect(new URL(url!).searchParams.get("k")).toBe(key1);
  });
});

describe("turn end duration fallback (ACP agents report none)", () => {
  it("uses turn_started → turn_ended timestamps when durationMs is missing", async () => {
    const { newTimelineState, applyEvent } = await import("../../web/src/timeline/reducer.js");
    const st = newTimelineState();
    applyEvent(st, { seq: 1, ts: 1000, threadId: "t", turnId: "u", type: "turn_started", model: null, mode: "default", effort: null } as never);
    applyEvent(st, { seq: 2, ts: 5200, threadId: "t", turnId: "u", type: "turn_ended", status: "completed" } as never);
    const te = st.items.find((i) => i.kind === "turnend") as { durationMs?: number };
    expect(te.durationMs).toBe(4200);
  });
});

describe("daemon log: a closed console pipe (host killed hard) is not a crash", () => {
  it("swallows EPIPE on stdout and stops writing to the console", async () => {
    const { log, consoleClosed } = await import("../../daemon/src/log.js");
    log("info", "before");
    expect(consoleClosed()).toBe(false);
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // Without a listener this emit would throw (and in the daemon become an uncaughtException)
    expect(() => process.stdout.emit("error", err)).not.toThrow();
    expect(consoleClosed()).toBe(true);
    expect(() => log("info", "after")).not.toThrow();
  });
});

describe("Magpie's accent is taken over (PR #569 review)", () => {
  it("passes --magpie-accent (and a bare --accent) through like every other token", async () => {
    const { applyMagpieTokensFromSearch } = await import("../../web/src/layout/applyMagpieTokens.js");
    const g = globalThis as Record<string, unknown>;
    const saved = g.document;
    const set = new Map<string, string>();
    g.document = { documentElement: { style: { setProperty: (k: string, v: string) => set.set(k, v) } } };
    try {
      const enc = (o: object) => "?tokens=" + Buffer.from(JSON.stringify(o)).toString("base64");
      applyMagpieTokensFromSearch(enc({ accent: "#4f46e5", "accent-soft": "#eeedfd", "accent-fg": "#ffffff", bg: "#f4f4f6" }));
      expect(set.get("--magpie-accent")).toBe("#4f46e5");
      expect(set.get("--magpie-accent-fg")).toBe("#ffffff");
      expect(set.get("--magpie-bg")).toBe("#f4f4f6");
      applyMagpieTokensFromSearch(enc({ "--accent": "#ff0000" }));
      expect(set.get("--accent")).toBe("#ff0000");
    } finally {
      g.document = saved;
    }
  });
  it("tokens.css: teal only as the fallback, every accent tint derived from --accent", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(resolve(__dirname, "..", ".."), "web", "src", "styles", "tokens.css"), "utf8");
    // every hard-coded teal sits inside a var(--magpie-accent, …) fallback
    for (const m of css.matchAll(/#(0f766e|14b8a6|2dd4bf)/gi)) {
      const line = css.slice(css.lastIndexOf("\n", m.index!) + 1, css.indexOf("\n", m.index!));
      expect(line).toMatch(/var\(--magpie-accent, #/);
    }
    for (const v of ["--accent-soft", "--run-bg", "--cp-focus", "--cp-ring"]) {
      const decl = new RegExp(`${v}:\\s*([^;]+);`).exec(css)?.[1] ?? "";
      expect(decl, v).toContain("var(--accent)");
    }
    expect(css).toMatch(/--run-fg:\s*var\(--accent\)/);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { onRequest } from "../src/hooks.ts";
import { fetchImages } from "../src/tool.ts";
import { createPanelServer, PageService } from "../src/panel-service.ts";
import { writeLiveData } from "../src/live-data.ts";
import { measureStorage } from "../src/storage-usage.ts";
import { getPolicyWithOptions, keyFor, recordSession } from "../src/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let root: string;
let server: ReturnType<typeof createPanelServer> | null = null;
let base = "";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "magpie-cam-panel-"));
  await onRequest({ model: "test/model", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }], tools: [{ name: "cam_view_image" }] }, {
    protocol: "responses", path: "/responses", origin: "local", agent: "codex", session: "panel-thread", options: { dataDir: root }, report() {},
  });
  server = createPanelServer({ dataDir: root, sessionPolicies: nativePolicies });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(root, { recursive: true, force: true });
});

const panelKey = keyFor("codex", "panel-thread");
const nativePolicies: Record<string, { auto: boolean; updatedAt?: string }> = {};

describe("panel service", () => {
  test("counts stored bytes separately and does not follow symlinks", () => {
    const cache = join(root, "usage-fixture");
    const panel = join(cache, "panel");
    const originals = join(cache, "platforms", "codex", "images");
    const indexes = join(cache, "platforms", "codex", "sessions");
    for (const dir of [originals, indexes, join(panel, "images")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(originals, "original"), "12345");
    writeFileSync(join(indexes, "index.json"), "123");
    writeFileSync(join(panel, "images", "preview.png"), "12");
    writeFileSync(join(panel, "live.js"), "1234");
    symlinkSync(originals, join(panel, "images", "external"));
    expect(measureStorage(cache, panel)).toEqual({ originals: 5, indexes: 3, panel: 6 });
  });

  test("background snapshots preserve selection, skip unchanged detail, and pause on settings", async () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const nodes: Record<string, any> = { settings: { hidden: true } };
    const environment = createContext({
      location: { hash: "#selected" },
      document: { getElementById: (id: string) => (nodes[id] ??= {}) },
      magpie: { ready: new Promise(() => {}) },
    });
    const result = await runInContext(source + `
      (async () => {
        const selected = { key: "selected", title: "Selected" };
        const detail = { session: selected, images: [], legacyPolicy: {} };
        current = detail;
        const reads = [];
        const rendered = [];
        loadLive = async () => { live = { sessions: [{ key: "newest" }, selected], details: { selected: detail } }; };
        renderSessions = (key) => rendered.push(key);
        loadDetail = async (key) => reads.push(key);
        await loadSessions(true);
        detail.images = [{ id: "IMG-001" }];
        current = { ...detail, images: [] };
        await loadSessions(true);
        $("settings").hidden = false;
        await loadSessions(true);
        return { reads, rendered, hash: location.hash };
      })()
    `, environment);
    expect(result).toEqual({ reads: ["selected"], rendered: ["selected"], hash: "#selected" });
  });

  test("selecting a session from settings returns to the session view", async () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const nodes: Record<string, any> = {};
    const environment = createContext({
      location: {},
      document: { getElementById: (id: string) => (nodes[id] ??= { setAttribute() {} }) },
      magpie: { ready: new Promise(() => {}) },
    });
    const selected = await runInContext(source + `
      showSettings = (visible) => {
        $("settings").hidden = !visible;
        $("attachments").hidden = visible;
      };
      loadDetail = async (key) => key;
      showSettings(true);
      openSession("selected");
    `, environment);
    expect(selected).toBe("selected");
    expect(nodes.settings.hidden).toBeTrue();
    expect(nodes.attachments.hidden).toBeFalse();
  });

  test("settings save Agent overrides without overwriting unrelated host options", async () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const nodes: Record<string, any> = {
      "settings-form": { reportValidity: () => true },
      "settings-language": { value: "en" },
      "settings-codex-mode": { value: "compatible" },
      "settings-image-limit": { valueAsNumber: 2 },
      "settings-size-limit": { valueAsNumber: 2048 },
    };
    const original = { dataDir: root, sessionPolicies: { other: { auto: false } }, agentAuto: { other: false } };
    const writes: Record<string, unknown>[] = [];
    const environment = createContext({
      document: {
        getElementById: (id: string) => (nodes[id] ??= {}),
        querySelectorAll: () => [{ dataset: { agent: "opencode" }, checked: false }],
      },
      magpie: {
        ready: new Promise(() => {}),
        options: { get: async () => original, set: async (value: Record<string, unknown>) => { writes.push(value); return value; } },
      },
      setTimeout, clearTimeout,
    });
    await runInContext(source + "\nsaveSettings({ preventDefault() {} })", environment);
    expect(writes).toEqual([{ ...original, agentAuto: { other: false, opencode: false }, codexMode: "compatible", language: "en", maxFetchImages: 2, maxFetchBytes: 2048 }]);
    const user = (text: string, data?: string) => ({ type: "message", role: "user", content: [
      { type: "input_text", text },
      ...(data ? [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] : []),
    ] });
    const request = { tools: [{ name: "cam_view_image" }], input: [user("first", PNG), user("second")] };
    const context = { path: "/responses", protocol: "responses", origin: "local", session: "panel-thread", options: writes[0] };
    expect(await onRequest(request, { ...context, agent: "opencode" })).toBeUndefined();
    expect(JSON.stringify(await onRequest(request, { ...context, agent: "codex" }))).toContain("omitted");
    const oversized = { ...request, input: [user("first", PNG.padEnd(2049, "A")), user("second")] };
    expect(await onRequest(oversized, { ...context, agent: "codex" })).toBeUndefined();
    const toolContext = { agent: "codex", abort: new AbortController().signal };
    const response = await fetchImages({ session: panelKey, ids: ["IMG-001", "IMG-002", "IMG-003"] }, toolContext, writes[0]);
    expect(response).toBe("Fetch at most 2 images at once.");
  });

  test("shows attachments but prevents policy edits if the host cannot supply options", async () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const nodes: Record<string, any> = {};
    const element = () => ({
      dataset: {}, children: [] as unknown[], append() {}, setAttribute() {}, textContent: "",
      replaceChildren() { this.children.length = 0; },
      insertBefore(node: unknown, before: unknown) {
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
      },
    });
    const buttons: any[] = [];
    let hostAvailable = false;
    let writes = 0;
    const environment = createContext({
      panelKey, location: {}, setTimeout, clearTimeout,
      document: {
        getElementById: (id: string) => (nodes[id] ??= element()),
        querySelectorAll: () => [],
        createElement: (tag: string) => {
          const node = element();
          if (tag === "button") buttons.push(node);
          return node;
        },
      },
      IntersectionObserver: class { observe() {} disconnect() {} },
      magpie: {
        ready: new Promise(() => {}),
        options: {
          get: async () => {
            if (!hostAvailable) throw new Error("Host unavailable");
            return { auto: false };
          },
          set: async () => { writes++; },
        },
      },
    });
    runInContext(`${source}
      live.details[panelKey] = {
        session: { key: panelKey, platform: "codex" },
        legacyPolicy: { pinnedContentIds: [] },
        images: [{ id: "IMG-001", contentId: "a".repeat(64), stored: true }]
      };
    `, environment);
    await runInContext("loadDetail(panelKey)", environment);
    expect(nodes.count.textContent).toBe(1);
    expect(nodes.auto.disabled).toBeTrue();
    expect(nodes.auto.indeterminate).toBeTrue();
    expect(buttons.at(-1).disabled).toBeTrue();
    await runInContext('$("auto").onchange({ target: { checked: true } })', environment);
    expect(writes).toBe(0);
    hostAvailable = true;
    await runInContext("loadDetail(panelKey)", environment);
    expect(nodes.auto.disabled).toBeFalse();
    expect(nodes.auto.checked).toBeFalse();
    const firstCard = nodes.grid.children[0];
    await runInContext(`
      current.images = [...current.images, { id: "IMG-002", contentId: "b".repeat(64), stored: true }];
      renderDetail();
    `, environment);
    expect(nodes.grid.children).toHaveLength(2);
    expect(nodes.grid.children[0]).toBe(firstCard);
  });

  test("native and web page scripts save through the same host options", async () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const previouslyPinned = "a".repeat(64);
    const newPin = "b".repeat(64);
    let options: Record<string, any> = { language: "en", sessionPolicies: { other: { auto: false }, [panelKey]: { version: 2, auto: true, pinnedContentIds: [previouslyPinned] } } };
    for (const native of [true, false]) {
      const elements: Record<string, Record<string, unknown>> = {};
      const environment = createContext({
        native, newPin, panelKey, setTimeout, clearTimeout,
        document: { getElementById: (id: string) => (elements[id] ??= {}), querySelectorAll: () => [] },
        magpie: {
          ready: new Promise(() => {}),
          options: {
            get: async () => structuredClone(options),
            set: async (next: typeof options) => (options = structuredClone(next)),
          },
        },
        fetch: () => { throw new Error("Policy saves must not use the HTTP service"); },
      });
      await runInContext(`${source}
        current = { session: { key: panelKey }, policy: { auto: true, pinnedContentIds: [] }, legacyPolicy: { auto: true, pinnedContentIds: [] } };
        renderDetail = () => {};
        toast = (message, error) => { if (error) throw new Error(message); };
        native ? $("auto").onchange({ target: { checked: false } }) : togglePin(newPin);
      `, environment);
    }
    expect(options.language).toBe("en");
    expect(options.sessionPolicies.other).toEqual({ auto: false });
    expect(options.sessionPolicies[panelKey]).toEqual({ version: 2, auto: false, pinnedContentIds: [previouslyPinned, newPin] });
    expect(getPolicyWithOptions(root, panelKey, true, options)).toEqual({ auto: false, pinnedContentIds: [previouslyPinned, newPin] });
  });

  test("web exposes the legacy fallback and directs writes to host options", async () => {
    nativePolicies[panelKey] = { auto: false };
    try {
      const url = `${base}/api/sessions/${panelKey}`;
      const detail = await (await fetch(url)).json();
      expect(detail.policy.auto).toBeFalse();
      expect(detail.legacyPolicy.auto).toBeUndefined();
      const saved = await fetch(`${url}/policy`, { method: "PUT", body: JSON.stringify({ auto: true }) });
      expect(saved.status).toBe(405);
      expect(getPolicyWithOptions(root, panelKey, true, { sessionPolicies: nativePolicies }).auto).toBeFalse();
      expect((await (await fetch(url)).json()).policy.auto).toBeFalse();
    } finally {
      delete nativePolicies[panelKey];
    }
  });

  test("the panel uses the current host default unless a legacy file explicitly sets auto", () => {
    const source = readFileSync(new URL("../panel/app.js", import.meta.url), "utf8");
    const environment = createContext({
      panelKey,
      document: { getElementById: () => ({}) },
      magpie: { ready: new Promise(() => {}) },
    });
    const readAuto = (legacyPolicy: string) => runInContext(`effectivePolicy(
      { session: { key: panelKey }, policy: { auto: true, pinnedContentIds: [] }, legacyPolicy: ${legacyPolicy} },
      { auto: false }).auto`, environment);
    runInContext(source, environment);
    expect(readAuto("{ pinnedContentIds: [] }")).toBeFalse();
    expect(readAuto("{ auto: true, pinnedContentIds: [] }")).toBeTrue();
    expect(readAuto("undefined")).toBeFalse();
  });

  test("publishes the last session recorded inside the throttle window", async () => {
    const snapshot = join(process.env.MAGPIE_CAM_PANEL_DIR!, "live.js");
    writeLiveData(root, true);
    const key = keyFor("codex", "trailing-session");
    recordSession(root, { key, named: "trailing-session", platform: "codex", protocol: "responses", model: "test" });
    writeLiveData(root);
    expect(readFileSync(snapshot, "utf8")).not.toContain(key);
    const deadline = Date.now() + 2200;
    while (!readFileSync(snapshot, "utf8").includes(key) && Date.now() < deadline) await Bun.sleep(50);
    expect(readFileSync(snapshot, "utf8")).toContain(key);
  });

  test("serves the page, session detail, image and policy", async () => {
    const page = await fetch(base + "/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("上下文附件");
    const sessions = await (await fetch(base + "/api/sessions")).json();
    expect(sessions.sessions).toHaveLength(1);
    const key = sessions.sessions[0].key;
    const detail = await (await fetch(base + "/api/sessions/" + key)).json();
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].id).toBe("IMG-001");
    expect(detail.policy.auto).toBeTrue();
    const image = await (await fetch(base + `/api/sessions/${key}/images/IMG-001`)).json();
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG}`);
  });

  test("returns complete UTF-8 JSON for Chinese session titles", async () => {
    const first = await (await fetch(base + "/api/sessions")).json();
    const info = first.sessions[0];
    recordSession(root, { ...info, title: "中文会话标题" });
    const response = await fetch(base + "/api/sessions");
    const data = await response.json();
    expect(data.sessions[0].title).toBe("中文会话标题");
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(JSON.stringify(data)));
  });

  test("reuses the listener with the latest options during plugin reload", async () => {
    const port = (server!.address() as AddressInfo).port;
    const options = { dataDir: root, panelPort: port, auto: false };
    await expect(PageService({}, options)).resolves.toEqual({});
    const url = `${base}/api/sessions/${panelKey}`;
    expect((await (await fetch(url)).json()).policy.auto).toBeFalse();
    await PageService({}, { ...options, auto: true });
    expect((await (await fetch(url)).json()).policy.auto).toBeTrue();
  });

  test("rejects a listener whose options it cannot update", async () => {
    const occupied = createServer((_request, response) => response.end('{"service":"magpie-cam"}'));
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const panelPort = (occupied.address() as AddressInfo).port;
      await expect(PageService({}, { dataDir: root, panelPort })).rejects.toThrow(/EADDRINUSE|in use/i);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("publishes native live data and static thumbnails", async () => {
    const sessions = await (await fetch(base + "/api/sessions")).json();
    const key = sessions.sessions[0].key;
    const dir = process.env.MAGPIE_CAM_PANEL_DIR!;
    expect(existsSync(join(dir, "live.js"))).toBeTrue();
    const snapshot = readFileSync(join(dir, "live.js"), "utf8");
    const detail = JSON.parse(snapshot.slice(snapshot.indexOf("=") + 1).trimEnd().slice(0, -1)).details[key];
    expect(detail.legacyPolicy).toEqual({ pinnedContentIds: [] });
    expect(detail).not.toHaveProperty("policy");
    expect(detail.images[0]).not.toHaveProperty("pinned");
    const digest = createHash("sha256").update(PNG).digest("hex");
    expect(existsSync(join(dir, "images", key, `IMG-001-${digest}.png`))).toBeTrue();
    const app = await fetch(base + "/app.js");
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("loadLive");
  });

  test("publishes a different thumbnail when a data directory reuses an image id", async () => {
    const secondRoot = mkdtempSync(join(tmpdir(), "magpie-cam-panel-other-"));
    try {
      const otherImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      writeLiveData(root, true);
      await onRequest({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: `data:image/png;base64,${otherImage}` }] }] }, {
        protocol: "responses", path: "/responses", origin: "local", agent: "codex", session: "panel-thread", options: { dataDir: secondRoot },
      });
      writeLiveData(secondRoot, true);
      const digest = createHash("sha256").update(otherImage).digest("hex");
      const thumbnail = join(process.env.MAGPIE_CAM_PANEL_DIR!, "images", panelKey, `IMG-001-${digest}.png`);
      expect(readFileSync(thumbnail).toString("base64")).toBe(otherImage);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test("rejects DNS-rebinding hosts and cross-site browser requests", async () => {
    const sessions = await (await fetch(base + "/api/sessions")).json();
    const key = sessions.sessions[0].key;
    const response = await fetch(base + `/api/sessions/${key}/images/IMG-001`, { headers: { host: "evil.example", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("base64,");
  });

  test("does not expose another session's image", async () => {
    const response = await fetch(base + "/api/sessions/00000000000000000000000000000000/images/IMG-001");
    expect(response.status).toBe(404);
  });
});

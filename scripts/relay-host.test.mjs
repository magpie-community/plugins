// Set MAGPIE_SOURCE to a magpie checkout. Runs its unmodified Bun host;
// every account and upstream below is local to this test.
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = process.env.MAGPIE_SOURCE;
const host = source && join(source, "internal/plugin/host.js");

test.skipIf(!host || !existsSync(host))("relay plugins: real magpie host loads, signs in, discovers and streams all protocols", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-relay-host-"));
  const authPath = join(home, "plugin-auth.json");
  const existing = { type: "oauth", access: "existing-oauth", refresh: "existing-refresh", expires: 9999999999999 };
  writeFileSync(authPath, JSON.stringify({ zenmux: existing }));
  const zenmux = JSON.parse(readFileSync(join(root, "packages/zenmux-api/bootstrap.json")));
  const token = JSON.parse(readFileSync(join(root, "packages/tokendance/bootstrap.json")));
  token.data.push({ id: "messages-only", supported_protocols: ["anthropic:messages"] });
  token.data.push({ id: "responses-only", supported_protocols: ["openai:responses"] });
  const requests = [];
  let failTokenList = false;
  const vendor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/catalog") {
      expect(req.headers.get("authorization")).toBeNull();
      return Response.json({ zenmux });
    }
    if (url.pathname === "/gateway/v1/models") {
      expect(req.headers.get("authorization")).toBe("Bearer token-key");
      return failTokenList ? new Response("down", { status: 503 }) : Response.json(token);
    }
    const body = await req.json();
    requests.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body });
    return new Response("data: first\n\ndata: second\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const base = vendor.url.origin;
  const child = spawn(process.execPath, [host], { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (x) => { stderr += x; });
  const exited = new Promise((r) => child.once("exit", r));
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const m = JSON.parse(line), p = pending.get(m.id);
    if (!p) return;
    if (m.event) { p.events.push(m); return; }
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve({ result: m.result, events: p.events });
  });
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 8000);
      pending.set(id, { resolve, reject, timer, events: [] });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    const init = await rpc("init", { authPath, directory: home, plugins: [
      { spec: "zenmux-api", target: join(root, "packages/zenmux-api"), options: { baseURL: base + "/api/v1", anthropicBaseURL: base + "/api/anthropic/v1", catalogURL: base + "/catalog" } },
      { spec: "tokendance", target: join(root, "packages/tokendance"), options: { baseURL: base + "/gateway/v1", appURL: "app://relay-test" } },
    ] });
    expect(init.result.plugins.every((p) => !p.error)).toBe(true);
    for (const [provider, key] of [["zenmux-api", "zen-key"], ["tokendance", "token-key"]])
      expect((await rpc("apiKey", { provider, method: 0, key })).result.ok).toBe(true);
    const list = (await rpc("providers", {})).result;
    expect(list.map((p) => p.id).sort()).toEqual(["tokendance", "zenmux-api"]);
    expect(JSON.parse(readFileSync(authPath)).zenmux).toEqual(existing);
    for (const p of list) {
      expect(p.signedIn).toBe(true);
      expect(p.fellBack).toBe(false);
      const chosen = new Map(p.models.map((m) => [m.npm, m]));
      for (const [npm, suffix] of [["@ai-sdk/openai-compatible", "/chat/completions"], ["@ai-sdk/openai", "/responses"], ["@ai-sdk/anthropic", "/messages"]]) {
        const m = chosen.get(npm);
        expect(m).toBeDefined();
        const result = await rpc("fetch", { provider: p.id, model: m.apiId, npm, url: m.url + suffix, method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ model: m.apiId, stream: true, tools: [{ name: "read" }] })).toString("base64") });
        expect(result.events.find((e) => e.event === "head").status).toBe(200);
        expect(result.events.filter((e) => e.event === "chunk").map((e) => Buffer.from(e.data, "base64").toString()).join("")).toBe("data: first\n\ndata: second\n\n");
        const r = requests.at(-1), key = p.id === "zenmux-api" ? "zen-key" : "token-key";
        expect(r.body.model).toBe(m.apiId);
        expect(r.body.tools).toEqual([{ name: "read" }]);
        expect(r.headers[npm === "@ai-sdk/anthropic" ? "x-api-key" : "authorization"]).toBe(npm === "@ai-sdk/anthropic" ? key : `Bearer ${key}`);
        if (p.id === "tokendance") expect(r.headers["x-app-url"]).toBe("app://relay-test");
      }
    }
    failTokenList = true;
    const failed = (await rpc("providers", {})).result.find((p) => p.id === "tokendance");
    expect(failed.fellBack).toBe(true);
    expect(failed.listError).toContain("503");
    expect(failed.signedIn).toBe(true);
    expect(requests.length).toBe(6);
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    await exited; clearTimeout(kill); lines.close(); vendor.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

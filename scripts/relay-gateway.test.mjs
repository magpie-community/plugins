// Optional end-to-end check with a built magpie. All configs, keys and
// upstreams belong to this test, including the copied binary's home.
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const binary = process.env.MAGPIE_BINARY;
function freePort() {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port; s.stop(true); return port;
}
function stream(path, model) {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  if (path.endsWith("/messages")) return [
    event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "relay-ok" } }),
    event("content_block_stop", { index: 0 }), event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }), event("message_stop", {}),
  ].join("");
  if (path.endsWith("/responses")) return [
    event("response.created", { response: { id: "resp_1", object: "response", model, status: "in_progress", output: [] } }),
    event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "relay-ok" }),
    event("response.completed", { response: { id: "resp_1", object: "response", model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "relay-ok" }] }], usage: { input_tokens: 2, output_tokens: 2 } } }),
  ].join("");
  return `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "relay-ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
}

test.skipIf(!binary)("relay plugins: installed packages work through magpie's HTTP gateway", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-relay-gateway-"));
  const config = join(home, ".config/magpie"); mkdirSync(config, { recursive: true });
  const cache = join(home, ".cache/magpie"); mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "models.json"), "{}");
  // Copying avoids a portable data directory beside the caller's binary.
  const exe = join(home, "magpie"); copyFileSync(binary, exe); chmodSync(exe, 0o700);
  const zenmux = JSON.parse(readFileSync(join(root, "packages/zenmux-api/bootstrap.json")));
  const token = JSON.parse(readFileSync(join(root, "packages/tokendance/bootstrap.json")));
  token.data.push({ id: "messages-only", supported_protocols: ["anthropic:messages"] }, { id: "responses-only", supported_protocols: ["openai:responses"] });
  const requests = [];
  const vendor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/catalog") return Response.json({ zenmux });
    if (path.endsWith("/models")) return Response.json(token);
    const body = await req.json(); requests.push({ path, body, headers: Object.fromEntries(req.headers) });
    return new Response(stream(path, body.model), { headers: { "content-type": "text/event-stream" } });
  } });
  const base = vendor.url.origin, webPort = freePort(), port = freePort();
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), MAGPIE_BUN: process.execPath, MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_WEB_KEY: "relay-web-test-key-123" };
  async function run(args, input = "") {
    return new Promise((res, rej) => {
      const p = spawn(exe, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      p.stdout.on("data", (x) => { output += x; }); p.stderr.on("data", (x) => { output += x; });
      const timer = setTimeout(() => { p.kill(); rej(new Error(`command timed out: ${args}: ${output}`)); }, 15000);
      p.on("error", rej); p.on("exit", (code) => { clearTimeout(timer); code === 0 ? res(output) : rej(new Error(`${args}: ${output}`)); });
      p.stdin.end(input);
    });
  }
  let web, exited;
  try {
    for (const name of ["zenmux-api", "tokendance"]) await run(["plugin", "add", join(root, "packages", name)]);
    for (const [name, options] of [
      ["zenmux-api", { baseURL: base + "/api/v1", anthropicBaseURL: base + "/api/anthropic/v1", catalogURL: base + "/catalog" }],
      ["tokendance", { baseURL: base + "/gateway/v1", appURL: "app://gateway-test" }],
    ]) await run(["plugin", "options", join(root, "packages", name), JSON.stringify(options)]);
    // Exercise the CLI's actual API-key sign-in, not a hand-written auth file.
    await run(["plugin", "login", "zenmux-api"], "zen-key\n");
    await run(["plugin", "login", "tokendance"], "token-key\n");
    const listed = JSON.parse(await run(["plugin", "list", "--json"]));
    expect(JSON.stringify(listed)).toContain("zenmux-api");
    expect(JSON.stringify(listed)).toContain("tokendance");
    web = spawn(exe, ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open", "--gateway"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    exited = new Promise((r) => web.once("exit", r));
    let log = ""; web.stdout.on("data", (x) => { log += x; }); web.stderr.on("data", (x) => { log += x; });
    let available;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/v1/models`); if (r.ok) { available = await r.json(); break; } } catch {}
      if (web.exitCode !== null) throw new Error(log);
      await Bun.sleep(100);
    }
    if (!available) throw new Error(`Gateway not ready: ${log}`);
    const wanted = ["anthropic/claude-sonnet-4.5", "openai/gpt-5.2", "deepseek/deepseek-v4-pro", "glm-4.7", "messages-only", "responses-only"];
    for (const id of wanted) {
      const served = available.data.find((m) => m.id.endsWith("/" + id));
      expect(served).toBeDefined();
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: served.id, messages: [{ role: "user", content: "Hello" }], stream: true, max_tokens: 64, tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }] }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain("relay-ok");
      const received = requests.at(-1);
      expect(received.body.model).toBe(id);
      expect(received.body.tools.some((t) => (t.name ?? t.function?.name) === "read")).toBe(true);
      const expectedKey = served.id.startsWith("tokendance") ? "token-key" : "zen-key";
      expect(received.headers[received.path.endsWith("/messages") ? "x-api-key" : "authorization"]).toContain(expectedKey);
    }
    expect(requests.length).toBe(6);
  } finally {
    if (web) {
      try { process.kill(-web.pid, "SIGTERM"); } catch {}
      const kill = setTimeout(() => { try { process.kill(-web.pid, "SIGKILL"); } catch {} }, 1000);
      await exited; clearTimeout(kill);
    }
    vendor.stop(true); rmSync(home, { recursive: true, force: true });
  }
}, 60000);

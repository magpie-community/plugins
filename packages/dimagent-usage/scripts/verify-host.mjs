import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const [hostFile, dimPath] = process.argv.slice(2);
if (!hostFile || !dimPath) throw new Error("Usage: bun scripts/verify-host.mjs /path/to/magpie/internal/plugin/host.js /absolute/path/to/dim");
const directory = await mkdtemp(join(tmpdir(), "dimagent-usage-host-"));
const authPath = join(directory, "plugin-auth.json");
const child = spawn(process.execPath, [resolve(hostFile)], { cwd: directory, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const job = pending.get(message.id);
  if (!job) return;
  if (message.event) { job.events.push(message); return; }
  pending.delete(message.id);
  clearTimeout(job.timer);
  if (message.error) job.reject(new Error(message.error.message));
  else job.resolve({ result: message.result, events: job.events });
});

function request(method, params = {}) {
  return new Promise((resolveJob, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`host ${method} timed out`));
    }, 25000);
    pending.set(id, { resolve: resolveJob, reject, timer, events: [] });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

try {
  const target = resolve(import.meta.dir, "..");
  const loaded = await request("init", { directory, authPath, plugins: [{ spec: target, target }] });
  assert.equal(loaded.result.plugins.length, 1);
  assert.equal(loaded.result.plugins[0].error, undefined);
  const before = (await request("providers")).result[0];
  assert.equal(before.id, "dimagent-usage");
  assert.equal(before.name, "DimAgent");
  assert.equal(before.icon, "https://dimagent.cn/favicon.png");
  assert.equal(before.signedIn, false);
  assert.equal(before.usage, true);
  assert.equal(before.methods[0].keyless, true);
  assert.deepEqual(before.models, []);
  const connected = (await request("apiKey", { provider: before.id, method: 0, inputs: { dimPath } })).result;
  assert.equal(connected.ok, true);
  const after = (await request("providers")).result[0];
  assert.equal(after.signedIn, true);
  assert.deepEqual(after.models, []);
  const quota = (await request("usage", { provider: before.id, account: connected.account })).result;
  assert.equal(quota.error, "");
  assert.ok(quota.windows.some((w) => w.name === "Credits" && Number.isFinite(w.used)));
  const stored = JSON.parse(await readFile(authPath, "utf8"))[connected.account];
  assert.equal(stored.key, "local-cli-only");
  assert.equal(stored.metadata.accountId, quota.user);
  assert.deepEqual(Object.keys(stored).sort(), ["key", "metadata", "type"]);
  const fetched = await request("fetch", {
    provider: before.id, account: connected.account, model: "must-not-exist", npm: "@ai-sdk/openai-compatible",
    url: "https://must-never-be-contacted.invalid/v1/chat/completions", method: "POST", headers: {}, body: "e30=",
  });
  assert.equal(fetched.events.find((e) => e.event === "head")?.status, 405);
  console.log(JSON.stringify({
    host: resolve(hostFile), plugin: "dimagent-usage", connected: true, models: 0,
    credentialImport: false, modelRequestStatus: 405, plan: quota.plan,
    name: before.name, icon: before.icon,
    windows: quota.windows.map(({ name, used, amount, limit, span, resetsAt }) => ({ name, used, amount, limit, span, resetsAt })),
  }, null, 2));
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  lines.close();
  child.stdin.end();
  child.kill("SIGKILL");
  await new Promise((done) => child.exitCode !== null ? done() : child.once("close", done));
  await rm(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAgents } from "../lib/agents.mjs";
import { createActivity } from "../lib/activity.mjs";
import { configuration } from "../lib/config.mjs";

test("agent discovery reports installation, policy evidence and native events without exporting log text", async () => {
  const home = await mkdtemp(join(tmpdir(), "magpie-hindsight-inventory-"));
  const configDir = join(home, ".config", "magpie");
  const fixture = {
    ".config/magpie/applied.json": { hermes: { secret: "fixture-value" }, opencode: {} },
    ".hermes/config.yaml": "memory:\n  provider: hindsight\n",
    ".hermes/hindsight/config.json": { bank_id: "hermes", auto_recall: false },
    ".dsh/cordis.patch.yml": "- insert:\n    - id: hindsight\n      name: fixture\n",
    ".hindsight/coding-agent.json": { retainSessions: true, harnesses: { dsh: { retainSessions: false } } },
    ".hindsight/coding-agents-logs/usage.jsonl": JSON.stringify({
      ts: new Date().toISOString(), harness: "dsh", calls: ["hindsight_reflect"], query: "fixture-query"
    }) + "\n"
  };
  for (const [name, content] of Object.entries(fixture)) {
    const path = join(home, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  }
  const data = await discoverAgents({ home, configDir, env: {} });
  assert.equal(data.native.hermes.recall, "inactive");
  assert.equal(data.native.hermes.capture, "active");
  assert.equal(data.native.dsh.recall, "active");
  assert.equal(data.native.dsh.capture, "inactive");
  assert.equal(data.agents.find(agent => agent.id === "dsh").activity.tools, 1);
  assert.ok(data.agents.find(agent => agent.id === "opencode").connected);
  assert.doesNotMatch(JSON.stringify(data), /fixture-value|fixture-query/);
});

test("gateway activity reports counts and config revision without submitting conversation data", async () => {
  const time = new Date("2026-08-01T01:02:00Z").getTime();
  const dir = await mkdtemp(join(tmpdir(), "magpie-hindsight-activity-"));
  const events = createActivity({ dir, clock: () => time });
  events.observe({ agent: "claude", action: "request", code: "seen", revision: "346789bc4321", bank: "hermes" });
  events.observe({ agent: "claude", action: "recall", code: "hit", bank: "hermes", bytes: 300 });
  const data = await events.summary();
  assert.equal(data.runtime.revision, "346789bc4321");
  assert.equal(data.rows.find(row => row.code === "hit").n, 1);
  assert.equal(data.rows.find(row => row.code === "hit").bytes, 300);
});

test("pending retain is marked completed only after polling the operation", { skip: !globalThis.Bun }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-hindsight-operations-"));
  let time = Date.now();
  let requests = 0;
  const events = createActivity({
    dir, clock: () => time,
    fetcher: async (_url, init) => {
      requests++;
      assert.equal(init.method, "GET");
      return Response.json({ status: "completed", task_payload: "private" });
    }
  });
  const connection = configuration();
  events.observe({ agent: "dsh", action: "capture", code: "submitted", bank: "hermes",
    operation: "59cbb852-3a3c-5bc0-a357-31519cde1357" }, connection);
  assert.ok(!(await events.summary()).rows.some(row => row.code === "completed"));
  time += 3000;
  await events.poll(connection);
  const summary = await events.summary();
  assert.equal(requests, 1);
  assert.equal(summary.rows.find(row => row.code === "completed").n, 1);
  assert.doesNotMatch(JSON.stringify(summary), /private|59cbb852/);
});

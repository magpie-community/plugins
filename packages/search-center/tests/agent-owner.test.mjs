import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("Agent assignments follow the installed plugin path without requiring node on PATH, and surface missing CLI clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-owner-"));
  const moduleURL = new URL("../agents.mjs", import.meta.url).href;
  const installed = fileURLToPath(new URL("../", import.meta.url));
  try {
    fs.writeFileSync(path.join(root, "library.json"), JSON.stringify({
      mcp: [
        { name: "magpie-search-center", plugin: path.join(root, "other-copy"), agents: ["claude"] },
        { name: "renamed-search", plugin: installed, agents: ["codex"] },
      ],
      applied: { codex: {} },
    }));
    const runner = path.join(root, "verify-agents.mjs");
    fs.writeFileSync(runner, [
      `import { agentView, setAgents } from ${JSON.stringify(moduleURL)};`,
      `const selected = agentView().filter(x => x.selected).map(x => x.id);`,
      `let errCode = null;`,
      `try { await setAgents(["codex"]); } catch (e) { errCode = e.code; }`,
      `console.log(JSON.stringify({ selected, errCode }));`,
    ].join("\n"), "utf8");
    const result = spawnSync(process.execPath, [runner], {
      env: { ...process.env, MAGPIE_HOME: root, MAGPIE_BIN: path.join(root, "nonexistent-magpie-cli") },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(parsed.selected, ["codex"]);
    assert.equal(parsed.errCode, "MAGPIE_CLI_MISSING");
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

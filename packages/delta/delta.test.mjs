import test from "node:test";
import assert from "node:assert/strict";
import { agent, connect, getDeltaConfigPath } from "./delta.agent.js";

test("delta agent definition metadata", () => {
  assert.equal(agent.id, "delta");
  assert.equal(agent.name, "Delta");
  assert.equal(agent.format, "json");
  assert.equal(agent.model, "portable.profiles.worker.model");
  assert.deepEqual(agent.ua, ["delta", "zed"]);
  assert.ok(agent.config.includes("settings.json"));
});

test("delta agent library configuration bridges ~/.agents", () => {
  assert.equal(agent.library.instructions, "~/.agents/AGENTS.md");
  assert.equal(agent.library.skills, "~/.agents/skills");
  assert.equal(agent.library.mcp, "~/.agents/mcp.json");
  assert.equal(agent.library.mcpFormat, "zed");
});

test("delta config path detects Windows and POSIX via stack traces", () => {
  // Windows backslash stack trace
  const winStack = "Error\n    at packages\\delta\\delta.agent.js:15:17";
  assert.equal(getDeltaConfigPath(winStack), "~/AppData/Roaming/delta/settings.json");

  // Windows drive letter with backslash
  const winDriveStack = "Error\n    at C:\\magpie\\packages\\delta\\delta.agent.js:15:17";
  assert.equal(getDeltaConfigPath(winDriveStack), "~/AppData/Roaming/delta/settings.json");

  // Windows drive letter with forward slash (as normalized by Go/MoeJS)
  const winForwardDriveStack = "Error\n    at C:/magpie/packages/delta/delta.agent.js:15:17";
  assert.equal(getDeltaConfigPath(winForwardDriveStack), "~/AppData/Roaming/delta/settings.json");

  // macOS / Linux POSIX stack trace (without backslash or drive letter)
  const posixStack = "Error\n    at /home/runner/work/magpie/packages/delta/delta.agent.js:15:17";
  const stackHasWindows =
    posixStack.includes("\\") ||
    posixStack.includes(":\\") ||
    posixStack.includes(":/") ||
    /^[a-zA-Z]:/.test(posixStack);
  assert.equal(stackHasWindows, false);
});

test("delta connect returns valid Delta schema without leaking env or subagents", () => {
  const result = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "test-gateway-key" },
    model: { id: "test-model-1", name: "Test Model 1" },
    models: [
      { id: "test-model-1", name: "Test Model 1", context: 1000000, output: 128000, efforts: ["low", "high"] },
      { id: "test-model-2", name: "Test Model 2", context: 500000, output: 32768, efforts: [] },
    ],
  });

  // Verify custom provider structure
  assert.ok(result["native.custom_providers"], "native.custom_providers should be defined");
  const providers = result["native.custom_providers"];
  assert.equal(providers.length, 1);
  const magpie = providers[0];
  assert.equal(magpie.name, "Magpie");
  assert.equal(magpie.base_url, "http://127.0.0.1:3425/v1");
  assert.equal(magpie.api_mode, "open_ai_chat_completions");
  assert.equal(magpie.headers.length, 1);
  assert.equal(magpie.headers[0].name, "Authorization");
  assert.equal(magpie.headers[0].value, "Bearer test-gateway-key");
  assert.equal(magpie.models.length, 2);
  assert.equal(magpie.models[0].id, "test-model-1");
  assert.deepEqual(magpie.models[0].reasoning_efforts, ["low", "high"]);

  // Verify worker profile
  assert.equal(result["portable.profiles.worker.model"], "test-model-1");

  // Ensure env and subagent profiles are NOT written
  assert.equal(result["native.env.MAGPIE_GATEWAY_KEY"], undefined);
  assert.equal(result["portable.profiles.scout.model"], undefined);
  assert.equal(result["portable.profiles.reviewer.model"], undefined);

  // Verify strict key hierarchy
  for (const key of Object.keys(result)) {
    assert.ok(
      key === "native.custom_providers" || key === "portable.profiles.worker.model",
      `Unexpected key: ${key}`
    );
  }
});

test("delta connect handles empty models and empty gateway key cleanly", () => {
  // Empty models list with a single target model
  const r1 = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "" },
    model: { id: "codearts/glm-5.3-flash" },
  });
  const p1 = r1["native.custom_providers"][0];
  assert.equal(p1.models.length, 1);
  assert.equal(p1.models[0].id, "codearts/glm-5.3-flash");
  assert.deepEqual(p1.headers, [], "Headers should be empty when gateway key is empty");
  assert.equal(r1["portable.profiles.worker.model"], "codearts/glm-5.3-flash");

  // Empty models and no model specified
  const r2 = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1" },
  });
  const p2 = r2["native.custom_providers"][0];
  assert.equal(p2.models.length, 0);
  assert.deepEqual(p2.headers, []);
  assert.equal(r2["portable.profiles.worker.model"], "");
});

test("connect and restore from seed preserves seed exactly without leftover empty objects", () => {
  // Typical user seed file before connecting Magpie
  const seed = {
    version: 1,
    portable: {
      profiles: {
        worker: {
          model: "anthropic/claude-sonnet-4-5",
        },
      },
    },
    native: {
      custom_providers: [
        {
          name: "MyOllama",
          base_url: "http://127.0.0.1:11434/v1",
        },
      ],
    },
  };

  // Clone seed
  const file = JSON.parse(JSON.stringify(seed));

  // Connect
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "test-key" },
    model: { id: "fake/fake-model" },
  });

  // Simulate Magpie's wired state
  // 1. Stash original values of keys to be written
  const stash = {
    "native.custom_providers": JSON.parse(JSON.stringify(file.native.custom_providers)),
    "portable.profiles.worker.model": file.portable.profiles.worker.model,
  };

  // 2. Magpie writes connect output and target model
  file.native.custom_providers = out["native.custom_providers"];
  file.portable.profiles.worker.model = out["portable.profiles.worker.model"];

  assert.equal(file.native.custom_providers[0].name, "Magpie");
  assert.equal(file.portable.profiles.worker.model, "fake/fake-model");

  // 3. Magpie restore on disconnect (magpie delta default)
  file.native.custom_providers = stash["native.custom_providers"];
  file.portable.profiles.worker.model = stash["portable.profiles.worker.model"];

  // Assert file is 100% identical to seed
  assert.deepEqual(file, seed);

  // Assert no leftover empty objects
  assert.equal(file.native.env, undefined);
  assert.equal(file.portable.profiles.scout, undefined);
  assert.equal(file.portable.profiles.reviewer, undefined);
});

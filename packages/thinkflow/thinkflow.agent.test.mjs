import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(directory, "thinkflow.agent.js"), "utf8");
const plugin = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function setPath(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(value);
}

function getPath(target, path) {
  return path.split(".").reduce((value, part) => value?.[part], target);
}

function applyAndRestore(target, patch) {
  const before = new Map();
  for (const [path, value] of Object.entries(patch)) {
    const oldValue = getPath(target, path);
    before.set(path, oldValue === undefined ? undefined : structuredClone(oldValue));
    setPath(target, path, value);
  }
  return () => {
    for (const [path, value] of [...before].reverse()) {
      if (value === undefined) {
        const parts = path.split(".");
        const leaf = parts.pop();
        const parent = parts.reduce((current, part) => current?.[part], target);
        if (parent) delete parent[leaf];
      } else {
        setPath(target, path, value);
      }
    }
  };
}

test("declares ThinkFlow's file-backed model setting", () => {
  assert.deepEqual(plugin.agent, {
    id: "thinkflow",
    name: "ThinkFlow",
    bin: "thinkflow",
    config: "~/.thinkflow/config.json",
    model: "model",
    notice: "Restart ThinkFlow to use the connected model.",
  });
});

test("connects through Magpie and restores an existing ThinkFlow config", () => {
  const gateway = {
    url: "http://127.0.0.1:3425",
    v1: "http://127.0.0.1:3425/v1",
    key: "magpie-local-key",
  };
  const patch = plugin.connect({
    gateway,
    model: { id: "provider/model-b" },
    models: [{ id: "provider/model-a" }, { id: "provider/model-b" }],
  });
  const original = {
    active_provider: "personal",
    provider: "anthropic",
    base_url: "https://api.example.test",
    api_path: "/v1/messages",
    api_key: "existing-secret",
    model: "personal-model",
    models: ["personal-model"],
    providers: {
      personal: { provider: "anthropic", api_key: "profile-secret", model: "personal-model" },
      other: { provider: "openai", api_key: "other-secret", model: "other-model" },
    },
    context: { enabled: true, files: ["AGENTS.md"] },
    native_tools: ["read", "edit"],
  };
  const config = structuredClone(original);
  const restore = applyAndRestore(config, patch);
  const profile = config.providers[config.active_provider];

  assert.equal(config.provider, "openai");
  assert.equal(config.base_url, gateway.v1);
  assert.equal(config.api_path, "/chat/completions");
  assert.equal(config.api_key, gateway.key);
  assert.equal(config.model, "provider/model-b");
  assert.deepEqual(config.models, ["provider/model-a", "provider/model-b"]);
  assert.deepEqual(profile, {
    provider: "openai",
    base_url: gateway.v1,
    api_path: "/chat/completions",
    api_key: gateway.key,
    model: "provider/model-b",
    models: ["provider/model-a", "provider/model-b"],
  });
  assert.deepEqual(config.providers.personal, original.providers.personal);
  assert.deepEqual(config.providers.other, original.providers.other);
  assert.deepEqual(config.context, original.context);
  assert.deepEqual(config.native_tools, original.native_tools);

  restore();
  assert.deepEqual(config, original);
});

test("rejects incomplete gateway or model input", () => {
  assert.throws(() => plugin.connect({ gateway: {}, model: { id: "m" } }), /gateway URL/);
  assert.throws(() => plugin.connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "key" },
    model: {},
  }), /model ID/);
});

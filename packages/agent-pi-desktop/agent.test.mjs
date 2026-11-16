// The agent module is the moejs half of the plugin: magpie writes the sidecar
// file from this descriptor and connect(); sync.mjs (Bun) copies it into
// PI-Desktop's SQLite.

import { expect, test } from "bun:test";
import { agent, connect, own } from "./pi-desktop.agent.js";

test("descriptor points at PI-Desktop's sidecar", () => {
  expect(agent.id).toBe("pi-desktop-app");
  expect(agent.name).toBe("PI-Desktop");
  expect(agent.aliases).toEqual(["pi-desktop", "pidesktop"]);
  expect(agent.config).toBe("~/.pi-desktop/magpie-agent.json");
  expect(agent.format).toBe("json");
  expect(agent.model).toBe("model");
});

test("connect writes the gateway and the model list into the sidecar", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "sk-test" },
    model: { id: "a/model", name: "A" },
    models: [{ id: "a/model", name: "A", context: 128000, output: 8192 }],
  });
  expect(out).toEqual({
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKey: "sk-test",
    models: [{ id: "a/model", name: "A", context: 128000, output: 8192 }],
    modelName: "A",
  });
  expect(own()).toEqual([]);
});

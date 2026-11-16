// The agent module runs in magpie's moejs process: it must stay a plain
// descriptor plus the keys connect() writes, with no imports or side effects.

import { expect, test } from "bun:test";
import { agent, connect } from "./tern.agent.js";

test("descriptor tells magpie which two omp files to write", () => {
  expect(agent.id).toBe("tern");
  expect(agent.name).toBe("Tern");
  expect(agent.bin).toBe("tern");
  expect(agent.config).toBe("~/.omp/agent/models.yml");
  expect(agent.format).toBe("yaml");
  expect(agent.prefix).toBe("magpie/");
  expect(agent.startup).toEqual({
    config: "~/.omp/agent/config.yml",
    format: "yaml",
    model: "modelRoles.default",
  });
});

test("connect opens magpie's provider in omp's models.yml", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1" },
    models: [
      { id: "a/model", name: "A", context: 128000, output: 8192, efforts: ["none", "high", "ultra"] },
      { id: "b/model", name: "B", context: 0, output: 0, efforts: [] },
    ],
  });
  expect(out["providers.magpie"]).toEqual({
    baseUrl: "http://127.0.0.1:3425/v1",
    api: "openai-completions",
    auth: "none",
    models: [
      {
        id: "a/model",
        name: "A",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        thinking: { mode: "effort", efforts: ["high"] },
      },
      { id: "b/model", name: "B", reasoning: false },
    ],
  });
});

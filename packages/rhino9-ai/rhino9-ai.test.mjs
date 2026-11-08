import { expect, test } from "bun:test";
import { agent, connect } from "./rhino9-ai.agent.js";

test("owns a dedicated config, not a personal agent profile", () => {
  expect(agent).toMatchObject({
    id: "rhino9-ai",
    config: "~/.config/rhino9-magpie/settings.json",
    dir: "~/.config/rhino9-magpie",
    model: "model",
    format: "json",
  });
  expect(agent.ua).toEqual([]);
});

test("writes the Messages root and assigned key, without taking ownership of model aliases", () => {
  expect(connect({
    gateway: { url: "http://127.0.0.1:4567", v1: "http://127.0.0.1:4567/v1", key: "test-key" },
    model: { id: "provider/model/with/slashes" },
  })).toEqual({ baseUrl: "http://127.0.0.1:4567", apiKey: "test-key" });
});

test("incomplete connections cannot produce partial config", () => {
  expect(() => connect()).toThrow();
  expect(() => connect({ gateway: { url: "http://127.0.0.1:3425", key: "key" } })).toThrow();
});

test("package declares only an agent without a host runtime", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json();
  expect(pkg.magpie.agent).toBe("./rhino9-ai.agent.js");
  expect(pkg.main).toBeUndefined();
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.scripts?.postinstall).toBeUndefined();
});

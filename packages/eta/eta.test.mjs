import { expect, test } from "bun:test";
import { agent, connect } from "./eta.agent.js";

const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json();

test("writes only the local gateway origin and Eta-scoped key; Eta owns model selection", () => {
  for (const url of ["http://127.0.0.1:3425", "http://localhost:3425/", "http://[::1]:3425/"]) {
    expect(
      connect({
        gateway: { url, v1: url + "/v1", key: "magpie-eta" },
        models: [{ id: "route/group" }, { id: "vendor/model" }],
      }),
    ).toEqual({ version: 1, baseUrl: url.replace(/\/$/, ""), apiKey: "magpie-eta" });
  }
});

test("rejects remote gateways and malformed keys without echoing credentials", () => {
  for (const url of [
    "https://127.0.0.1:3425",
    "http://example.com",
    "http://127.0.0.1:3425/v1",
    "http://localhost.evil:3425",
    "http://user@localhost:3425",
  ]) {
    expect(() => connect({ gateway: { url, key: "private-key" } })).toThrow(
      "Eta requires a local HTTP Magpie gateway and a valid gateway key",
    );
  }
  for (const key of ["", "secret key", "private\r\nvalue", null]) {
    expect(() => connect({ gateway: { url: "http://127.0.0.1:3425", key } })).toThrow();
  }
});

test("uses the same offline Eta artwork for agent and installed-package discovery", async () => {
  const icon = await Bun.file(new URL("./icon.svg", import.meta.url)).text();
  const dataUri = "data:image/svg+xml;base64," + Buffer.from(icon).toString("base64");
  expect(agent.icon).toBe(dataUri);
  expect(pkg.magpie.icon).toBe(dataUri);
  expect(pkg.magpie.name).toBe("Eta");
  expect(pkg.name).toBe("@magpie-community/agent-eta");
  expect(pkg.magpie.summary.en).toBeTruthy();
  expect(pkg.magpie.summary.zh).toBeTruthy();
  // A pure agent must not be sent to the separate Bun/provider host.
  expect(pkg.main).toBeUndefined();
  expect(pkg.exports).toBeUndefined();
});

test("the installed package contains the descriptor, artwork and instructions", async () => {
  for (const path of [pkg.magpie.agent.replace(/^\.\//, ""), "icon.svg", "README.md", "LICENSE"]) {
    expect(pkg.files).toContain(path);
    expect(await Bun.file(new URL(path, import.meta.url)).exists()).toBe(true);
  }
  expect(agent.config).toBe("~/.config/eta/magpie.json");
  expect(agent.model).toBeUndefined();
  expect(agent.startup).toBeUndefined();
});

test("the market lists Eta as an agent with the package's name, artwork and summaries", async () => {
  const registry = await Bun.file(new URL("../../registry.json", import.meta.url)).json()
  const entries = registry.plugins.filter((entry) => entry.package === pkg.name)
  expect(entries).toHaveLength(1)
  expect(entries[0].kind).toBe("agent")
  expect(entries[0].providers).toBeUndefined()
  for (const key of ["name", "icon", "summary"]) {
    expect(entries[0][key]).toEqual(pkg.magpie[key])
  }
})

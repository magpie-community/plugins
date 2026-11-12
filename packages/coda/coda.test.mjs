import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agent, connect } from "./coda.agent.js";

describe("@magpie-community/agent-coda", () => {
  test("declares Mode A dual-picker agent descriptor with effort disabled", () => {
    expect(agent.id).toBe("coda");
    expect(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent.id)).toBe(true);
    expect(agent.name).toBe("Coda Bot");
    expect(agent.dir).toBe("~/.coda");
    expect(agent.config).toBe("~/.coda/magpie.json");
    expect(agent.format).toBe("json");
    expect(agent.model).toBe("defaultModel");
    expect(Boolean(agent.effort)).toBe(false);
    expect(agent.ua).toEqual(["codabot"]);
    // magpie matches the lowercased product name of the User-Agent against these prefixes
    expect(agent.ua.every((p) => p === p.toLowerCase())).toBe(true);
    expect(agent.ua.some((p) => "CodaBot/0.0.2-dev.7".split("/")[0].toLowerCase().startsWith(p))).toBe(true);
    expect(agent.icon.startsWith("https://")).toBe(true);
    expect(agent.notice.length).toBeGreaterThan(20);
  });

  test("contains no Node/Bun/external imports so moejs loads it cleanly", () => {
    const raw = readFileSync(join(import.meta.dir, "coda.agent.js"), "utf8");
    const codeOnly = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\bimport\s+/.test(codeOnly)).toBe(false);
    expect(/\brequire\s*\(/.test(codeOnly)).toBe(false);
    expect(/\bprocess\b|\bBuffer\b|\bBun\b/.test(codeOnly)).toBe(false);
  });

  test("connect writes top-level string marks and normalized gateway model catalog", () => {
    const out = connect({
      gateway: {
        url: "http://127.0.0.1:3425/",
        v1: "http://127.0.0.1:3425/v1/",
        key: "mgp_coda_token_123",
      },
      model: {
        id: "kimi/k3",
        name: "Kimi K3",
        context: 200000,
        output: 64000,
        images: true,
        efforts: ["none", "low", "medium", "high", "max", "high"],
        native_endpoints: ["/v1/messages"],
      },
      models: [
        {
          id: "kimi/k3",
          name: "Kimi K3",
          context: 200000,
          output: 64000,
          images: true,
          efforts: ["none", "low", "medium", "high", "max", "high"],
          native_endpoints: ["/v1/messages"],
        },
        {
          id: "openai/gpt-5.4",
          name: "GPT-5.4",
          context: 128000,
          output: 256000,
          images: false,
          efforts: ["medium", "high", "xhigh", "ultra", "invalid"],
          native_endpoints: ["/v1/responses", "/v1/chat/completions"],
        },
        {
          id: "bad,model id",
          name: "Invalid",
        },
      ],
    });

    expect(out.url).toBe("http://127.0.0.1:3425");
    expect(out.baseUrl).toBe("http://127.0.0.1:3425/v1");
    expect(out.apiKey).toBe("mgp_coda_token_123");
    expect("defaultModel" in out).toBe(false);

    expect(out.gateway).toEqual({
      version: 1,
      url: "http://127.0.0.1:3425",
      baseUrl: "http://127.0.0.1:3425/v1",
      models: [
        {
          id: "kimi/k3",
          name: "Kimi K3",
          vision: true,
          efforts: ["off", "low", "medium", "high", "max"],
          nativeEndpoints: ["/v1/messages"],
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
        {
          id: "openai/gpt-5.4",
          name: "GPT-5.4",
          vision: false,
          efforts: ["medium", "high", "xhigh", "ultra"],
          nativeEndpoints: ["/v1/responses", "/v1/chat/completions"],
          contextWindow: 128000,
          maxOutputTokens: 128000,
        },
      ],
    });
  });

  test("prepends selected model when absent from models list (e.g. newly added route group)", () => {
    const out = connect({
      gateway: {
        url: "http://127.0.0.1:3425",
        v1: "http://127.0.0.1:3425/v1",
        key: "mgp_key",
      },
      model: {
        id: "group/smart-router",
        name: "Smart Router",
        context: 0,
        output: 0,
        images: false,
        efforts: [],
      },
      models: [],
    });
    expect(out.gateway.models).toHaveLength(1);
    expect(out.gateway.models[0].id).toBe("group/smart-router");
  });

  test("simulates plugged.go stash: preserves pre-existing bridge values, detects token/url drift and restores cleanly", () => {
    const file = { userNote: "keep-me", url: "http://127.0.0.1:9999" };
    const stash = { mark: "", value: "", had: new Map(), wrote: new Map() };

    function wire(ref, gk, port = 3425) {
      const out = connect({
        gateway: {
          url: `http://127.0.0.1:${port}`,
          v1: `http://127.0.0.1:${port}/v1`,
          key: gk,
        },
        model: { id: ref, name: ref },
        models: [{ id: ref, name: ref }],
      });
      stash.mark = "";
      stash.wrote.clear();
      for (const k of Object.keys(out).sort()) {
        if (typeof out[k] === "string") {
          stash.wrote.set(k, out[k]);
          if (out[k] === gk && !stash.mark) stash.mark = k;
        }
      }
      stash.value = gk;
      const kvs = { [agent.model]: ref, ...out };
      for (const [k, v] of Object.entries(kvs)) {
        if (!stash.had.has(k)) {
          stash.had.set(k, k in file ? structuredClone(file[k]) : Symbol.for("absent"));
        }
        file[k] = v;
      }
    }

    function checkDrift() {
      for (const [k, want] of stash.wrote.entries()) {
        if (file[k] !== want) return k;
      }
      return "";
    }

    function disconnect() {
      for (const [k, prev] of stash.had.entries()) {
        if (prev === Symbol.for("absent")) delete file[k];
        else file[k] = prev;
      }
      stash.had.clear();
    }

    wire("workbuddy/deepseek-v4.1", "mgp_tok_1");
    expect(stash.mark).toBe("apiKey");
    expect(checkDrift()).toBe("");

    // External modification triggers drift on top-level string key
    file.baseUrl = "http://127.0.0.1:4000/v1";
    expect(checkDrift()).toBe("baseUrl");

    // Re-sync fixes drift
    wire("deepseek/deepseek-chat", "mgp_tok_2");
    expect(checkDrift()).toBe("");

    // Disconnect restores pre-existing url and removes keys that were absent
    disconnect();
    expect(file).toEqual({ userNote: "keep-me", url: "http://127.0.0.1:9999" });
  });

  test("rejects missing or invalid gateway fields and invalid selected model id", () => {
    expect(() => connect({})).toThrow();
    expect(() =>
      connect({ gateway: { url: "ftp://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "k" } }),
    ).toThrow();
    expect(() =>
      connect({ gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "   " } }),
    ).toThrow();
    expect(() =>
      connect({
        gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "k" },
        model: { id: "bad model id" },
        models: [],
      }),
    ).toThrow();
  });
});

import { describe, it, expect, vi } from "vitest";
const config = vi.hoisted(() => ({ base: "" }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn(async () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: config.base } })),
}));

import {
  parseCapabilities,
  magpieTokenFor,
  magpieAgentId,
  filterToGatewayShown,
  fetchGatewayModelIds,
  magpieDefaultModel,
} from "../../daemon/src/providers/magpieGateway.js";

describe("magpie gateway capability table", () => {
  it("effort / xhigh_effort / max_effort become levels", () => {
    const m = parseCapabilities("devin/swe-2=effort,xhigh_effort,max_effort;cursor/auto=effort;cursor/grok-4.7@256k=effort,xhigh_effort;x/no=foo");
    expect(m.get("devin/swe-2")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(m.get("cursor/auto")).toEqual(["low", "medium", "high"]);
    expect(m.get("cursor/grok-4.7@256k")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(m.has("x/no")).toBe(false);
  });

  it("empty or missing returns an empty table", () => {
    expect(parseCapabilities(undefined).size).toBe(0);
    expect(parseCapabilities("").size).toBe(0);
  });
});

describe("magpie per-agent gateway identity", () => {
  it("TokenFor matches Magpie gateway.TokenFor", () => {
    expect(magpieTokenFor("claude")).toBe("magpie-claude");
    expect(magpieTokenFor("codex")).toBe("magpie-codex");
    expect(magpieTokenFor("opencode")).toBe("magpie-opencode");
    expect(magpieTokenFor("pi")).toBe("magpie-pi");
    expect(magpieTokenFor("dsh")).toBe("magpie-dsh");
  });

  it("provider ids map to Magpie agent ids (CatalogFor / HiddenModels keys)", () => {
    expect(magpieAgentId("claude")).toBe("claude");
    expect(magpieAgentId("codex")).toBe("codex");
    expect(magpieAgentId("opencode")).toBe("opencode");
    expect(magpieAgentId("pi")).toBe("pi");
    expect(magpieAgentId("dsh")).toBe("dsh");
    expect(magpieAgentId("cursor")).toBeNull();
  });

  it("magpieDefaultModel never returns applied.json strings for dsh", async () => {
    expect(await magpieDefaultModel("dsh")).toBeNull();
  });

  it("filterToGatewayShown drops models Magpie hid for the agent", () => {
    const list = [
      { id: "hub-ccttt99/gpt-6.1-sol", name: "hub" },
      { id: "deepseek/deepseek-flash", name: "flash" },
      { id: "cursor/auto", name: "cursor" },
    ];
    const shown = filterToGatewayShown(list, ["deepseek/deepseek-flash"], "");
    expect(shown.map((m) => m.id)).toEqual(["deepseek/deepseek-flash"]);
  });

  it("filterToGatewayShown respects magpie/ prefix used by OpenCode / Pi", () => {
    const list = [
      { id: "magpie/deepseek/deepseek-flash", name: "flash" },
      { id: "magpie/cursor/auto", name: "cursor" },
      { id: "local/other", name: "other" },
    ];
    const shown = filterToGatewayShown(list, ["deepseek/deepseek-flash"], "magpie/");
    expect(shown.map((m) => m.id)).toEqual(["magpie/deepseek/deepseek-flash"]);
  });

  it("filterToGatewayShown keeps Codex ChatGPT bare slugs that Magpie lists as codex/<slug>", () => {
    const list = [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
      { id: "deepseek/deepseek-flash", name: "flash" },
    ];
    // Magpie CatalogFor("codex") shows ChatGPT-own as "codex/<slug>"; gpt-5-mini was hidden via ModelOff
    const shown = filterToGatewayShown(
      list,
      ["codex/gpt-5.3-codex", "deepseek/deepseek-flash"],
      "",
      { providerId: "codex" },
    );
    expect(shown.map((m) => m.id)).toEqual(["gpt-5.3-codex", "deepseek/deepseek-flash"]);
  });

  it("rejects a gateway base with a loopback-looking hostile hostname", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ data: [] }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    config.base = "http://localhost.evil.com";
    try {
      await fetchGatewayModelIds("claude");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3425/v1/models");
    } finally {
      config.base = "";
      vi.unstubAllGlobals();
    }
  });

  it("fetchGatewayModelIds sends TokenFor Authorization / x-api-key", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "deepseek/deepseek-flash" }, { id: "hub/hidden" }] }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ids = await fetchGatewayModelIds("claude");
      expect(ids).toEqual(["deepseek/deepseek-flash", "hub/hidden"]);
      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(String(call[0])).toMatch(/\/v1\/models$/);
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer magpie-claude");
      expect(headers["x-api-key"]).toBe("magpie-claude");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

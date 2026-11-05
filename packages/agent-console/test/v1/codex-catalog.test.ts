// #758: a custom Codex provider's models come from model_catalog_json, not only the top-level model.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexProvider, parseCodexConfig, resolveCatalogPath } from "../../daemon/src/providers/codex/provider.js";

// The reporter's config.toml, as written in the issue
const REPORTER_CONFIG = `model_provider = "magpie"
model_catalog_json = "$HOME/.codex/magpie-models.json"
model = "group/deepseek-v4-1-flash"

[model_providers.magpie]
name = "magpie"
base_url = "http://127.0.0.1:3425/v1"
wire_api = "responses"
`;

const SLUGS = [
  "group/deepseek-v4-1-flash",
  "group/glm-5.3-flash",
  "workbuddy/hy3",
  "workbuddy/deepseek-v4.1-flash",
  "workbuddy/glm-5.3-flash",
  "trae-cn/glm-5.3-flashx-max",
  "trae-cn/deepseek-v4.1-flash",
];
const NAMES = ["DeepSeek V4.1 Flash", "GLM 5.3 Flash", "HY3", "DeepSeek V4.1 Flash", "GLM 5.3 Flash", "GLM 5.3 FlashX Max", "DeepSeek V4.1 Flash"];

function catalog(extra: object[] = []): string {
  const levels = ["low", "medium", "high"].map((effort) => ({ effort, description: effort }));
  return JSON.stringify({
    models: [
      ...SLUGS.map((slug, i) => ({
        slug,
        display_name: NAMES[i],
        visibility: "list",
        supported_reasoning_levels: levels,
        default_reasoning_level: "medium",
        priority: i + 1,
      })),
      ...extra,
    ],
  });
}

describe("Codex model_catalog_json (#758)", () => {
  let home: string;
  let codexHome: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ac-758-"));
    codexHome = join(home, ".codex");
    mkdirSync(codexHome);
    for (const k of ["HOME", "USERPROFILE", "CODEX_HOME"]) saved[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = codexHome;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const list = () => createCodexProvider("0").listModels();

  it("lists every model of the reporter's catalog, display_name as the label", async () => {
    writeFileSync(join(codexHome, "config.toml"), REPORTER_CONFIG);
    writeFileSync(join(codexHome, "magpie-models.json"), catalog([{ slug: "hidden/one", display_name: "Hidden", visibility: "hide" }]));
    const rows = await list();
    expect(rows.map((r) => r.id)).toEqual(SLUGS);
    expect(rows.map((r) => r.name)).toEqual(NAMES);
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual(["group/deepseek-v4-1-flash"]);
    expect(rows[1].thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high"]);
    expect(rows[1].defaultThinking).toBe("medium");
  });

  it("takes a relative path from config.toml's folder and ~/ from home, as Codex does", async () => {
    writeFileSync(join(codexHome, "config.toml"), REPORTER_CONFIG.replace("$HOME/.codex/magpie-models.json", "magpie-models.json"));
    writeFileSync(join(codexHome, "magpie-models.json"), catalog());
    expect((await list()).map((r) => r.id)).toEqual(SLUGS);
    expect(resolveCatalogPath("~/x/m.json", "/cfg", "/h")).toBe(join("/h", "x", "m.json"));
    expect(resolveCatalogPath("${HOME}/m.json", "/cfg", "/h")).toBe(join("/h", "m.json"));
    expect(resolveCatalogPath("m.json", "/cfg", "/h")).toBe(join("/cfg", "m.json"));
    expect(resolveCatalogPath("$HOMEX/m.json", "/cfg", "/h")).toBe(join("/cfg", "$HOMEX", "m.json"));
  });

  it("a profile's model_catalog_json wins over the top-level one", () => {
    const cfg = parseCodexConfig(REPORTER_CONFIG.replace('model = "group', 'profile = "p"\nmodel = "group') + '\n[profiles.p]\nmodel_catalog_json = "p.json"\n');
    expect(cfg.catalogJson).toBe("p.json");
  });

  it("a missing or broken catalog keeps the configured model", async () => {
    writeFileSync(join(codexHome, "config.toml"), REPORTER_CONFIG);
    const only = [{ id: "group/deepseek-v4-1-flash", name: "group/deepseek-v4-1-flash", isDefault: true }];
    expect(await list()).toEqual(only);
    writeFileSync(join(codexHome, "magpie-models.json"), '{"models": [');
    expect(await list()).toEqual(only);
    writeFileSync(join(codexHome, "magpie-models.json"), '{"models": "nope"}');
    expect(await list()).toEqual(only);
  });

  it("keeps the provider's models = [...] beside the catalog", async () => {
    writeFileSync(join(codexHome, "config.toml"), REPORTER_CONFIG + 'models = ["extra/one", "group/glm-5.3-flash"]\n');
    writeFileSync(join(codexHome, "magpie-models.json"), catalog());
    expect((await list()).map((r) => r.id)).toEqual([...SLUGS, "extra/one"]);
  });
});

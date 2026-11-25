import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as entry from "../src/index.ts";
import { CamPlugin } from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("Magpie package contract", () => {
  test("declares request hooks, a tool-capable main module and a port-free page", async () => {
    expect(manifest.name).toBe("@magpie-community/gateway-cam");
    expect(manifest.magpie.hooks).toBe("./src/hooks.ts");
    expect(manifest.magpie.page.service).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    const plugin = await CamPlugin({}, {});
    expect(plugin.tool.cam_view_image.description).toContain("omitted");
    expect(plugin.tool.cam_view_image.args.required).toEqual(["ids", "session"]);
    expect(Object.keys(entry).sort()).toEqual(["CamPlugin", "default"]);
    // Helper exports are mistaken for plugin entries by Magpie's loader.
    expect(entry.fetchImages).toBeUndefined();
  });

  test("the Magpie adapter never touches Codex configuration", () => {
    for (const file of ["hooks.ts", "index.ts", "store.ts", "payload.ts", "panel-service.ts"]) {
      const source = readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
      expect(source).not.toContain("config.toml");
      expect(source).not.toContain("openai_base_url");
      expect(source).not.toContain("codex-reroute");
    }
  });
});

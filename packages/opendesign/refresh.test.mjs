// refresh-models.mjs rewrites models.mjs from amr-link's catalog. A kind, a
// limit or a word the catalog leaves out is kept from the seed, as the plugin
// serves it (#829), so a refresh doesn't take image from DeepSeek V4.1 Flash
// Eco. The script runs on a copy of the package, with fetch stubbed.
import { test, expect } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const CATALOG = {
  data: [
    { id: "deepseek-v4.1-flash-eco", architecture: { input_modalities: ["text"] }, metadata: { cost: "low", capability: "advanced", context_limit: 1048000, context_budget: 232000 } },
    { id: "glm-5.3-flashx" },
    { id: "kimi-k2.7-code", architecture: { input_modalities: ["text", "image", "video"] }, metadata: { context_limit: 262000 } },
    { id: "deepseek-v4-pro", architecture: { input_modalities: ["text"] }, metadata: { cost: "high" } },
    { id: "brand-new-9", architecture: { input_modalities: ["text"] } },
  ],
}

test("a refresh keeps what the catalog leaves out of a seed model (#829)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opendesign-refresh-"))
  try {
    for (const f of ["refresh-models.mjs", "models.mjs"]) copyFileSync(join(import.meta.dir, f), join(dir, f))
    writeFileSync(
      join(dir, "stub.mjs"),
      `globalThis.fetch = async (url) => {
        if (String(url) !== "https://amr-link.open-design.ai/v1/models") throw new Error("unexpected fetch " + url)
        return Response.json(${JSON.stringify(CATALOG)})
      }\n`,
    )
    const run = Bun.spawnSync([process.execPath, "--preload", join(dir, "stub.mjs"), join(dir, "refresh-models.mjs")], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, OPENDESIGN_KEY: "sk-amr-test" },
    })
    const out = run.stdout.toString()
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""])
    expect(out).toContain("deepseek-v4.1-flash-eco: kept image from models.mjs")
    // a fresh URL, so this isn't the copy's import from before the write
    const { MODELS } = await import(pathToFileURL(join(dir, "models.mjs")).href + "?after")
    expect(Object.keys(MODELS)).toEqual(CATALOG.data.map((m) => m.id))
    expect(MODELS["deepseek-v4.1-flash-eco"]).toEqual({ name: "DeepSeek V4.1 Flash Eco", context: 1048000, output: 232000, input: ["image"], cost: "low", capability: "advanced", efforts: ["low", "high", "max"] })
    expect(MODELS["glm-5.3-flashx"]).toEqual({ name: "GLM 5.3 FlashX", context: 1000000, output: 232000, input: ["image", "file", "video"], cost: "medium", capability: "advanced", efforts: ["low", "high", "max"] })
    expect(MODELS["kimi-k2.7-code"].input).toEqual(["image", "video"])
    expect(MODELS["deepseek-v4-pro"].input).toBeUndefined()
    expect(MODELS["brand-new-9"]).toEqual({ name: "brand-new-9" })
    // the package's own seed is untouched
    expect(readFileSync(join(import.meta.dir, "models.mjs"), "utf8")).toContain('"deepseek-v4.1-flash-eco"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

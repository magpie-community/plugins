import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"
import { mediaPaths } from "./media-sync.mjs"

test("companion plugin starts, follows disconnect and leaves other plugins running",
  { timeout: 20000, skip: !["darwin", "win32"].includes(process.platform) }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-media-host-"))
  const appData = path.join(home, "AppData", "Roaming")
  const paths = mediaPaths(home, process.platform, appData)
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["x-magpie-drawers"], "1")
    assert.equal(request.headers["x-magpie-videomakers"], "1")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "fixture/image", kind: "image" },
      { id: "replacement/new-image", kind: "image" }, { id: "fixture/video", kind: "video" }] }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = `http://127.0.0.1:${server.address().port}/v1`
  fs.mkdirSync(path.dirname(paths.control), { recursive: true })
  fs.writeFileSync(paths.control, JSON.stringify({ customMcpVault: JSON.stringify({
    version: 1, servers: { conflict: { name: "conflict", enabled: true,
      config: { transport: "http", url: "https://user.invalid/mcp" } } },
  }), config: { customModels: {
    "user-custom-magpie": { baseUrl: address, apiKey: "magpie-minimax-design" },
  } } }))
  fs.writeFileSync(path.join(path.dirname(paths.control), "library-mcp.json"), JSON.stringify({
    mcp: { conflict: { type: "remote", url: "https://library.invalid/mcp" } },
  }))
  const source = path.join(home, "library-source")
  const staging = path.join(path.dirname(paths.control), "library-skills")
  const userSkill = path.join(home, "Movies/Hub/skills/conflict")
  fs.mkdirSync(source)
  fs.mkdirSync(staging)
  fs.mkdirSync(userSkill, { recursive: true })
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: conflict\ndescription: Fixture\n---\n")
  fs.writeFileSync(path.join(userSkill, "SKILL.md"), "user skill")
  fs.symlinkSync(source, path.join(staging, "conflict"), "junction")
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import plugin from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)};
    const hooks = await plugin({}, { imageRoutes: { "fixture/image": "replacement/new-image" } });
    const shared = {};
    hooks.config(shared);
    shared.provider = { replacement: { models: { "new-image": {
      modalities: { input: ["text", "image"] }, capabilities: { maxReferences: 6 }
    } } } };
    const config = ${JSON.stringify(path.join(paths.store, "config.json"))};
    assert.equal(JSON.parse(fs.readFileSync(config)).models.length, 2);
    await new Promise(resolve => setTimeout(resolve, 5500));
    const entry = JSON.parse(fs.readFileSync(config)).models.find(model => model.type === "image");
    const folder = ${JSON.stringify(path.join(paths.store, "models"))} + "/" + entry.id;
    assert.equal(JSON.parse(fs.readFileSync(folder + "/spec.json")).references.image.max, 6);
    assert.ok(fs.readFileSync(folder + "/adapter.js", "utf8").includes("replacement/new-image"));
    fs.writeFileSync(${JSON.stringify(paths.control)}, "{}");
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(JSON.parse(fs.readFileSync(config)).models.length, 0);
    clearInterval(globalThis[Symbol.for("magpie.minimax-design.media.v1")]);
    console.log("host remains alive after disconnect");
  `
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData }, timeout: 16000,
    })
    assert.match(stdout, /host remains alive/)
    assert.match(stderr, /Design skill (?:name is already in use|projection requires a YAML parser)/)
    assert.match(stderr, /Design MCP already exists outside Magpie/)
    assert.equal(stderr.split("[minimax-design:skills]").length - 1, 1)
    assert.equal(stderr.split("[minimax-design:mcp] Design MCP already exists outside Magpie").length - 1, 1)
    assert.equal(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf8"), "user skill")
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
})

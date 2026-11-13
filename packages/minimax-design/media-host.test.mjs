import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"
import { mediaPaths } from "./media-sync.mjs"

test("companion plugin starts, follows disconnect and leaves other plugins running", { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-media-host-"))
  const paths = mediaPaths(home, "darwin")
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["x-magpie-drawers"], "1")
    assert.equal(request.headers["x-magpie-videomakers"], "1")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "fixture/image", kind: "image" }, { id: "fixture/video", kind: "video" }] }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = `http://127.0.0.1:${server.address().port}/v1`
  fs.mkdirSync(path.dirname(paths.control), { recursive: true })
  fs.writeFileSync(paths.control, JSON.stringify({ config: { customModels: {
    "user-custom-magpie": { baseUrl: address, apiKey: "magpie-minimax-design" },
  } } }))
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import plugin from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)};
    await plugin();
    const config = ${JSON.stringify(path.join(paths.store, "config.json"))};
    assert.equal(JSON.parse(fs.readFileSync(config)).models.length, 2);
    fs.writeFileSync(${JSON.stringify(paths.control)}, "{}");
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(JSON.parse(fs.readFileSync(config)).models.length, 0);
    clearInterval(globalThis[Symbol.for("magpie.minimax-design.media.v1")]);
    console.log("host remains alive after disconnect");
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 12000,
    })
    assert.match(stdout, /host remains alive/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
})

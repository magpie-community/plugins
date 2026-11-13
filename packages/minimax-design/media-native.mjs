import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { applyMedia, mediaPaths } from "./media-sync.mjs"

const app = process.env.MINIMAX_APP
if (!app) throw new Error("Set MINIMAX_APP for native media validation.")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-native-media-"))
const paths = mediaPaths(root, "darwin")
const gateway = { baseURL: "http://127.0.0.1:3425/v1", key: "magpie-minimax-design" }
const catalogue = [
  { ref: "minimax-code/MiniMax-Image", name: "Fixture image", type: "image", images: true },
  { ref: "minimax-code/MiniMax-Hailuo-2.3", name: "Fixture video", type: "video", images: true },
]
applyMedia(paths, gateway, catalogue)
const generated = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
const imageFolder = path.join(paths.store, "models", generated.models.find((model) => model.type === "image").id)
const videoFolder = path.join(paths.store, "models", generated.models.find((model) => model.type === "video").id)
const source = fs.readFileSync(path.join(app, "Contents/Resources/gateway/dist/main.js"), "utf8")
const bootstrap = source.lastIndexOf("bootstrap().catch(")
assert.ok(bootstrap > 0)
const driver = `
{
const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const service = CustomMediaModelsService.at(${JSON.stringify(paths.store)});
const models = await service.models();
assert.equal(models.length, 2);
assert.deepEqual(models.map(model => model.type).sort(), ["image", "video"]);
console.log("PASS: installed Design loads both native media models and adapters");
const imageSpec = parseMediaSpec(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(imageFolder, "spec.json"))})));
const videoSpec = parseMediaSpec(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(videoFolder, "spec.json"))})));
assert.equal(imageSpec.references.image.max, 16);
assert.deepEqual(videoSpec.params[0].enum, ["自动", "768P · 6秒", "768P · 10秒", "1080P · 6秒"]);
assert.equal(videoSpec.params[0].default, "自动");
const imageBundle = { source: fs.readFileSync(${JSON.stringify(path.join(imageFolder, "adapter.js"))}, "utf8") };
const videoBundle = { source: fs.readFileSync(${JSON.stringify(path.join(videoFolder, "adapter.js"))}, "utf8") };
const endpoint = { baseUrl: "http://127.0.0.1:3425/v1", headers: { authorization: "Bearer magpie-minimax-design" } };
const requests = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let polls = 0;
const fakeFetch = async (url, init) => {
  const address = new URL(url);
  requests.push(address.pathname);
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer magpie-minimax-design");
  const headers = { "content-type": "application/json" };
  if (address.pathname.endsWith("/images/generations") || address.pathname.endsWith("/images/edits")) {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "minimax-code/MiniMax-Image");
    if (address.pathname.endsWith("/edits")) {
      assert.equal(body.images.length, 2);
      assert.match(body.images[0].image_url, /^data:image\\/png;base64,/);
    }
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { headers });
  }
  if (address.pathname === "/v1/videos") {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "minimax-code/MiniMax-Hailuo-2.3");
    assert.equal(body.size, "1080P");
    assert.equal(body.seconds, "6");
    return new Response(JSON.stringify({ id: "video_fixture", status: "queued" }), { headers });
  }
  if (address.pathname === "/v1/videos/video_fixture/content") return new Response(new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109]), { headers: { "content-type": "video/mp4" } });
  if (address.pathname === "/v1/videos/video_fixture") return new Response(JSON.stringify({ status: ++polls === 1 ? "in_progress" : "completed", progress: 50 }), { headers });
  throw new Error("Unexpected fixture URL: " + address.pathname);
};
const common = { bundle: imageBundle, endpoint, fetch: fakeFetch };
const image = await submitOnce({ ...common, job: { type: "image", model: "minimax-code/MiniMax-Image", prompt: "native fixture", params: {}, references: {} } });
assert.equal(image.kind, "done");
assert.equal(image.outputs.length, 1);
console.log("PASS: Design's actual executor resolves image fixture output");
const referencePath = ${JSON.stringify(path.join(root, "reference.png"))};
fs.writeFileSync(referencePath, png);
const reference = { path: referencePath, mime: "image/png", name: "reference.png", size: png.length, blob: async () => new Blob([png], { type: "image/png" }) };
const edit = await submitOnce({ ...common, job: { type: "image", model: "minimax-code/MiniMax-Image", prompt: "edit", params: {},
  references: { image: [reference, reference] } } });
assert.equal(edit.kind, "done");
common.bundle = videoBundle;
const beforeInvalid = requests.length;
await assert.rejects(submitOnce({ ...common, job: { type: "video", model: "minimax-code/MiniMax-Hailuo-2.3", prompt: "invalid", params: { preset: "1080P · 10秒" }, references: {} } }));
assert.equal(requests.length, beforeInvalid);
console.log("PASS: native enum/default/reference limits and invalid combination rejected before HTTP");
const video = await submitOnce({ ...common, job: { type: "video", model: "minimax-code/MiniMax-Hailuo-2.3", prompt: "native fixture", params: { preset: "1080P · 6秒" }, references: {} } });
assert.equal(video.kind, "task");
const task = { id: video.taskId };
assert.equal((await pollOnce({ ...common, task })).kind, "running");
const done = await pollOnce({ ...common, task });
assert.equal(done.kind, "done");
assert.equal(done.outputs.length, 1);
assert.ok(requests.includes("/v1/videos/video_fixture/content"));
console.log("PASS: Design's actual executor edits an image, submits/polls video and fetches authenticated content");
process.exit(0);
}
`
const program = path.join(root, "native-runtime.mjs")
fs.symlinkSync(path.join(app, "Contents/Resources/gateway/node_modules"), path.join(root, "node_modules"), "dir")
fs.writeFileSync(program, source.slice(0, bootstrap) + driver)
const result = await promisify(execFile)(path.join(app, "Contents/MacOS/MiniMax Design"), [program], {
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production", HILO_RELEASE_REGION: "domestic", HILO_RELEASE_CHANNEL: "prod" },
  timeout: 60000, maxBuffer: 2 << 20,
})
console.log(result.stdout)
console.log(`Native media validation passed. Sandbox: ${root}`)

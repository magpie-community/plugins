import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, root } from "./build-v1.mjs";

const files = [
  "app/app.js",
  "app/app.css",
  "app/index.html",
  "daemon/dist/main.js",
  "daemon/dist/main.js.map",
];
const output = await mkdtemp(join(tmpdir(), "agent-console-build-"));
let failed = false;
try {
  await buildAll(output);
  for (const file of files) {
    const expected = await readFile(join(root, file));
    const actual = await readFile(join(output, file));
    const hash = createHash("sha256").update(expected).digest("hex");
    if (expected.equals(actual)) console.log(`OK ${hash}  ${file}`);
    else {
      console.error(`MISMATCH ${hash}  ${file}`);
      failed = true;
    }
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;

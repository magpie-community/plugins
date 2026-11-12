import { spawnSync } from "node:child_process";
import { pythonCommand, DATA, PORT } from "../runtime.mjs";
const p = pythonCommand();
const check = spawnSync(p.file, [...p.args, "-c", 'import sys; assert sys.version_info >= (3,12); import httpx,pydantic,tenacity; print("ready")'], { encoding: "utf8", windowsHide: true });
console.log(JSON.stringify({
  platform: process.platform,
  dpapiSupported: process.platform === "win32",
  dataDirectory: DATA,
  port: PORT,
  pythonDependencies: check.status === 0 ? "ready" : "missing; run scripts/setup.ps1 or pip install -r requirements.txt",
}, null, 2));
if (check.status !== 0) process.exitCode = 1;

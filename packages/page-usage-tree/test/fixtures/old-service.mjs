// An older build's service: the same health answer, an older version. It
// owns the port and says in the pid file which process that is, so a newer
// build can replace it.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const port = Number(process.argv[2]);
const pidFile = process.argv[3];

mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, `${process.pid} 0.0.1`, "utf8");

createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, name: "magpie-usage-tree", version: "0.0.1" }));
}).listen(port, "127.0.0.1");

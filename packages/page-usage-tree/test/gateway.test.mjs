import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gatewayUsage } from "../lib/gateway.mjs";

test("a successful HTTP answer that is not a JSON object is an error", async (t) => {
  const replies = [
    ["text/html", "<html>not the usage API</html>"],
    ["application/json", "[1, 2, 3]"],
  ];
  const gateway = createServer((_req, res) => {
    const [type, body] = replies.shift() || ["application/json", "null"];
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const options = {
    gateway: `http://127.0.0.1:${gateway.address().port}`,
    timeout: 2_000,
  };
  await assert.rejects(gatewayUsage("today", options), /invalid JSON object/);
  await assert.rejects(gatewayUsage("today", options), /invalid JSON object/);
});

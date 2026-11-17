import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { sendUsage } from "../lib/transport.mjs";
test("host transport sends no browser headers and never follows redirects", async (t) => {
  let headers;
  const server = createServer((req, res) => {
    headers = req.headers;
    res.writeHead(302, { Location: "http://example.invalid" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const response = await sendUsage(
    `http://127.0.0.1:${server.address().port}/usage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
      signal: AbortSignal.timeout(1000),
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(headers["sec-fetch-mode"], undefined);
  assert.equal(headers.origin, undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { BUILD_FILES, startServer, version } from "../lib/server.mjs";

function status(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path,
        agent: false,
        headers: { Connection: "close" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
}

test("the build ID covers every runtime asset", () => {
  for (const file of [
    "../package.json",
    "../page/boot.js",
    "../page/icon.svg",
    "../ui/app.html",
    "../ui/app.js",
    "../ui/view.js",
    "../ui/i18n.js",
    "../ui/style.css",
  ]) {
    assert.ok(BUILD_FILES.includes(file), `${file} is part of the build ID`);
  }
});

test("a second copy of this build reuses the running service", async (t) => {
  const first = await startServer({
    port: 0,
    load: async () => ({ summary: {}, providers: [], accounts: [] }),
  });
  t.after(() => first.close());

  const second = await startServer({
    port: first.port,
    load: async () => ({ summary: {}, providers: [], accounts: [] }),
  });
  assert.equal(second.reused, true);
  assert.equal(second.port, first.port);
  assert.equal(second.token, "");

  const res = await fetch(`http://127.0.0.1:${first.port}/healthz`);
  const body = await res.json();
  assert.equal(body.name, "magpie-usage-tree");
  assert.equal(body.version, version());
  assert.match(body.build, /^[a-f0-9]{16}$/);
});

test("another build on the port is reported, never killed", async (t) => {
  const old = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "magpie-usage-tree", version: "0.0.1" }));
  });
  await new Promise((resolve) => old.listen(0, "127.0.0.1", resolve));
  const port = old.address().port;
  t.after(() => new Promise((resolve) => old.close(resolve)));

  await assert.rejects(
    startServer({
      port,
      retryAttempts: 1,
      load: async () => ({ summary: {}, providers: [], accounts: [] }),
    }),
    /held by another build of this plugin/i,
  );

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200, "the running build was left alone");
  assert.equal(body.version, "0.0.1");
});

test("a host on its way out releases the port and the new copy takes it", async (t) => {
  const sockets = new Set();
  const leaving = createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("leaving");
  });
  leaving.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => leaving.listen(0, "127.0.0.1", resolve));
  const port = leaving.address().port;
  setTimeout(() => {
    // A host that is going away drops its clients; Bun otherwise keeps the
    // listener alive until a probed connection closes.
    for (const socket of sockets) socket.destroy();
    leaving.close();
  }, 800);
  t.after(() => {
    if (leaving.listening) {
      return new Promise((resolve) => leaving.close(resolve));
    }
  });

  const info = await startServer({
    port,
    load: async () => ({ summary: {}, providers: [], accounts: [] }),
  });
  t.after(() => info.close());

  assert.equal(await status(port, "/healthz"), 200);
});

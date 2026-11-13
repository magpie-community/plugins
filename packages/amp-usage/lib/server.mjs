import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollector, acquireLock } from "./collector.mjs";
import { readJSON, writeJSON } from "./storage.mjs";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));

// The token outlives the service: Magpie restarts its plugin host whenever
// any plugin updates, and a page already open must keep its token.
async function serviceToken(dataDir) {
  const path = join(dataDir, "service-token.json");
  const kept = await readJSON(path, null).catch(() => null);
  if (/^[a-f0-9]{64}$/.test(kept?.token)) return kept.token;
  const token = randomBytes(32).toString("hex");
  await writeJSON(path, { token });
  return token;
}

export async function startServer({
  port = 3497,
  dataDir,
  configDir,
  options = {},
  collector: injected,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid service port.");
  const release = await acquireLock(dataDir);
  let collector, token;
  try {
    token = await serviceToken(dataDir);
    collector =
      injected || (await createCollector({ dataDir, configDir, options }));
  } catch (e) {
    await release();
    throw e;
  }
  let actualPort;
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (
        ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)
      )
        return send(res, 403, { error: "Invalid host." });
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;
      const originOK =
        !origin || origin === "null" || origin === `http://${host}`;
      if (!originOK) return send(res, 403, { error: "Invalid origin." });
      if (url.pathname.startsWith("/api/")) {
        // Sandboxed pages must also be able to read authentication failures.
        res.setHeader(
          "Access-Control-Allow-Origin",
          origin || `http://${host}`,
        );
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Amp-Usage-Token",
          );
          res.setHeader("Access-Control-Allow-Methods", "GET, POST");
          return send(res, 204, "", "text/plain");
        }
        const given = Buffer.from(
          String(req.headers["x-amp-usage-token"] || ""),
        );
        const expected = Buffer.from(token);
        if (
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        )
          return send(res, 403, {
            error: "Reopen the Amp usage page to reconnect.",
            code: "reconnect",
          });
        if (url.pathname === "/api/status" && req.method === "GET")
          return send(res, 200, collector.view());
        if (req.method !== "POST")
          return send(res, 405, { error: "Method not allowed." });
        if (
          String(req.headers["content-type"]).split(";")[0] !==
          "application/json"
        )
          return send(res, 415, { error: "Expected JSON." });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 4096)
            return send(res, 413, { error: "Request too large." });
        }
        try {
          JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "Invalid JSON." });
        }
        if (url.pathname === "/api/refresh") {
          // The page polls status; a long cloud export never holds its HTTP request.
          void collector.run().catch(() => {});
          return send(res, 202, collector.view());
        }
        return send(res, 404, { error: "Not found." });
      }
      if (req.method !== "GET")
        return send(res, 405, { error: "Method not allowed." });
      const files = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/words.js": ["words.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const file = files[url.pathname];
      if (!file) return send(res, 404, "Not found", "text/plain");
      // The page carries the token, so only a navigation may read it.
      const mode = req.headers["sec-fetch-mode"];
      if (file[0] === "index.html" && mode && mode !== "navigate")
        return send(res, 403, "Forbidden", "text/plain");
      let text = await readFile(join(ui, file[0]), "utf8");
      if (file[0] === "index.html")
        text = text.replace("__SERVICE_TOKEN__", token);
      const self = `http://127.0.0.1:${actualPort} http://localhost:${actualPort}`;
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self' ${self}; style-src 'self' ${self}; connect-src 'self' ${self}; base-uri 'none'; form-action 'none'`,
      );
      return send(res, 200, text, file[1]);
    } catch {
      if (!res.headersSent)
        send(res, 500, {
          error: "Local service error. Check the plugin log.",
          code: "serviceError",
        });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    actualPort = server.address().port;
  } catch (e) {
    await collector.close();
    await release();
    throw e;
  }
  return {
    port: actualPort,
    collector,
    async close() {
      await collector.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await release();
    },
  };
}

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReader } from "./data.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export async function startServer({ port = 3497, configDir, reader } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须为 0–65535 的整数");
  const readReport = reader ?? createReader({ configDir });
  const key = randomBytes(32).toString("hex");
  let actualPort;

  const server = createServer(async (request, response) => {
    const origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    const origin = request.headers.origin;
    const send = (status, body, type = "application/json; charset=utf-8") => {
      response.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Vary": "Origin",
        ...(origin === "null" || origins.includes(origin) ? {
          "Access-Control-Allow-Origin": origin,
        } : {}),
      });
      response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    try {
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(request.headers.host)) {
        return send(403, { error: "不接受此 Host" });
      }
      if (origin && origin !== "null" && !origins.includes(origin)) return send(403, { error: "不接受此来源" });
      const url = new URL(request.url, origins[0]);
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "x-provider-quota-key");
        return send(204, "");
      }
      if (request.method !== "GET") return send(405, { error: "仅支持 GET" });
      if (url.pathname === "/api/report") {
        const received = Buffer.from(String(request.headers["x-provider-quota-key"] ?? ""));
        const expected = Buffer.from(key);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
          return send(401, { error: "页面凭证已失效，请重新打开页面" });
        }
        return send(200, await readReport({ force: url.searchParams.get("refresh") === "1" }));
      }
      const asset = assets.get(url.pathname);
      if (!asset) return send(404, { error: "页面不存在" });
      let content = await readFile(new URL(`../ui/${asset[0]}`, import.meta.url));
      if (url.pathname === "/") {
        const mode = request.headers["sec-fetch-mode"];
        if (mode && mode !== "navigate") return send(403, { error: "请通过页面导航打开" });
        response.setHeader("Content-Security-Policy", [
          "default-src 'none'",
          `script-src 'self' ${origins.join(" ")}`,
          `style-src 'self' 'unsafe-inline' ${origins.join(" ")}`,
          `connect-src 'self' ${origins.join(" ")}`,
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "));
        content = content.toString().replace("__PAGE_KEY__", key);
      }
      return send(200, content, asset[1]);
    } catch (error) {
      if (!response.headersSent) return send(500, { error: error.message });
      response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      actualPort = server.address().port;
      resolve();
    });
  });
  return { server, port: actualPort };
}

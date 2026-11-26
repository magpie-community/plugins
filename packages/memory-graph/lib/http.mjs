// 本文由AI自动生成
// 传输层：只监听回环；Host / Origin / token 三道门；所有响应都带 CORS。

import { timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-memory-graph-token";

export const STATIC = {
  "/": { file: "page/app/index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "page/app/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "page/app/app.js", type: "text/javascript; charset=utf-8" },
  "/graph.js": { file: "page/app/graph.js", type: "text/javascript; charset=utf-8" },
  "/tooltip.js": { file: "page/app/tooltip.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "page/app/style.css", type: "text/css; charset=utf-8" },
  "/icon.svg": { file: "page/icon.svg", type: "image/svg+xml" },
};

export function hostAllowed(req, port) {
  const host = String(req.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function originAllowed(req, port, allowNull = false) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === "null") return allowNull;
  const own = new Set([
    `http://127.0.0.1:${port}`,
    `https://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `https://localhost:${port}`,
    `http://[::1]:${port}`,
    `https://[::1]:${port}`,
  ]);
  return own.has(String(origin).toLowerCase());
}

export function fetchSiteAllowed(req) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (!site) return true;
  return site === "same-origin" || site === "none";
}

export function corsHeaders(req, port, allowNull = false) {
  const origin = String(req.headers.origin ?? "");
  const headers = {
    "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  if (origin === "null" && allowNull) {
    headers["access-control-allow-origin"] = "null";
  } else if (origin && origin !== "null" && originAllowed(req, port, false)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

export function tokenOK(req, token) {
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
  const want = Buffer.from(String(token || ""));
  return got.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export function send(
  req,
  res,
  port,
  status,
  body,
  type = "application/json; charset=utf-8",
  allowNull = false,
) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(req, port, allowNull),
  });
  res.end(body);
}

export async function readBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function injectToken(html, token) {
  return String(html).replace(
    /<meta name="memory-graph-token" content="[^"]*"\s*\/?>/i,
    `<meta name="memory-graph-token" content="${token}">`,
  );
}

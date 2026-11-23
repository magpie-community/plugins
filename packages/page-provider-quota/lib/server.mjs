import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReader, createResetter } from "./data.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

async function readBody(request, limit = 4096) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error("请求内容过大"), { status: 413 });
  }
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw Object.assign(new Error("请求内容不是 JSON 对象"), { status: 400 });
}

export async function startServer({ port = 3497, configDir, reader, resetter, gatewayKey = "" } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须为 0–65535 的整数");
  const readReport = reader ?? createReader({ configDir });
  const useReset = resetter ?? createResetter({ configDir });
  const key = randomBytes(32).toString("hex");
  // 网关密钥：插件选项 gatewayKey，或在页面中输入后保存在本服务内存中，重启插件后需重新输入
  let sessionKey = String(gatewayKey || process.env.MAGPIE_GATEWAY_KEY || "").trim();
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
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "x-provider-quota-key, content-type");
        return send(204, "");
      }
      const authorized = () => {
        const received = Buffer.from(String(request.headers["x-provider-quota-key"] ?? ""));
        const expected = Buffer.from(key);
        return received.length === expected.length && timingSafeEqual(received, expected);
      };
      if (url.pathname === "/api/reset") {
        if (request.method !== "POST") return send(405, { error: "仅支持 POST" });
        if (!authorized()) return send(401, { error: "页面凭证已失效，请重新打开页面" });
        if (!/^application\/json\b/i.test(String(request.headers["content-type"] ?? ""))) {
          return send(415, { error: "请以 JSON 提交" });
        }
        const ask = await readBody(request);
        const report = await readReport();
        const account = [...(report.accounts ?? []), ...(report.otherAccounts ?? [])]
          .find((candidate) => candidate.id === ask.id);
        if (!account?.resetTarget || !account.resets?.count) {
          return send(404, { error: "该账号没有可在此使用的重置卡，请刷新后重试" });
        }
        const credit = typeof ask.credit === "string" ? ask.credit : "";
        if (credit && !account.resets.each.some((card) => card.id === credit)) {
          return send(400, { error: "所选重置卡已不存在，请刷新后重试" });
        }
        const typed = typeof ask.key === "string" ? ask.key.trim() : "";
        try {
          const outcome = await useReset({ ...account.resetTarget, credit, key: typed || sessionKey });
          if (typed && ask.remember !== false) sessionKey = typed;
          const next = await readReport({ force: true }).catch(() => null);
          return send(200, { ...outcome, report: next ? { ...next, canReset: Boolean(sessionKey) } : null });
        } catch (error) {
          if (error.code === "bad_key" && !typed) sessionKey = "";
          return send(error.status ?? 500, { error: error.message, code: error.code ?? "" });
        }
      }
      if (request.method !== "GET") return send(405, { error: "仅支持 GET" });
      if (url.pathname === "/api/report") {
        if (!authorized()) return send(401, { error: "页面凭证已失效，请重新打开页面" });
        const report = await readReport({ force: url.searchParams.get("refresh") === "1" });
        return send(200, { ...report, canReset: Boolean(sessionKey) });
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
      if (!response.headersSent) return send(error.status ?? 500, { error: error.message });
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

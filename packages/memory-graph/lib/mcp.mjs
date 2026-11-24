// 本文由AI自动生成
// magpie memory MCP 的最小客户端：Streamable HTTP + SSE。
//
// 用 node:http 而不是 fetch：magpie 网关会把带 Sec-Fetch-* 的 fetch 请求
// 认成「网页」，对 memory MCP 直接 403。node:http 的请求才被当作本机 agent。
//
// 只做三件事：initialize、tools/call memory_search、会话失效后重建。
// 不调用 memory_save / memory_forget，也不碰任何写接口。

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function collect(response) {
  return new Promise((resolve, reject) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      text += chunk;
    });
    response.on("end", () => resolve(text));
    response.on("error", reject);
  });
}

function sessionError(message) {
  const error = new Error(message);
  error.code = "SESSION";
  return error;
}

export function parseIds(text) {
  const ids = [];
  const pattern = /\[(m_[0-9a-f]{12})\]/g;
  let hit;
  while ((hit = pattern.exec(String(text || "")))) ids.push(hit[1]);
  return ids;
}

export class MemoryMcp {
  constructor({ url, timeoutMs = 15000, idleMs = 300000 }) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.sessionId = "";
    this.session = null;
    this.sequence = 0;
    this.lastUsed = 0;
  }

  reset() {
    this.sessionId = "";
    this.session = null;
  }

  async ensureSession() {
    if (this.lastUsed && Date.now() - this.lastUsed > this.idleMs) this.reset();
    if (!this.session) {
      this.session = this.openSession().catch((error) => {
        this.session = null;
        throw error;
      });
    }
    await this.session;
  }

  async openSession() {
    const id = ++this.sequence;
    const result = await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "magpie-memory-graph", version: "0.1.0" },
        },
      },
      this.timeoutMs,
    );
    if (!result) throw new Error("memory MCP initialize 没有返回");
    await this.notify("notifications/initialized", {});
    this.lastUsed = Date.now();
  }

  async notify(method, params) {
    await this.post({ jsonrpc: "2.0", method, params }, this.timeoutMs);
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    await this.ensureSession();
    const id = ++this.sequence;
    const result = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    this.lastUsed = Date.now();
    return result;
  }

  post(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = new URL(this.url);
      const body = Buffer.from(JSON.stringify(payload));
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": body.length,
        connection: "close",
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const driver = target.protocol === "https:" ? httpsRequest : httpRequest;
      const request = driver(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers,
        },
        (response) => {
          const session = response.headers["mcp-session-id"];
          if (session) this.sessionId = session;

          const status = response.statusCode || 0;
          if (status === 202 || status === 204) {
            response.resume();
            finish(resolve, null);
            return;
          }

          if (status === 400 || status === 404) {
            response.resume();
            this.reset();
            finish(reject, sessionError(`memory MCP ${status}`));
            return;
          }

          if (status !== 200) {
            collect(response)
              .then((text) => {
                const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
                finish(reject, new Error(`memory MCP ${status}${detail ? `: ${detail}` : ""}`));
              })
              .catch((error) => finish(reject, error));
            return;
          }

          const type = String(response.headers["content-type"] || "");
          if (type.includes("text/event-stream")) {
            let buffer = "";
            const decoder = new TextDecoder();

            response.on("data", (chunk) => {
              buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
              let cut;
              while ((cut = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  const text = line.slice(5).trim();
                  if (!text || text === "[DONE]") continue;
                  let message;
                  try {
                    message = JSON.parse(text);
                  } catch {
                    continue;
                  }
                  if (message?.id !== payload.id || (message.result === undefined && !message.error)) {
                    continue;
                  }
                  response.destroy();
                  if (message.error) {
                    const text = String(message.error.message || "memory MCP error");
                    if (/session|initiali[sz]e/i.test(text)) {
                      this.reset();
                      finish(reject, sessionError(text));
                    } else {
                      finish(reject, new Error(text));
                    }
                  } else {
                    finish(resolve, message.result ?? null);
                  }
                  return;
                }
              }
            });

            response.on("end", () => {
              finish(reject, new Error("memory MCP 流结束但没有拿到匹配的响应"));
            });
            response.on("error", (error) => finish(reject, error));
            return;
          }

          collect(response)
            .then((text) => {
              if (!text.trim()) {
                finish(resolve, null);
                return;
              }
              let parsed;
              try {
                parsed = JSON.parse(text);
              } catch (error) {
                finish(reject, error);
                return;
              }
              if (parsed?.error) {
                const message = String(parsed.error.message || "memory MCP error");
                if (/session|initiali[sz]e/i.test(message)) {
                  this.reset();
                  finish(reject, sessionError(message));
                } else {
                  finish(reject, new Error(message));
                }
                return;
              }
              finish(resolve, parsed?.result ?? null);
            })
            .catch((error) => finish(reject, error));
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error("timeout"));
      });
      request.on("error", (error) => finish(reject, error));
      request.end(body);
    });
  }

  async search(text, { limit = 16, scope = "all" } = {}) {
    const args = { query: String(text || ""), limit, scope };
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.request("tools/call", {
          name: "memory_search",
          arguments: args,
        });
        const content = Array.isArray(result?.content) ? result.content : [];
        const block = content.find((item) => item?.type === "text");
        return typeof block?.text === "string" ? block.text : "";
      } catch (error) {
        lastError = error;
        if (error?.code === "SESSION") {
          this.reset();
          continue;
        }
        if (attempt === 0) {
          await sleep(350);
          continue;
        }
      }
    }

    throw lastError || new Error("memory_search 失败");
  }
}

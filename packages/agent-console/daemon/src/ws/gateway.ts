// WS gateway: hello authentication, request dispatch, subscriptions, heartbeat, binary terminal frames, broadcast.
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import { checkHost, classifyOrigin, tokenEqual } from "../security.js";
import { log } from "../log.js";
import { setAppLocale } from "../util/i18n.js";

export type MethodHandler = (params: unknown, ctx: ConnCtx) => Promise<unknown> | unknown;
export type ConnCtx = { connId: string; conn: Conn };

type ClientMsg =
  | { t: "hello"; token: string; v?: number; lang?: string }
  | { t: "req"; id: number; m: string; p?: unknown }
  | { t: "ping" };

class Conn {
  id: string;
  ws: WebSocket;
  authed = false;
  subs = new Set<string>();
  alive = true;
  lastMsg = Date.now();
  constructor(ws: WebSocket) {
    this.id = "c_" + randomBytes(4).toString("hex");
    this.ws = ws;
  }
  send(obj: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const s = JSON.stringify(obj);
      if (this.overflow(s.length)) {
        log("warn", `连接 ${this.id} 出站缓冲超 8MB，断开`);
        this.ws.close(4000, "buffer_overflow");
        return;
      }
      this.ws.send(s);
    } catch {}
  }
  // Look at bytes really still unsent in the socket (only grows when the client is stuck), not the cumulative amount sent
  private overflow(next: number): boolean {
    return this.ws.bufferedAmount + next > 8 * 1024 * 1024;
  }
  sendBinary(frame: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.overflow(frame.length)) {
      log("warn", `连接 ${this.id} 出站缓冲超 8MB，断开`);
      this.ws.close(4000, "buffer_overflow");
      return;
    }
    try {
      this.ws.send(frame);
    } catch {}
  }
}

export class Gateway {
  private wss: WebSocketServer;
  private conns = new Map<string, Conn>();
  private methods = new Map<string, MethodHandler>();
  private helloTimers = new Map<string, NodeJS.Timeout>();
  onTerminalInput?: (conn: Conn, index: number, op: number, payload: Buffer) => void;

  constructor(private cfg: Config) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  method(name: string, fn: MethodHandler): void {
    this.methods.set(name, fn);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const hostCheck = checkHost(req.headers.host, this.cfg.port);
    if (!hostCheck.ok) {
      socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (classifyOrigin(req.headers.origin, this.cfg.port) === "foreign") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.cfg.port}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConn(ws));
  }

  private onConn(ws: WebSocket): void {
    const conn = new Conn(ws);
    this.conns.set(conn.id, conn);
    // The first frame must be hello within 5 seconds
    const timer = setTimeout(() => {
      if (!conn.authed) ws.close(4401, "auth_timeout");
    }, 5000);
    this.helloTimers.set(conn.id, timer);

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      conn.lastMsg = Date.now();
      if (isBinary) {
        this.onBinary(conn, data as Buffer);
        return;
      }
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        conn.send({ t: "res", id: 0, ok: false, e: { code: "bad_json", message: "消息不是合法 JSON" } });
        return;
      }
      this.onMessage(conn, msg);
    });
    ws.on("close", () => {
      this.conns.delete(conn.id);
      const t = this.helloTimers.get(conn.id);
      if (t) clearTimeout(t);
      this.helloTimers.delete(conn.id);
    });
    ws.on("error", () => {});
  }

  private onMessage(conn: Conn, msg: ClientMsg): void {
    if (msg.t === "hello") {
      if (!conn.authed) {
        if (typeof msg.token === "string" && tokenEqual(msg.token, this.cfg.token)) {
          conn.authed = true;
          setAppLocale(msg.lang);
          const t = this.helloTimers.get(conn.id);
          if (t) clearTimeout(t);
          conn.send({ t: "hello.ok", version: this.cfg.version, serverTime: Date.now() });
        } else {
          conn.send({ t: "res", id: 0, ok: false, e: { code: "bad_token", message: "令牌无效" } });
          conn.ws.close(4401, "bad_token");
        }
      }
      return;
    }
    if (msg.t === "ping") {
      conn.send({ t: "pong" });
      return;
    }
    if (msg.t === "req") {
      if (!conn.authed) {
        conn.send({ t: "res", id: msg.id, ok: false, e: { code: "unauthorized", message: "未鉴权" } });
        return;
      }
      void this.dispatch(conn, msg);
      return;
    }
  }

  private async dispatch(conn: Conn, msg: { t: "req"; id: number; m: string; p?: unknown }): Promise<void> {
    const fn = this.methods.get(msg.m);
    if (!fn) {
      conn.send({ t: "res", id: msg.id, ok: false, e: { code: "not_found", message: `未知方法 ${msg.m}` } });
      return;
    }
    try {
      const r = await fn(msg.p, { connId: conn.id, conn });
      conn.send({ t: "res", id: msg.id, ok: true, r: r ?? null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      conn.send({
        t: "res",
        id: msg.id,
        ok: false,
        e: { code: err.code ?? "internal", message: err.message ?? "服务内部错误" },
      });
    }
  }

  // Terminal binary frame: [op:1][terminalIndex:2 BE][payload]
  private onBinary(conn: Conn, buf: Buffer): void {
    if (buf.length < 3) return;
    const op = buf.readUInt8(0);
    const index = buf.readUInt16BE(1);
    this.onTerminalInput?.(conn, index, op, buf.subarray(3));
  }

  publish(ch: string, data: unknown): void {
    for (const c of this.conns.values()) {
      if (c.authed && c.subs.has(ch)) c.send({ t: "evt", ch, d: data });
    }
  }

  publishTerminal(index: number, payload: Buffer): void {
    const frame = Buffer.concat([Buffer.from([1, (index >> 8) & 0xff, index & 0xff]), payload]);
    for (const c of this.conns.values()) {
      if (c.authed && c.subs.has(`terminal:${index}`)) c.sendBinary(frame);
    }
  }

  subscribe(conn: Conn, ch: string): void {
    conn.subs.add(ch);
  }
  unsubscribe(conn: Conn, ch: string): void {
    conn.subs.delete(ch);
  }

  closeAll(): void {
    for (const c of this.conns.values()) {
      try {
        c.ws.close(1001, "server_shutdown");
      } catch {}
    }
    this.conns.clear();
  }
}

export { Conn };

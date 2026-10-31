// WS client: hello, request/response, subscriptions, auto-reconnect, binary frames.
import { t } from "../i18n/index.js";
export type ConnState = "connecting" | "open" | "reconnecting" | "down";
export type EvtHandler = (ch: string, data: unknown) => void;
export type BinHandler = (op: number, index: number, payload: Uint8Array) => void;

type Pending = { res: (v: unknown) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, { handler: EvtHandler; afterSeq?: () => number | undefined }>();
  private binHandlers: BinHandler[] = [];
  private stateListeners = new Set<(s: ConnState) => void>();
  private state: ConnState = "connecting";
  private retry = 0;
  private closed = false;
  private helloOk: Record<string, unknown> | null = null;
  private helloWaiters: ((v: Record<string, unknown>) => void)[] = [];

  constructor(private token: string, private lang = "zh") {}

  onState(fn: (s: ConnState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }
  getState(): ConnState {
    return this.state;
  }
  private setState(s: ConnState): void {
    this.state = s;
    for (const f of this.stateListeners) f(s);
  }

  connect(): void {
    if (this.closed) return;
    this.setState(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "hello", token: this.token, v: 1, lang: this.lang }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === "hello.ok") {
        this.retry = 0;
        this.helloOk = msg;
        this.setState("open");
        const w = this.helloWaiters.splice(0);
        for (const fn of w) fn(msg);
        // Restore subscriptions after reconnecting
        for (const [ch, s] of this.subs) {
          void this.call("sub.add", { ch, afterSeq: s.afterSeq?.() }).catch(() => {});
        }
        return;
      }
      if (msg.t === "res") {
        const id = msg.id as number;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          if (msg.ok) p.res(msg.r);
          else {
            const e = msg.e as { code?: string; message?: string } | undefined;
            const err = new Error(e?.message ?? t("api.requestFailed"));
            (err as { code?: string }).code = e?.code;
            p.rej(err);
          }
        }
        return;
      }
      if (msg.t === "evt") {
        const sub = this.subs.get(msg.ch as string);
        sub?.handler(msg.ch as string, msg.d);
        return;
      }
    };
    ws.onclose = () => {
      this.ws = null;
      // Reject all pending requests
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.rej(new Error("连接中断"));
        this.pending.delete(id);
      }
      if (this.closed) return;
      this.retry++;
      const delay = Math.min(1000 * Math.pow(2, this.retry - 1), 10000);
      this.setState(this.retry > 20 ? "down" : "reconnecting");
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  waitHello(): Promise<Record<string, unknown>> {
    if (this.helloOk) return Promise.resolve(this.helloOk);
    return new Promise((res) => this.helloWaiters.push(res));
  }

  call(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    return new Promise((res, rej) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        rej(new Error("连接未建立"));
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("请求超时"));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      ws.send(JSON.stringify({ t: "req", id, m: method, p: params ?? {} }));
    });
  }

  subscribe(ch: string, handler: EvtHandler, afterSeq?: () => number | undefined): () => void {
    this.subs.set(ch, { handler, afterSeq });
    if (this.state === "open") {
      void this.call("sub.add", { ch, afterSeq: afterSeq?.() }).catch(() => {});
    }
    return () => {
      this.subs.delete(ch);
      if (this.state === "open") void this.call("sub.remove", { ch }).catch(() => {});
    };
  }

  onBinaryFrame(fn: BinHandler): () => void {
    this.binHandlers.push(fn);
    return () => {
      this.binHandlers = this.binHandlers.filter((f) => f !== fn);
    };
  }
  private onBinary(data: Uint8Array): void {
    if (data.length < 3) return;
    const op = data[0];
    const index = (data[1] << 8) | data[2];
    for (const f of this.binHandlers) f(op, index, data.subarray(3));
  }
  sendBinary(op: number, index: number, payload: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(3 + payload.length);
    frame[0] = op;
    frame[1] = (index >> 8) & 0xff;
    frame[2] = index & 0xff;
    frame.set(payload, 3);
    ws.send(frame);
  }

  ping(): void {
    try {
      this.ws?.send(JSON.stringify({ t: "ping" }));
    } catch {}
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

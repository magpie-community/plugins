// WS gateway tests: hello authentication, app.info, wrong token 4401, subscription push
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createHttpServer } from "../../daemon/src/http.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { SettingsStore } from "../../daemon/src/store/settings.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { registerMethods } from "../../daemon/src/ws/methods.js";
import { GitService } from "../../daemon/src/git/service.js";
import { FileService } from "../../daemon/src/files/service.js";
import { TerminalService } from "../../daemon/src/terminal/service.js";
import type { Config } from "../../daemon/src/config.js";

const TOKEN = "testtoken123";
let dir = "";
let server: Server;
let port = 0;
let gateway: Gateway;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-ws-"));
  const appDir = join(dir, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), "x");
  const cfg: Config = { port: 0, dataDir: dir, token: TOKEN, version: "9.9.9", idleExitMinutes: 60, buildStamp: "0" };
  gateway = new Gateway(cfg);
  const settings = new SettingsStore(dir);
  registerMethods(gateway, { cfg, settings, gateway, projects: new ProjectsStore(dir), threads: new ThreadsStore(dir), git: new GitService(), files: new FileService(), terminals: new TerminalService(gateway) });
  server = createHttpServer(cfg, appDir, new AttachmentStore(join(dir, "attachments")), {
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  cfg.port = port;
});

afterAll(() => {
  gateway.closeAll();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function connect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}

function nextMsg(ws: WebSocket, filter?: (o: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((res) => {
    const on = (d: WebSocket.RawData) => {
      try {
        const o = JSON.parse(String(d));
        if (!filter || filter(o)) {
          ws.off("message", on);
          res(o);
        }
      } catch {}
    };
    ws.on("message", on);
  });
}

describe("ws gateway", () => {
  it("hello with the right token → hello.ok; app.info succeeds", async () => {
    const ws = await connect();
    const hello = nextMsg(ws, (o) => o.t === "hello.ok");
    ws.send(JSON.stringify({ t: "hello", token: TOKEN, v: 1 }));
    const h = await hello;
    expect(h.version).toBe("9.9.9");
    const res = nextMsg(ws, (o) => o.t === "res" && o.id === 1);
    ws.send(JSON.stringify({ t: "req", id: 1, m: "app.info", p: {} }));
    const r = await res;
    expect(r.ok).toBe(true);
    expect((r.r as { port: number }).port).toBe(port);
    ws.close();
  });

  it("wrong token → closed with 4401", async () => {
    const ws = await connect();
    const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
    ws.send(JSON.stringify({ t: "hello", token: "wrong" }));
    expect(await closed).toBe(4401);
  });

  it("unknown method → not_found; bad params → bad_params", async () => {
    const ws = await connect();
    const hello = nextMsg(ws, (o) => o.t === "hello.ok");
    ws.send(JSON.stringify({ t: "hello", token: TOKEN }));
    await hello;
    const r1 = nextMsg(ws, (o) => o.t === "res" && o.id === 10);
    ws.send(JSON.stringify({ t: "req", id: 10, m: "no.such", p: {} }));
    const res1 = await r1;
    expect(res1.ok).toBe(false);
    expect((res1.e as { code: string }).code).toBe("not_found");
    const r2 = nextMsg(ws, (o) => o.t === "res" && o.id === 11);
    ws.send(JSON.stringify({ t: "req", id: 11, m: "sub.add", p: {} }));
    const res2 = await r2;
    expect(res2.ok).toBe(false);
    expect((res2.e as { code: string }).code).toBe("bad_params");
    ws.close();
  });

  it("subscribe → publish is pushed to that connection", async () => {
    const ws = await connect();
    const hello = nextMsg(ws, (o) => o.t === "hello.ok");
    ws.send(JSON.stringify({ t: "hello", token: TOKEN }));
    await hello;
    const sub = nextMsg(ws, (o) => o.t === "res" && o.id === 20);
    ws.send(JSON.stringify({ t: "req", id: 20, m: "sub.add", p: { ch: "sidebar" } }));
    await sub;
    const evt = nextMsg(ws, (o) => o.t === "evt");
    gateway.publish("sidebar", { type: "thread.upsert", id: "t_1" });
    const e = await evt;
    expect(e.ch).toBe("sidebar");
    ws.close();
  });
});

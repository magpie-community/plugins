// frpc kept in sight without one: the state, the log and the stopping are
// read and answered with no frpc running, and nothing is downloaded.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as paths from "../lib/paths.mjs";
import * as sup from "../lib/supervise.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "frp-connect-test-"));

test("with no frpc ever started, the state is not running", () => {
  const dir = tmp();
  const s = sup.state(paths.files(dir));
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.equal(s.logPath, path.join(dir, "frpc.log"));
  assert.equal(sup.tail(s.logPath), "");
});

test("stopping with no frpc running stops nothing", () => {
  const dir = tmp();
  assert.deepEqual(sup.stop(paths.files(dir)), { stopped: false, pid: null });
  assert.equal(fs.existsSync(path.join(dir, "frpc.json")), false);
});

test("a PID that is no longer our frpc is not signalled", () => {
  const dir = tmp();
  const files = paths.files(dir);
  // a live PID — this process — recorded for a config file it never named
  fs.writeFileSync(files.record, JSON.stringify({ pid: process.pid, toml: "/nowhere/frpc.toml", exe: "/nowhere/frpc" }));
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(sup.state(files).running, false, "another program's PID isn't frpc");
    assert.deepEqual(sup.stop(files), { stopped: false, pid: null });
    assert.equal(sup.state(files).pid, null);
  }
  // the process is still here: the check, not the signal, decided
  assert.ok(process.pid > 0);
});

test("a PID that is gone reads as not running", () => {
  const dir = tmp();
  const files = paths.files(dir);
  fs.writeFileSync(files.record, JSON.stringify({ pid: 2 ** 22 + 12345, toml: "/nowhere/frpc.toml" }));
  assert.equal(sup.state(files).running, false);
});

test("the log's end is read back", () => {
  const dir = tmp();
  const files = paths.files(dir);
  fs.writeFileSync(files.log, "one\ntwo\nthree\n");
  assert.equal(sup.tail(files.log), "one\ntwo\nthree\n");
  assert.equal(sup.tail(files.log, 4), "ree\n");
});

test("the state folder is magpie's, never the plugin's or the project's", () => {
  const linux = paths.stateDir({ HOME: "/home/u", XDG_CONFIG_HOME: "" }, "linux");
  assert.equal(linux, "/home/u/.config/magpie/frp-connect");
  const xdg = paths.stateDir({ HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.cfg" }, "linux");
  assert.equal(xdg, "/home/u/.cfg/magpie/frp-connect");
  const mac = paths.stateDir({ HOME: "/Users/u" }, "darwin");
  assert.equal(mac, "/Users/u/Library/Application Support/magpie/frp-connect");
  const win = paths.stateDir({ USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32");
  assert.equal(win, path.join("C:\\Users\\u\\AppData\\Local", "magpie", "frp-connect"));
  assert.equal(paths.stateDir({ HOME: "/home/u", MAGPIE_FRP_DIR: "/tmp/here" }, "linux"), "/tmp/here");
});

test("an older install in the project folder is moved, token and all", () => {
  const dir = tmp();
  const project = path.join(tmp(), "project");
  fs.mkdirSync(path.join(project, "frp-connect"), { recursive: true });
  fs.writeFileSync(path.join(project, "frp-connect", "frpc.toml"), 'auth.token = "s3cret"\n');
  paths.adopt(dir, project);
  assert.equal(fs.readFileSync(path.join(dir, "frpc.toml"), "utf8"), 'auth.token = "s3cret"\n');
  assert.equal(fs.existsSync(path.join(project, "frp-connect", "frpc.toml")), false);
});

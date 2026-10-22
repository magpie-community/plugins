import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("页面按账号合并窗口，保留展开状态，过期留空且只加载自己的汇总脚本", async () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.textContent = ""; }
    set innerHTML(value) { throw new Error("Usage data must be rendered as text"); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    querySelectorAll() { return walk(this).filter(node => node.tag === "details" && node.open); }
  }
  const walk = node => [node, ...node.children.flatMap(walk)];
  const ids = Object.fromEntries(["cards", "updated", "refresh", "errors"].map(id => [id, new Node("div")]));
  const document = { getElementById: id => ids[id], createElement: tag => new Node(tag), head: new Node("head") };
  const forbidden = () => { throw new Error("Page attempted an undeclared read or external connection"); };
  const window = {}, timers = [];
  const code = await readFile(new URL("../page/app.js", import.meta.url), "utf8");
  runInNewContext(code, { document, window, Date, Intl, setInterval: fn => timers.push(fn),
    fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden, EventSource: forbidden,
    navigator: { sendBeacon: forbidden }, magpie: { read: forbidden } }, { timeout: 1000 });
  const firstScript = document.head.children[0];
  assert.match(firstScript.src, /^snapshot\.js\?v=\d+$/);
  firstScript.onload();
  const now = Date.now();
  const row = (title, window, extra = {}) => ({ title, window, state: "estimated", used: 50, readAt: now, end: now + 3600000,
    tokens: 10000, cost: 1, calls: 1, observedTokens: 5000, observedCost: .5, confidence: "参考估算", reason: "记录说明", ...extra });
  const snapshot = { version: 1, generatedAt: now, errors: [], cards: [
    row("本机 Codex · 账号 1", "5 小时", { state: "unavailable", used: null, tokens: null, cost: null, reason: "供应商未上报此窗口" }),
    row("本机 Codex · 账号 1", "周"), row("本机 Claude · 账号 1", "5 小时"), row("本机 Claude · 账号 1", "周"),
    row("Remote magpie 1 · Claude · 账号 1", "5 小时"), row("Remote magpie 1 · Claude · 账号 1", "周"),
  ] };
  window.acceptQuotaSnapshot(snapshot);
  assert.equal(ids.cards.children.length, 3);
  assert.equal(walk(ids.cards).filter(node => node.className === "window").length, 6);
  const details = walk(ids.cards).filter(node => node.tag === "details");
  details[1].open = true;
  window.acceptQuotaSnapshot(snapshot);
  assert.equal(walk(ids.cards).filter(node => node.tag === "details" && node.open).length, 1);
  snapshot.generatedAt = now - 4 * 60000;
  window.acceptQuotaSnapshot(snapshot);
  assert.ok(walk(ids.cards).filter(node => node.className?.startsWith("capacity")).every(node => node.textContent === "—"));
  snapshot.cards[0].reason = '<img src="https://unrelated.example/collect" onerror="alert(1)">';
  window.acceptQuotaSnapshot(snapshot);
  assert.ok(!walk(ids.cards).some(node => node.tag === "img"));
  assert.ok(walk(ids.cards).some(node => node.textContent === snapshot.cards[0].reason));
  ids.refresh.listeners.click();
  assert.match(document.head.children[0].src, /^snapshot\.js\?v=\d+$/);
  assert.equal(timers.length, 1);
  snapshot.cards = [];
  window.acceptQuotaSnapshot(snapshot);
  assert.equal(ids.cards.children[0].textContent, "尚无可读取的账号");
  assert.equal(ids.cards.attributes["aria-busy"], "false");
});

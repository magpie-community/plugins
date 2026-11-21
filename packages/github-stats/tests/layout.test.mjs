import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../dist/config.js";
import { renderCard } from "../dist/renderer.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("a stalled bridge still opens the desktop service and binds retry immediately", async () => {
  const boot = await readFile(
    new URL("../page/boot.js", import.meta.url),
    "utf8",
  );
  const retry = {},
    status = {},
    targets = [];
  let timeout;
  vm.runInNewContext(boot, {
    URL,
    window: { magpie: { ready: new Promise(() => {}) } },
    location: {
      href: "http://localhost/plugin/",
      replace: (url) => targets.push(url),
    },
    document: { getElementById: (id) => (id === "retry" ? retry : status) },
    setTimeout: (fn) => {
      timeout = fn;
    },
    clearTimeout: () => {},
  });
  assert.equal(typeof retry.onclick, "function");
  timeout();
  assert.deepEqual(targets, ["http://127.0.0.1:3498/"]);
});

test("ordered enabled sections share the first row only at supported widths", () => {
  const config = validateConfig({
    blockOrder: ["models", "heatmap", "trend"],
    pairBlocks: true,
    showHeatmap: false,
  });
  const stats = {
    since: "2026-11-18",
    days: [],
    models: [],
    tokens: 0,
    requests: 0,
    activeDays: 0,
  };
  const card = (width) =>
    renderCard(stats, { ...config, width }, "dark", "2026-11-18");
  assert.match(
    card(520),
    /TOP MODELS[\s\S]+translate\(260 0\)[\s\S]+TOKEN ACTIVITY/,
  );
  assert.doesNotMatch(card(320), /translate\(|DAILY CALLS/);
  assert.throws(() =>
    validateConfig({ blockOrder: ["models", "models", "trend"] }),
  );
});

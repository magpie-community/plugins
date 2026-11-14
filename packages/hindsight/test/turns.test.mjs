import test from "node:test";
import assert from "node:assert/strict";
import { createConversationStore, injected, replay, turnKey } from "../lib/turns.mjs";
import { OPEN } from "../lib/protocol.mjs";

// One resent conversation. Each request rebuilds these from the client's own
// history, which never carries our blocks, so keys are derived from the clean
// text exactly like the real flow.
const history = entries => entries.map(([index, role, text]) => ({
  index, role, text, appended: "",
  append(value) { this.appended += value; }
}));

const conversation = () => ({ turns: new Map(), at: 0 });

const seed = (conv, turn, block) => conv.turns.set(turnKey(turn), { text: block, bytes: block.length });

test("under the cap every cached block is replayed on its own turn", () => {
  const conv = conversation();
  const all = history([[0, "user", "first"], [1, "assistant", "reply"], [2, "user", "second"]]);
  seed(conv, all[0], "BLOCK-A");
  seed(conv, all[2], "BLOCK-B");

  replay(all, conv, 8);
  assert.equal(all[0].appended, "BLOCK-A");
  assert.equal(all[1].appended, "", "assistant turns never carry a block");
  assert.equal(all[2].appended, "BLOCK-B");
  assert.equal(conv.turns.size, 2);
});

test("crossing the cap drops the whole older tail in one batch, keeping the newest block", () => {
  const conv = conversation();
  const all = history([[0, "user", "a"], [2, "user", "b"], [4, "user", "c"]]);
  seed(conv, all[0], "BLOCK-A");
  seed(conv, all[1], "BLOCK-B");
  seed(conv, all[2], "BLOCK-C");

  replay(all, conv, 2);
  assert.equal(all[0].appended, "", "dropped turns keep no block");
  assert.equal(all[1].appended, "");
  assert.equal(all[2].appended, "BLOCK-C");
  assert.equal(conv.turns.size, 1, "dropped blocks are evicted from the cache too");
});

test("after a batch drop the following turns stay stable until the cap is crossed again", () => {
  const conv = conversation();
  const first = history([[0, "user", "a"], [2, "user", "b"], [4, "user", "c"]]);
  seed(conv, first[0], "BLOCK-A");
  seed(conv, first[1], "BLOCK-B");
  seed(conv, first[2], "BLOCK-C");
  replay(first, conv, 2);

  // Next request: the same conversation plus one new turn that just recalled.
  const next = history([[0, "user", "a"], [2, "user", "b"], [4, "user", "c"], [6, "user", "d"]]);
  seed(conv, next[3], "BLOCK-D");
  replay(next, conv, 2);
  assert.equal(next[3].appended, "BLOCK-D");
  assert.equal(next[2].appended, "BLOCK-C", "the previous block is untouched: prefix unchanged");
  assert.equal(conv.turns.size, 2, "no second drop on the very next request");
});

test("maxBlocks of zero means unlimited", () => {
  const conv = conversation();
  const all = history([[0, "user", "a"], [2, "user", "b"], [4, "user", "c"]]);
  all.forEach((turn, i) => seed(conv, turn, `BLOCK-${i}`));
  replay(all, conv, 0);
  assert.deepEqual(all.map(t => t.appended), ["BLOCK-0", "BLOCK-1", "BLOCK-2"]);
});

test("a turn that already carries a block is never wrapped twice", () => {
  const conv = conversation();
  const all = history([[0, "user", `${OPEN}\nold\n</hindsight-memories>`]]);
  seed(conv, all[0], "BLOCK-A");
  assert.equal(injected(all[0]), true);
  replay(all, conv, 8);
  assert.equal(all[0].appended, "");
});

test("conversation eviction is least-recently-used, not insertion order", () => {
  const store = createConversationStore();
  const config = { hindsight_api: "http://127.0.0.1:8888", bank: "hermes" };
  const ctx = session => ({ origin: "local", protocol: "chat", session, cwd: "/work" });

  const hotContext = ctx("hot");
  const hot = store(hotContext, config);
  const cold = store(ctx("cold-0"), config);

  for (let i = 1; i < 80; i++) {
    store(hotContext, config); // keep touching the long-running session
    store(ctx(`cold-${i}`), config);
  }

  assert.equal(store(hotContext, config), hot, "a session in active use is never evicted");
  assert.notEqual(store(ctx("cold-0"), config), cold, "an idle session is evicted and rebuilt");
});

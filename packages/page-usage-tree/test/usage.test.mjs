import test from "node:test";
import assert from "node:assert/strict";
import { accountKey, aggregateGatewayUsage, PERIODS } from "../lib/usage.mjs";
import { cacheUsable } from "../lib/data.mjs";

const usage = {
  period: "today",
  calls: 5,
  errors: 1,
  input: 1000,
  output: 100,
  cache_read: 500,
  cache_write: 0,
  reasoning: 10,
  cost: 0.5,
  unpriced: 2,
  accounts: [
    {
      id: "codex@alice",
      provider: "codex",
      account: "alice@example.com",
      name: "10月学生Plus",
      sub: "Codex",
      calls: 3,
      errors: 1,
      input: 800,
      output: 50,
      cache_read: 500,
      cost: 0.5,
      unpriced: 0,
    },
    {
      id: "codex@bob",
      provider: "codex",
      account: "bob@example.com",
      name: "bob@example.com",
      sub: "Codex",
      last_at: "2026-11-04T12:00:00.000Z",
      calls: 2,
      errors: 0,
      input: 200,
      output: 50,
      cost: 0,
      unpriced: 2,
    },
  ],
};

const requests = {
  [accountKey("codex", "alice@example.com")]: {
    by: {
      modelAt: [
        {
          id: "codex/gpt-a",
          calls: 3,
          errors: 1,
          input: 800,
          output: 50,
          cache_read: 500,
          cost: 0.5,
          unpriced: 0,
        },
      ],
    },
  },
  [accountKey("codex", "bob@example.com")]: {
    by: {
      modelAt: [
        {
          id: "codex/gpt-b",
          calls: 2,
          errors: 0,
          input: 200,
          output: 50,
          cost: 0,
          unpriced: 2,
        },
      ],
    },
  },
};

test("builds provider, account and model from the gateway's own totals", () => {
  const data = aggregateGatewayUsage(usage, requests, { period: "today" });

  assert.deepEqual([...PERIODS].sort(), ["30d", "7d", "all", "today"]);
  assert.equal(data.summary.calls, 5);
  assert.equal(data.summary.errors, 1);
  assert.equal(data.summary.tokens, 1100);
  assert.equal(data.summary.cache, 500);
  assert.equal(data.summary.cost, 0.5);
  assert.equal(data.summary.unpriced, 2);
  assert.equal(data.summary.accounts, 2);
  assert.equal(data.summary.providers, 1);
  assert.equal(data.summary.models, 2);

  assert.equal(data.providers.length, 1);
  assert.equal(data.providers[0].providerName, "Codex");
  assert.equal(data.providers[0].accounts.length, 2);
  const alice = data.accounts.find((account) => account.account === "alice@example.com");
  assert.equal(alice.alias, "10月学生Plus");
  assert.equal(alice.calls, 3);
  assert.equal(alice.models.length, 1);
  assert.equal(alice.models[0].model, "gpt-a");
  assert.equal(alice.models[0].errors, 1);
  const bob = data.accounts.find((account) => account.account === "bob@example.com");
  assert.equal(bob.lastAt, "2026-11-04T12:00:00.000Z");
});

test("API-key calls are a marked group, never an account", () => {
  const keyed = {
    ...usage,
    accounts: [
      ...usage.accounts,
      {
        id: "anthropic@API key",
        provider: "anthropic",
        account: "API key",
        access: "key",
        sub: "Anthropic",
        calls: 1,
        errors: 0,
        input: 10,
        output: 1,
      },
    ],
  };
  const data = aggregateGatewayUsage(keyed, requests, { period: "today" });

  assert.equal(data.summary.accounts, 2);
  assert.equal(data.summary.apiKeyGroups, 1);
  const group = data.accounts.find((account) => account.kind === "api-key");
  assert.ok(group);
  assert.equal(group.account, "API key");
});

test("one account's model rows merge even when the gateway splits them by host", () => {
  const split = {
    period: "today",
    calls: 3,
    errors: 1,
    input: 30,
    output: 6,
    cache_read: 12,
    cache_write: 3,
    cost: 0.3,
    unpriced: 0,
    accounts: [
      {
        provider: "codex",
        account: "alice@example.com",
        name: "Alice",
        calls: 3,
        errors: 1,
        input: 30,
        output: 6,
        cache_read: 12,
        cache_write: 3,
        cost: 0.3,
        unpriced: 0,
      },
    ],
    models: [
      {
        provider: "codex",
        model: "gpt-6",
        host: "alice@example.com",
        calls: 2,
        errors: 1,
        input: 20,
        output: 4,
        cache_read: 8,
        cache_write: 2,
        cost: 0.2,
        last_at: "2026-11-04T10:00:00.000Z",
      },
      {
        provider: "codex",
        model: "gpt-6",
        host: "Alice",
        calls: 1,
        errors: 0,
        input: 10,
        output: 2,
        cache_read: 4,
        cache_write: 1,
        cost: 0.1,
        last_at: "2026-11-04T12:00:00.000Z",
      },
    ],
  };

  const data = aggregateGatewayUsage(split, {}, { period: "today" });
  const account = data.accounts[0];
  assert.equal(data.summary.models, 1);
  assert.equal(account.models.length, 1);
  assert.equal(account.models[0].model, "gpt-6");
  assert.equal(account.models[0].id, "codex\u001falice@example.com\u001fcodex\u001fgpt-6");
  assert.equal(account.models[0].calls, 3);
  assert.equal(account.models[0].errors, 1);
  assert.equal(account.models[0].tokens, 36);
  assert.equal(account.models[0].cache, 15);
  assert.equal(Number(account.models[0].cost.toFixed(6)), 0.3);
  assert.equal(account.models[0].lastAt, "2026-11-04T12:00:00.000Z");
  assert.deepEqual(account.models[0].hostNotes, [
    { account: "alice@example.com", calls: 2 },
    { account: "Alice", calls: 1 },
  ]);
});

test("an empty gateway answer is an empty tree with a note", () => {
  const data = aggregateGatewayUsage({ calls: 0, accounts: [] }, {}, { period: "7d" });
  assert.deepEqual(data.providers, []);
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(data.warnings, [{ code: "no-usage" }]);
});

test("a read from before the three-level shape is not served as current", () => {
  assert.equal(cacheUsable({ summary: {}, accounts: [{ id: "a" }] }), false);
  assert.equal(cacheUsable({ summary: {}, providers: [], accounts: [] }), true);
  assert.equal(cacheUsable(null), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { aggregateGatewayUsage } from "../lib/usage.mjs";
import { gatewayCandidates } from "../lib/gateway.mjs";

const execFileAsync = promisify(execFile);

function magpieBinary() {
  for (const key of ["MAGPIE_BIN", "MAGPIE_BINARY", "MAGPIE_EXE"]) {
    if (process.env[key] && existsSync(process.env[key])) return process.env[key];
  }
  const names = process.platform === "win32"
    ? ["magpie", "magpie.exe", "magpie.com", "magpie.cmd"]
    : ["magpie"];
  for (const directory of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

async function usageSnapshot(gateway) {
  const res = await fetch(`${gateway}/v1/magpie/usage?period=7d`);
  assert.equal(res.status, 200);
  return res.json();
}

function compactNumber(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return NaN;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1;
  return Number(match[1]) * scale;
}

function parseCLIUsage(stdout) {
  const lines = stdout.split(/\r?\n/);
  const summaryLine = lines.find((line) => /\btokens last\b/.test(line) && /\bcalls?\b/.test(line));
  const detailLine = lines.find((line) => /^\s{2}in\s+\S+\s+out\s+\S+/.test(line));
  assert.ok(summaryLine, "the CLI printed its usage summary");
  assert.ok(detailLine, "the CLI printed its token and error details");

  const calls = Number(summaryLine.match(/·\s*(\d+)\s+calls?\b/)?.[1]);
  const cost = Number(summaryLine.match(/≈\$([0-9]+(?:\.[0-9]+)?)/)?.[1]);
  const input = compactNumber(detailLine.match(/^\s{2}in\s+(\S+)/)?.[1]);
  const output = compactNumber(detailLine.match(/\sout\s+(\S+)/)?.[1]);
  const errors = Number(detailLine.match(/·\s*(\d+)\s+errors?\b/)?.[1]);
  assert.ok(Number.isFinite(calls), "the CLI printed a call count");
  assert.ok(Number.isFinite(errors), "the CLI printed an error count");
  assert.ok(Number.isFinite(input) && Number.isFinite(output), "the CLI printed input and output");
  assert.ok(Number.isFinite(cost), "the CLI printed an estimated cost");
  return { calls, errors, tokens: input + output, cost };
}

function modelCallTotals(snapshot) {
  const totals = new Map();
  for (const item of snapshot.models || []) {
    const provider = String(item?.provider || "");
    const model = String(item?.model || "");
    if (!provider || !model) continue;
    const key = `${provider}/${model}`;
    totals.set(key, (totals.get(key) || 0) + (Number(item.calls) || 0));
  }
  return totals;
}

function aggregateModelCallTotals(tree) {
  const totals = new Map();
  for (const account of tree.accounts) {
    for (const model of account.models) {
      const key = `${model.provider}/${model.model}`;
      totals.set(key, (totals.get(key) || 0) + model.calls);
    }
  }
  return totals;
}

function parseCLIModelCalls(stdout) {
  const totals = new Map();
  let section = "";
  for (const line of stdout.split(/\r?\n/)) {
    const heading = line.match(/^\s{2}([a-z][a-z ]*)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (section !== "models") continue;
    const row = line.match(
      /^\s{2}([a-z0-9_.-]+)\/([^\s]+)\s+(?:@\s+.*?\s+)?\d+%\s+\S+\s+(\d+)\s+calls?\b/,
    );
    if (!row) continue;
    const key = `${row[1]}/${row[2]}`;
    totals.set(key, (totals.get(key) || 0) + Number(row[3]));
  }
  return totals;
}

function assertBetween(name, value, before, after) {
  const low = Math.min(before, after);
  const high = Math.max(before, after);
  assert.ok(
    value >= low && value <= high,
    `${name}: ${value} is outside the gateway's concurrent-read range ${low}..${high}`,
  );
}

function assertDisplayedNearRange(name, displayed, before, after, relative = 0.015) {
  const low = Math.min(before, after);
  const high = Math.max(before, after);
  const tolerance = Math.max(1, Math.max(Math.abs(low), Math.abs(high)) * relative);
  assert.ok(
    displayed >= low - tolerance && displayed <= high + tolerance,
    `${name}: CLI display ${displayed} is outside the gateway's ${low}..${high} range`,
  );
}

function gatewayReachable(gateway) {
  return new Promise((resolve) => {
    let client;
    try {
      client = new URL(gateway).protocol === "https:" ? https : http;
    } catch {
      resolve(false);
      return;
    }
    const req = client.get(
      `${gateway}/v1/magpie/usage?period=today`,
      { agent: false, headers: { connection: "close" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        res.on("error", () => resolve(false));
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// The gateway's account rows must be the rows `magpie usage 7d` prints,
// except API-key calls: magpie's Accounts table leaves those out by design.
test("matches magpie's own usage tables", async (t) => {
  const binary = magpieBinary();
  const gateway = gatewayCandidates()[0];
  if (!binary) {
    t.skip("magpie CLI is not available");
    return;
  }
  if (!(await gatewayReachable(gateway))) {
    t.skip("magpie gateway is not available");
    return;
  }

  // The ledger can receive a call while the CLI runs. Take a snapshot on
  // either side of the CLI read: a call made during the test must be in the
  // inclusive range, while a real accounting difference still fails.
  const before = await usageSnapshot(gateway);

  const { stdout } = await execFileAsync(binary, ["usage", "7d"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const after = await usageSnapshot(gateway);
  const mine = aggregateGatewayUsage(after, {}, { period: "7d" });
  const cli = parseCLIUsage(stdout);

  // The gateway answer on the page must agree with Magpie's own top-level
  // table, not just the Accounts table below it.
  assertBetween("summary.calls", mine.summary.calls, before.calls, after.calls);
  assertBetween("summary.errors", mine.summary.errors, before.errors, after.errors);
  assertBetween("summary.tokens", mine.summary.tokens, before.input + before.output, after.input + after.output);
  assertBetween("summary.cost", mine.summary.cost, before.cost, after.cost);
  assertBetween("CLI calls", cli.calls, before.calls, after.calls);
  assertBetween("CLI errors", cli.errors, before.errors, after.errors);
  assertDisplayedNearRange(
    "CLI tokens",
    cli.tokens,
    before.input + before.output,
    after.input + after.output,
  );
  assertDisplayedNearRange("CLI cost", cli.cost, before.cost, after.cost);

  const cliModels = parseCLIModelCalls(stdout);
  const beforeModels = modelCallTotals(before);
  const afterModels = modelCallTotals(after);
  const mineModels = aggregateModelCallTotals(mine);
  assert.ok(cliModels.size > 0, "the CLI printed a models table");
  for (const [key, calls] of cliModels) {
    assertBetween(
      `CLI model ${key}`,
      calls,
      beforeModels.get(key) || 0,
      afterModels.get(key) || 0,
    );
    assertBetween(
      `aggregated model ${key}`,
      mineModels.get(key) || 0,
      beforeModels.get(key) || 0,
      afterModels.get(key) || 0,
    );
  }

  const cliAccounts = new Map();
  let section = "";
  for (const line of stdout.split(/\r?\n/)) {
    const heading = line.match(/^\s{2}([a-z][a-z ]*)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (section !== "accounts") continue;
    const row = line.match(/^\s{2}(\S+)\s+\/\s+(.*?)\s{2,}(\d+)%\s+(\S+)\s+(\d+)\s+calls?/);
    if (row) cliAccounts.set(`${row[1]}@${row[2].trim()}`, Number(row[5]));
  }

  // The CLI prints each account's display name, while the gateway keeps
  // both that name and the sign-in id. Compare display names, and leave out
  // API-key-only providers: depending on the magpie version, its accounts
  // table either hides them or labels them differently.
  const apiKeyProviders = new Set();
  const regularProviders = new Set();
  for (const account of [...(before.accounts || []), ...(after.accounts || [])]) {
    if (
      account.account === "API key" ||
      account.access === "key" ||
      account.access === "api-key"
    ) {
      apiKeyProviders.add(account.provider);
    }
    else regularProviders.add(account.provider);
  }
  const ignoredProviders = new Set(
    [...apiKeyProviders].filter((provider) => !regularProviders.has(provider)),
  );

  const gatewayAccounts = new Map();
  for (const [snapshot, label] of [[before, "before"], [after, "after"]]) {
    for (const account of snapshot.accounts || []) {
      if (account.account === "API key" || account.access === "key") continue;
      const key = `${account.provider}@${account.name || account.account}`;
      const row = gatewayAccounts.get(key) || { before: Infinity, after: -Infinity };
      const calls = Number(account.calls) || 0;
      if (label === "before") row.before = Math.min(row.before, calls);
      else row.after = Math.max(row.after, calls);
      gatewayAccounts.set(key, row);
    }
  }

  const cliRegularAccounts = new Map(
    [...cliAccounts].filter(([key]) => !ignoredProviders.has(key.split("@")[0])),
  );
  assert.ok(cliRegularAccounts.size > 0, "the CLI printed an accounts table");
  assert.ok(gatewayAccounts.size > 0, "the gateway answered with account rows");
  assert.deepEqual([...gatewayAccounts.keys()].sort(), [...cliRegularAccounts.keys()].sort());
  for (const [key, calls] of cliRegularAccounts) {
    const range = gatewayAccounts.get(key);
    assert.ok(range, `the gateway has ${key}`);
    assert.ok(
      calls >= range.before && calls <= range.after,
      `${key}: CLI ${calls} is outside the gateway's concurrent-read range ${range.before}..${range.after}`,
    );
  }

  // The aggregation's account rows use the same calls the gateway reports.
  for (const account of mine.accounts) {
    if (account.kind === "api-key") continue;
    const range = gatewayAccounts.get(`${account.provider}@${account.alias || account.account}`);
    assert.ok(range, `the aggregation has ${account.provider}/${account.account}`);
    assert.ok(account.calls >= range.before && account.calls <= range.after);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aggregateUsageCSV } from "../lib/usage.mjs";
import { accountNames, findMagpieBinary } from "../lib/data.mjs";

const execFileAsync = promisify(execFile);

// The plugin's numbers must be magpie's numbers: the same account rows and
// the same model rows as `magpie usage 7d` prints.
test("matches magpie's own usage tables", async (t) => {
  const binary = findMagpieBinary();
  if (!binary) {
    t.skip("magpie is not on PATH");
    return;
  }

  const [text, csv] = await Promise.all([
    execFileAsync(binary, ["usage", "7d"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync(binary, ["usage", "--csv", "7d"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  ]);

  const mine = aggregateUsageCSV(csv.stdout, { period: "7d", accountNames: accountNames() });

  const cliModels = new Map();
  const cliAccounts = new Map();
  let section = "";
  for (const line of text.stdout.split(/\r?\n/)) {
    const heading = line.match(/^\s{2}([a-z][a-z ]*)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (section === "models") {
      const row = line.match(/^\s{2}(\S+?)(?:\s+@\s+(.*?))?\s{2,}(\d+)\%\s+(\S+)\s+(\d+)\s+calls?/);
      if (row) {
        const key = row[2] ? `${row[1]} @ ${row[2].trim()}` : row[1];
        cliModels.set(key, (cliModels.get(key) || 0) + Number(row[5]));
      }
    } else if (section === "accounts") {
      const row = line.match(/^\s{2}(\S+)\s+\/\s+(.*?)\s{2,}(\d+)\%\s+(\S+)\s+(\d+)\s+calls?/);
      if (row) {
        const key = `${row[1]}@${row[2].trim()}`;
        cliAccounts.set(key, (cliAccounts.get(key) || 0) + Number(row[5]));
      }
    }
  }

  assert.ok(cliAccounts.size > 0, "the CLI printed an accounts table");
  assert.ok(cliModels.size > 0, "the CLI printed a models table");

  // Accounts: same calls per provider and account.
  const mineAccounts = new Map();
  for (const account of mine.accounts) {
    mineAccounts.set(`${account.provider}@${account.account}`, account.calls);
  }
  const cliAccountCounts = [...cliAccounts.values()].sort((a, b) => b - a);
  const mineAccountCounts = [...mineAccounts.values()].sort((a, b) => b - a);
  assert.deepEqual(mineAccountCounts, cliAccountCounts);

  // Models: the same provider and model, summed over their accounts.
  const mineModels = new Map();
  for (const account of mine.accounts) {
    for (const model of account.models) {
      const key = `${model.provider}/${model.model}`;
      mineModels.set(key, (mineModels.get(key) || 0) + model.calls);
    }
  }
  const cliModelTotals = new Map();
  for (const [key, calls] of cliModels) {
    const base = key.split(" @ ")[0];
    cliModelTotals.set(base, (cliModelTotals.get(base) || 0) + calls);
  }
  for (const [key, calls] of cliModelTotals) {
    assert.equal(mineModels.get(key), calls, `${key} calls differ`);
  }
});

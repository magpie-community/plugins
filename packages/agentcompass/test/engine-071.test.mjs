/**
 * Rules of the AgentCompass v0.7.1 engine the port carries, each tested as the rule it states (never a winner, a share or a score
 * copied from output): the effort order with `none`, `minimal` and `ultra`; an effort name off the scale read where the data
 * declares; no inversion along effort; a manual score filled to every effort the panel steps to; the operating-point floor under a
 * maintainer score; a derived facet following a score on its larger row; the operator's schema-3 `userScores` carried to the rows
 * v0.7.0 meant; a family name with no scores of its own; the `/v1/models` converter; and a `default` row, the one configuration
 * of a model listed with no levels.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rankCandidates } from "../src/allocator.js";
import { readingEffort, scoredModels } from "../src/axis-scores.js";
import { FAMILIES, MODELS, MODEL_ALIASES, PROVIDER_NAMES, canonicalModel, catalogNameWarning, healthKey, modelLeaf, resolveModel, rowKey, servedModel } from "../src/catalog.js";
import { durationAt } from "../src/quota-economy.js";
import { FIVE_AXIS_EFFORT_READINGS, FIVE_AXIS_EFFORT_STEPS, FIVE_AXIS_MODELS } from "../src/reference-data.js";
import { V0_7_0, v070Row } from "../src/released-names.js";
import { EFFORTS, SCHEMA_VERSION, anchorEffort, boundAlongEffort, resolveModelKey, risesWithEffort, scoreLayer, upgradeScores } from "../src/user-scores.js";
import { ONE_CONFIGURATION, candidatesFromModels, levelsOf } from "../scripts/candidates-from-models.mjs";
import { onProvider as middlewareOnProvider, onRequest as middlewareOnRequest } from "../src/middleware.js";
import { EFFORT_TO_JEV_SCORE, JEV_EFFORT_LEVELS, buildEffortAnswer } from "../src/index.js";
import { profile } from "./profile.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = profile();
const FIVE_AXIS_MODELS_TABLE = scoredModels();
const facetsOf = (info) => Object.entries(info.five_axis.categories).flatMap(([c, cell]) => Object.entries(cell.facets || {}).map(([f, fc]) => [c, f, fc]));
const ordered = (by, rises) => {
  const values = EFFORTS.filter((e) => e in by).map((e) => (rises ? 1 : -1) * by[e]);
  return values.every((v, i) => i === 0 || v >= values[i - 1] - 1e-12);
};

test("the effort order is user_scores.EFFORTS: none and minimal below low, ultra above max", () => {
  assert.deepEqual(EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(SCHEMA_VERSION, 4);
});

test("an effort off the scale reads the effort the data declares; one on the scale reads itself; no effort reads the default", () => {
  const state = { effort_readings: FIVE_AXIS_EFFORT_READINGS };
  for (const [name, reads] of Object.entries(FIVE_AXIS_EFFORT_READINGS)) assert.equal(readingEffort(state, name), reads);
  for (const e of EFFORTS) assert.equal(readingEffort(state, e), e);
  assert.equal(readingEffort(state, null), FIVE_AXIS_EFFORT_READINGS.default);
  // The time a task takes follows the same reading
  const [model, info] = Object.entries(scoredModels()).find(([, i]) => Object.keys(i.five_axis.duration.by_effort || {}).length > 0);
  assert.deepEqual(durationAt(info, null), durationAt(info, FIVE_AXIS_EFFORT_READINGS.default), model);
});

test("no curve inverts along effort: bounding keeps the pinned values and leaves an ordered curve as it is", () => {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 4 - 2;
  for (let n = 0; n < 200; n++) {
    const by = Object.fromEntries(EFFORTS.filter(() => next() > -1.2).map((e) => [e, Math.round(next() * 1e4) / 1e4]));
    if (Object.keys(by).length === 0) continue;
    for (const rises of [true, false]) {
      const out = boundAlongEffort(by, rises);
      assert.ok(ordered(out, rises), JSON.stringify({ by, rises, out }));
      const anchor = anchorEffort(Object.keys(by));
      assert.equal(out[anchor], by[anchor], "the anchor is pinned");
      assert.deepEqual(boundAlongEffort(out, rises), out, "an ordered curve is unchanged");
    }
  }
  assert.throws(() => boundAlongEffort({ low: 1, high: 0 }, true, ["low", "high"]), /themselves inverted/);
});

test("every shipped facet, after the maintainer scores, is ordered along effort in its direction", () => {
  for (const [model, info] of Object.entries(scoredModels())) {
    for (const [c, f, cell] of facetsOf(info)) assert.ok(ordered(cell.by_effort || {}, risesWithEffort(c, f)), `${model} ${c}.${f}`);
  }
});

test("a manual score fills every effort the panel steps to from High, and the edges from their anchors", () => {
  const [model] = Object.entries(FIVE_AXIS_MODELS).find(([, r]) => r.categories.coding && r.categories.coding.facets);
  const scored = scoredModels({ userScores: { schema_version: 4, scores: { [model]: { "coding.execution": { level: 2.4, as_of: "2026-11-19" } } } } })[model];
  const cell = scored.five_axis.categories.coding.facets.execution;
  const steps = FIVE_AXIS_EFFORT_STEPS["coding.execution"];
  const reachable = new Set(["high", ...Object.keys(steps.high), ...Object.keys(FIVE_AXIS_MODELS[model].categories.coding.facets.execution.by_effort)]);
  if (reachable.has("low") && steps.low && steps.low.minimal) reachable.add("minimal");
  if (reachable.has("max") && steps.max && steps.max.ultra) reachable.add("ultra");
  if (steps.lowest_reasoning && steps.lowest_reasoning.none) reachable.add("none");
  for (const e of reachable) assert.ok(typeof cell.by_effort[e] === "number", `${model} coding.execution at ${e}`);
  assert.ok(ordered(cell.by_effort, true));
  assert.equal(cell.status, "user");
});

test("a maintainer score on a row declared as another row at an operating point never reads below that point", () => {
  const shipped = scoredModels();
  let checked = 0;
  for (const [model, row] of Object.entries(FIVE_AXIS_MODELS)) {
    for (const [c, cell] of Object.entries(row.categories)) {
      for (const [f, own] of Object.entries(cell.facets || {})) {
        const est = own.estimate || {};
        if (est.method !== "same_model" || !est.at_effort || (c === "tool_operation" && f === "responsiveness")) continue;
        const after = shipped[model].five_axis.categories[c].facets[f];
        if (after.status !== "maintainer") continue;
        checked += 1;
        for (const [e, v] of Object.entries(after.by_effort)) {
          if (e in own.by_effort) assert.ok(v >= own.by_effort[e] - 1e-12, `${model} ${c}.${f} at ${e}`);
          assert.equal(v, Math.max(after.operating_point_floor.score_by_effort[e], own.by_effort[e] ?? -Infinity), `${model} ${c}.${f} at ${e}: max(score, point)`);
        }
        // A local user's score on the same facet is the user's: not floored
        const low = scoredModels({ userScores: { schema_version: 4, scores: { [model]: { [`${c}.${f}`]: { level: 0.5, as_of: "2026-11-19" } } } } });
        const mine = low[model].five_axis.categories[c].facets[f];
        assert.equal(mine.operating_point_floor, undefined);
        assert.ok(Object.entries(mine.by_effort).some(([e, v]) => e in own.by_effort && v < own.by_effort[e]), `${model} ${c}.${f}: a low user score reads low`);
      }
    }
  }
  assert.ok(checked > 0, "the shipped data has a row at a declared operating point under a maintainer score");
});

test("a facet derived from a larger row moves by the change a score makes on that row, bounded along effort", () => {
  const derived = [];
  for (const [model, row] of Object.entries(FIVE_AXIS_MODELS)) {
    for (const [c, cell] of Object.entries(row.categories)) {
      for (const [f, own] of Object.entries(cell.facets || {})) {
        const est = own.estimate || {};
        if (["tier_down", "size_step"].includes(est.method) && est.base_model in FIVE_AXIS_MODELS) derived.push([model, c, f, est.base_model]);
      }
    }
  }
  assert.ok(derived.length > 0, "the shipped data has a facet derived from a larger row");
  const [model, c, f, base] = derived[0];
  const before = scoredModels();
  const after = scoredModels({ userScores: { schema_version: 4, scores: { [base]: { [`${c}.${f}`]: { level: 2.7, as_of: "2026-11-19" } } } } });
  const was = before[base].five_axis.categories[c].facets[f].by_effort;
  const now = after[base].five_axis.categories[c].facets[f].by_effort;
  const cell = after[model].five_axis.categories[c].facets[f];
  const moved = {};
  for (const [e, v] of Object.entries(before[model].five_axis.categories[c].facets[f].by_effort)) if (e in now && e in was) moved[e] = v + now[e] - was[e];
  const expected = Object.fromEntries(Object.entries(boundAlongEffort(moved, risesWithEffort(c, f))).map(([e, v]) => [e, Math.round(v * 1e4) / 1e4]));
  for (const e of Object.keys(expected)) assert.ok(Math.abs(cell.by_effort[e] - expected[e]) < 1e-9, `${model} ${c}.${f} at ${e}`);
  assert.equal(cell.follows.base_model, base);
});

test("the operator's schema-3 userScores move to the rows v0.7.0 meant; a name with no row stays in the table and makes no row", () => {
  const upgraded = upgradeScores({
    schema_version: 3,
    scores: {
      "gemini-4-pro": { creativity: { level: 2.5, as_of: "2026-11-04" } },
      "anthropic/claude-opus-5": { "coding.execution": { level: 3.1, as_of: "2026-11-05" } },
      "no-such-model-xyz": { coding: { level: 3, as_of: "2026-11-05" } },
    },
  });
  assert.equal(upgraded.schema_version, 4);
  assert.deepEqual(Object.keys(upgraded.scores).sort(), [v070Row("anthropic/claude-opus-5"), v070Row("gemini-4-pro"), "no-such-model-xyz"].sort());
  const scored = scoredModels({ userScores: upgraded });
  assert.equal(scored["no-such-model-xyz"], undefined, "an unresolved name is never made a row");
  assert.equal(scored[v070Row("gemini-4-pro")].five_axis.manual_scores.creativity.kind, "user");
  // Every name of the table resolved through an alias at v0.7.0 and resolves otherwise now
  for (const [name, row] of Object.entries(V0_7_0)) {
    assert.ok(row in FIVE_AXIS_MODELS, `${name} -> ${row} is a row`);
    assert.notDeepEqual([resolveModel(name).source, resolveModel(name).key], ["alias", row], `${name} resolves otherwise now`);
  }
});

test("a family name has no scores of its own: it is out of automatic routing with a data error, and its warning says so", () => {
  const name = "claude-opus-9";
  assert.equal(resolveModel(name).source, "family");
  assert.match(catalogNameWarning(name), /has no row of its own, so it has no scores/);
  assert.doesNotMatch(catalogNameWarning(name), /estimate/);
  const ranked = rankCandidates(PROFILE, { candidateModels: [`${name}:high`] });
  assert.equal(ranked.allCandidates[0].eligible, false);
  assert.match(ranked.allCandidates[0].excluded.join("; "), /data error/);
});

test("the /v1/models converter gives every listed model its own efforts: its levels, or the one configuration `default`", () => {
  // test/fixtures/magpie-v1-models.json: a /v1/models response in the shape Magpie v0.1.4470 writes it (gateway.go modelObject:
  // reasoning_levels and supported_reasoning_levels), for the openai and account:antigravity rows of the saved Magpie 0.1.4470
  // catalog (AgentCompass audit/gateway-catalogs). No gateway is asked.
  const listing = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "magpie-v1-models.json"), "utf8"));
  const warnings = [];
  const rows = candidatesFromModels(listing, (message) => warnings.push(message));
  assert.deepEqual(warnings, [], "every fixture row is read");
  assert.equal(rows.length, listing.data.length);
  assert.ok(listing.data.some((m) => levelsOf(m).length === 0), "the fixture has rows with no levels");
  listing.data.forEach((m, i) => {
    // audit/gateway_coverage.py: a row that lists no efforts is the model's one configuration, offered at `default`
    const efforts = m.reasoning_levels.length > 0 ? m.reasoning_levels : [ONE_CONFIGURATION];
    assert.deepEqual(rows[i], { model: m.id, efforts }, m.id);
  });
  assert.throws(() => candidatesFromModels({ models: [] }), /data array/);

  // A row's own efforts are what it runs at: each row is offered at exactly its efforts, a no-level row once, at `default`.
  const ranked = rankCandidates(PROFILE, { candidateModels: rows });
  for (const c of ranked.allCandidates) {
    const row = rows.find((r) => r.model === c.model);
    assert.ok(row.efforts.includes(c.effort), `${c.model} at ${c.effort}`);
  }
  assert.equal(ranked.allCandidates.length, rows.reduce((n, r) => n + r.efforts.length, 0));
});

test("a `default` row is one candidate read where the data reads `default`, and goes to Magpie as the bare model with no effort", () => {
  const reads = readingEffort({ effort_readings: FIVE_AXIS_EFFORT_READINGS }, ONE_CONFIGURATION);
  assert.ok(EFFORTS.includes(reads), `default reads an effort on the scale (${reads})`);
  for (const model of ["gemini-pro-agent", "gpt-6.1-sol"]) {
    const atDefault = rankCandidates(PROFILE, { candidateModels: [{ model, efforts: [ONE_CONFIGURATION] }] }).allCandidates;
    const atReading = rankCandidates(PROFILE, { candidateModels: [{ model, efforts: [reads] }] }).allCandidates;
    assert.equal(atDefault.length, 1);
    assert.equal(atDefault[0].effort, ONE_CONFIGURATION);
    assert.equal(atDefault[0].score, atReading[0].score, `${model}: scored as its ${reads} reading`);
    assert.equal(atDefault[0].duration_hours, atReading[0].duration_hours, `${model}: timed as its ${reads} reading`);
  }
  // Magpie's askedAt reads only none..max after a colon (provider.MemberEfforts); `m:default` would name another model.
  for (const protocol of ["chat", "responses", "anthropic"]) {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
    const ctx = { protocol, state: {}, reject: (status, message) => ({ rejected: status, message }), options: { injectProtocolEffort: true, candidateModels: [{ model: "gpt-6.1-sol", efforts: [ONE_CONFIGURATION] }] } };
    middlewareOnRequest(body, ctx);
    assert.equal(ctx.state.route.targetEffort, ONE_CONFIGURATION, protocol);
    assert.equal(body.model, "gpt-6.1-sol", protocol);
    assert.equal(body.reasoning_effort, undefined, protocol);
    assert.equal(body.reasoning?.effort, undefined, protocol);
    assert.equal(body.output_config?.effort, undefined, protocol);
  }
  // any other effort still goes as <model>:<effort> with the protocol's field
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  middlewareOnRequest(body, { protocol: "chat", state: {}, options: { injectProtocolEffort: true, candidateModels: [{ model: "gpt-6.1-sol", efforts: ["high"] }] } });
  assert.equal(body.model, "gpt-6.1-sol:high");
  assert.equal(body.reasoning_effort, "high");
});

test("the converter reads reasoning_levels first, else supported_reasoning_levels, and names what it skips on stderr", () => {
  // the documented order: reasoning_levels when it lists any, supported_reasoning_levels otherwise
  const differing = { id: "m-order", reasoning_levels: ["low", "High"], supported_reasoning_levels: [{ effort: "medium" }, { effort: "xhigh" }] };
  const objectsOnly = { id: "m-objects", reasoning_levels: [], supported_reasoning_levels: [{ effort: "Low" }, { effort: "high" }] };
  assert.deepEqual(candidatesFromModels({ data: [differing, objectsOnly] }), [
    { model: "m-order", efforts: ["low", "high"] },
    { model: "m-objects", efforts: ["low", "high"] },
  ]);

  const warnings = [];
  const listing = { data: [{ id: "m-1", reasoning_levels: ["low"] }, null, { name: "no id" }, { id: "m-1", reasoning_levels: ["low"] }, { id: "m-1", reasoning_levels: ["max"] }, ["m-2"]] };
  assert.deepEqual(candidatesFromModels(listing, (message) => warnings.push(message)), [{ model: "m-1", efforts: ["low"] }]);
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /^row 1: skipped, not an object/);
  assert.match(warnings[1], /^row 2: skipped, no model id/);
  assert.match(warnings[2], /^row 3: m-1 skipped, listed again \(row 0 kept\)$/);
  assert.match(warnings[3], /^row 4: m-1 skipped, listed again \(row 0 kept\); its efforts \[max\] differ from the kept row's \[low\]/);
  assert.match(warnings[4], /^row 5: skipped, not an object/);

  // the command line: warnings on stderr, stdout only the JSON
  const run = spawnSync(process.execPath, [path.join(REPO, "scripts", "candidates-from-models.mjs")], { input: JSON.stringify(listing), encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { candidateModels: [{ model: "m-1", efforts: ["low"] }] });
  assert.equal(run.stderr.trim().split(/\r?\n/).length, 5);
  assert.match(run.stderr, /candidates-from-models: row 4: m-1 skipped/);
});

test("Mode B answers every effort on Magpie's effort scale: outside it the nearest end, `default` as it reads, an unknown name not at all", () => {
  // Magpie decide.go: the effort answer is jevLevels[clamp(round(score), 0, 3)], jevLevels = low, medium, high, xhigh
  JEV_EFFORT_LEVELS.forEach((level, point) => assert.equal(buildEffortAnswer(level).score, point, level));
  const scores = EFFORTS.map((effort) => buildEffortAnswer(effort)?.score);
  for (const [i, score] of scores.entries()) {
    assert.ok(Number.isInteger(score) && score >= 0 && score < JEV_EFFORT_LEVELS.length, `${EFFORTS[i]} has an answer on the scale`);
    if (i > 0) assert.ok(score >= scores[i - 1], `non-decreasing at ${EFFORTS[i]}`);
  }
  const below = EFFORTS.slice(0, EFFORTS.indexOf(JEV_EFFORT_LEVELS[0]));
  const above = EFFORTS.slice(EFFORTS.indexOf(JEV_EFFORT_LEVELS.at(-1)) + 1);
  for (const effort of below) assert.equal(buildEffortAnswer(effort).score, 0, `${effort}: the bottom of the scale`);
  for (const effort of above) assert.equal(buildEffortAnswer(effort).score, JEV_EFFORT_LEVELS.length - 1, `${effort}: the top of the scale`);
  const reads = readingEffort({ effort_readings: FIVE_AXIS_EFFORT_READINGS }, "default");
  assert.equal(buildEffortAnswer("default").score, buildEffortAnswer(reads).score, `default answers as ${reads}`);
  assert.deepEqual(Object.keys(EFFORT_TO_JEV_SCORE).sort(), [...EFFORTS, "default"].sort());
  for (const unknown of ["turbo", "auto", "", null, undefined]) assert.equal(buildEffortAnswer(unknown), null, `${unknown}: no answer`);
});

// ---------------------------------------------------------------------------- provider_names (AgentCompass v0.7.2)

const DECLARED = [
  ...Object.keys(PROVIDER_NAMES.defaults).map((name) => [null, name]),
  ...Object.entries(PROVIDER_NAMES.rows).flatMap(([provider, names]) => Object.keys(names).map((name) => [provider, name])),
];

test("a served name reads its provider's declaration, then its maker's default, for every spelling, whatever order the providers come in", () => {
  for (const [provider, name] of DECLARED) {
    const declared = provider ? PROVIDER_NAMES.rows[provider][name] : PROVIDER_NAMES.defaults[name];
    const spellings = provider
      ? [`${provider}/${name}`, `${provider.toUpperCase()}/${name.toUpperCase()}`, `${provider}/${name}:high`]
      : [name, name.toUpperCase(), `${name}:high`, `${name}-high`];
    for (const spelling of spellings) {
      const r = resolveModel(spelling);
      if (declared.model == null) {
        assert.equal(r.key, null, spelling);
        assert.equal(r.source, declared.status, spelling);
        assert.equal(r.provider, provider, spelling);
      } else {
        assert.equal(r.key, declared.model, spelling);
        assert.equal(r.source, provider ? "provider" : "default", spelling);
      }
    }
    // the same declaration on the endpoint that lists the name bare (a Magpie preset's own namespace)
    if (provider) assert.equal(resolveModel(name, MODELS, MODEL_ALIASES, FAMILIES, PROVIDER_NAMES, [provider]).key, declared.model ?? null, `${name} on ${provider}`);
  }
  // providers that declare different rows: no row, in either order
  const table = { defaults: {}, rows: { a: { m: { model: "claude-opus-5-5" } }, b: { m: { model: "claude-sonnet-5-5" } } } };
  for (const order of [["a", "b"], ["b", "a"]]) {
    const r = resolveModel("m", MODELS, MODEL_ALIASES, FAMILIES, table, order);
    assert.deepEqual([r.source, r.key], ["conflict", null], order.join(","));
  }
  // a table without its parts is refused, never read as declaring none
  assert.throws(() => resolveModel("claude-opus-5-5", MODELS, MODEL_ALIASES, FAMILIES, { defaults: {} }), /provider_names/);
});

test("a pair with no row on its provider is its own model: out of automatic routing with the reason, and launched when named", () => {
  const noRow = DECLARED.filter(([provider, name]) => provider && PROVIDER_NAMES.rows[provider][name].model == null).map(([provider, name]) => `${provider}/${name}`);
  assert.ok(noRow.length > 0);
  for (const pair of noRow) {
    const r = resolveModel(pair);
    // never the same model as the same name elsewhere, and a stored value reads the same declaration again
    assert.notEqual(rowKey(pair), rowKey(modelLeaf(pair)), pair);
    assert.equal(rowKey(pair), `${r.provider}/${modelLeaf(pair)}`.toLowerCase());
    assert.equal(healthKey(pair), rowKey(pair));
    assert.equal(canonicalModel(canonicalModel(pair)), canonicalModel(pair));
    assert.equal(resolveModel(canonicalModel(pair)).source, r.source);
    const free = rankCandidates(PROFILE, { candidateModels: [{ model: pair, efforts: ["high"] }, { model: "gpt-6.1-sol", efforts: ["high"] }] });
    const mine = free.allCandidates.filter((c) => c.model === pair);
    assert.ok(mine.length > 0 && mine.every((c) => !c.eligible), `${pair}: out of automatic routing`);
    assert.match(catalogNameWarning(pair), new RegExp(`${r.provider}.*\\(${r.source}\\)`), `${pair}: the reason`);
    const named = rankCandidates(PROFILE, { candidateModels: [{ model: pair, efforts: ["high"] }], constraintModel: pair });
    assert.equal(named.selected?.model, pair, `${pair}: launched when named`);
  }
});

test("a modelsByProvider name is read on its preset: a name the preset declares with no row is routed as that pair and sent as listed", () => {
  const [provider, name] = DECLARED.find(([p, n]) => p && PROVIDER_NAMES.rows[p][n].model == null);
  const pair = `${provider}/${name}`;
  assert.equal(servedModel(name, [provider]), pair);
  assert.equal(servedModel(`${name}:low`, [provider]), `${pair}:low`);
  // a name the preset does not declare, or declares as the row the name is anyway, stays as listed
  for (const [p, n] of DECLARED.filter(([p]) => p)) {
    if (PROVIDER_NAMES.rows[p][n].model === resolveModel(n).key) assert.equal(servedModel(n, [p]), n, `${n} on ${p}`);
  }
  assert.equal(servedModel("gpt-6.1-sol", [provider]), "gpt-6.1-sol");
  const options = {
    candidateModels: [{ model: pair, efforts: ["high"] }],
    modelsByProvider: { [provider]: [{ model: name, efforts: ["high"] }] },
    routePerProvider: true,
    constraintModel: pair,
  };
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  const ctx = { protocol: "chat", state: {}, options };
  middlewareOnRequest(body, ctx);
  middlewareOnProvider(body, { ...ctx, provider: { id: provider, model: name } });
  assert.equal(ctx.state.route.targetModel, pair, "routed as the pair");
  assert.equal(body.model, `${name}:high`, "sent to the preset as listed");
});

test("a user score lands where its key's maker default says, the row's own id wins for its row, and the order of keys never matters", () => {
  const entry = (level) => ({ level, as_of: "2026-11-19" });
  for (const [, name] of DECLARED.filter(([p]) => !p)) {
    const row = PROVIDER_NAMES.defaults[name].model;
    assert.equal(resolveModelKey(name, FIVE_AXIS_MODELS_TABLE), row, name);
    // a provider's declaration is never read for a score: a provider-qualified key reads the default of its name
    for (const provider of Object.keys(PROVIDER_NAMES.rows)) assert.equal(resolveModelKey(`${provider}/${name}`, FIVE_AXIS_MODELS_TABLE), row, `${provider}/${name}`);
    // the row's own id wins where it lands on the row; the undated row of a moved name is reached by its repository id alone
    if (name === row || resolveModelKey(row, FIVE_AXIS_MODELS_TABLE) !== row) continue;
    const layer = { [name]: { coding: entry(1.1), creativity: entry(2.2) }, [row]: { coding: entry(2.9) } };
    const reversed = Object.fromEntries(Object.entries(layer).reverse());
    for (const doc of [layer, reversed]) assert.deepEqual(scoreLayer(doc, FIVE_AXIS_MODELS_TABLE).get(row), { coding: entry(2.9), creativity: entry(2.2) }, name);
  }
});

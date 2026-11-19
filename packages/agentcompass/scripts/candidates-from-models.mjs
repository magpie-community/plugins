#!/usr/bin/env node
/**
 * Turn the gateway's own model list (`GET /v1/models`) into `candidateModels` rows that carry Magpie's efforts:
 *
 *   curl -s -H "Authorization: Bearer $MAGPIE_KEY" http://127.0.0.1:<port>/v1/models | node scripts/candidates-from-models.mjs
 *   node scripts/candidates-from-models.mjs models.json
 *
 * The operator runs it with their own gateway key; this script makes no request. It prints `{ "candidateModels": [...] }` for the
 * plugin's options, one row per model, each with `efforts[]`, so the plugin routes it at exactly the efforts Magpie offers for it
 * (a row's own efforts are what it runs at):
 *
 * - a model the list gives with reasoning levels becomes `{ "model": <id>, "efforts": [<levels>] }`;
 * - a model the list gives with no levels is the model's one configuration (AgentCompass `audit/gateway_coverage.py`) and becomes
 *   `{ "model": <id>, "efforts": ["default"] }`: one candidate, read where the data reads `default`, and routed to Magpie as the
 *   bare model id with no effort. It is never written as a bare name, which the plugin would offer at every effort the data times.
 *
 * Levels are read from `reasoning_levels` (plain names) when it lists any, else from `supported_reasoning_levels` (`[{ effort }]`),
 * as Magpie's `modelObject` writes both. The order of the list is kept. A row it cannot read (not an object, or no id) is
 * skipped, and an id listed again keeps its first row; each is named on stderr with why, as is a repeated id whose levels differ
 * from its first row's. Stdout is only the JSON.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** The effort of a model listed with no reasoning levels: its one configuration. */
export const ONE_CONFIGURATION = "default";

/** The effort names of one `/v1/models` row, lowercase, each once, in the order Magpie gives them. */
export function levelsOf(row) {
  const clean = (names) => [...new Set(names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().toLowerCase()))];
  const flat = Array.isArray(row.reasoning_levels) ? clean(row.reasoning_levels) : [];
  if (flat.length > 0) return flat;
  return Array.isArray(row.supported_reasoning_levels) ? clean(row.supported_reasoning_levels.map((level) => level && level.effort)) : [];
}

/**
 * `candidateModels` rows for a `/v1/models` response (`{ data: [...] }`, or the bare array). `warn(message)` is told of every
 * row skipped (with its index or id, and why) and of every repeated id whose levels differ from the row kept.
 */
export function candidatesFromModels(listing, warn = () => {}) {
  const rows = Array.isArray(listing) ? listing : listing && Array.isArray(listing.data) ? listing.data : null;
  if (!rows) throw new Error("expected a /v1/models response: an object with a data array");
  const kept = new Map();
  const out = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      warn(`row ${index}: skipped, not an object`);
      return;
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) {
      warn(`row ${index}: skipped, no model id`);
      return;
    }
    const levels = levelsOf(row);
    const efforts = levels.length > 0 ? levels : [ONE_CONFIGURATION];
    if (kept.has(id)) {
      const first = kept.get(id);
      const same = first.efforts.length === efforts.length && first.efforts.every((effort, i) => effort === efforts[i]);
      warn(
        `row ${index}: ${id} skipped, listed again (row ${first.index} kept)` +
          (same ? "" : `; its efforts [${efforts.join(", ")}] differ from the kept row's [${first.efforts.join(", ")}]`),
      );
      return;
    }
    kept.set(id, { index, efforts });
    out.push({ model: id, efforts });
  });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8");
  const candidateModels = candidatesFromModels(JSON.parse(source.replace(/^﻿/, "")), (message) => process.stderr.write(`candidates-from-models: ${message}\n`));
  process.stdout.write(`${JSON.stringify({ candidateModels }, null, 2)}\n`);
}

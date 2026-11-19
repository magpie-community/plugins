#!/usr/bin/env node
/**
 * Turn the gateway's own model list (`GET /v1/models`) into `candidateModels` rows that carry Magpie's efforts:
 *
 *   curl -s -H "Authorization: Bearer $MAGPIE_KEY" http://127.0.0.1:<port>/v1/models | node scripts/candidates-from-models.mjs
 *   node scripts/candidates-from-models.mjs models.json
 *
 * The operator runs it with their own gateway key; this script makes no request. It prints `{ "candidateModels": [...] }` for the
 * plugin's options: each model the list gives with reasoning levels becomes `{ "model": <id>, "efforts": [<levels>] }`, so the
 * plugin routes it at exactly the efforts Magpie offers for it (a row's own efforts are what it runs at); a model the list gives
 * with no levels is written as its bare id, which the plugin offers as a bare name (`docs/reference.md`, "The efforts of a row").
 * Levels are read from `reasoning_levels` (plain names), else `supported_reasoning_levels` (`[{ effort }]`), as Magpie's
 * `modelObject` writes both. The order of the list is kept; an id listed twice keeps its first row.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** The effort names of one `/v1/models` row, lowercase, each once, in the order Magpie gives them. */
function levelsOf(row) {
  const flat = Array.isArray(row.reasoning_levels) ? row.reasoning_levels : null;
  const objects = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map((level) => level && level.effort) : [];
  const names = (flat && flat.length > 0 ? flat : objects).filter((name) => typeof name === "string" && name.trim());
  return [...new Set(names.map((name) => name.trim().toLowerCase()))];
}

/** `candidateModels` rows for a `/v1/models` response (`{ data: [...] }`, or the bare array). */
export function candidatesFromModels(listing) {
  const rows = Array.isArray(listing) ? listing : listing && Array.isArray(listing.data) ? listing.data : null;
  if (!rows) throw new Error("expected a /v1/models response: an object with a data array");
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = row && typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const efforts = levelsOf(row);
    out.push(efforts.length > 0 ? { model: id, efforts } : id);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8");
  process.stdout.write(`${JSON.stringify({ candidateModels: candidatesFromModels(JSON.parse(source.replace(/^﻿/, ""))) }, null, 2)}\n`);
}

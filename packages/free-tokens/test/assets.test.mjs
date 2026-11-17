import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/icons.js";
import { MAPPING } from "../src/mapping.js";
import { OFFICIAL_PROVIDERS } from "../src/allowlist.js";
import "../page/view.js";

const pageDir = fileURLToPath(new URL("../page/", import.meta.url));

test("every brand icon file exists in page/brand", () => {
  for (const [prov, file] of Object.entries(BRAND)) assert.ok(fs.existsSync(pageDir + "brand/" + file), `${prov} -> ${file}`);
});
test("index.html local assets exist (except magpie bridge & generated data.js)", () => {
  const html = fs.readFileSync(pageDir + "index.html", "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|#)/.test(u));
  for (const r of refs) { if (r.startsWith("_magpie/") || r === "data.js") continue; assert.ok(fs.existsSync(pageDir + r), `missing asset: ${r}`); }
});
test("load order: view.js before app.js", () => {
  const html = fs.readFileSync(pageDir + "index.html", "utf8");
  assert.ok(html.indexOf("view.js") >= 0 && html.indexOf("app.js") > html.indexOf("view.js"));
});
test("every mapping provider is in the official allowlist (else it'd never show)", () => {
  for (const k of Object.keys(MAPPING)) assert.ok(OFFICIAL_PROVIDERS.has(k), `mapping provider not allowlisted: ${k}`);
});
test("allowlist non-empty; kept vendor present; dropped providers excluded", () => {
  assert.ok(OFFICIAL_PROVIDERS.size > 0);
  assert.ok(OFFICIAL_PROVIDERS.has("DeepSeek"));
  for (const p of ["Nace AI", "硅基流动", "秒悟 Meoo", "魔搭社区"]) assert.ok(!OFFICIAL_PROVIDERS.has(p), `should be dropped: ${p}`);
});
test("view KIND covers every classify kind", () => {
  const V = globalThis.FTView;
  for (const k of ["daily", "monthly", "once", "limited", "free"]) assert.ok(V.KIND[k], `missing KIND ${k}`);
});
